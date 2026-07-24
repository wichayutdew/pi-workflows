import assert from "node:assert/strict";
import test from "node:test";
import {
  captureResumeCheckpoint,
  matchesResumeCheckpoint,
} from "../src/engine/resume.ts";
import { pauseRun } from "../src/engine/transitions.ts";
import { createRun, type WorkflowRun } from "../src/engine/state.ts";
import { loadedWorkflow } from "./helpers.ts";

function pausedRun(): WorkflowRun {
  return pauseRun(
    createRun(loadedWorkflow(), "request", ["read"], "run-1", 1),
    "inspect",
    2,
  );
}

test("resume checkpoints reject a session switch or state transition", () => {
  const run = pausedRun();
  const checkpoint = captureResumeCheckpoint(run, 4);
  assert.equal(matchesResumeCheckpoint(run, 4, checkpoint), true);
  assert.equal(matchesResumeCheckpoint(run, 5, checkpoint), false);
  assert.equal(
    matchesResumeCheckpoint({ ...run, status: "aborted" }, 4, checkpoint),
    false,
  );
});

test("resume checkpoints allow an update to the same paused gate", () => {
  const run: WorkflowRun = {
    ...pausedRun(),
    pausedFrom: "awaiting-gate",
    pendingGate: {
      provider: "plannotator",
      requestId: "request-1",
      stepId: "inspect",
      artifact: "# Plan",
      submittedOutcome: "submit",
      requestedAt: 3,
      reviewId: "review-1",
    },
  };
  const checkpoint = captureResumeCheckpoint(run, 4);
  const withResolution: WorkflowRun = {
    ...run,
    pendingGate: {
      ...run.pendingGate!,
      resolution: {
        approved: true,
        feedback: "Approved",
        resolvedAt: 5,
      },
    },
  };
  assert.equal(matchesResumeCheckpoint(withResolution, 4, checkpoint), true);
});
