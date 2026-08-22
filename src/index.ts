import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { KeyId } from '@earendil-works/pi-tui';
import { defaultUserWorkflowDirectory, loadSettings } from './config/load.ts';
import { WorkflowHarness } from './harness.ts';
import { registerSubagentChildRuntime } from './integrations/subagents/child-runtime.ts';

/**
 * Asynchronous entry point accepted by Pi's extension loader.
 */
export type PiWorkflowsExtension = (pi: ExtensionAPI) => Promise<void>;

/**
 * Process-role information used during extension registration.
 */
export type PiWorkflowsRuntimeEnvironment = {
  readonly isSubagentChild: boolean;
  readonly childAgent: string | undefined;
};

/**
 * External effects required to create the extension entry point.
 */
export type PiWorkflowsExtensionDependencies = {
  readonly loadSettings: typeof loadSettings;
  readonly userWorkflowDirectory: () => string;
  readonly runtimeEnvironment: () => PiWorkflowsRuntimeEnvironment;
  readonly registerChildRuntime: (pi: ExtensionAPI, childAgent: string) => void;
  readonly createHarness: (pi: ExtensionAPI, statusShortcut: KeyId) => void;
};

const DEFAULT_DEPENDENCIES = {
  loadSettings,
  userWorkflowDirectory: defaultUserWorkflowDirectory,
  runtimeEnvironment: (): PiWorkflowsRuntimeEnvironment => ({
    isSubagentChild:
      process.env.PI_WORKFLOWS_CHILD === '1' &&
      process.env.PI_WORKFLOWS_CHILD_RUNTIME === '1',
    childAgent: process.env.PI_WORKFLOWS_CHILD_AGENT?.trim(),
  }),
  registerChildRuntime: (pi, childAgent): void => {
    registerSubagentChildRuntime(pi, { childAgent });
  },
  createHarness: (pi, statusShortcut): void => {
    new WorkflowHarness(pi, statusShortcut);
  },
} as const satisfies PiWorkflowsExtensionDependencies;

/**
 * Creates the Pi extension entry point from explicit environment and runtime
 * dependencies.
 *
 * @param dependencies - Configuration and runtime effects for the extension.
 * @returns An asynchronous Pi extension factory.
 */
export function createPiWorkflowsExtension(
  dependencies: PiWorkflowsExtensionDependencies,
): PiWorkflowsExtension {
  return async (pi): Promise<void> => {
    const environment = dependencies.runtimeEnvironment();

    if (environment.isSubagentChild && environment.childAgent) {
      dependencies.registerChildRuntime(pi, environment.childAgent);
      return;
    }

    const { settings } = await dependencies.loadSettings(
      dependencies.userWorkflowDirectory(),
    );
    dependencies.createHarness(pi, settings.statusShortcut);
  };
}

/**
 * Registers the workflow harness or delegated child policy runtime with Pi.
 */
const piWorkflowsExtension = createPiWorkflowsExtension(DEFAULT_DEPENDENCIES);

export default piWorkflowsExtension;
