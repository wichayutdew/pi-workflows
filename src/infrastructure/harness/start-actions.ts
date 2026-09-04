import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { createRun } from '../../function/index.ts';
import { restartRun } from '../../function/index.ts';
import type { LoadedWorkflow } from '../../domain/index.ts';
import { analyzeWorkflow, formatWorkflowDoctor } from '../../function/index.ts';
import { formatWorkflowList } from './workflow-list.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';
import { formatCatalogDiagnostics } from './catalog.ts';
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

type RestartWorkspaceBinding = {
  readonly cwd: string;
  readonly allowedRoots: ReadonlyArray<string>;
};

function completedWorkspaceBinding(
  run: NonNullable<HarnessActionContext['run']>,
  workflow: LoadedWorkflow,
): RestartWorkspaceBinding | undefined {
  for (let index = run.history.length - 1; index >= 0; index -= 1) {
    const entry = run.history[index];
    if (!entry?.workspaceCwd) continue;
    const step = workflow.definition.steps[entry.stepId];
    if (!step?.workspace || !step.workspace.bindOn.includes(entry.outcome)) {
      throw new Error(
        `workspace-binding step "${entry.stepId}" no longer matches the completed iteration`,
      );
    }
    return {
      cwd: entry.workspaceCwd,
      allowedRoots: step.workspace.allowedRoots,
    };
  }
  return undefined;
}

export type StartActions = {
  listWorkflows: (
    this: HarnessActionContext,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  doctorWorkflows: (
    this: HarnessActionContext,
    workflowId: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  startNow: (
    this: HarnessActionContext,
    workflowId: string,
    input: string,
    startContext: WorkflowStartContext,
    sessionEpoch: number,
  ) => Promise<void>;
  restartNow: (
    this: HarnessActionContext,
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

async function doctorWorkflows(
  this: HarnessActionContext,
  workflowId: string,
  context: ExtensionCommandContext,
): Promise<void> {
  const catalog = await this.dependencies.loadCatalog({
    cwd: context.cwd,
    projectTrusted: context.isProjectTrusted(),
  });
  if (catalog.diagnostics.some((diagnostic) => diagnostic.level === 'error')) {
    context.ui.notify(
      `Workflow configuration errors:\n${formatCatalogDiagnostics(catalog)}`,
      'warning',
    );
  }
  const selected = workflowId
    ? [catalog.workflows.get(workflowId)].filter(
        (workflow) => workflow !== undefined,
      )
    : [...catalog.workflows.values()].sort((left, right) =>
        left.definition.id.localeCompare(right.definition.id),
      );
  if (workflowId && selected.length === 0) {
    context.ui.notify(`Workflow "${workflowId}" is not loaded`, 'error');
    return;
  }
  if (selected.length === 0) {
    context.ui.notify(
      `No workflows loaded from ${catalog.userDirectory}`,
      catalog.diagnostics.length > 0 ? 'warning' : 'info',
    );
    return;
  }
  this.pi.sendMessage({
    customType: 'workflow-doctor',
    content: formatWorkflowDoctor(
      selected.map((workflow) => analyzeWorkflow(workflow.definition)),
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
  const livenessErrors = analyzeWorkflow(workflow.definition).issues.filter(
    (issue) => issue.level === 'error',
  );
  if (livenessErrors.length > 0) {
    context.ui.notify(
      `Cannot start workflow; run /workflow-doctor ${workflowId}:\n${livenessErrors.map((issue) => issue.message).join('\n')}`,
      'error',
    );
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

  let canonicalStartCwd: string;
  try {
    canonicalStartCwd = this.dependencies.resolveWorkspaceDirectory({
      candidateCwd: context.cwd,
      startCwd: context.cwd,
      allowedRoots: ['.'],
    });
  } catch (error) {
    context.ui.notify(
      `Cannot capture workflow working directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
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
    canonicalStartCwd,
  );
  this.persist();
  this.isolateMainSessionTools();
  this.updateStatus();
  this.launchCurrentStep(workflow);
}

async function restartNow(
  this: HarnessActionContext,
  input: string,
  startContext: WorkflowStartContext,
  sessionEpoch: number,
): Promise<void> {
  const { context } = startContext;
  const completedRun = this.run;
  if (!completedRun || completedRun.status !== 'completed') {
    context.ui.notify('Only a completed workflow can be restarted', 'warning');
    return;
  }
  if (this.activeDelegation) {
    context.ui.notify(
      `Cannot restart while subagent "${this.activeDelegation.agent}" is still cancelling`,
      'warning',
    );
    return;
  }
  if (!completedRun.startCwd) {
    context.ui.notify(
      'Cannot restart this workflow on the same worktree because its original start directory was not captured; start a new workflow instead',
      'error',
    );
    return;
  }
  if (!context.isIdle()) {
    context.abort();
    await startContext.waitForIdle();
  }
  if (!isCurrentSession(this, sessionEpoch) || this.run !== completedRun) {
    context.ui.notify(
      'Workflow restart was superseded by a session or workflow change',
      'warning',
    );
    return;
  }

  this.captureSkills(startContext.skills());
  if (!(await this.reloadCatalog(context, false))) {
    context.ui.notify(
      'Workflow restart was superseded by a newer configuration load',
      'warning',
    );
    return;
  }
  if (!isCurrentSession(this, sessionEpoch) || this.run !== completedRun) {
    context.ui.notify(
      'Workflow restart was superseded by a session or workflow change',
      'warning',
    );
    return;
  }

  const workflow = this.catalog.workflows.get(completedRun.workflowId);
  if (!workflow) {
    context.ui.notify(
      `Workflow "${completedRun.workflowId}" is no longer loaded`,
      'error',
    );
    return;
  }
  const livenessErrors = analyzeWorkflow(workflow.definition).issues.filter(
    (issue) => issue.level === 'error',
  );
  if (livenessErrors.length > 0) {
    context.ui.notify(
      `Cannot restart workflow; run /workflow-doctor ${workflow.definition.id}:\n${livenessErrors.map((issue) => issue.message).join('\n')}`,
      'error',
    );
    return;
  }
  const preflightErrors = this.preflight(workflow, workflow.definition.start);
  if (preflightErrors.length > 0) {
    context.ui.notify(
      `Cannot restart workflow:\n${preflightErrors.join('\n')}`,
      'error',
    );
    return;
  }

  let canonicalStartCwd: string;
  let canonicalSessionCwd: string;
  try {
    canonicalStartCwd = this.dependencies.resolveWorkspaceDirectory({
      candidateCwd: completedRun.startCwd,
      startCwd: completedRun.startCwd,
      allowedRoots: ['.'],
    });
    canonicalSessionCwd = this.dependencies.resolveWorkspaceDirectory({
      candidateCwd: context.cwd,
      startCwd: context.cwd,
      allowedRoots: ['.'],
    });
  } catch (error) {
    context.ui.notify(
      `Cannot restart workflow on its captured worktree: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'error',
    );
    return;
  }
  if (
    canonicalStartCwd !== completedRun.startCwd ||
    canonicalSessionCwd !== canonicalStartCwd
  ) {
    context.ui.notify(
      'Current session cwd does not match the captured workflow start directory',
      'error',
    );
    return;
  }

  try {
    const binding = completedWorkspaceBinding(completedRun, workflow);
    if (binding) {
      const canonicalWorkspaceCwd = this.dependencies.resolveWorkspaceDirectory(
        {
          candidateCwd: binding.cwd,
          startCwd: canonicalStartCwd,
          allowedRoots: binding.allowedRoots,
        },
      );
      if (canonicalWorkspaceCwd !== binding.cwd) {
        throw new Error(
          'previous workspace no longer resolves to its captured canonical directory',
        );
      }
    }
    this.run = restartRun(
      workflow,
      completedRun,
      input.trim() || completedRun.input,
      this.pi.getActiveTools(),
      this.dependencies.now(),
    );
  } catch (error) {
    context.ui.notify(
      `Cannot restart workflow on the same worktree: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'error',
    );
    return;
  }

  this.persist();
  this.isolateMainSessionTools();
  this.updateStatus();
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
  return { listWorkflows, doctorWorkflows, startNow, restartNow, reloadNow };
}
