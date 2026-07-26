import type { LoadedWorkflow, WorkflowStep } from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';

/**
 * Immutable values addressable from a workflow prompt template.
 */
export type TemplateValues = Readonly<Record<string, string>>;

/**
 * Combines the incoming handoff with the latest paused-attempt
 * summary without duplicating identical content.
 *
 * @param run - Current workflow run.
 * @returns The handoff text for the active step.
 */
export function currentStepHandoff(run: WorkflowRun): string {
  const incomingHandoff = run.stepHandoff ?? '';

  if (!incomingHandoff || incomingHandoff === run.lastSummary) {
    return run.lastSummary;
  }
  if (!run.lastSummary) {
    return incomingHandoff;
  }

  return [
    'Incoming previous-step handoff:',
    incomingHandoff,
    '',
    'Latest paused attempt:',
    run.lastSummary,
  ].join('\n');
}

/**
 * Replaces `{{ name }}` placeholders with their supplied values.
 *
 * Missing values render as empty strings so optional prompt fields remain
 * backwards compatible.
 *
 * @param template - Prompt template to render.
 * @param values - Values keyed by placeholder name.
 * @returns The rendered prompt.
 */
export function renderTemplate(
  template: string,
  values: TemplateValues,
): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    return values[name] ?? '';
  });
}

type CreateTemplateValuesOptions = {
  readonly workflow: LoadedWorkflow;
  readonly run: WorkflowRun;
  readonly step: WorkflowStep;
};

/**
 * Creates the immutable placeholder values for one workflow step.
 *
 * @param options - Workflow, run, and step being rendered.
 * @returns Values accepted by the workflow prompt template.
 */
export function createTemplateValues({
  workflow,
  run,
  step,
}: CreateTemplateValuesOptions): TemplateValues {
  return {
    'workflow.input': run.input,
    'workflow.id': workflow.definition.id,
    'run.id': run.runId,
    'step.id': run.currentStepId,
    'step.title': step.title,
    'last.summary': currentStepHandoff(run),
    'reviewed.artifact': run.reviewedArtifact ?? '',
    'reviewed.feedback': run.reviewedFeedback ?? '',
    'gate.feedback': run.gateFeedback,
    'resume.input': run.resumeInput ?? '',
  };
}
