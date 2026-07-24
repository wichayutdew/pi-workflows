import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { WorkflowHarness } from "../src/harness.ts";
import {
  PLANNOTATOR_REQUEST_CHANNEL,
  PLANNOTATOR_RESULT_CHANNEL,
} from "../src/integrations/plannotator.ts";
import {
  extractChildPolicy,
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  type SubagentDelegationRequest,
} from "../src/integrations/subagents/protocol.ts";

type LifecycleHandler = (
  event: Record<string, unknown>,
  context: ExtensionContext,
) => unknown;

type CommandHandler = (
  args: string,
  context: ExtensionCommandContext,
) => Promise<void>;

class FakeEventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => unknown>>();

  on(event: string, handler: (data: unknown) => unknown): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      void handler(data);
    }
  }
}

interface HarnessFixture {
  pi: ExtensionAPI;
  context: ExtensionCommandContext;
  events: FakeEventBus;
  lifecycle: Map<string, LifecycleHandler[]>;
  commands: Map<string, CommandHandler>;
  checkpoints: Array<{ type: string; data: unknown }>;
  activeTools: () => string[];
}

function createHarnessFixture(cwd: string): HarnessFixture {
  const events = new FakeEventBus();
  const lifecycle = new Map<string, LifecycleHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const checkpoints: Array<{ type: string; data: unknown }> = [];
  let activeTools = ["read", "bash"];
  const ui = {
    notify() {},
    setStatus() {},
  };
  const context = {
    cwd,
    ui,
    isProjectTrusted: () => true,
    isIdle: () => true,
    abort() {},
    waitForIdle: async () => undefined,
    getSystemPromptOptions: () => ({ skills: [] }),
    sessionManager: {
      getBranch: () => [],
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    events,
    on(event: string, handler: LifecycleHandler) {
      lifecycle.set(event, [...(lifecycle.get(event) ?? []), handler]);
    },
    registerCommand(
      name: string,
      command: { handler: CommandHandler },
    ) {
      commands.set(name, command.handler);
    },
    getCommands() {
      return [...commands.keys()].map((name) => ({
        name,
        sourceInfo: { source: "extension", path: "/pi-workflows/src/index.ts" },
      }));
    },
    getAllTools() {
      return [
        { name: "read", sourceInfo: { source: "builtin" } },
        { name: "bash", sourceInfo: { source: "builtin" } },
        {
          name: "subagent",
          sourceInfo: {
            source: "extension",
            path: "/node_modules/pi-subagents/index.ts",
          },
        },
        {
          name: "plannotator_plan_review",
          sourceInfo: {
            source: "extension",
            path: "/node_modules/@plannotator/pi-extension/index.ts",
          },
        },
      ];
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(tools: string[]) {
      activeTools = [...tools];
    },
    appendEntry(type: string, data: unknown) {
      checkpoints.push({ type, data });
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    context,
    events,
    lifecycle,
    commands,
    checkpoints,
    activeTools: () => [...activeTools],
  };
}

async function writeWorkflow(directory: string): Promise<void> {
  await writeFile(
    join(directory, "delegate.workflow.json"),
    JSON.stringify({
      version: 1,
      id: "delegate",
      command: "delegate",
      description: "Delegate one step",
      start: "inspect",
      steps: {
        inspect: {
          prompt: "Inspect {{workflow.input}}.",
          permissions: {
            tools: ["read"],
          },
          requires: {
            tools: ["read"],
          },
          transitions: {
            done: "$done",
            blocked: "$pause",
          },
        },
      },
    }),
  );
}

async function writeGatedWorkflow(directory: string): Promise<void> {
  await writeFile(
    join(directory, "gated.workflow.json"),
    JSON.stringify({
      version: 1,
      id: "gated",
      command: "gated",
      description: "Delegate a gated step",
      start: "plan",
      steps: {
        plan: {
          prompt: "Prepare a plan for {{workflow.input}}.",
          permissions: {
            tools: ["read"],
            extensions: ["plannotator"],
          },
          requires: {
            tools: ["read"],
            extensions: ["plannotator"],
          },
          gate: {
            provider: "plannotator",
            submitOutcome: "submit",
            approvedOutcome: "approved",
            rejectedOutcome: "changes-requested",
            timeoutMs: 1_000,
          },
          transitions: {
            approved: "$done",
            "changes-requested": "plan",
            blocked: "$pause",
          },
        },
      },
    }),
  );
}

async function initialize(fixture: HarnessFixture): Promise<void> {
  new WorkflowHarness(fixture.pi);
  const sessionStart = fixture.lifecycle.get("session_start")?.[0];
  assert.ok(sessionStart);
  await sessionStart(
    { type: "session_start" },
    fixture.context as unknown as ExtensionContext,
  );
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

function latestRun(fixture: HarnessFixture): Record<string, unknown> {
  const checkpoint = fixture.checkpoints.at(-1);
  assert.ok(checkpoint);
  return checkpoint.data as Record<string, unknown>;
}

test("the harness delegates a step and advances only from its correlated child result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflows-harness-"));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeWorkflow(directory);
    const fixture = createHarnessFixture(directory);
    let delegatedRequest: SubagentDelegationRequest | undefined;
    fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
      delegatedRequest = data as SubagentDelegationRequest;
      assert.deepEqual(fixture.activeTools(), []);
      const extracted = extractChildPolicy(delegatedRequest.task);
      assert.ok(extracted);
      await writeFile(
        extracted.policy.resultPath,
        JSON.stringify({
          version: 1,
          policyDigest: extracted.policy.policyDigest,
          outcome: "done",
          summary: "Inspected in the child",
        }),
      );
      fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
        version: 1,
        requestId: delegatedRequest.requestId,
      });
      fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        version: 1,
        requestId: delegatedRequest.requestId,
        status: "completed",
      });
    });

    await initialize(fixture);
    const start = fixture.commands.get("delegate");
    assert.ok(start);
    await start("the repository", fixture.context);

    await eventually(() => {
      assert.equal(latestRun(fixture).status, "completed");
    });
    assert.equal(delegatedRequest?.agent, "pi-workflows.step");
    assert.equal(delegatedRequest?.context, "fresh");
    assert.equal(delegatedRequest?.skill, false);
    assert.deepEqual(fixture.activeTools(), ["read", "bash"]);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("pause cancels the active child, ignores its late response, and resumes the same step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflows-harness-"));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeWorkflow(directory);
    const fixture = createHarnessFixture(directory);
    const requests: SubagentDelegationRequest[] = [];
    let firstResultWritten: Promise<void> | undefined;
    fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (data) => {
      const request = data as SubagentDelegationRequest;
      requests.push(request);
      const extracted = extractChildPolicy(request.task);
      assert.ok(extracted);
      const writeResult = writeFile(
        extracted.policy.resultPath,
        JSON.stringify({
          version: 1,
          policyDigest: extracted.policy.policyDigest,
          outcome: "done",
          summary: `Child attempt ${requests.length}`,
        }),
      );
      fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
        version: 1,
        requestId: request.requestId,
      });
      if (requests.length === 1) {
        firstResultWritten = writeResult;
        return;
      }
      void writeResult.then(() => {
        fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          version: 1,
          requestId: request.requestId,
          status: "completed",
        });
      });
    });

    const cancellations: string[] = [];
    fixture.events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (data) => {
      cancellations.push((data as { requestId: string }).requestId);
    });

    await initialize(fixture);
    const start = fixture.commands.get("delegate");
    const pause = fixture.commands.get("workflow-pause");
    const resume = fixture.commands.get("workflow-resume");
    assert.ok(start);
    assert.ok(pause);
    assert.ok(resume);
    await start("the repository", fixture.context);
    assert.ok(firstResultWritten);
    await firstResultWritten;

    const pausing = pause("repair workflow definition", fixture.context);
    await eventually(() => {
      assert.deepEqual(cancellations, [requests[0]?.requestId]);
      assert.equal(requests.length, 1);
    });
    fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId: requests[0]?.requestId,
      status: "cancelled",
    });
    await pausing;
    assert.equal(latestRun(fixture).status, "paused");
    assert.equal(latestRun(fixture).currentStepId, "inspect");
    assert.deepEqual(cancellations, [requests[0]?.requestId]);
    assert.deepEqual(fixture.activeTools(), ["read", "bash"]);

    fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId: requests[0]?.requestId,
      status: "completed",
    });
    await eventually(() => {
      assert.equal(latestRun(fixture).status, "paused");
    });

    await resume("", fixture.context);
    await eventually(() => {
      assert.equal(requests.length, 2);
      assert.equal(latestRun(fixture).status, "completed");
    });
    assert.equal(
      extractChildPolicy(requests[1]?.task ?? "")?.policy.stepId,
      "inspect",
    );
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a local delegation timeout keeps main tools and resume blocked until terminal response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflows-harness-"));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeWorkflow(directory);
    const fixture = createHarnessFixture(directory);
    const requests: SubagentDelegationRequest[] = [];
    const cancellations: string[] = [];
    fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
      const request = data as SubagentDelegationRequest;
      requests.push(request);
      if (requests.length === 1) return;

      const extracted = extractChildPolicy(request.task);
      assert.ok(extracted);
      await writeFile(
        extracted.policy.resultPath,
        JSON.stringify({
          version: 1,
          policyDigest: extracted.policy.policyDigest,
          outcome: "done",
          summary: "Second child completed",
        }),
      );
      fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
        version: 1,
        requestId: request.requestId,
      });
      fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        version: 1,
        requestId: request.requestId,
        status: "completed",
      });
    });
    fixture.events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (data) => {
      cancellations.push((data as { requestId: string }).requestId);
    });

    await initialize(fixture);
    const start = fixture.commands.get("delegate");
    const resume = fixture.commands.get("workflow-resume");
    assert.ok(start);
    assert.ok(resume);
    await start("the repository", fixture.context);
    assert.equal(requests.length, 1);
    assert.deepEqual(fixture.activeTools(), []);

    await new Promise((resolve) => setTimeout(resolve, 3_100));
    await eventually(() => {
      assert.equal(latestRun(fixture).status, "paused");
      assert.deepEqual(cancellations, [requests[0]?.requestId]);
    });
    assert.deepEqual(fixture.activeTools(), []);

    await resume("", fixture.context);
    assert.equal(requests.length, 1);
    assert.deepEqual(fixture.activeTools(), []);

    fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId: requests[0]?.requestId,
      status: "cancelled",
    });
    await eventually(() => {
      assert.deepEqual(fixture.activeTools(), ["read", "bash"]);
    });

    await resume("", fixture.context);
    await eventually(() => {
      assert.equal(requests.length, 2);
      assert.equal(latestRun(fixture).status, "completed");
    });
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Plannotator results are serialized behind pause and retained for resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflows-harness-"));
  const previousDirectory = process.env.PI_WORKFLOWS_DIR;
  process.env.PI_WORKFLOWS_DIR = directory;
  try {
    await writeGatedWorkflow(directory);
    const fixture = createHarnessFixture(directory);
    let childRequests = 0;
    fixture.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, async (data) => {
      childRequests += 1;
      const request = data as SubagentDelegationRequest;
      const extracted = extractChildPolicy(request.task);
      assert.ok(extracted);
      await writeFile(
        extracted.policy.resultPath,
        JSON.stringify({
          version: 1,
          policyDigest: extracted.policy.policyDigest,
          outcome: "submit",
          summary: "Plan ready",
          artifact: "# Plan\n\nImplement carefully.",
        }),
      );
      fixture.events.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
        version: 1,
        requestId: request.requestId,
      });
      fixture.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        version: 1,
        requestId: request.requestId,
        status: "completed",
      });
    });
    fixture.events.on(PLANNOTATOR_REQUEST_CHANNEL, (data) => {
      const request = data as {
        action: string;
        respond: (response: unknown) => void;
      };
      if (request.action === "plan-review") {
        request.respond({
          status: "handled",
          result: { status: "pending", reviewId: "review-serialized" },
        });
      }
    });

    await initialize(fixture);
    const start = fixture.commands.get("gated");
    const pause = fixture.commands.get("workflow-pause");
    const resume = fixture.commands.get("workflow-resume");
    assert.ok(start);
    assert.ok(pause);
    assert.ok(resume);
    await start("the change", fixture.context);
    await eventually(() => {
      assert.equal(latestRun(fixture).status, "awaiting-gate");
      assert.equal(
        (latestRun(fixture).pendingGate as { reviewId?: string }).reviewId,
        "review-serialized",
      );
    });

    const pausing = pause("inspect the review", fixture.context);
    fixture.events.emit(PLANNOTATOR_RESULT_CHANNEL, {
      reviewId: "review-serialized",
      approved: true,
      feedback: "Approved while pausing",
    });
    await pausing;
    await eventually(() => {
      const run = latestRun(fixture);
      assert.equal(run.status, "paused");
      const pendingGate = run.pendingGate as {
        resolution?: { approved?: boolean };
      };
      assert.equal(pendingGate.resolution?.approved, true);
    });
    assert.equal(childRequests, 1);

    await resume("", fixture.context);
    await eventually(() => {
      assert.equal(latestRun(fixture).status, "completed");
    });
    assert.equal(childRequests, 1);
  } finally {
    if (previousDirectory === undefined) delete process.env.PI_WORKFLOWS_DIR;
    else process.env.PI_WORKFLOWS_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
