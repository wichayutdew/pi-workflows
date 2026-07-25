import type { GateResolution } from '../engine/state.ts';
import {
  failRun,
  resolveGate,
  storeGateResolution,
} from '../engine/transitions.ts';
import {
  parsePlannotatorResult,
  PLANNOTATOR_RESULT_CHANNEL,
} from '../integrations/plannotator.ts';
import type { HarnessActionContext as FullHarnessActionContext } from './action-context.ts';

type HarnessActionContext = Pick<
  FullHarnessActionContext,
  | 'catalog'
  | 'dependencies'
  | 'handlePlannotatorResult'
  | 'isSessionActive'
  | 'latestContext'
  | 'mutationQueue'
  | 'persist'
  | 'pi'
  | 'restoreBaselineTools'
  | 'run'
  | 'settleAfterTransition'
  | 'updateStatus'
>;

export type PlannotatorResultActions = {
  registerPlannotatorResults: (this: HarnessActionContext) => void;
  handlePlannotatorResult: (
    this: HarnessActionContext,
    data: unknown,
  ) => Promise<void>;
};

function registerPlannotatorResults(this: HarnessActionContext): void {
  this.pi.events.on(PLANNOTATOR_RESULT_CHANNEL, (data) => {
    void this.mutationQueue
      .run(() => this.handlePlannotatorResult(data))
      .catch((error: unknown) => {
        this.latestContext?.ui.notify(
          `Cannot apply Plannotator result: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'error',
        );
      });
  });
}

async function handlePlannotatorResult(
  this: HarnessActionContext,
  data: unknown,
): Promise<void> {
  if (
    !this.isSessionActive ||
    this.run?.pendingGate?.provider !== 'plannotator' ||
    !this.run.pendingGate.reviewId
  ) {
    return;
  }
  const result = parsePlannotatorResult(data);
  if (!result || result.reviewId !== this.run.pendingGate.reviewId) return;

  const resolution: GateResolution = {
    approved: result.approved,
    feedback: result.feedback,
    resolvedAt: this.dependencies.now(),
  };
  if (this.run.status === 'paused') {
    this.run = storeGateResolution(
      this.run,
      resolution,
      this.dependencies.now(),
    );
    this.persist();
    this.latestContext?.ui.notify(
      `Review ${result.reviewId} finished while paused. Run /workflow-resume to apply it.`,
      'info',
    );
    return;
  }
  if (this.run.status !== 'awaiting-gate') return;

  const workflow = this.catalog.workflows.get(this.run.workflowId);
  if (!workflow) {
    this.run = failRun(
      this.run,
      'Gate result arrived, but workflow configuration is unavailable',
      this.dependencies.now(),
    );
    this.persist();
    this.restoreBaselineTools();
    this.updateStatus();
    return;
  }
  try {
    this.run = resolveGate(
      workflow,
      this.run,
      resolution,
      this.dependencies.now(),
    );
    this.settleAfterTransition(workflow);
  } catch (error) {
    this.run = failRun(
      this.run,
      `Cannot apply gate result: ${error instanceof Error ? error.message : String(error)}`,
      this.dependencies.now(),
    );
    this.persist();
    this.restoreBaselineTools();
    this.updateStatus();
  }
}

/**
 * Returns Plannotator result-channel actions for harness composition.
 */
export function createPlannotatorResultActions(): PlannotatorResultActions {
  return { registerPlannotatorResults, handlePlannotatorResult };
}
