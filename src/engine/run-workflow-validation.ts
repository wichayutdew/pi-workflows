import type { LoadedWorkflow, WorkflowStep } from '../config/types.ts';
import type { StepHistoryEntry, WorkflowRun } from './state-types.ts';

const sameVisitCounts = (
  actual: Readonly<Record<string, number>>,
  expected: Readonly<Record<string, number>>,
): boolean => {
  const actualEntries = Object.entries(actual).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return (
    actualEntries.length === expectedEntries.length &&
    actualEntries.every(
      ([stepId, count], index) =>
        expectedEntries[index]?.[0] === stepId &&
        expectedEntries[index][1] === count,
    )
  );
};

const validateHistoryMetadata = (
  workflow: LoadedWorkflow,
  step: WorkflowStep,
  entry: StepHistoryEntry,
): string | undefined => {
  const shouldBind = step.workspace?.bindOn.includes(entry.outcome) === true;
  if (shouldBind !== (entry.workspaceCwd !== undefined)) {
    return shouldBind
      ? `history step "${entry.stepId}" is missing its workspace binding`
      : `history step "${entry.stepId}" has an unauthorized workspace binding`;
  }

  const isApprovedGate =
    step.gate !== undefined && entry.outcome === step.gate.approvedOutcome;
  if (isApprovedGate && !entry.approval) {
    return `history step "${entry.stepId}" is missing authoritative gate approval`;
  }
  if (isApprovedGate && entry.artifact !== entry.approval?.artifact) {
    return `history step "${entry.stepId}" approval artifact is inconsistent`;
  }
  if (!isApprovedGate && (entry.approval || entry.artifact !== undefined)) {
    return `history step "${entry.stepId}" has approval data for a non-approved outcome`;
  }
  if (
    isApprovedGate &&
    entry.approval?.stepStructuralDigest !==
      workflow.stepStructuralDigests[entry.stepId]
  ) {
    return `history step "${entry.stepId}" approval does not match its configured structure`;
  }
  return undefined;
};

const validatePendingGate = (
  run: WorkflowRun,
  step: WorkflowStep,
): string | undefined => {
  const pending = run.pendingGate;
  if (!pending) return undefined;
  if (
    !step.gate ||
    pending.stepId !== run.currentStepId ||
    pending.provider !== step.gate.provider ||
    pending.submittedOutcome !== step.gate.submitOutcome
  ) {
    return 'pending gate does not match the current workflow step';
  }
  if (pending.provider === 'prompt' && pending.reviewId !== undefined) {
    return 'built-in prompt gate cannot carry a Plannotator review id';
  }
  return undefined;
};

/**
 * Validates persisted control-flow state against the loaded declarative graph.
 *
 * When configuration changed, the first digest-mismatched history entry is
 * intentionally left to reconciliation, which restarts that exact reachable
 * step and discards everything after it.
 */
export function validateRunWorkflowSemantics(
  run: WorkflowRun,
  workflow: LoadedWorkflow,
): string | undefined {
  const sameWorkflowDigest = run.workflowDigest === workflow.digest;
  let expectedStepId = workflow.definition.start;
  let reachedDone = false;
  let boundWorkspaceCwd: string | undefined;
  let latestApproval:
    { readonly artifact: string; readonly feedback: string } | undefined;
  const expectedVisits: Record<string, number> = { [expectedStepId]: 1 };

  for (let index = 0; index < run.history.length; index += 1) {
    const entry = run.history[index];
    if (!entry) continue;
    if (reachedDone) {
      return 'workflow history continues after a $done transition';
    }
    if (entry.stepId !== expectedStepId) {
      return `history step "${entry.stepId}" is not reachable after "${expectedStepId}"`;
    }

    const step = workflow.definition.steps[entry.stepId];
    const configuredDigest = workflow.stepDigests[entry.stepId];
    if (!step || entry.stepDigest !== configuredDigest) {
      return sameWorkflowDigest
        ? `history step "${entry.stepId}" does not match the active workflow digest`
        : undefined;
    }

    const metadataError = validateHistoryMetadata(workflow, step, entry);
    if (metadataError) return metadataError;
    if (entry.workspaceCwd) {
      if (
        boundWorkspaceCwd !== undefined &&
        boundWorkspaceCwd !== entry.workspaceCwd
      ) {
        return 'workflow history attempts to replace an existing workspace binding';
      }
      boundWorkspaceCwd = entry.workspaceCwd;
    }
    if (entry.approval) {
      latestApproval = {
        artifact: entry.approval.artifact,
        feedback: entry.approval.feedback,
      };
    }

    const target = step.transitions[entry.outcome];
    if (!target) {
      return `history outcome "${entry.outcome}" is not configured for step "${entry.stepId}"`;
    }
    if (target === '$pause') {
      return `history step "${entry.stepId}" records a non-completing $pause transition`;
    }
    if (target === '$done') {
      if (index !== run.history.length - 1) {
        return 'workflow history continues after a $done transition';
      }
      reachedDone = true;
      continue;
    }

    expectedStepId = target;
    expectedVisits[target] = (expectedVisits[target] ?? 0) + 1;
  }

  if (run.currentStepId !== expectedStepId) {
    return `current step "${run.currentStepId}" does not match reachable step "${expectedStepId}"`;
  }
  if (reachedDone !== (run.status === 'completed')) {
    return reachedDone
      ? 'a workflow that reached $done must be completed'
      : 'a completed workflow has no $done transition in its history';
  }
  if (
    run.status === 'completed' &&
    run.currentStepDigest !== run.history.at(-1)?.stepDigest
  ) {
    return 'completed workflow current-step digest does not match its terminal history';
  }
  if (!sameVisitCounts(run.visits, expectedVisits)) {
    return 'workflow visit counts do not match its execution history';
  }
  const reviewedArtifact = run.reviewedArtifact ?? '';
  const reviewedFeedback = run.reviewedFeedback ?? '';
  if (
    reviewedArtifact !== (latestApproval?.artifact ?? '') ||
    reviewedFeedback !== (latestApproval?.feedback ?? '')
  ) {
    return 'reviewed artifact and feedback do not match authoritative approval history';
  }

  const currentStep = workflow.definition.steps[run.currentStepId];
  if (!currentStep) {
    return `current step "${run.currentStepId}" is missing from the workflow`;
  }
  const currentStepChanged =
    run.currentStepDigest !== workflow.stepDigests[run.currentStepId];
  if (sameWorkflowDigest && currentStepChanged) {
    return `current step "${run.currentStepId}" does not match the active workflow digest`;
  }
  if (currentStepChanged) return undefined;
  return validatePendingGate(run, currentStep);
}
