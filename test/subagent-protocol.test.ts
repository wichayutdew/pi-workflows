import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  encodeChildPolicy,
  extractChildPolicy,
  isSafeStepCapabilityPath,
  isSafeStepResultPath,
  parseDelegatedStepResult,
  type ChildStepPolicy,
} from "../src/integrations/subagents/protocol.ts";

async function withPolicy(
  run: (policy: ChildStepPolicy) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflows-step-"));
  const policy: ChildStepPolicy = {
    version: 1,
    requestId: "request-1",
    agent: "pi-workflows.step",
    workflowId: "example",
    runId: "run-1",
    stepId: "inspect",
    stepTitle: "Inspect",
    policyDigest: "a".repeat(64),
    capabilityPath: join(directory, "capability"),
    capabilityToken: "c".repeat(64),
    resultPath: join(directory, "result.json"),
    permissions: {
      tools: ["read", "bash"],
      mcp: ["gitlab/get_merge_request"],
      extensions: [],
      skills: ["planning"],
      bash: { mode: "read-only", allow: [] },
    },
    outcomes: ["ready", "blocked", "submit"],
    summaryMaxChars: 500,
    gateSubmitOutcome: "submit",
  };
  try {
    await run(policy);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("child policy envelope is removed before the subagent sees the task", async () => {
  await withPolicy((policy) => {
    const envelope = encodeChildPolicy(policy);
    const extracted = extractChildPolicy(`${envelope}\n\nInspect the merge request.`);
    assert.deepEqual(extracted?.policy, policy);
    assert.equal(extracted?.task, "Inspect the merge request.");
    assert.equal(isSafeStepCapabilityPath(policy.capabilityPath), true);
    assert.equal(isSafeStepResultPath(policy.resultPath), true);
    assert.equal(isSafeStepResultPath(join(tmpdir(), "result.json")), false);
  });
});

test("delegated results are correlated and gate artifacts are required", async () => {
  await withPolicy((policy) => {
    assert.deepEqual(
      parseDelegatedStepResult(
        {
          version: 1,
          policyDigest: policy.policyDigest,
          outcome: "ready",
          summary: "  inspected  ",
        },
        policy,
      ),
      {
        version: 1,
        policyDigest: policy.policyDigest,
        outcome: "ready",
        summary: "inspected",
      },
    );
    assert.throws(
      () =>
        parseDelegatedStepResult(
          {
            version: 1,
            policyDigest: policy.policyDigest,
            outcome: "submit",
            summary: "plan",
          },
          policy,
        ),
      /requires a non-empty artifact/,
    );
    assert.throws(
      () =>
        parseDelegatedStepResult(
          {
            version: 1,
            policyDigest: "b".repeat(64),
            outcome: "ready",
            summary: "forged",
          },
          policy,
        ),
      /does not match the active policy/,
    );
  });
});
