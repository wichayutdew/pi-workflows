import assert from "node:assert/strict";
import test from "node:test";
import { readLatestCheckpoint } from "../src/engine/checkpoint.ts";
import { createRun } from "../src/engine/state.ts";
import { loadedWorkflow } from "./helpers.ts";

const entryType = "pi-workflows-state-v1";

test("checkpoint restore stops at the newest malformed workflow entry", () => {
  const older = createRun(loadedWorkflow(), "request", ["read"], "run-1", 1);
  const result = readLatestCheckpoint(
    [
      { type: "custom", customType: entryType, data: older },
      {
        type: "custom",
        customType: entryType,
        data: { ...older, stateVersion: 2 },
      },
    ],
    entryType,
  );
  assert.deepEqual(result, { status: "invalid" });
});

test("checkpoint restore ignores unrelated newer entries", () => {
  const run = createRun(loadedWorkflow(), "request", ["read"], "run-1", 1);
  const result = readLatestCheckpoint(
    [
      { type: "custom", customType: entryType, data: run },
      { type: "custom", customType: "other", data: null },
    ],
    entryType,
  );
  assert.equal(result.status, "valid");
  assert.equal(result.status === "valid" ? result.run.runId : undefined, "run-1");
});
