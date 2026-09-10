import { describe, expect, test } from 'bun:test';
import { createRun } from '../../src/domain/index.ts';
import { createGateSubmissionAction } from '../../src/infrastructure/harness/gate-submission-action.ts';
import { baseWorkflow, loadedWorkflow } from '../helpers.ts';

describe('when submitting a gate', () => {
  test('opens a Plannotator review after accepting its structural contract', async () => {
    const raw = {
      ...baseWorkflow(),
      steps: {
        ...(baseWorkflow().steps as Record<string, unknown>),
        inspect: {
          ...((baseWorkflow().steps as Record<string, Record<string, unknown>>)
            .inspect!),
          gate: {
            timeoutMs: 1_000,
            artifactContract: {
              maxChars: 1_000,
              requiredHeadings: [
                { level: 1, title: 'Plan', guidance: 'Describe the work.' },
              ],
            },
          },
          transitions: { ready: '$done', handoff: 'inspect' },
        },
      },
    };
    const workflow = loadedWorkflow(raw);
    const run = createRun(workflow, 'request', [], 'run-1', 1);
    let currentRun = run;
    let requestedArtifact = '';
    const context = {
      dependencies: {
        createRequestId: () => 'request-1',
        now: () => 1,
        requestPlannotatorReview: async (
          _events: unknown,
          _requestId: string,
          artifact: string,
        ) => {
          requestedArtifact = artifact;
          return { status: 'handled' as const, result: { reviewId: 'review-1' } };
        },
      },
      isSessionActive: true,
      latestContext: { ui: { notify: () => {} } },
      persist: () => {},
      pi: { events: {} },
      restoreBaselineTools: () => {},
      run,
      sessionEpoch: 1,
      settleAfterTransition: () => {},
      updateStatus: () => {},
    };

    await createGateSubmissionAction().submitGate.call(
      context as never,
      workflow,
      run,
      'ready',
      'Plan ready',
      '# Plan\nImplement it.',
    );

    expect(requestedArtifact).toBe('# Plan\nImplement it.');
    expect(currentRun).toBe(run);
  });
});
