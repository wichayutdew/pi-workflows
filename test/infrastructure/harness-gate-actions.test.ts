import { describe, expect, test } from 'bun:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { LoadedWorkflow } from '../../src/domain/index.ts';
import {
  attachGateReviewId,
  beginGate,
  pauseRun,
} from '../../src/function/engine/index.ts';
import { createRun, type WorkflowRun } from '../../src/domain/index.ts';
import type { PlannotatorStartResponse } from '../../src/infrastructure/integrations/plannotator.ts';
import type { HarnessActionContext } from '../../src/infrastructure/harness/action-context.ts';
import { createGateSubmissionAction } from '../../src/infrastructure/harness/gate-submission-action.ts';
import { createPlannotatorResultActions } from '../../src/infrastructure/harness/plannotator-result-actions.ts';
import { createPromptGateActions } from '../../src/infrastructure/harness/prompt-gate-actions.ts';
import type { ActivePromptReview } from '../../src/infrastructure/harness/types.ts';
import { baseWorkflow, loadedWorkflow } from '../helpers.ts';

type Notice = {
  message: string;
  level: string;
};

function gatedWorkflow(
  provider: 'prompt' | 'plannotator',
  artifactContract?: Record<string, unknown>,
): LoadedWorkflow {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  const inspect = steps.inspect!;
  if (provider === 'plannotator') {
    const permissions = inspect.permissions as Record<string, unknown>;
    const requirements = inspect.requires as Record<string, unknown>;
    permissions.extensions = ['plannotator'];
    requirements.extensions = ['plannotator'];
  }
  inspect.gate = {
    provider,
    submitOutcome: 'submit',
    approvedOutcome: 'ready',
    rejectedOutcome: 'blocked',
    ...(provider === 'plannotator' ? { timeoutMs: 1_000 } : {}),
    ...(artifactContract ? { artifactContract } : {}),
  };
  return loadedWorkflow(raw);
}

function awaitingGateRun(
  workflow: LoadedWorkflow,
  reviewId?: string,
): WorkflowRun {
  let run = beginGate(
    workflow,
    createRun(workflow, 'request', ['read'], 'run-1', 1),
    'submit',
    '# Plan',
    'gate-request',
    2,
    'Plan ready',
  );
  if (reviewId) run = attachGateReviewId(run, reviewId, 3);
  return run;
}

function invalidGateWorkflow(workflow: LoadedWorkflow): LoadedWorkflow {
  const ungatedInspect = { ...workflow.definition.steps.inspect! };
  delete ungatedInspect.gate;
  return {
    ...workflow,
    definition: {
      ...workflow.definition,
      steps: {
        ...workflow.definition.steps,
        inspect: ungatedInspect,
      },
    },
  };
}

function createGateFixture(run: WorkflowRun, workflow: LoadedWorkflow) {
  const notices: Array<Notice> = [];
  const calls = {
    pausedPromptGates: [] as Array<{
      requestId: string;
      reason: string;
      failed: boolean;
    }>,
    persisted: 0,
    plannotatorRequests: 0,
    restoredTools: 0,
    settled: 0,
    statusUpdates: 0,
  };
  let now = 10;
  const fixture = {
    activePromptReview: undefined as ActivePromptReview | undefined,
    catalog: {
      workflows: new Map<string, LoadedWorkflow>([
        [workflow.definition.id, workflow],
      ]),
    },
    dependencies: {
      createAbortController: () => new AbortController(),
      createRequestId: () => 'provider-request',
      now: () => {
        now += 1;
        return now;
      },
      requestPlannotatorReview: async (): Promise<PlannotatorStartResponse> => {
        calls.plannotatorRequests += 1;
        return { status: 'unavailable', error: 'Plannotator is offline' };
      },
      requestPromptGateReview: async () => ({
        status: 'dismissed' as const,
      }),
    },
    isSessionActive: true,
    latestContext: {
      hasUI: true,
      ui: {
        notify: (message: string, level: string) => {
          notices.push({ message, level });
        },
      },
    },
    mutationQueue: {
      run: async (operation: () => Promise<void>) => operation(),
    },
    pi: { events: {} },
    run: run as WorkflowRun | undefined,
    sessionEpoch: 4,
    isolateMainSessionTools: () => {},
    launchPromptReview: () => {},
    pausePromptGate: (requestId: string, reason: string, failed: boolean) => {
      calls.pausedPromptGates.push({ requestId, reason, failed });
    },
    persist: () => {
      calls.persisted += 1;
    },
    restoreBaselineTools: () => {
      calls.restoredTools += 1;
    },
    settleAfterTransition: () => {
      calls.settled += 1;
    },
    updateStatus: () => {
      calls.statusUpdates += 1;
    },
  };
  return { calls, fixture, notices };
}

function activeReview(): ActivePromptReview {
  return {
    requestId: 'gate-request',
    runId: 'run-1',
    stepId: 'inspect',
    sessionEpoch: 4,
    abortController: new AbortController(),
  };
}

describe('when testing gate actions', () => {
  test('rejects artifacts that violate a gate contract before opening review', async () => {
    const artifactContract = {
      maxChars: 1_000,
      requiredSubstrings: ['# Plan', '## Evidence'],
      forbiddenSubstrings: ['saved at /'],
      equalOccurrenceGroups: [['**Question:**', '**Answer:**']],
    };
    const workflow = gatedWorkflow('plannotator', artifactContract);
    const originalRun = createRun(workflow, 'request', ['read'], 'run-1', 1);
    const { calls, fixture } = createGateFixture(originalRun, workflow);

    await expect(
      createGateSubmissionAction().submitGate.call(
        fixture as unknown as HarnessActionContext,
        workflow,
        originalRun,
        'submit',
        'Plan ready',
        'The complete gate artifact is the exact Markdown saved at /tmp/plan.md',
      ),
    ).rejects.toThrow('missing required text');

    expect(fixture.run).toBe(originalRun);
    expect(calls.plannotatorRequests).toBe(0);
    expect(calls.persisted).toBe(0);
    expect(calls.restoredTools).toBe(0);
  });

  test('rejects overlong or incomplete repeated artifact sections before opening review', async () => {
    const workflow = gatedWorkflow('plannotator', {
      maxChars: 20,
      requiredSubstrings: ['# Plan'],
      forbiddenSubstrings: [],
      equalOccurrenceGroups: [['**Question:**', '**Answer:**']],
    });
    const originalRun = createRun(workflow, 'request', ['read'], 'run-1', 1);
    const { calls, fixture } = createGateFixture(originalRun, workflow);

    await expect(
      createGateSubmissionAction().submitGate.call(
        fixture as unknown as HarnessActionContext,
        workflow,
        originalRun,
        'submit',
        'Plan ready',
        '# Plan\n**Question:**\n**Answer:**\n'.repeat(2),
      ),
    ).rejects.toThrow('exceeds 20 characters');

    expect(calls.plannotatorRequests).toBe(0);
  });

  test('retries a configured artifact-contract failure without opening review', async () => {
    const raw = baseWorkflow();
    const steps = raw.steps as Record<string, Record<string, unknown>>;
    steps.inspect!.gate = {
      provider: 'plannotator',
      submitOutcome: 'submit',
      approvedOutcome: 'ready',
      rejectedOutcome: 'blocked',
      timeoutMs: 1_000,
      artifactContract: {
        maxChars: 1_000,
        requiredSubstrings: ['# Plan'],
        forbiddenSubstrings: [],
        equalOccurrenceGroups: [],
        onValidationFailure: 'retry',
      },
    };
    steps.inspect!.transitions = {
      ready: 'implement',
      blocked: '$pause',
      retry: 'inspect',
    };
    const retryWorkflow = loadedWorkflow(raw);
    const originalRun = createRun(
      retryWorkflow,
      'request',
      ['read'],
      'run-1',
      1,
    );
    const { calls, fixture } = createGateFixture(originalRun, retryWorkflow);

    await createGateSubmissionAction().submitGate.call(
      fixture as unknown as HarnessActionContext,
      retryWorkflow,
      originalRun,
      'submit',
      'Plan ready',
      'missing plan heading',
    );

    expect(fixture.run).toMatchObject({
      status: 'running',
      currentStepId: 'inspect',
    });
    expect(calls.plannotatorRequests).toBe(0);
    expect(calls.persisted).toBe(1);
  });

  test('fails a Plannotator submission when the provider is unavailable', async () => {
    const workflow = gatedWorkflow('plannotator');
    const originalRun = createRun(workflow, 'request', ['read'], 'run-1', 1);
    const { calls, fixture } = createGateFixture(originalRun, workflow);
    const action = createGateSubmissionAction();

    await expect(
      action.submitGate.call(
        fixture as unknown as HarnessActionContext,
        workflow,
        originalRun,
        'submit',
        'Plan ready',
        '# Plan',
      ),
    ).rejects.toThrow('Plannotator is offline');

    expect(fixture.run).toMatchObject({
      status: 'paused',
      pauseReason: 'Plannotator is offline',
    });
    expect(calls.persisted).toBe(2);
    expect(calls.restoredTools).toBe(2);
    expect(calls.statusUpdates).toBe(2);
  });

  test('rejects a gate request superseded while awaiting its provider', async () => {
    const workflow = gatedWorkflow('plannotator');
    const originalRun = createRun(workflow, 'request', ['read'], 'run-1', 1);
    const { fixture } = createGateFixture(originalRun, workflow);
    fixture.dependencies.requestPlannotatorReview = async () => {
      fixture.sessionEpoch += 1;
      return {
        status: 'handled' as const,
        result: { status: 'pending' as const, reviewId: 'review-1' },
      };
    };

    await expect(
      createGateSubmissionAction().submitGate.call(
        fixture as unknown as HarnessActionContext,
        workflow,
        originalRun,
        'submit',
        'Plan ready',
        '# Plan',
      ),
    ).rejects.toThrow('superseded');
  });

  test('pauses a prompt gate when no interactive UI is available', () => {
    const workflow = gatedWorkflow('prompt');
    const run = awaitingGateRun(workflow);
    const { calls, fixture } = createGateFixture(run, workflow);

    createPromptGateActions().launchPromptReview.call(
      fixture as unknown as HarnessActionContext,
      workflow,
      run,
      { hasUI: false } as ExtensionContext,
    );

    expect(calls.pausedPromptGates).toEqual([
      {
        requestId: 'gate-request',
        reason:
          'Built-in review requires Pi TUI or RPC mode; resume there to continue',
        failed: false,
      },
    ]);
  });

  test('ignores a prompt result superseded by a session change', async () => {
    const workflow = gatedWorkflow('prompt');
    const run = awaitingGateRun(workflow);
    const { fixture } = createGateFixture(run, workflow);
    const active = activeReview();
    fixture.activePromptReview = active;
    fixture.sessionEpoch += 1;

    await createPromptGateActions().finishPromptReview.call(
      fixture as unknown as HarnessActionContext,
      active,
      { status: 'dismissed' },
    );

    expect(fixture.activePromptReview).toBeUndefined();
    expect(fixture.run).toBe(run);
  });

  test('stores a prompt result that finishes while the workflow is paused', async () => {
    const workflow = gatedWorkflow('prompt');
    const run = pauseRun(awaitingGateRun(workflow), 'manual pause', 3);
    const { calls, fixture, notices } = createGateFixture(run, workflow);
    const active = activeReview();
    fixture.activePromptReview = active;

    await createPromptGateActions().finishPromptReview.call(
      fixture as unknown as HarnessActionContext,
      active,
      { status: 'resolved', approved: true, feedback: '' },
    );

    expect(fixture.run?.pendingGate?.resolution).toMatchObject({
      approved: true,
    });
    expect(calls.persisted).toBe(1);
    expect(notices.at(-1)?.message).toContain('finished while paused');
  });

  test('fails a prompt result when its workflow is unavailable', async () => {
    const workflow = gatedWorkflow('prompt');
    const run = awaitingGateRun(workflow);
    const { calls, fixture } = createGateFixture(run, workflow);
    const actions = createPromptGateActions();
    const active = activeReview();
    fixture.activePromptReview = active;
    fixture.catalog.workflows.clear();
    fixture.pausePromptGate = (requestId, reason, failed) => {
      actions.pausePromptGate.call(
        fixture as unknown as HarnessActionContext,
        requestId,
        reason,
        failed,
      );
    };

    await actions.finishPromptReview.call(
      fixture as unknown as HarnessActionContext,
      active,
      { status: 'resolved', approved: true, feedback: '' },
    );

    expect(fixture.run).toMatchObject({
      status: 'paused',
      failedStepId: 'inspect',
    });
    expect(calls.persisted).toBe(1);
  });

  test('fails a prompt result that no longer matches its gated step', async () => {
    const workflow = gatedWorkflow('prompt');
    const run = awaitingGateRun(workflow);
    const { fixture, notices } = createGateFixture(run, workflow);
    const actions = createPromptGateActions();
    const active = activeReview();
    fixture.activePromptReview = active;
    fixture.catalog.workflows.set(
      workflow.definition.id,
      invalidGateWorkflow(workflow),
    );
    fixture.pausePromptGate = (requestId, reason, failed) => {
      actions.pausePromptGate.call(
        fixture as unknown as HarnessActionContext,
        requestId,
        reason,
        failed,
      );
    };

    await actions.finishPromptReview.call(
      fixture as unknown as HarnessActionContext,
      active,
      { status: 'resolved', approved: true, feedback: '' },
    );

    expect(fixture.run?.status).toBe('paused');
    expect(notices.at(-1)?.message).toContain(
      'gated step "inspect" no longer exists',
    );
  });

  test('stores a Plannotator result that arrives while paused', async () => {
    const workflow = gatedWorkflow('plannotator');
    const run = pauseRun(
      awaitingGateRun(workflow, 'review-1'),
      'manual pause',
      4,
    );
    const { calls, fixture, notices } = createGateFixture(run, workflow);

    await createPlannotatorResultActions().handlePlannotatorResult.call(
      fixture as unknown as HarnessActionContext,
      { reviewId: 'review-1', approved: true, feedback: 'looks good' },
    );

    expect(fixture.run?.pendingGate?.resolution).toMatchObject({
      approved: true,
      feedback: 'looks good',
    });
    expect(calls.persisted).toBe(1);
    expect(notices.at(-1)?.message).toContain('finished while paused');
  });

  test('fails a Plannotator result when configuration is unavailable', async () => {
    const workflow = gatedWorkflow('plannotator');
    const run = awaitingGateRun(workflow, 'review-1');
    const { calls, fixture } = createGateFixture(run, workflow);
    fixture.catalog.workflows.clear();

    await createPlannotatorResultActions().handlePlannotatorResult.call(
      fixture as unknown as HarnessActionContext,
      { reviewId: 'review-1', approved: true, feedback: '' },
    );

    expect(fixture.run).toMatchObject({
      status: 'paused',
      failedStepId: 'inspect',
    });
    expect(calls).toMatchObject({
      persisted: 1,
      restoredTools: 1,
      statusUpdates: 1,
    });
  });

  test('fails a Plannotator result that no longer matches its gate', async () => {
    const workflow = gatedWorkflow('plannotator');
    const run = awaitingGateRun(workflow, 'review-1');
    const { calls, fixture } = createGateFixture(run, workflow);
    fixture.catalog.workflows.set(
      workflow.definition.id,
      invalidGateWorkflow(workflow),
    );

    await createPlannotatorResultActions().handlePlannotatorResult.call(
      fixture as unknown as HarnessActionContext,
      { reviewId: 'review-1', approved: true, feedback: '' },
    );

    expect(fixture.run).toMatchObject({
      status: 'paused',
      failedStepId: 'inspect',
      pauseReason: expect.stringContaining(
        'gated step "inspect" no longer exists',
      ),
    });
    expect(calls).toMatchObject({
      persisted: 1,
      restoredTools: 1,
      statusUpdates: 1,
    });
  });
});
