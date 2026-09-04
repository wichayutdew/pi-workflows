import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { WORKFLOW_COMPLETION_TOOL } from './completion-tool.ts';
import type { MainStepRuntimeState } from './main-step-runtime-types.ts';
import { deactivateMainStep, settleMainStep } from './main-step-state.ts';

type RegisterMainStepLifecycleOptions = {
  readonly pi: ExtensionAPI;
  readonly state: MainStepRuntimeState;
};

/**
 * Connects runtime state transitions to Pi session and agent lifecycle events.
 *
 * @param options - Pi API and isolated runtime state.
 */
export function registerMainStepLifecycle({
  pi,
  state,
}: RegisterMainStepLifecycleOptions): void {
  const reset = (): void => {
    state.isSuspended = false;
    deactivateMainStep(state);
    pi.setActiveTools(
      pi.getActiveTools().filter((tool) => tool !== WORKFLOW_COMPLETION_TOOL),
    );
  };

  pi.on('session_start', reset);
  pi.on('session_tree', reset);
  pi.on('session_shutdown', () => {
    state.isSuspended = false;
    deactivateMainStep(state);
  });
  pi.on('agent_settled', (_event, context) =>
    settleMainStep({ state, context }),
  );
}
