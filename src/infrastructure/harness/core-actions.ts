import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { LoadedWorkflow } from '../../domain/index.ts';
import { hasRuntimeCommandConflict } from '../../function/index.ts';
import { readLatestCheckpoint } from '../../function/index.ts';
import { failRun, pauseRun } from '../../function/index.ts';
import { preflightStep } from '../../function/index.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';
import { formatCatalogDiagnostics } from './catalog.ts';
import {
  conciseStepFailureSummary,
  conciseStepPauseSummary,
  reportFailedStep,
  reportPausedStep,
  reportSettledStep,
  type SettledStepReport,
} from './step-reporting.ts';

const STATE_ENTRY_TYPE = 'pi-workflows-state-v1';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'activeDelegation'
  | 'availableSkills'
  | 'catalog'
  | 'catalogLoadSequence'
  | 'dependencies'
  | 'isSessionActive'
  | 'isolateMainSessionTools'
  | 'latestContext'
  | 'launchCurrentStep'
  | 'mainSteps'
  | 'mutationQueue'
  | 'persist'
  | 'pi'
  | 'preflight'
  | 'registeredWorkflowCommands'
  | 'restoreBaselineTools'
  | 'run'
  | 'sessionEpoch'
  | 'start'
  | 'statusShortcut'
  | 'updateStatus'
>;

export type CoreActions = {
  settleAfterTransition: (
    this: HarnessActionContext,
    workflow: LoadedWorkflow,
    report: SettledStepReport,
  ) => void;
  preflight: (
    this: HarnessActionContext,
    workflow: LoadedWorkflow,
    stepId: string,
  ) => Array<string>;
  isolateMainSessionTools: (this: HarnessActionContext) => void;
  restoreBaselineTools: (this: HarnessActionContext) => void;
  captureSkills: (
    this: HarnessActionContext,
    skills: ReadonlyArray<{ name: string }> | undefined,
  ) => void;
  enqueueMutation: (
    this: HarnessActionContext,
    context: ExtensionContext,
    operation: (sessionEpoch: number) => Promise<void>,
  ) => Promise<void>;
  persist: (this: HarnessActionContext) => void;
  restoreFromSession: (
    this: HarnessActionContext,
    context: ExtensionContext,
  ) => void;
  reloadCatalog: (
    this: HarnessActionContext,
    context: ExtensionContext,
    shouldAnnounce: boolean,
  ) => Promise<boolean>;
};

function settleAfterTransition(
  this: HarnessActionContext,
  workflow: LoadedWorkflow,
  report: SettledStepReport,
): void {
  if (!this.run) return;
  if (this.run.status === 'running') {
    const preflightErrors = this.preflight(workflow, this.run.currentStepId);
    if (preflightErrors.length > 0) {
      this.run = failRun(
        this.run,
        `Step preflight failed: ${preflightErrors.join('; ')}`,
        this.dependencies.now(),
      );
    }
  }

  this.persist();
  reportSettledStep(this.pi, workflow, this.run, report);
  if (
    this.run.status === 'paused' &&
    this.run.failedStepId === this.run.currentStepId &&
    this.run.pauseReason
  ) {
    reportFailedStep(this.pi, workflow, this.run, this.run.pauseReason);
  }
  if (this.run.status !== 'running') {
    this.restoreBaselineTools();
    this.updateStatus();
    if (this.run.status === 'completed') {
      this.latestContext?.ui.notify(
        `Workflow "${this.run.workflowId}" completed`,
        'info',
      );
    } else if (this.run.status === 'paused') {
      const reason = this.run.pauseReason ?? 'manual action required';
      this.latestContext?.ui.notify(
        `Workflow paused: ${
          this.run.failedStepId
            ? conciseStepFailureSummary(reason)
            : conciseStepPauseSummary(reason)
        }`,
        'warning',
      );
    }
    return;
  }

  this.isolateMainSessionTools();
  this.updateStatus();
  this.launchCurrentStep(workflow);
}

function preflight(
  this: HarnessActionContext,
  workflow: LoadedWorkflow,
  stepId: string,
): Array<string> {
  const step = workflow.definition.steps[stepId];
  if (!step) return [`step "${stepId}" does not exist`];
  return preflightStep(step, {
    tools: this.pi.getAllTools(),
    commands: this.pi.getCommands(),
    skills: this.availableSkills,
  });
}

function isolateMainSessionTools(this: HarnessActionContext): void {
  this.pi.setActiveTools([]);
}

function restoreBaselineTools(this: HarnessActionContext): void {
  this.mainSteps.release();
  if (this.run) {
    this.pi.setActiveTools([...this.run.baselineTools]);
    return;
  }
  this.pi.setActiveTools(this.pi.getActiveTools());
}

function captureSkills(
  this: HarnessActionContext,
  skills: ReadonlyArray<{ name: string }> | undefined,
): void {
  if (!skills) return;
  this.availableSkills = new Set(skills.map((skill) => skill.name));
}

function enqueueMutation(
  this: HarnessActionContext,
  context: ExtensionContext,
  operation: (sessionEpoch: number) => Promise<void>,
): Promise<void> {
  if (!this.isSessionActive) {
    context.ui.notify('The Pi session is still initializing', 'warning');
    return Promise.resolve();
  }
  const sessionEpoch = this.sessionEpoch;
  return this.mutationQueue.run(async () => {
    if (!this.isSessionActive || this.sessionEpoch !== sessionEpoch) {
      context.ui.notify(
        'Workflow command was superseded by a session change',
        'warning',
      );
      return;
    }
    await operation(sessionEpoch);
  });
}

function persist(this: HarnessActionContext): void {
  if (this.run) {
    this.pi.appendEntry(STATE_ENTRY_TYPE, structuredClone(this.run));
    const session = this.latestContext?.sessionManager;
    if (session) this.dependencies.flushUnwrittenSession(session);
  }
}

function restoreFromSession(
  this: HarnessActionContext,
  context: ExtensionContext,
): void {
  this.latestContext = context;
  const previousBaseline = this.run?.baselineTools;
  const entries = context.sessionManager.getBranch();
  const checkpoint = readLatestCheckpoint(entries, STATE_ENTRY_TYPE);
  this.run = checkpoint.status === 'valid' ? checkpoint.run : undefined;
  if (checkpoint.status === 'invalid') {
    context.ui.notify(
      'The newest workflow checkpoint is invalid or from an unsupported version; recovery stopped',
      'error',
    );
  }
  if (
    this.run &&
    (this.run.status === 'running' || this.run.status === 'awaiting-gate')
  ) {
    this.run = pauseRun(
      this.run,
      'Session was restored; inspect the checkpoint before resuming',
      this.dependencies.now(),
    );
    this.persist();
    reportPausedStep(
      this.pi,
      this.catalog.workflows.get(this.run.workflowId),
      this.run,
      this.run.pauseReason ?? 'Session was restored',
    );
  }
  if (!this.run && previousBaseline) {
    this.pi.setActiveTools([...previousBaseline]);
  } else {
    this.restoreBaselineTools();
  }
  if (this.activeDelegation) this.isolateMainSessionTools();
  this.updateStatus();
}

async function reloadCatalog(
  this: HarnessActionContext,
  context: ExtensionContext,
  shouldAnnounce: boolean,
): Promise<boolean> {
  const loadSequence = ++this.catalogLoadSequence;
  const sessionEpoch = this.sessionEpoch;
  const catalog = await this.dependencies.loadCatalog({
    cwd: context.cwd,
    projectTrusted: context.isProjectTrusted(),
  });
  if (
    loadSequence !== this.catalogLoadSequence ||
    sessionEpoch !== this.sessionEpoch
  ) {
    return false;
  }
  this.latestContext = context;
  const workflows = new Map(catalog.workflows);
  const diagnostics = [...catalog.diagnostics];
  if (catalog.settings.statusShortcut !== this.statusShortcut) {
    diagnostics.push({
      level: 'warning',
      path: join(catalog.userDirectory, 'settings.yaml'),
      message:
        `settings.statusShortcut is "${catalog.settings.statusShortcut}", ` +
        `but the active shortcut is "${this.statusShortcut}"; run Pi /reload to apply shortcut changes`,
    });
  }
  const availableCommands = this.pi.getCommands();
  for (const [workflowId, workflow] of catalog.workflows) {
    const command = workflow.definition.command;
    if (
      hasRuntimeCommandConflict(
        command,
        availableCommands,
        this.registeredWorkflowCommands,
      )
    ) {
      workflows.delete(workflowId);
      diagnostics.push({
        level: 'error',
        path: workflow.sourcePath,
        message: `command "/${command}" conflicts with another loaded Pi resource`,
      });
    }
  }
  this.catalog = { ...catalog, workflows, diagnostics };
  for (const workflow of workflows.values()) {
    this.pi.registerCommand(workflow.definition.command, {
      description: workflow.definition.description,
      handler: async (args, commandContext) =>
        this.start(workflow.definition.id, args, commandContext),
    });
    this.registeredWorkflowCommands.add(workflow.definition.command);
  }

  const diagnosticText = formatCatalogDiagnostics(this.catalog);
  if (shouldAnnounce) {
    context.ui.notify(
      diagnosticText
        ? `Loaded ${this.catalog.workflows.size} workflow(s)\n${diagnosticText}`
        : `Loaded ${this.catalog.workflows.size} workflow(s)`,
      diagnosticText ? 'warning' : 'info',
    );
  } else if (
    this.catalog.diagnostics.some((diagnostic) => diagnostic.level === 'error')
  ) {
    context.ui.notify(
      `Workflow configuration errors:\n${diagnosticText}`,
      'warning',
    );
  }
  return true;
}

/**
 * Returns shared transition, persistence, preflight, and catalog actions.
 */
export function createCoreActions(): CoreActions {
  return {
    settleAfterTransition,
    preflight,
    isolateMainSessionTools,
    restoreBaselineTools,
    captureSkills,
    enqueueMutation,
    persist,
    restoreFromSession,
    reloadCatalog,
  };
}
