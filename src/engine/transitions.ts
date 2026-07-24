import type { LoadedWorkflow } from "../config/types.ts";
import type {
  GateResolution,
  StepHistoryEntry,
  WorkflowRun,
} from "./state.ts";

export interface ReconcileResult {
  run?: WorkflowRun;
  changed: boolean;
  restartedStep?: string;
  error?: string;
}

function currentStep(workflow: LoadedWorkflow, run: WorkflowRun) {
  return workflow.definition.steps[run.currentStepId];
}

function withUpdate(run: WorkflowRun, changes: Partial<WorkflowRun>, now: number): WorkflowRun {
  return { ...run, ...changes, updatedAt: now };
}

export function allowedOutcomes(workflow: LoadedWorkflow, run: WorkflowRun): string[] {
  const step = currentStep(workflow, run);
  if (!step) return [];
  return [
    ...Object.keys(step.transitions),
    ...(step.gate ? [step.gate.submitOutcome] : []),
  ];
}

export function pauseRun(run: WorkflowRun, reason: string, now: number): WorkflowRun {
  if (run.status !== "running" && run.status !== "awaiting-gate") {
    return withUpdate(run, { pauseReason: reason || run.pauseReason }, now);
  }
  return withUpdate(
    run,
    {
      status: "paused",
      pausedFrom: run.status,
      pauseReason: reason || `Paused during step "${run.currentStepId}"`,
    },
    now,
  );
}

export function resumeRun(run: WorkflowRun, now: number): WorkflowRun {
  if (run.status !== "paused") return run;
  return withUpdate(
    run,
    {
      status: run.pausedFrom ?? (run.pendingGate ? "awaiting-gate" : "running"),
      pauseReason: undefined,
      pausedFrom: undefined,
    },
    now,
  );
}

export function abortRun(run: WorkflowRun, reason: string, now: number): WorkflowRun {
  return withUpdate(
    run,
    {
      status: "aborted",
      pauseReason: reason || "Aborted by user",
      pausedFrom: undefined,
      pendingGate: undefined,
    },
    now,
  );
}

export function advanceRun(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  outcome: string,
  summary: string,
  now: number,
): WorkflowRun {
  if (run.status !== "running") {
    throw new Error(`workflow is ${run.status}; only a running workflow can advance`);
  }
  const step = currentStep(workflow, run);
  if (!step) throw new Error(`current step "${run.currentStepId}" no longer exists`);
  if (step.gate?.submitOutcome === outcome) {
    throw new Error(`outcome "${outcome}" must be submitted through the configured gate`);
  }

  const target = step.transitions[outcome];
  if (!target) {
    throw new Error(
      `outcome "${outcome}" is not valid for step "${run.currentStepId}"`,
    );
  }
  if (target === "$pause") {
    return withUpdate(
      run,
      {
        status: "paused",
        pausedFrom: "running",
        pauseReason: summary || `Step "${run.currentStepId}" requested a pause`,
        lastSummary: summary,
      },
      now,
    );
  }

  const completed: StepHistoryEntry = {
    stepId: run.currentStepId,
    stepDigest: run.currentStepDigest,
    outcome,
    summary,
    completedAt: now,
  };
  if (target === "$done") {
    return withUpdate(
      run,
      {
        status: "completed",
        history: [...run.history, completed],
        lastSummary: summary,
        gateFeedback: "",
        pausedFrom: undefined,
        pendingGate: undefined,
      },
      now,
    );
  }

  const nextStep = workflow.definition.steps[target];
  if (!nextStep) throw new Error(`transition target "${target}" does not exist`);
  const nextVisitCount = (run.visits[target] ?? 0) + 1;
  const visits = { ...run.visits, [target]: nextVisitCount };
  const overVisitLimit = nextVisitCount > workflow.definition.maxStepVisits;
  return withUpdate(
    run,
    {
      status: overVisitLimit ? "paused" : "running",
      currentStepId: target,
      currentStepDigest: workflow.stepDigests[target] ?? "",
      visits,
      history: [...run.history, completed],
      lastSummary: summary,
      gateFeedback: "",
      ...(overVisitLimit
        ? {
            pausedFrom: "running" as const,
            pauseReason: `Step "${target}" exceeded maxStepVisits (${workflow.definition.maxStepVisits})`,
          }
        : { pausedFrom: undefined, pauseReason: undefined }),
    },
    now,
  );
}

export function beginGate(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  outcome: string,
  artifact: string,
  requestId: string,
  now: number,
): WorkflowRun {
  if (run.status !== "running") {
    throw new Error(`workflow is ${run.status}; gate submission requires a running workflow`);
  }
  const step = currentStep(workflow, run);
  if (!step?.gate) throw new Error(`step "${run.currentStepId}" has no gate`);
  if (outcome !== step.gate.submitOutcome) {
    throw new Error(`gate expects outcome "${step.gate.submitOutcome}"`);
  }
  if (!artifact.trim()) throw new Error("gate submission requires a non-empty artifact");
  if (!requestId) throw new Error("gate submission requires a request id");

  return withUpdate(
    run,
    {
      status: "awaiting-gate",
      pendingGate: {
        provider: step.gate.provider,
        requestId,
        stepId: run.currentStepId,
        artifact,
        submittedOutcome: outcome,
        requestedAt: now,
      },
    },
    now,
  );
}

export function attachGateReviewId(
  run: WorkflowRun,
  reviewId: string,
  now: number,
): WorkflowRun {
  if (!run.pendingGate) throw new Error("workflow has no pending gate");
  return withUpdate(
    run,
    { pendingGate: { ...run.pendingGate, reviewId } },
    now,
  );
}

export function failGate(run: WorkflowRun, reason: string, now: number): WorkflowRun {
  if (!run.pendingGate) return run;
  return withUpdate(
    run,
    {
      status: "running",
      pendingGate: undefined,
      gateFeedback: reason,
    },
    now,
  );
}

export function storeGateResolution(
  run: WorkflowRun,
  resolution: GateResolution,
  now: number,
): WorkflowRun {
  if (!run.pendingGate) return run;
  return withUpdate(
    run,
    { pendingGate: { ...run.pendingGate, resolution } },
    now,
  );
}

export function resolveGate(
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  resolution: GateResolution,
  now: number,
): WorkflowRun {
  const pending = run.pendingGate;
  if (!pending) throw new Error("workflow has no pending gate");
  const step = workflow.definition.steps[pending.stepId];
  if (!step?.gate) throw new Error(`gated step "${pending.stepId}" no longer exists`);
  if (run.currentStepId !== pending.stepId) {
    throw new Error("gate result does not match the current step");
  }

  const outcome = resolution.approved
    ? step.gate.approvedOutcome
    : step.gate.rejectedOutcome;
  const summary = resolution.feedback
    ? `Gate ${resolution.approved ? "approved" : "rejected"}: ${resolution.feedback}`
    : `Gate ${resolution.approved ? "approved" : "rejected"}`;
  const runnable = withUpdate(
    run,
    {
      status: "running",
      pendingGate: undefined,
      pausedFrom: undefined,
      pauseReason: undefined,
      gateFeedback: resolution.feedback,
    },
    now,
  );
  const advanced = advanceRun(workflow, runnable, outcome, summary, now);
  return {
    ...advanced,
    gateFeedback: resolution.feedback,
  };
}

function rebuildVisits(history: readonly StepHistoryEntry[], currentStepId: string): Record<string, number> {
  const visits: Record<string, number> = {};
  for (const entry of history) {
    visits[entry.stepId] = (visits[entry.stepId] ?? 0) + 1;
  }
  visits[currentStepId] = (visits[currentStepId] ?? 0) + 1;
  return visits;
}

export function reconcileRun(
  run: WorkflowRun,
  workflow: LoadedWorkflow,
  now: number,
): ReconcileResult {
  if (run.workflowId !== workflow.definition.id) {
    return {
      changed: false,
      error: `run belongs to "${run.workflowId}", not "${workflow.definition.id}"`,
    };
  }
  if (run.workflowDigest === workflow.digest) {
    return { run, changed: false };
  }
  if (!workflow.definition.steps[run.currentStepId]) {
    return {
      changed: true,
      error: `current step "${run.currentStepId}" was removed; abort or restore the configuration`,
    };
  }

  const changedHistoryIndex = run.history.findIndex(
    (entry) => workflow.stepDigests[entry.stepId] !== entry.stepDigest,
  );
  if (changedHistoryIndex >= 0) {
    const changedEntry = run.history[changedHistoryIndex];
    if (!changedEntry || !workflow.definition.steps[changedEntry.stepId]) {
      return {
        changed: true,
        error: "a completed step was removed; abort or restore the configuration",
      };
    }
    const retainedHistory = run.history.slice(0, changedHistoryIndex);
    const restartedStep = changedEntry.stepId;
    return {
      changed: true,
      restartedStep,
      run: withUpdate(
        run,
        {
          workflowDigest: workflow.digest,
          status: "paused",
          currentStepId: restartedStep,
          currentStepDigest: workflow.stepDigests[restartedStep] ?? "",
          history: retainedHistory,
          visits: rebuildVisits(retainedHistory, restartedStep),
          pendingGate: undefined,
          pausedFrom: "running",
          pauseReason: `Configuration changed; restarted step "${restartedStep}"`,
          gateFeedback: "",
        },
        now,
      ),
    };
  }

  const currentDigest = workflow.stepDigests[run.currentStepId] ?? "";
  const currentChanged = currentDigest !== run.currentStepDigest;
  return {
    changed: true,
    ...(currentChanged ? { restartedStep: run.currentStepId } : {}),
    run: withUpdate(
      run,
      {
        workflowDigest: workflow.digest,
        currentStepDigest: currentDigest,
        ...(currentChanged
          ? {
              status: "paused" as const,
              pendingGate: undefined,
              pausedFrom: "running" as const,
              pauseReason: `Configuration changed; restarted step "${run.currentStepId}"`,
              gateFeedback: "",
            }
          : {}),
      },
      now,
    ),
  };
}
