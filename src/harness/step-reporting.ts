import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { LoadedWorkflow } from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';
import { redactStepDetailText } from '../step-log.ts';

export const WORKFLOW_STEP_SUMMARY_MESSAGE_TYPE = 'workflow-step-summary';
export const MAX_POSTED_STEP_SUMMARY_CHARS = 4_000;
export const MAX_POSTED_STEP_FAILURE_CHARS = 1_000;

export type SettledStepReport = {
  readonly stepId: string;
  readonly outcome: string;
  readonly summary: string;
};

type StepSummaryDetails = {
  readonly workflowId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly stepTitle: string;
  readonly status: 'completed' | 'paused' | 'failed';
  readonly outcome?: string;
  readonly workflowCompleted: boolean;
};

function boundedPostedText(value: string, maxChars: number): string {
  const normalized = redactStepDetailText(value).trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Produces the only failure text suitable for compact chat/toast surfaces. */
export function conciseStepFailureSummary(reason: string): string {
  return (
    boundedPostedText(reason, MAX_POSTED_STEP_FAILURE_CHARS) ||
    'The step failed without a diagnostic summary.'
  );
}

/** Produces a compact pause reason while full state remains in the checkpoint. */
export function conciseStepPauseSummary(reason: string): string {
  return (
    boundedPostedText(reason, MAX_POSTED_STEP_FAILURE_CHARS) ||
    'Manual action is required before this step can continue.'
  );
}

function stepTitle(
  workflow: LoadedWorkflow | undefined,
  stepId: string,
): string {
  const title = workflow?.definition.steps[stepId]?.title ?? stepId;
  return boundedPostedText(title, 200) || stepId;
}

function postStepMessage(
  pi: ExtensionAPI,
  content: string,
  details: StepSummaryDetails,
): void {
  try {
    pi.sendMessage(
      {
        customType: WORKFLOW_STEP_SUMMARY_MESSAGE_TYPE,
        content,
        display: true,
        details,
      },
      { triggerTurn: false },
    );
  } catch {
    // Reporting is best-effort and must never block a durable transition.
  }
}

/**
 * Posts only the structured handoff supplied by a successfully settled step.
 *
 * Execution transcripts and artifacts are deliberately unavailable to this
 * function, so they cannot leak into the concise chat summary.
 */
export function reportSettledStep(
  pi: ExtensionAPI,
  workflow: LoadedWorkflow,
  run: WorkflowRun,
  report: SettledStepReport,
): void {
  const workflowCompleted = run.status === 'completed';
  const paused =
    run.status === 'paused' &&
    run.failedStepId === undefined &&
    run.currentStepId === report.stepId;
  const status = paused ? 'paused' : 'completed';
  const title = stepTitle(workflow, report.stepId);
  const summary =
    boundedPostedText(report.summary, MAX_POSTED_STEP_SUMMARY_CHARS) ||
    'No summary was provided.';
  const completion = workflowCompleted
    ? `\n\nWorkflow \`${run.workflowId}\` completed.`
    : '';
  postStepMessage(
    pi,
    `### Step ${status}: ${title} (\`${report.stepId}\`)\n\n` +
      `Outcome: \`${report.outcome}\`\n\n${summary}${completion}`,
    {
      workflowId: run.workflowId,
      runId: run.runId,
      stepId: report.stepId,
      stepTitle: title,
      status,
      outcome: report.outcome,
      workflowCompleted,
    },
  );
}

/**
 * Posts a concise failure reason for the current step.
 *
 * The full diagnostic remains in the workflow checkpoint/status explorer.
 * Only a redacted prefix is displayed in chat.
 */
export function reportFailedStep(
  pi: ExtensionAPI,
  workflow: LoadedWorkflow | undefined,
  run: WorkflowRun,
  reason: string,
): void {
  const title = stepTitle(workflow, run.currentStepId);
  const summary = conciseStepFailureSummary(reason);
  postStepMessage(
    pi,
    `### Step failed: ${title} (\`${run.currentStepId}\`)\n\n${summary}\n\n` +
      `Workflow \`${run.workflowId}\` is paused.`,
    {
      workflowId: run.workflowId,
      runId: run.runId,
      stepId: run.currentStepId,
      stepTitle: title,
      status: 'failed',
      workflowCompleted: false,
    },
  );
}

/** Posts the concise reason for a non-failure workflow pause. */
export function reportPausedStep(
  pi: ExtensionAPI,
  workflow: LoadedWorkflow | undefined,
  run: WorkflowRun,
  reason: string,
): void {
  const title = stepTitle(workflow, run.currentStepId);
  const summary = conciseStepPauseSummary(reason);
  postStepMessage(
    pi,
    `### Step paused: ${title} (\`${run.currentStepId}\`)\n\n${summary}\n\n` +
      `Workflow \`${run.workflowId}\` is paused.`,
    {
      workflowId: run.workflowId,
      runId: run.runId,
      stepId: run.currentStepId,
      stepTitle: title,
      status: 'paused',
      workflowCompleted: false,
    },
  );
}
