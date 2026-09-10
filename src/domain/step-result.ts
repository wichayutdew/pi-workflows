import type { StepWorkspaceBinding } from './config.ts';

export const MAX_ARTIFACT_CHARS = 200_000;

export const RESULT_KEYS = new Set([
  'version',
  'policyDigest',
  'outcome',
  'completed',
  'remaining',
  'artifact',
  'workspace',
]);

export const HANDOFF_RESULT_KEYS = new Set([
  'outcome',
  'completed',
  'remaining',
  'artifact',
  'workspace',
]);

export type WorkflowHandoffInput = {
  readonly completed: ReadonlyArray<string>;
  readonly remaining: ReadonlyArray<string>;
};

/**
 * Result constraints derived from the active workflow step.
 */
export type StepResultPolicy = {
  readonly policyDigest: string;
  readonly outcomes: ReadonlyArray<string>;
  readonly summaryMaxChars: number;
  readonly gateSubmitOutcome?: string;
  readonly workspace?: StepWorkspaceBinding;
};

export type WorkflowResultWorkspace = {
  readonly cwd: string;
};

/**
 * Validated result handed back to the workflow engine.
 */
export type WorkflowStepResult = {
  readonly version: 1;
  readonly policyDigest: string;
  readonly outcome: string;
  readonly summary: string;
  readonly artifact?: string;
  readonly workspace?: WorkflowResultWorkspace;
};

export type ArtifactContractValidationResult = {
  readonly valid: boolean;
  readonly reason?: string;
};

export { parseWorkflowStepResult } from '../function/step-result/parse-result.ts';
