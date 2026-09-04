import { failRun } from '../../function/index.ts';
import { buildMainWorkflowNotice } from '../../function/index.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';
import { parseAvailableSkills } from './catalog.ts';
import { waitForEventContextIdle } from './context-idle.ts';
import { reportFailedStep } from './step-reporting.ts';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'cancelActiveDelegation'
  | 'cancelPromptReview'
  | 'captureSkills'
  | 'catalog'
  | 'dependencies'
  | 'enqueueMutation'
  | 'isSessionActive'
  | 'latestContext'
  | 'mainSteps'
  | 'persist'
  | 'pi'
  | 'registeredWorkflowCommands'
  | 'reloadCatalog'
  | 'restoreBaselineTools'
  | 'restoreFromSession'
  | 'run'
  | 'sessionEpoch'
  | 'startNow'
  | 'statusShortcutLabel'
  | 'stopStatusRefresh'
  | 'updateStatus'
>;

export type LifecycleActions = {
  registerMultilineCommandInput: (this: HarnessActionContext) => void;
  registerLifecycle: (this: HarnessActionContext) => void;
  registerPolicy: (this: HarnessActionContext) => void;
};

function registerMultilineCommandInput(this: HarnessActionContext): void {
  this.pi.on('input', async (event, context) => {
    if (
      event.source === 'extension' ||
      event.images?.length ||
      !event.text.startsWith('/')
    ) {
      return;
    }
    const newlineIndex = event.text.indexOf('\n');
    if (newlineIndex === -1) return;
    const command = event.text.slice(1, newlineIndex).replace(/\r$/, '');
    if (!this.registeredWorkflowCommands.has(command)) return;
    const workflow = [...this.catalog.workflows.values()].find(
      (candidate) => candidate.definition.command === command,
    );
    if (!workflow) return;

    const input = event.text.slice(newlineIndex + 1);
    const skills = parseAvailableSkills(context.getSystemPrompt());
    try {
      await this.enqueueMutation(context, (sessionEpoch) =>
        this.startNow(
          workflow.definition.id,
          input,
          {
            context,
            skills: () => skills,
            waitForIdle: () =>
              waitForEventContextIdle(context, this.dependencies),
          },
          sessionEpoch,
        ),
      );
    } catch (error) {
      context.ui.notify(
        `Cannot start workflow: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
    return { action: 'handled' as const };
  });
}

function registerLifecycle(this: HarnessActionContext): void {
  this.pi.on('session_start', async (_event, context) => {
    this.sessionEpoch += 1;
    this.isSessionActive = false;
    this.cancelPromptReview();
    this.mainSteps.deactivate();
    await this.cancelActiveDelegation('Pi session changed');
    if (this.run) this.restoreBaselineTools();
    this.run = undefined;
    this.latestContext = context;
    if (!(await this.reloadCatalog(context, false))) return;
    this.restoreFromSession(context);
    this.isSessionActive = true;
  });

  this.pi.on('session_tree', async (_event, context) => {
    this.sessionEpoch += 1;
    this.isSessionActive = false;
    this.cancelPromptReview();
    this.mainSteps.deactivate();
    await this.cancelActiveDelegation('Pi session tree changed');
    this.latestContext = context;
    if (!(await this.reloadCatalog(context, false))) return;
    this.restoreFromSession(context);
    this.isSessionActive = true;
  });

  this.pi.on('session_shutdown', async (_event, context) => {
    this.sessionEpoch += 1;
    this.isSessionActive = false;
    if (this.run) {
      this.latestContext = context;
      try {
        this.persist();
      } catch (error) {
        context.ui.notify(
          `Workflow checkpoint could not be saved before shutdown: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'error',
        );
      }
    }
    this.cancelPromptReview();
    this.mainSteps.deactivate();
    await this.cancelActiveDelegation('Pi session shut down');
    if (this.run) this.restoreBaselineTools();
    this.run = undefined;
    this.latestContext = undefined;
    this.stopStatusRefresh();
  });
}

function registerPolicy(this: HarnessActionContext): void {
  this.pi.on('before_agent_start', (event, context) => {
    this.latestContext = context;
    this.captureSkills(event.systemPromptOptions.skills);
    if (!this.run || this.run.status !== 'running') return;
    const workflow = this.catalog.workflows.get(this.run.workflowId);
    if (!workflow) {
      const reason = 'Workflow configuration disappeared; reload or restore it';
      this.run = failRun(this.run, reason, this.dependencies.now());
      this.persist();
      reportFailedStep(this.pi, undefined, this.run, reason);
      this.restoreBaselineTools();
      this.updateStatus();
      return;
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildMainWorkflowNotice(workflow, this.run, this.statusShortcutLabel)}`,
    };
  });
}

/**
 * Returns Pi lifecycle and input registration actions for composition.
 */
export function createLifecycleActions(): LifecycleActions {
  return {
    registerMultilineCommandInput,
    registerLifecycle,
    registerPolicy,
  };
}
