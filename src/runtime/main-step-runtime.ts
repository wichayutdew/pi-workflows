import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { invalidCompletionCallIds } from '../policy/completion-batch.ts';
import { freezeToolInput } from '../policy/immutable-input.ts';
import { authorizeToolCall, resolveActiveTools } from '../policy/tools.ts';
import { registerMainStepCompletion } from './main-step-completion.ts';
import { registerMainStepLifecycle } from './main-step-lifecycle.ts';
import { registerMainStepPolicy } from './main-step-policy.ts';
import type {
  MainStepExecution,
  MainStepRuntimeController,
  MainStepRuntimeDependencies,
} from './main-step-runtime-types.ts';
import {
  activateMainStep,
  createMainStepRuntimeState,
  deactivateMainStep,
} from './main-step-state.ts';
import { parseWorkflowStepResult } from './step-result.ts';
import { WORKFLOW_COMPLETION_TOOL } from './completion-tool.ts';

export type {
  MainStepExecution,
  MainStepRuntimeController,
  MainStepRuntimeDependencies,
} from './main-step-runtime-types.ts';

const DEFAULT_DEPENDENCIES = {
  invalidCompletionCallIds,
  freezeToolInput,
  authorizeToolCall,
  resolveActiveTools,
  parseWorkflowStepResult,
} as const satisfies MainStepRuntimeDependencies;

/**
 * Inputs used to create an isolated main-step runtime.
 */
export type CreateMainStepRuntimeOptions = {
  readonly pi: ExtensionAPI;
  readonly dependencies?: Partial<MainStepRuntimeDependencies>;
};

/**
 * Creates a closure-based main-step runtime with explicit policy dependencies.
 *
 * @param options - Pi API and optional dependency overrides.
 * @returns A controller compatible with the workflow harness.
 */
export function createMainStepRuntime({
  pi,
  dependencies: dependencyOverrides = {},
}: CreateMainStepRuntimeOptions): MainStepRuntimeController {
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const state = createMainStepRuntimeState();

  const activate = (execution: MainStepExecution): void => {
    activateMainStep({ state, execution });
    pi.setActiveTools(
      dependencies.resolveActiveTools(
        pi.getAllTools(),
        execution.step,
        WORKFLOW_COMPLETION_TOOL,
      ),
    );
  };

  const deactivate = (): boolean => deactivateMainStep(state);

  const suspend = (): boolean => {
    const wasActive = deactivate();
    if (wasActive) {
      state.isSuspended = true;
      pi.setActiveTools([]);
    }
    return wasActive;
  };

  const release = (): void => {
    state.isSuspended = false;
  };

  registerMainStepLifecycle({ pi, state });
  registerMainStepPolicy({ pi, state, dependencies });
  registerMainStepCompletion({ pi, state, dependencies });

  return {
    get activeStepId() {
      return state.active?.stepId;
    },
    activate,
    deactivate,
    suspend,
    release,
  };
}

/**
 * Compatibility facade for harness code that constructs the runtime with
 * `new MainStepRuntime(pi)`.
 */
export class MainStepRuntime implements MainStepRuntimeController {
  private readonly controller: MainStepRuntimeController;

  /**
   * Creates and registers a main-step runtime against the Pi extension API.
   *
   * @param pi - Pi extension API used for lifecycle and tool registration.
   * @param dependencies - Optional policy and parsing overrides.
   */
  constructor(
    pi: ExtensionAPI,
    dependencies: Partial<MainStepRuntimeDependencies> = {},
  ) {
    this.controller = createMainStepRuntime({ pi, dependencies });
  }

  /** ID of the active main-agent workflow step, when present. */
  get activeStepId(): string | undefined {
    return this.controller.activeStepId;
  }

  /**
   * Activates one main-agent workflow step.
   *
   * @param execution - Step identity, policy, and settlement callback.
   */
  activate(execution: MainStepExecution): void {
    this.controller.activate(execution);
  }

  /**
   * Clears the active step.
   *
   * @returns Whether a step was active.
   */
  deactivate(): boolean {
    return this.controller.deactivate();
  }

  /**
   * Clears the active step and blocks tools until released.
   *
   * @returns Whether a step was active.
   */
  suspend(): boolean {
    return this.controller.suspend();
  }

  /** Releases a suspended runtime for future activation. */
  release(): void {
    this.controller.release();
  }
}
