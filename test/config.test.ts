import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkWorkflowAgainstCeiling } from "../src/config/ceiling.ts";
import { loadCatalog } from "../src/config/load.ts";
import {
  validateSettings,
  validateWorkflow,
} from "../src/config/validate.ts";
import { baseWorkflow } from "./helpers.ts";

function projectSubagentCeiling() {
  return {
    agents: ["pi-workflows.step"],
    contexts: ["fresh"],
    models: [],
    maxTimeoutMs: 60_000,
    maxTurns: 10,
    maxGraceTurns: 1,
    maxToolCalls: 20,
    artifacts: false,
  };
}

test("validates a declarative workflow graph", () => {
  const result = validateWorkflow(baseWorkflow());
  assert.deepEqual(result.errors, []);
  assert.equal(result.value?.start, "inspect");
  assert.equal(result.value?.steps.inspect?.permissions.bash.mode, "read-only");
  assert.deepEqual(result.value?.steps.inspect?.subagent, {
    agent: "pi-workflows.step",
    context: "fresh",
    timeoutMs: 900_000,
    artifacts: false,
  });
});

test("validates per-step subagent model and execution budgets", () => {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  steps.inspect = {
    ...steps.inspect,
    subagent: {
      agent: "pi-workflows.inspector",
      context: "fork",
      model: "anthropic/claude-sonnet-4",
      timeoutMs: 120_000,
      turnBudget: { maxTurns: 12, graceTurns: 2 },
      toolBudget: { soft: 20, hard: 30, block: "*" },
      artifacts: true,
    },
  };
  const result = validateWorkflow(raw);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value?.steps.inspect?.subagent, {
    agent: "pi-workflows.inspector",
    context: "fork",
    model: "anthropic/claude-sonnet-4",
    timeoutMs: 120_000,
    turnBudget: { maxTurns: 12, graceTurns: 2 },
    toolBudget: { soft: 20, hard: 30, block: "*" },
    artifacts: true,
  });

  const invalid = baseWorkflow();
  const invalidSteps = invalid.steps as Record<string, Record<string, unknown>>;
  invalidSteps.inspect = {
    ...invalidSteps.inspect,
    subagent: {
      agent: "reviewer",
      context: "shared",
      toolBudget: { soft: 10, hard: 5 },
    },
  };
  const invalidResult = validateWorkflow(invalid);
  assert.match(invalidResult.errors.join("\n"), /agent: invalid value "reviewer"/);
  assert.match(invalidResult.errors.join("\n"), /expected fresh or fork/);
  assert.match(invalidResult.errors.join("\n"), /soft: must not exceed hard/);
});

test("rejects unknown properties and transition targets", () => {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  steps.inspect = {
    ...steps.inspect,
    typo: true,
    transitions: { ready: "missing" },
  };
  const result = validateWorkflow(raw);
  assert.equal(result.value, undefined);
  assert.match(result.errors.join("\n"), /unknown property "typo"/);
  assert.match(result.errors.join("\n"), /unknown target "missing"/);
});

test("rejects a non-string schema hint", () => {
  const result = validateWorkflow({ ...baseWorkflow(), $schema: 42 });
  assert.match(result.errors.join("\n"), /workflow\.\$schema: expected a string/);
});

test("rejects workflow aliases reserved by Pi", () => {
  const result = validateWorkflow({ ...baseWorkflow(), command: "model" });
  assert.equal(result.value, undefined);
  assert.match(result.errors.join("\n"), /reserved by Pi or the harness/);
});

test("requires explicit Plannotator permission and dependency", () => {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  steps.inspect = {
    ...steps.inspect,
    gate: {
      provider: "plannotator",
      submitOutcome: "submit",
      approvedOutcome: "ready",
      rejectedOutcome: "blocked",
    },
  };
  const result = validateWorkflow(raw);
  assert.match(result.errors.join("\n"), /must allow "plannotator"/);
  assert.match(result.errors.join("\n"), /must require "plannotator"/);
});

test("project permission ceiling rejects wider tools and MCP servers", () => {
  const workflow = validateWorkflow({
    ...baseWorkflow(),
    steps: {
      inspect: {
        prompt: "Inspect",
        subagent: {
          agent: "pi-workflows.writer",
          context: "fork",
          model: "anthropic/claude-sonnet-4",
          timeoutMs: 120_000,
          turnBudget: { maxTurns: 12, graceTurns: 2 },
          toolBudget: { hard: 30 },
          artifacts: true,
        },
        permissions: {
          tools: ["read", "write"],
          mcp: ["gitlab/get_merge_request"],
        },
        transitions: { done: "$done" },
      },
    },
    start: "inspect",
  });
  assert.ok(workflow.value);
  const settings = validateSettings({
    version: 1,
    allowProjectWorkflows: true,
    permissionCeiling: {
      tools: ["read"],
      mcp: ["github"],
      bash: { mode: "deny" },
      subagent: projectSubagentCeiling(),
    },
  });
  assert.ok(settings.value?.permissionCeiling);
  const errors = checkWorkflowAgainstCeiling(
    workflow.value!,
    settings.value!.permissionCeiling!,
  );
  assert.match(errors.join("\n"), /"write" exceeds/);
  assert.match(errors.join("\n"), /"gitlab\/get_merge_request" exceeds/);
  assert.match(errors.join("\n"), /subagent\.agent/);
  assert.match(errors.join("\n"), /subagent\.context/);
  assert.match(errors.join("\n"), /subagent\.model/);
  assert.match(errors.join("\n"), /subagent\.timeoutMs/);
  assert.match(errors.join("\n"), /subagent\.turnBudget\.maxTurns/);
  assert.match(errors.join("\n"), /subagent\.toolBudget\.hard/);
  assert.match(errors.join("\n"), /subagent\.toolBudget\.block/);
  assert.match(errors.join("\n"), /subagent\.artifacts/);
});

test("loader rejects prompt paths that escape the workflow directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-config-"));
  const userDirectory = join(root, "workflows");
  await mkdir(userDirectory, { recursive: true });
  await writeFile(join(root, "outside.md"), "outside", "utf8");
  const raw = {
    ...baseWorkflow(),
    steps: {
      inspect: {
        prompt: { file: "../outside.md" },
        transitions: { done: "$done" },
      },
    },
    start: "inspect",
  };
  await writeFile(
    join(userDirectory, "escape.workflow.json"),
    JSON.stringify(raw),
    "utf8",
  );

  try {
    const catalog = await loadCatalog({
      cwd: root,
      projectTrusted: false,
      userDirectory,
    });
    assert.equal(catalog.workflows.size, 0);
    assert.match(catalog.diagnostics[0]?.message ?? "", /escapes workflow directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted project workflows cannot override user workflow ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-catalog-"));
  const userDirectory = join(root, "user");
  const projectDirectory = join(root, "project", ".pi", "workflows");
  await mkdir(userDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(
    join(userDirectory, "settings.json"),
    JSON.stringify({
      version: 1,
      allowProjectWorkflows: true,
      permissionCeiling: {
        tools: ["read", "edit", "bash"],
        mcp: [],
        extensions: [],
        skills: [],
        bash: { mode: "read-only" },
        subagent: {
          ...projectSubagentCeiling(),
          maxTimeoutMs: 900_000,
          maxTurns: 40,
          maxGraceTurns: 3,
          maxToolCalls: 100,
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    join(userDirectory, "example.workflow.json"),
    JSON.stringify(baseWorkflow()),
    "utf8",
  );
  const projectWorkflow = baseWorkflow();
  const projectSteps = projectWorkflow.steps as Record<
    string,
    Record<string, unknown>
  >;
  for (const [stepId, step] of Object.entries(projectSteps)) {
    projectSteps[stepId] = {
      ...step,
      subagent: {
        turnBudget: { maxTurns: 20, graceTurns: 2 },
        toolBudget: { hard: 50, block: "*" },
      },
    };
  }
  await writeFile(
    join(projectDirectory, "override.workflow.json"),
    JSON.stringify(projectWorkflow),
    "utf8",
  );

  try {
    const catalog = await loadCatalog({
      cwd: join(root, "project"),
      projectTrusted: true,
      userDirectory,
    });
    assert.equal(catalog.workflows.size, 1);
    assert.match(catalog.diagnostics.at(-1)?.message ?? "", /overrides are not allowed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
