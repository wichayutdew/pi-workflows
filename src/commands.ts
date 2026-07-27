import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from '@earendil-works/pi-coding-agent';

/**
 * Workflow operations exposed to slash-command handlers.
 */
export type WorkflowCommandController = {
  /** Returns loaded workflow IDs for command completion. */
  readonly workflowIds: () => ReadonlyArray<string>;
  /** Lists loaded workflows. */
  readonly list: (context: ExtensionCommandContext) => Promise<void>;
  /** Diagnoses workflow graph liveness. */
  readonly doctor: (
    workflowId: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  /** Starts a workflow. */
  readonly start: (
    workflowId: string,
    input: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  /** Restarts a completed workflow in its existing worktree. */
  readonly restart: (
    input: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  /** Pauses the active workflow. */
  readonly pause: (
    reason: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  /** Resumes the paused workflow with optional user guidance. */
  readonly resume: (
    input: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  /** Aborts the active workflow. */
  readonly abort: (
    reason: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  /** Reloads workflow configuration. */
  readonly reload: (context: ExtensionCommandContext) => Promise<void>;
};

/**
 * Declarative Pi command registration.
 */
export type HarnessCommand = {
  readonly name: string;
  readonly options: Omit<RegisteredCommand, 'name' | 'sourceInfo'>;
};

const splitFirst = (value: string): readonly [string, string] => {
  const trimmedValue = value.trim();
  const separatorIndex = trimmedValue.search(/\s/);

  return separatorIndex === -1
    ? [trimmedValue, '']
    : [
        trimmedValue.slice(0, separatorIndex),
        trimmedValue.slice(separatorIndex).trim(),
      ];
};

const createStartCommand = (
  controller: WorkflowCommandController,
): HarnessCommand => ({
  name: 'workflow-start',
  options: {
    description: 'Start a workflow: /workflow-start <id> [input]',
    getArgumentCompletions: (prefix) => {
      const completions = controller
        .workflowIds()
        .filter((workflowId) => workflowId.startsWith(prefix))
        .map((workflowId) => ({
          value: workflowId,
          label: workflowId,
        }));
      return completions.length > 0 ? completions : null;
    },
    handler: async (args, context) => {
      const [workflowId, input] = splitFirst(args);
      if (!workflowId) {
        context.ui.notify('Usage: /workflow-start <id> [input]', 'warning');
        return;
      }
      await controller.start(workflowId, input, context);
    },
  },
});

/**
 * Creates the declarative command registrations for a workflow controller.
 *
 * @param controller - Injected workflow command operations.
 * @returns Command names and Pi registration options.
 */
export function createHarnessCommands(
  controller: WorkflowCommandController,
): ReadonlyArray<HarnessCommand> {
  return [
    {
      name: 'workflow-list',
      options: {
        description: 'List loaded declarative workflows',
        handler: async (_args, context) => controller.list(context),
      },
    },
    {
      name: 'workflow-doctor',
      options: {
        description:
          'Check workflow completion paths, unreachable steps, and cycles',
        getArgumentCompletions: (prefix) => {
          const completions = controller
            .workflowIds()
            .filter((workflowId) => workflowId.startsWith(prefix))
            .map((workflowId) => ({
              value: workflowId,
              label: workflowId,
            }));
          return completions.length > 0 ? completions : null;
        },
        handler: async (args, context) =>
          controller.doctor(args.trim(), context),
      },
    },
    createStartCommand(controller),
    {
      name: 'workflow-restart',
      options: {
        description:
          'Restart the completed workflow in its worktree: /workflow-restart [input]',
        handler: async (input, context) =>
          controller.restart(input.trim(), context),
      },
    },
    {
      name: 'workflow-pause',
      options: {
        description: 'Pause the active workflow without losing its checkpoint',
        handler: async (reason, context) =>
          controller.pause(reason.trim(), context),
      },
    },
    {
      name: 'workflow-resume',
      options: {
        description:
          'Reload configuration and resume: /workflow-resume [guidance]',
        handler: async (input, context) =>
          controller.resume(input.trim(), context),
      },
    },
    {
      name: 'workflow-abort',
      options: {
        description: 'Abort the active workflow',
        handler: async (reason, context) =>
          controller.abort(reason.trim(), context),
      },
    },
    {
      name: 'workflow-reload',
      options: {
        description: 'Reload workflow files while no workflow is running',
        handler: async (_args, context) => controller.reload(context),
      },
    },
  ];
}

/**
 * Registers all workflow commands with Pi.
 *
 * @param pi - Pi extension API used for registration.
 * @param controller - Injected workflow command operations.
 */
export function registerHarnessCommands(
  pi: ExtensionAPI,
  controller: WorkflowCommandController,
): void {
  for (const command of createHarnessCommands(controller)) {
    pi.registerCommand(command.name, command.options);
  }
}
