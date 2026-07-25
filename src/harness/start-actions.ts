import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createRun } from '../engine/state.ts';
import { formatWorkflowList } from '../workflow-list.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';
import type { WorkflowStartContext } from './types.ts';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'activeDelegation'
  | 'captureSkills'
  | 'catalog'
  | 'dependencies'
  | 'isSessionActive'
  | 'isolateMainSessionTools'
  | 'launchCurrentStep'
  | 'openWorkflowStatus'
  | 'persist'
  | 'pi'
  | 'preflight'
  | 'reloadCatalog'
  | 'run'
  | 'sessionEpoch'
  | 'updateStatus'
>;

type SessionIdentity = Pick<
  FullHarnessActionContext,
  'isSessionActive' | 'sessionEpoch'
>;

function isCurrentSession(
  session: SessionIdentity,
  sessionEpoch: number,
): boolean {
  return session.isSessionActive && session.sessionEpoch === sessionEpoch;
}

export type StartActions = {
  listWorkflows: (
    this: HarnessActionContext,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  startNow: (
    this: HarnessActionContext,
    workflowId: string,
    input: string,
    startContext: WorkflowStartContext,
    sessionEpoch: number,
  ) => Promise<void>;
  reloadNow: (
    this: HarnessActionContext,
    context: ExtensionCommandContext,
  ) => Promise<void>;
};

async function listWorkflows(
  this: HarnessActionContext,
  context: ExtensionCommandContext,
): Promise<void> {
  const workflows = [...this.catalog.workflows.values()].sort((left, right) =>
    left.definition.id.localeCompare(right.definition.id),
  );
  if (workflows.length === 0) {
    context.ui.notify(
      `No workflows loaded from ${this.catalog.userDirectory}`,
      this.catalog.diagnostics.length > 0 ? 'warning' : 'info',
    );
    return;
  }
  this.pi.sendMessage({
    customType: 'workflow-list',
    content: formatWorkflowList(
      workflows.map((workflow) => workflow.definition),
    ),
    display: true,
  });
}

async function startNow(
  this: HarnessActionContext,
  workflowId: string,
  input: string,
  startContext: WorkflowStartContext,
  sessionEpoch: number,
): Promise<void> {
  const { context } = startContext;
  if (this.activeDelegation) {
    context.ui.notify(
      `Cannot start a workflow while subagent "${this.activeDelegation.agent}" is still cancelling`,
      'warning',
    );
    return;
  }
  if (
    this.run &&
    this.run.status !== 'completed' &&
    this.run.status !== 'aborted'
  ) {
    context.ui.notify(
      `Workflow "${this.run.workflowId}" is ${this.run.status}; resume or abort it first`,
      'warning',
    );
    return;
  }
  if (!context.isIdle()) {
    context.abort();
    await startContext.waitForIdle();
  }
  if (!isCurrentSession(this, sessionEpoch)) {
    context.ui.notify(
      'Workflow start was superseded by a session change',
      'warning',
    );
    return;
  }

  this.captureSkills(startContext.skills());
  if (!(await this.reloadCatalog(context, false))) {
    context.ui.notify(
      'Workflow start was superseded by a newer configuration load',
      'warning',
    );
    return;
  }
  if (!isCurrentSession(this, sessionEpoch)) {
    context.ui.notify(
      'Workflow start was superseded by a session change',
      'warning',
    );
    return;
  }
  const workflow = this.catalog.workflows.get(workflowId);
  if (!workflow) {
    context.ui.notify(`Workflow "${workflowId}" is not loaded`, 'error');
    return;
  }
  const preflightErrors = this.preflight(workflow, workflow.definition.start);
  if (preflightErrors.length > 0) {
    context.ui.notify(
      `Cannot start workflow:\n${preflightErrors.join('\n')}`,
      'error',
    );
    return;
  }

  this.run = createRun(
    workflow,
    input.trim(),
    this.pi.getActiveTools(),
    this.dependencies.createRequestId(),
    this.dependencies.now(),
  );
  this.persist();
  this.isolateMainSessionTools();
  this.updateStatus();
  this.openWorkflowStatus(context);
  this.launchCurrentStep(workflow);
}

async function reloadNow(
  this: HarnessActionContext,
  context: ExtensionCommandContext,
): Promise<void> {
  if (
    this.run &&
    (this.run.status === 'running' || this.run.status === 'awaiting-gate')
  ) {
    context.ui.notify(
      'Pause the workflow before reloading its configuration',
      'warning',
    );
    return;
  }
  this.captureSkills(context.getSystemPromptOptions().skills);
  await this.reloadCatalog(context, true);
}

/**
 * Returns workflow listing, start, and reload actions for harness composition.
 */
export function createStartActions(): StartActions {
  return { listWorkflows, startNow, reloadNow };
}
