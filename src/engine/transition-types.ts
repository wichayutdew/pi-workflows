import type { WorkflowRun } from './state-types.ts';

export type ReconcileResult = {
  readonly run?: WorkflowRun;
  readonly changed: boolean;
  readonly restartedStep?: string;
  readonly error?: string;
};
