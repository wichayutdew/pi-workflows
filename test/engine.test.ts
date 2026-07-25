import { describe, expect, test } from 'bun:test';
import { createRun, isWorkflowRun } from '../src/engine/state.ts';
import {
  advanceRun,
  abortRun,
  attachGateReviewId,
  beginGate,
  failGate,
  pauseRun,
  reconcileRun,
  resolveGate,
  resumeRun,
  storeGateResolution,
} from '../src/engine/transitions.ts';
import { buildDelegatedStepTask } from '../src/prompt.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';

describe('when testing engine', () => {
  describe('should satisfy its behavioral contract', () => {
    test('advances through configured steps and completes', () => {
      // given
      const workflow = loadedWorkflow();
      let run = createRun(workflow, 'request', ['read', 'edit'], 'run-1', 1);
      // when
      run = advanceRun(workflow, run, 'ready', 'inspection complete', 2);
      // then
      expect(run.status).toBe('running');
      expect(run.currentStepId).toBe('implement');
      expect(run.history.length).toBe(1);

      run = advanceRun(workflow, run, 'done', 'implemented', 3);
      expect(run.status).toBe('completed');
      expect(run.history.length).toBe(2);
    });

    test('pause target checkpoints the same step and resumes it', () => {
      // given
      const workflow = loadedWorkflow();
      let run = createRun(workflow, '', ['read'], 'run-2', 1);
      // when
      run = advanceRun(workflow, run, 'blocked', 'fix configuration', 2);
      // then
      expect(run.status).toBe('paused');
      expect(run.currentStepId).toBe('inspect');
      expect(run.history.length).toBe(0);
      expect(resumeRun(run, 3).status).toBe('running');
    });

    test('paused attempts preserve the incoming step handoff for resume', () => {
      // given
      const raw = baseWorkflow();
      const steps = raw.steps as Record<string, Record<string, unknown>>;
      steps.implement = {
        ...steps.implement,
        prompt: 'Implement {{last.summary}}',
        transitions: {
          done: '$done',
          blocked: '$pause',
        },
      };
      const workflow = loadedWorkflow(raw);
      let run = createRun(workflow, '', ['read'], 'run-handoff', 1);
      // when
      run = advanceRun(
        workflow,
        run,
        'ready',
        'Approved implementation contract',
        2,
      );
      // then
      expect(run.reviewedArtifact).toBe('');
      run = advanceRun(
        workflow,
        run,
        'blocked',
        'Tooling failed after partial work',
        3,
      );

      expect(run.stepHandoff).toBe('Approved implementation contract');
      expect(run.lastSummary).toBe('Tooling failed after partial work');
      const resumed = resumeRun(run, 4);
      const task = buildDelegatedStepTask(workflow, resumed, 'policy');
      expect(task).toMatch(
        /Incoming approved or previous-step handoff:\nApproved implementation contract/,
      );
      expect(task).toMatch(
        /Latest paused attempt:\nTooling failed after partial work/,
      );
    });

    test('manual pause preserves an in-flight gate', () => {
      // given
      const raw = baseWorkflow();
      raw.steps = {
        plan: {
          prompt: 'Plan',
          permissions: {
            extensions: ['plannotator'],
          },
          requires: {
            extensions: ['plannotator'],
          },
          gate: {
            provider: 'plannotator',
            submitOutcome: 'submit',
            approvedOutcome: 'approved',
            rejectedOutcome: 'rejected',
          },
          transitions: {
            approved: '$done',
            rejected: 'plan',
          },
        },
      };
      raw.start = 'plan';
      const workflow = loadedWorkflow(raw);
      let run = createRun(workflow, '', [], 'run-3', 1);
      run = beginGate(workflow, run, 'submit', '# Plan', 'request-1', 2);
      // when
      run = pauseRun(run, 'repair integration', 3);
      // then
      expect(run.status).toBe('paused');
      expect(run.pausedFrom).toBe('awaiting-gate');
      expect(run.pendingGate?.artifact).toBe('# Plan');
      expect(resumeRun({ ...run, pausedFrom: undefined }, 4).status).toBe(
        'awaiting-gate',
      );
    });

    test('gate rejection follows its configured transition with feedback', () => {
      // given
      const raw = baseWorkflow();
      raw.steps = {
        plan: {
          prompt: 'Plan {{gate.feedback}}',
          permissions: {
            extensions: ['plannotator'],
          },
          requires: {
            extensions: ['plannotator'],
          },
          gate: {
            provider: 'plannotator',
            submitOutcome: 'submit',
            approvedOutcome: 'approved',
            rejectedOutcome: 'rejected',
          },
          transitions: {
            approved: '$done',
            rejected: 'plan',
          },
        },
      };
      raw.start = 'plan';
      const workflow = loadedWorkflow(raw);
      let run = createRun(workflow, '', [], 'run-4', 1);
      run = beginGate(workflow, run, 'submit', '# Plan', 'request-2', 2);
      run.pendingGate!.summary = 'Unreviewed child summary';
      // when
      run = resolveGate(
        workflow,
        run,
        { approved: false, feedback: 'Add rollback', resolvedAt: 3 },
        3,
      );
      // then
      expect(run.status).toBe('running');
      expect(run.currentStepId).toBe('plan');
      expect(run.gateFeedback).toBe('Add rollback');
    });

    test('gate approval uses the reviewed artifact as the delegated step handoff', () => {
      // given
      const raw = baseWorkflow();
      raw.steps = {
        plan: {
          prompt: 'Plan',
          permissions: {
            extensions: ['plannotator'],
          },
          requires: {
            extensions: ['plannotator'],
          },
          gate: {
            provider: 'plannotator',
            submitOutcome: 'submit',
            approvedOutcome: 'approved',
            rejectedOutcome: 'rejected',
          },
          transitions: {
            approved: '$done',
            rejected: 'plan',
          },
        },
      };
      raw.start = 'plan';
      const workflow = loadedWorkflow(raw);
      let run = createRun(workflow, '', [], 'run-gate-handoff', 1);
      run = beginGate(workflow, run, 'submit', '# Plan', 'request-handoff', 2);
      // when
      run = resolveGate(
        workflow,
        run,
        { approved: true, feedback: '', resolvedAt: 3 },
        3,
      );
      // then
      expect(run.status).toBe('completed');
      expect(run.lastSummary).toBe('# Plan');
      expect(run.stepHandoff).toBe('# Plan');
      expect(run.reviewedArtifact).toBe('# Plan');
      expect(run.history.at(-1)?.summary).toBe('# Plan');
    });

    test('configuration rewind never promotes legacy gate summaries to reviewed artifacts', () => {
      // given
      const raw = baseWorkflow();
      raw.steps = {
        plan: {
          prompt: 'Plan',
          permissions: {
            extensions: ['plannotator'],
          },
          requires: {
            extensions: ['plannotator'],
          },
          gate: {
            provider: 'plannotator',
            submitOutcome: 'submit',
            approvedOutcome: 'approved',
            rejectedOutcome: 'rejected',
          },
          transitions: {
            approved: 'implement',
            rejected: 'plan',
          },
        },
        implement: {
          prompt: 'Implement',
          transitions: {
            done: '$done',
          },
        },
      };
      raw.start = 'plan';
      const original = loadedWorkflow(raw);
      const artifact =
        '{"repositories":[{"worker":[{"command":"npm publish"}]}]}';
      let run = createRun(original, '', [], 'run-legacy-rewind', 1);
      run = beginGate(original, run, 'submit', artifact, 'request-rewind', 2);
      run = resolveGate(
        original,
        run,
        { approved: true, feedback: '', resolvedAt: 3 },
        3,
      );
      run = advanceRun(original, run, 'done', 'implemented', 4);

      const changedRaw = structuredClone(raw);
      const changedSteps = changedRaw.steps as Record<
        string,
        Record<string, unknown>
      >;
      changedSteps.implement = {
        ...changedSteps.implement,
        prompt: 'Changed implementation',
      };
      // when
      const changed = loadedWorkflow(changedRaw);

      // then
      expect(reconcileRun(run, changed, 5).run?.reviewedArtifact).toBe(
        artifact,
      );
      const legacyRun = { ...run };
      delete legacyRun.reviewedArtifact;
      expect(reconcileRun(legacyRun, changed, 5).run?.reviewedArtifact).toBe(
        '',
      );
    });

    test('configuration changes restart the earliest changed completed step', () => {
      // given
      const original = loadedWorkflow();
      let run = createRun(original, '', ['read'], 'run-5', 1);
      run = advanceRun(original, run, 'ready', 'done', 2);

      const changedRaw = baseWorkflow();
      const steps = changedRaw.steps as Record<string, Record<string, unknown>>;
      steps.inspect = { ...steps.inspect, prompt: 'Changed inspection prompt' };
      const changed = loadedWorkflow(changedRaw);
      // when
      const result = reconcileRun(run, changed, 3);
      // then
      expect(result.changed).toBe(true);
      expect(result.restartedStep).toBe('inspect');
      expect(result.run?.currentStepId).toBe('inspect');
      expect(result.run?.history.length).toBe(0);
      expect(result.run?.status).toBe('paused');
    });

    test('pauses a looping workflow after its maximum step visits', () => {
      // given
      const raw = baseWorkflow();
      raw.maxStepVisits = 1;
      const steps = raw.steps as Record<string, Record<string, unknown>>;
      steps.implement = {
        ...steps.implement,
        transitions: { retry: 'implement' },
      };
      const workflow = loadedWorkflow(raw);
      let run = createRun(workflow, '', [], 'visit-limit', 1);
      run = advanceRun(workflow, run, 'ready', 'ready', 2);

      // when
      run = advanceRun(workflow, run, 'retry', 'retry', 3);

      // then
      expect(run.status).toBe('paused');
      expect(run.pauseReason).toMatch(/exceeded maxStepVisits/);
    });

    test('reports every incompatible configuration reconciliation', () => {
      // given
      const original = loadedWorkflow();
      const initial = createRun(original, '', [], 'reconcile-errors', 1);
      const changedRaw = baseWorkflow();
      const changedSteps = changedRaw.steps as Record<
        string,
        Record<string, unknown>
      >;
      changedSteps.inspect = {
        ...changedSteps.inspect,
        prompt: 'Changed current step',
      };
      const changed = loadedWorkflow(changedRaw);

      // when
      const currentChanged = reconcileRun(initial, changed, 2);
      const wrongWorkflow = reconcileRun(
        { ...initial, workflowId: 'other' },
        changed,
        2,
      );
      const currentRemovedRaw = baseWorkflow();
      currentRemovedRaw.start = 'implement';
      currentRemovedRaw.steps = {
        implement: (
          currentRemovedRaw.steps as Record<string, Record<string, unknown>>
        ).implement,
      };
      const currentRemoved = reconcileRun(
        initial,
        loadedWorkflow(currentRemovedRaw),
        2,
      );
      const afterInspect = advanceRun(
        original,
        initial,
        'ready',
        'inspected',
        2,
      );
      const historyRemoved = reconcileRun(
        afterInspect,
        loadedWorkflow(currentRemovedRaw),
        3,
      );

      // then
      expect(currentChanged.restartedStep).toBe('inspect');
      expect(currentChanged.run?.status).toBe('paused');
      expect(reconcileRun(initial, original, 2)).toEqual({
        run: initial,
        changed: false,
      });
      expect(wrongWorkflow.error).toMatch(/run belongs to/);
      expect(currentRemoved.error).toMatch(
        /current step "inspect" was removed/,
      );
      expect(historyRemoved.error).toMatch(/completed step was removed/);
    });

    test('transition helpers reject invalid state and preserve gate lifecycle details', () => {
      // given
      const raw = baseWorkflow();
      raw.steps = {
        plan: {
          prompt: 'Plan',
          permissions: { extensions: ['plannotator'] },
          requires: { extensions: ['plannotator'] },
          gate: {
            provider: 'plannotator',
            submitOutcome: 'submit',
            approvedOutcome: 'approved',
            rejectedOutcome: 'rejected',
          },
          transitions: { approved: '$done', rejected: 'plan' },
        },
      };
      raw.start = 'plan';
      const workflow = loadedWorkflow(raw);
      // when
      const run = createRun(workflow, '', [], 'run-errors', 1);

      // then
      expect(resumeRun(run, 2)).toBe(run);
      expect(pauseRun({ ...run, status: 'completed' }, '', 2).pauseReason).toBe(
        undefined,
      );
      expect(abortRun(run, '', 2).status).toBe('aborted');
      expect(() =>
        advanceRun(
          workflow,
          { ...run, status: 'paused', pausedFrom: 'running' },
          'approved',
          '',
          2,
        ),
      ).toThrow(/only a running workflow/);
      expect(() =>
        advanceRun(
          workflow,
          { ...run, currentStepId: 'missing' },
          'approved',
          '',
          2,
        ),
      ).toThrow(/no longer exists/);
      expect(() => advanceRun(workflow, run, 'submit', '', 2)).toThrow(
        /configured gate/,
      );
      expect(() => advanceRun(workflow, run, 'unknown', '', 2)).toThrow(
        /not valid/,
      );
      expect(() =>
        beginGate(workflow, run, 'approved', '# Plan', 'request-1', 2),
      ).toThrow(/expects outcome/);
      expect(() =>
        beginGate(workflow, run, 'submit', ' ', 'request-1', 2),
      ).toThrow(/non-empty artifact/);
      expect(() => beginGate(workflow, run, 'submit', '# Plan', '', 2)).toThrow(
        /request id/,
      );
      expect(() =>
        beginGate(
          workflow,
          { ...run, status: 'completed' },
          'submit',
          '# Plan',
          'request-1',
          2,
        ),
      ).toThrow(/requires a running workflow/);
      expect(() => attachGateReviewId(run, 'review-1', 2)).toThrow(
        /no pending gate/,
      );
      expect(() =>
        resolveGate(
          workflow,
          run,
          { approved: true, feedback: '', resolvedAt: 2 },
          2,
        ),
      ).toThrow(/no pending gate/);

      const pending = beginGate(
        workflow,
        run,
        'submit',
        '# Plan',
        'request-1',
        2,
      );
      expect(
        attachGateReviewId(pending, 'review-1', 3).pendingGate?.reviewId,
      ).toBe('review-1');
      expect(() =>
        attachGateReviewId(
          {
            ...pending,
            pendingGate: { ...pending.pendingGate!, provider: 'prompt' },
          },
          'review-1',
          3,
        ),
      ).toThrow(/only a Plannotator gate/);
      expect(
        storeGateResolution(
          run,
          { approved: true, feedback: '', resolvedAt: 3 },
          3,
        ),
      ).toBe(run);
      expect(
        storeGateResolution(
          pending,
          { approved: true, feedback: '', resolvedAt: 3 },
          3,
        ).pendingGate?.resolution?.approved,
      ).toBe(true);
      expect(failGate(run, 'ignored', 3)).toBe(run);
      expect(failGate(pending, 'offline', 3).gateFeedback).toBe('offline');
      expect(() =>
        resolveGate(
          workflow,
          { ...pending, currentStepId: 'other' },
          { approved: true, feedback: '', resolvedAt: 3 },
          3,
        ),
      ).toThrow(/does not match/);
    });

    test('persisted state validator rejects malformed history and gates', () => {
      // given
      const workflow = loadedWorkflow();
      // when
      const run = createRun(workflow, '', ['read'], 'run-6', 1);
      // then
      expect(isWorkflowRun(run)).toBe(true);
      const legacyRun = { ...run };
      delete legacyRun.stepHandoff;
      delete legacyRun.reviewedArtifact;
      expect(isWorkflowRun(legacyRun)).toBe(true);
      expect(isWorkflowRun({ ...run, stepHandoff: 42 })).toBe(false);
      expect(isWorkflowRun({ ...run, reviewedArtifact: 42 })).toBe(false);
      expect(isWorkflowRun({ ...run, history: [{}] })).toBe(false);
      expect(
        isWorkflowRun({
          ...run,
          pendingGate: {
            provider: 'plannotator',
            requestId: 'request-3',
            stepId: 'inspect',
          },
        }),
      ).toBe(false);
      expect(
        isWorkflowRun({
          ...run,
          status: 'paused',
          pausedFrom: 'awaiting-gate',
          pendingGate: {
            provider: 'plannotator',
            requestId: 'request-4',
            stepId: 'inspect',
            artifact: '# Plan',
            submittedOutcome: 'submit',
            requestedAt: 2,
            reviewId: 'review-1',
            resolution: null,
          },
        }),
      ).toBe(false);
      expect(isWorkflowRun({ ...run, pausedFrom: 'anything' })).toBe(false);
      expect(isWorkflowRun({ ...run, status: 'awaiting-gate' })).toBe(false);
      expect(() => isWorkflowRun({ ...run, pendingGate: null })).not.toThrow();
      expect(isWorkflowRun({ ...run, pendingGate: null })).toBe(false);
      expect(isWorkflowRun({ ...run, pendingGate: 42 })).toBe(false);
      const gatedRaw = baseWorkflow();
      gatedRaw.steps = {
        inspect: {
          prompt: 'Inspect',
          gate: {
            submitOutcome: 'submit',
            approvedOutcome: 'approved',
            rejectedOutcome: 'rejected',
          },
          transitions: {
            approved: '$done',
            rejected: 'inspect',
          },
        },
      };
      const gatedWorkflow = loadedWorkflow(gatedRaw);
      const awaiting = beginGate(
        gatedWorkflow,
        createRun(gatedWorkflow, '', [], 'valid-gate', 1),
        'submit',
        'artifact',
        'request-valid',
        2,
      );
      expect(isWorkflowRun(awaiting)).toBe(true);
    });
  });
});
