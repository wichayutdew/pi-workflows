import assert from "node:assert/strict";
import test from "node:test";
import { authorizeBash } from "../src/policy/bash.ts";
import {
  authorizeMcpProxy,
  authorizeToolCall,
  resolveActiveTools,
} from "../src/policy/tools.ts";
import { loadedWorkflow } from "./helpers.ts";

test("read-only Bash accepts inspection and rejects shell composition", () => {
  const policy = { mode: "read-only" as const, allow: [] };
  assert.equal(authorizeBash("git status --short", policy).allowed, true);
  assert.equal(authorizeBash("rg TODO src", policy).allowed, true);
  assert.equal(authorizeBash("git status && rm -rf tmp", policy).allowed, false);
  assert.equal(authorizeBash("rg --pre sh TODO", policy).allowed, false);
  assert.equal(authorizeBash("rg --pr[e] ./evil needle .", policy).allowed, false);
  assert.equal(authorizeBash("git diff --outpu[t]=captured", policy).allowed, false);
  assert.equal(authorizeBash("rg -g '*.ts' TODO .", policy).allowed, true);
  assert.equal(
    authorizeBash("git grep -O'pager command' Pi", policy).allowed,
    false,
  );
  assert.equal(authorizeBash("git -c alias.status='!sh' status", policy).allowed, false);
});

test("Bash allow-list matches executable and argument prefix", () => {
  const policy = {
    mode: "allow-list" as const,
    allow: [{ executable: "npm", argsPrefix: ["test"] }],
  };
  assert.equal(authorizeBash("npm test -- --runInBand", policy).allowed, true);
  assert.equal(authorizeBash("npm run build", policy).allowed, false);
  assert.equal(
    authorizeBash("/bin/sh -c harmless", {
      mode: "allow-list",
      allow: [{ executable: "/bin/sh", argsPrefix: ["-c"] }],
    }).allowed,
    false,
  );
});

test("MCP proxy requires an explicit allowed server and tool", () => {
  const selectors = ["gitlab/get_merge_request"];
  assert.equal(
    authorizeMcpProxy(
      { server: "gitlab", tool: "get_merge_request", args: "{}" },
      selectors,
    ).allowed,
    true,
  );
  assert.equal(
    authorizeMcpProxy({ tool: "get_merge_request", args: "{}" }, selectors).allowed,
    false,
  );
  assert.equal(
    authorizeMcpProxy(
      { server: "github", tool: "get_merge_request", args: "{}" },
      selectors,
    ).allowed,
    false,
  );
  assert.equal(
    authorizeMcpProxy({ server: "gitlab", search: "merge" }, ["gitlab"]).allowed,
    false,
  );
});

test("tool policy enforces Bash rules after exact tool permission", () => {
  const workflow = loadedWorkflow();
  const step = workflow.definition.steps.inspect!;
  assert.equal(
    authorizeToolCall(
      "bash",
      { command: "git status" },
      step,
      [{ name: "bash", sourceInfo: { source: "builtin" } }],
    ).allowed,
    true,
  );
  assert.equal(
    authorizeToolCall(
      "bash",
      { command: "npm test" },
      step,
      [{ name: "bash", sourceInfo: { source: "builtin" } }],
    ).allowed,
    false,
  );
});

test("active tool selection includes exact tools and allowed extension tools", () => {
  const workflow = loadedWorkflow({
    version: 1,
    id: "extensions",
    command: "extensions",
    description: "Extension selection",
    start: "run",
    steps: {
      run: {
        prompt: "Run",
        permissions: {
          tools: ["read"],
          extensions: ["plannotator"],
        },
        transitions: { done: "$done" },
      },
    },
  });
  const selected = resolveActiveTools(
    [
      { name: "read", sourceInfo: { source: "builtin" } },
      {
        name: "annotate",
        sourceInfo: {
          source: "extension",
          path: "/packages/@plannotator/pi-extension/index.ts",
        },
      },
      { name: "write", sourceInfo: { source: "builtin" } },
      { name: "workflow_complete_step", sourceInfo: { source: "extension" } },
    ],
    workflow.definition.steps.run!,
    "workflow_complete_step",
  );
  assert.deepEqual(selected, ["read", "annotate", "workflow_complete_step"]);
});

test("extension selectors do not widen direct MCP access", () => {
  const workflow = loadedWorkflow({
    version: 1,
    id: "mcp-extension",
    command: "mcp-extension",
    description: "MCP extension",
    start: "run",
    steps: {
      run: {
        prompt: "Run",
        permissions: {
          extensions: ["pi-mcp-adapter"],
        },
        transitions: { done: "$done" },
      },
    },
  });
  const directTool = {
    name: "gitlab_get_merge_request",
    sourceInfo: {
      source: "extension",
      path: "/packages/pi-mcp-adapter/index.ts",
    },
  };
  const step = workflow.definition.steps.run!;
  assert.deepEqual(
    resolveActiveTools(
      [
        directTool,
        { name: "workflow_complete_step", sourceInfo: { source: "extension" } },
      ],
      step,
      "workflow_complete_step",
    ),
    ["workflow_complete_step"],
  );
  assert.equal(
    authorizeToolCall("gitlab_get_merge_request", {}, step, [directTool]).allowed,
    false,
  );
});
