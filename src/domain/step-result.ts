import type { StepWorkspaceBinding } from './config.ts';

export const MAX_ARTIFACT_CHARS = 200_000;

export const RESULT_KEYS = new Set([
  'version',
  'policyDigest',
  'outcome',
  'summary',
  'artifact',
  'workspace',
  'progress',
]);

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

export type WorkflowCheckpointProgress = {
  readonly feature: string;
  readonly commit: string;
  readonly changedFiles: ReadonlyArray<string>;
  readonly verification: ReadonlyArray<string>;
  readonly remaining: ReadonlyArray<string>;
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
  readonly progress?: WorkflowCheckpointProgress;
};

export type ArtifactContractValidationResult = {
  readonly valid: boolean;
  readonly reason?: string;
};

export { parseWorkflowStepResult } from '../function/step-result/parse-result.ts';
