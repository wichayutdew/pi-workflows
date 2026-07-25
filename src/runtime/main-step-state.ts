import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  MainStepExecution,
  MainStepRuntimeState,
} from './main-step-runtime-types.ts';

/**
 * Creates the isolated mutable state captured by one main-step runtime.
 *
 * @returns A fresh inactive runtime state.
 */
export function createMainStepRuntimeState(): MainStepRuntimeState {
  return {
    active: undefined,
    pendingResult: undefined,
    invalidCompletionCalls: new Set(),
    isSuspended: false,
  };
}

type ActivateMainStepOptions = {
  readonly state: MainStepRuntimeState;
  readonly execution: MainStepExecution;
};

/**
 * Activates an execution in a runtime state that currently has no active step.
 *
 * @param options - State and execution to activate.
 * @throws When another main-agent step remains active.
 */
export function activateMainStep({
  state,
  execution,
}: ActivateMainStepOptions): void {
  if (state.active) {
    throw new Error(
      `main workflow step "${state.active.stepId}" is still active`,
    );
  }

  state.isSuspended = false;
  state.active = execution;
  state.pendingResult = undefined;
  state.invalidCompletionCalls = new Set();
}

/**
 * Clears active execution data while preserving the suspension flag.
 *
 * @param state - Runtime state to clear.
 * @returns Whether a step was active.
 */
export function deactivateMainStep(state: MainStepRuntimeState): boolean {
  const wasActive = state.active !== undefined;
  state.active = undefined;
  state.pendingResult = undefined;
  state.invalidCompletionCalls = new Set();
  return wasActive;
}

type SettleMainStepOptions = {
  readonly state: MainStepRuntimeState;
  readonly context: ExtensionContext;
};

/**
 * Removes and settles the active execution with its captured result.
 *
 * @param options - Runtime state and extension context for the callback.
 * @returns The execution's settlement callback result.
 */
export function settleMainStep({
  state,
  context,
}: SettleMainStepOptions): Promise<void> | void {
  const activeExecution = state.active;
  if (!activeExecution) {
    return;
  }

  const result = state.pendingResult;
  deactivateMainStep(state);
  return activeExecution.onSettled(result, context);
}
