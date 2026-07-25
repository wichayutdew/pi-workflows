import { describe, expect, test } from 'bun:test';
import {
  captureResumeCheckpoint,
  matchesResumeCheckpoint,
} from '../src/engine/resume.ts';
import { pauseRun } from '../src/engine/transitions.ts';
import { createRun, type WorkflowRun } from '../src/engine/state.ts';
import { loadedWorkflow } from './helpers.ts';

describe('when testing resume', () => {
  function pausedRun(): WorkflowRun {
    return pauseRun(
      createRun(loadedWorkflow(), 'request', ['read'], 'run-1', 1),
      'inspect',
      2,
    );
  }

  describe('should satisfy its behavioral contract', () => {
    test('resume checkpoints reject a session switch or state transition', () => {
      // given
      const run = pausedRun();
      // when
      const checkpoint = captureResumeCheckpoint(run, 4);
      // then
      expect(matchesResumeCheckpoint(run, 4, checkpoint)).toBe(true);
      expect(matchesResumeCheckpoint(run, 5, checkpoint)).toBe(false);
      expect(
        matchesResumeCheckpoint({ ...run, status: 'aborted' }, 4, checkpoint),
      ).toBe(false);
    });

    test('resume checkpoints allow an update to the same paused gate', () => {
      // given
      const run: WorkflowRun = {
        ...pausedRun(),
        pausedFrom: 'awaiting-gate',
        pendingGate: {
          provider: 'plannotator',
          requestId: 'request-1',
          stepId: 'inspect',
          artifact: '# Plan',
          submittedOutcome: 'submit',
          requestedAt: 3,
          reviewId: 'review-1',
        },
      };
      const checkpoint = captureResumeCheckpoint(run, 4);
      // when
      const withResolution: WorkflowRun = {
        ...run,
        pendingGate: {
          ...run.pendingGate!,
          resolution: {
            approved: true,
            feedback: 'Approved',
            resolvedAt: 5,
          },
        },
      };
      // then
      expect(matchesResumeCheckpoint(withResolution, 4, checkpoint)).toBe(true);
    });
  });
});
