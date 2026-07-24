import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';

export interface WorkflowCommandController {
  workflowIds(): string[];
  list(ctx: ExtensionCommandContext): Promise<void>;
  start(
    workflowId: string,
    input: string,
    ctx: ExtensionCommandContext,
  ): Promise<void>;
  pause(reason: string, ctx: ExtensionCommandContext): Promise<void>;
  resume(ctx: ExtensionCommandContext): Promise<void>;
  abort(reason: string, ctx: ExtensionCommandContext): Promise<void>;
  reload(ctx: ExtensionCommandContext): Promise<void>;
  status(ctx: ExtensionCommandContext): Promise<void>;
}

function splitFirst(value: string): [string, string] {
  const trimmed = value.trim();
  const separator = trimmed.search(/\s/);
  if (separator === -1) return [trimmed, ''];
  return [trimmed.slice(0, separator), trimmed.slice(separator).trim()];
}

export function registerHarnessCommands(
  pi: ExtensionAPI,
  controller: WorkflowCommandController,
): void {
  pi.registerCommand('workflow-list', {
    description: 'List loaded declarative workflows',
    handler: async (_args, ctx) => controller.list(ctx),
  });

  pi.registerCommand('workflow-start', {
    description: 'Start a workflow: /workflow-start <id> [input]',
    getArgumentCompletions: (prefix) => {
      const items = controller
        .workflowIds()
        .filter((id) => id.startsWith(prefix))
        .map((id) => ({ value: id, label: id }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const [workflowId, input] = splitFirst(args);
      if (!workflowId) {
        ctx.ui.notify('Usage: /workflow-start <id> [input]', 'warning');
        return;
      }
      await controller.start(workflowId, input, ctx);
    },
  });

  pi.registerCommand('workflow-pause', {
    description: 'Pause the active workflow without losing its checkpoint',
    handler: async (reason, ctx) => controller.pause(reason.trim(), ctx),
  });

  pi.registerCommand('workflow-resume', {
    description: 'Reload configuration and resume the paused workflow',
    handler: async (_args, ctx) => controller.resume(ctx),
  });

  pi.registerCommand('workflow-abort', {
    description: 'Abort the active workflow',
    handler: async (reason, ctx) => controller.abort(reason.trim(), ctx),
  });

  pi.registerCommand('workflow-reload', {
    description: 'Reload workflow files while no workflow is running',
    handler: async (_args, ctx) => controller.reload(ctx),
  });

  pi.registerCommand('workflow-status', {
    description: 'Open the active workflow status board',
    handler: async (_args, ctx) => controller.status(ctx),
  });
}
