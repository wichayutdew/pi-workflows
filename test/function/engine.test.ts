import { describe, expect, test } from 'bun:test';
import {
  createRun,
  isWorkflowRun,
  MAX_GATE_FEEDBACK_CHARS,
  MAX_RESUME_INPUT_CHARS,
} from '../../src/domain/index.ts';
import {
  beginMainStepAttempt,
  recordCurrentStepUsage,
  usageAggregateFromModels,
} from '../../src/function/engine/step-trace.ts';
import {
  addUsage,
  normalizeUsage,
  isUsageAggregate,
  type UsageTotals,
} from '../../src/function/engine/usage.ts';
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
  setResumeInput,
  storeGateResolution,
} from '../../src/function/engine/index.ts';
import { buildDelegatedStepTask } from '../../src/function/prompt/index.ts';
import { baseWorkflow, loadedWorkflow } from '../helpers.ts';

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

    test('resume guidance is replaced per resume and consumed by a step result', () => {
      const workflow = loadedWorkflow();
      const initial = createRun(workflow, '', ['read'], 'guided-resume', 1);
      const paused = pauseRun(initial, 'repair the failure', 2);
      const guided = setResumeInput(
        paused,
        '  Use the already-created cache before retrying.  ',
        3,
      );

      expect(guided.resumeInput).toBe(
        'Use the already-created cache before retrying.',
      );
      const resumed = resumeRun(guided, 4);
      expect(resumed.resumeInput).toBe(guided.resumeInput);
      expect(
        advanceRun(workflow, resumed, 'ready', 'Recovered', 5).resumeInput,
      ).toBeUndefined();
      expect(setResumeInput(paused, '', 6).resumeInput).toBeUndefined();
    });

    test('same-step handoff preserves confirmed checkpoint context', () => {
      const raw = baseWorkflow();
      const steps = raw.steps as Record<string, Record<string, unknown>>;
      steps.inspect!.transitions = { handoff: 'inspect' };
      const workflow = loadedWorkflow(raw);
      const run = advanceRun(
        workflow,
        {
          ...createRun(workflow, 'request', [], 'run-handoff-history', 1),
          stepHandoff: '# Checkpoint: feature one committed',
          lastSummary: '# Checkpoint: feature one committed',
        },
        'handoff',
        '# Handoff: worker settled without a result',
        2,
      );

      expect(run.stepHandoff).toContain('# Checkpoint: feature one committed');
      expect(run.stepHandoff).toContain(
        '# Handoff: worker settled without a result',
      );
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
        /Incoming previous-step handoff:\nApproved implementation contract/,
      );
      expect(task).toMatch(
        /Latest current-step summary:\nTooling failed after partial work/,
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
      run = beginGate(
        workflow,
        run,
        'submit',
        '# Plan',
        'request-1',
        2,
        'Plan ready',
      );
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
          prompt:
            'Rejected artifact:\n{{gate.artifact}}\nFeedback:\n{{gate.feedback}}',
          agent: 'planner',
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
      run = beginGate(
        workflow,
        run,
        'submit',
        '# Plan',
        'request-2',
        2,
        'Unreviewed child summary',
      );
      // when
      const feedback = `# Plan Feedback\n\n${'x'.repeat(
        MAX_GATE_FEEDBACK_CHARS + 100,
      )}`;
      run = resolveGate(
        workflow,
        run,
        { approved: false, feedback, resolvedAt: 3 },
        3,
      );
      // then
      expect(run.status).toBe('running');
      expect(run.currentStepId).toBe('plan');
      expect(run.gateArtifact).toBe('# Plan');
      expect(run.gateFeedback).toHaveLength(MAX_GATE_FEEDBACK_CHARS);
      expect(run.gateFeedback).toEndWith(
        '… [gate feedback truncated by Pi Workflows]',
      );
      expect(run.lastSummary.length).toBeLessThanOrEqual(500);
      expect(run.lastSummary).toStartWith('Gate rejected: # Plan Feedback');
      expect(isWorkflowRun(run)).toBe(true);
    });

    test('same-step gate feedback can iterate until the user approves', () => {
      // given
      const raw = baseWorkflow();
      raw.maxStepVisits = 1;
      raw.steps = {
        prepare: {
          prompt: 'Prepare',
          transitions: {
            ready: 'plan',
          },
        },
        plan: {
          prompt:
            'Handoff:\n{{last.summary}}\nRejected artifact:\n{{gate.artifact}}\nFeedback:\n{{gate.feedback}}',
          agent: 'planner',
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
            rejectedOutcome: 'changes-requested',
          },
          transitions: {
            approved: '$done',
            'changes-requested': 'plan',
            retry: 'plan',
          },
        },
      };
      raw.start = 'prepare';
      const workflow = loadedWorkflow(raw);
      let run = createRun(workflow, '', [], 'iterative-gate', 1);
      let now = 2;
      run = advanceRun(
        workflow,
        run,
        'ready',
        'Bound worktree: /tmp/run-worktree',
        now,
      );

      // when
      for (const [round, feedback] of [
        [1, 'Clarify rollback'],
        [2, 'Add the exact validation command'],
      ] as const) {
        run = beginGate(
          workflow,
          run,
          'submit',
          `# Plan v${round}`,
          `request-${round}`,
          ++now,
          `Plan v${round} ready`,
        );
        run = resolveGate(
          workflow,
          run,
          { approved: false, feedback, resolvedAt: ++now },
          now,
        );

        expect(run.status).toBe('running');
        expect(run.currentStepId).toBe('plan');
        expect(run.stepHandoff).toBe('Bound worktree: /tmp/run-worktree');
        expect(run.gateArtifact).toBe(`# Plan v${round}`);
        expect(run.gateFeedback).toBe(feedback);
        const revisionTask = buildDelegatedStepTask(workflow, run, 'policy');
        expect(revisionTask).toMatch(
          /Incoming previous-step handoff:\nBound worktree: \/tmp\/run-worktree/,
        );
        expect(revisionTask).toContain(
          `Latest current-step summary:\nGate rejected: ${feedback}`,
        );
        expect(revisionTask).toContain(`Rejected artifact:\n# Plan v${round}`);
        expect(revisionTask).toContain(`Feedback:\n${feedback}`);

        if (round === 1) {
          run = advanceRun(
            workflow,
            run,
            'retry',
            'Transient planning dependency failed',
            ++now,
          );
          expect(run.status).toBe('paused');
          expect(run.pauseReason).toMatch(/exceeded maxStepVisits/);
          expect(run.stepHandoff).toBe('Bound worktree: /tmp/run-worktree');
          expect(run.gateArtifact).toBe('# Plan v1');
          expect(run.gateFeedback).toBe(feedback);
          run = resumeRun(run, ++now);
          const retryTask = buildDelegatedStepTask(workflow, run, 'policy');
          expect(retryTask).toContain(
            'Incoming previous-step handoff:\nBound worktree: /tmp/run-worktree',
          );
          expect(retryTask).toContain('Rejected artifact:\n# Plan v1');
          expect(retryTask).toContain(`Feedback:\n${feedback}`);
        }
      }
      run = beginGate(
        workflow,
        run,
        'submit',
        '# Plan v3',
        'request-3',
        ++now,
        'Plan v3 ready',
      );
      run = resolveGate(
        workflow,
        run,
        { approved: true, feedback: 'Approved', resolvedAt: ++now },
        now,
      );

      // then
      expect(run.status).toBe('completed');
      expect(run.visits.plan).toBe(4);
      expect(run.history.slice(-3).map((entry) => entry.outcome)).toEqual([
        'retry',
        'changes-requested',
        'approved',
      ]);
      expect(run.reviewedArtifact).toBe('# Plan v3');
      expect(run.gateArtifact).toBe('');
    });

    test('gate approval preserves summary and opaque artifact separately', () => {
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
      run = beginGate(
        workflow,
        run,
        'submit',
        '# Plan',
        'request-handoff',
        2,
        'Plan is ready for implementation',
      );
      // when
      run = resolveGate(
        workflow,
        run,
        { approved: true, feedback: 'Ship it', resolvedAt: 3 },
        3,
      );
      // then
      expect(run.status).toBe('completed');
      expect(run.lastSummary).toBe('Plan is ready for implementation');
      expect(run.stepHandoff).toBe('Plan is ready for implementation');
      expect(run.reviewedArtifact).toBe('# Plan');
      expect(run.reviewedFeedback).toBe('Ship it');
      expect(run.gateFeedback).toBe('');
      expect(run.history.at(-1)?.summary).toBe(
        'Plan is ready for implementation',
      );
      expect(run.history.at(-1)?.artifact).toBe('# Plan');
      expect(run.history.at(-1)?.approval).toEqual({
        requestId: 'request-handoff',
        artifact: '# Plan',
        feedback: 'Ship it',
        stepStructuralDigest: workflow.stepStructuralDigests.plan!,
      });
      expect(isWorkflowRun(run)).toBe(true);
      const approvedEntry = run.history.at(-1);
      if (!approvedEntry?.approval)
        throw new Error('approval was not recorded');
      expect(
        isWorkflowRun({
          ...run,
          history: [
            {
              ...approvedEntry,
              approval: {
                ...approvedEntry.approval,
                artifact: '# Different plan',
              },
            },
          ],
        }),
      ).toBe(false);
      expect(
        isWorkflowRun({
          ...run,
          history: [
            {
              ...approvedEntry,
              approval: {
                ...approvedEntry.approval,
                stepStructuralDigest: '',
              },
            },
          ],
        }),
      ).toBe(false);
    });

    test('gate approval to $pause remains a valid incomplete checkpoint', () => {
      const raw = baseWorkflow();
      raw.start = 'plan';
      raw.steps = {
        plan: {
          prompt: 'Plan',
          gate: {
            provider: 'prompt',
            submitOutcome: 'submit',
            approvedOutcome: 'approved',
            rejectedOutcome: 'rejected',
          },
          transitions: {
            approved: '$pause',
            rejected: '$pause',
            finish: '$done',
          },
        },
      };
      const workflow = loadedWorkflow(raw);
      let run = createRun(workflow, '', [], 'paused-approval', 1);
      run = beginGate(
        workflow,
        run,
        'submit',
        '# Approved but incomplete plan',
        'paused-approval-request',
        2,
        'Approval requires a later resume',
      );

      run = resolveGate(
        workflow,
        run,
        { approved: true, feedback: 'Approved', resolvedAt: 3 },
        3,
      );

      expect(run.status).toBe('paused');
      expect(run.currentStepId).toBe('plan');
      expect(run.history).toEqual([]);
      expect(run.reviewedArtifact).toBe('');
      expect(run.reviewedFeedback).toBe('');
      expect(isWorkflowRun(run)).toBe(true);
      expect(reconcileRun(run, workflow, 4)).toEqual({
        run,
        changed: false,
      });
    });

    test('revisiting a gate keeps the starting cwd and treats artifacts as opaque', () => {
      const raw = baseWorkflow();
      raw.start = 'plan';
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
          transitions: {
            approved: 'implement',
            rejected: 'plan',
          },
        },
        implement: {
          prompt: 'Implement',
          transitions: {
            revise: 'plan',
            done: '$done',
          },
        },
      };
      const workflow = loadedWorkflow(raw);
      const artifact = 'user-defined artifact: repository=/somewhere-else';
      let run = createRun(
        workflow,
        '',
        [],
        'run-revisit',
        1,
        '/tmp/existing-worktree',
      );
      run = beginGate(
        workflow,
        run,
        'submit',
        artifact,
        'request-first-review',
        2,
        'First review summary',
      );
      run = resolveGate(
        workflow,
        run,
        { approved: true, feedback: '', resolvedAt: 3 },
        3,
      );
      expect(run.reviewedArtifact).toBe(artifact);
      expect(run.stepHandoff).toBe('First review summary');

      run = advanceRun(
        workflow,
        run,
        'revise',
        'Revise the user-defined artifact',
        4,
      );

      expect(run.currentStepId).toBe('plan');
      expect(run.reviewedArtifact).toBe(artifact);
      expect(run.cwd).toBe('/tmp/existing-worktree');
      expect(run.stepHandoff).toBe('Revise the user-defined artifact');

      run = beginGate(
        workflow,
        run,
        'submit',
        'a completely different user-defined format',
        'request-second-review',
        5,
        'Second review summary',
      );
      expect(run.pendingGate?.artifact).toBe(
        'a completely different user-defined format',
      );
      expect(run.cwd).toBe('/tmp/existing-worktree');
    });

    test('configuration rewind retains only authoritative reviewed artifacts', () => {
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
      const artifact = 'opaque user-defined review artifact';
      let run = createRun(original, '', [], 'run-legacy-rewind', 1);
      run = beginGate(
        original,
        run,
        'submit',
        artifact,
        'request-rewind',
        2,
        'Review complete',
      );
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
    });

    test('configuration rewind retains or clears the reviewed approval pair together', () => {
      // given
      const raw = baseWorkflow();
      raw.start = 'plan';
      raw.steps = {
        plan: {
          prompt: 'Plan',
          gate: {
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
      const original = loadedWorkflow(raw);
      const artifact = 'opaque approved artifact';
      const feedback = 'Preserve this approval feedback';
      let run = createRun(original, '', [], 'approval-pair-rewind', 1);
      run = beginGate(
        original,
        run,
        'submit',
        artifact,
        'approval-pair-review',
        2,
        'Plan ready',
      );
      run = resolveGate(
        original,
        run,
        { approved: true, feedback, resolvedAt: 3 },
        3,
      );
      run = advanceRun(original, run, 'done', 'Implemented', 4);

      const retainedRaw = structuredClone(raw);
      const retainedSteps = retainedRaw.steps as Record<
        string,
        Record<string, unknown>
      >;
      retainedSteps.implement = {
        ...retainedSteps.implement,
        prompt: 'Changed implementation',
      };

      const invalidatedRaw = structuredClone(raw);
      const invalidatedSteps = invalidatedRaw.steps as Record<
        string,
        Record<string, unknown>
      >;
      invalidatedSteps.plan = {
        ...invalidatedSteps.plan,
        gate: {
          submitOutcome: 'submit',
          approvedOutcome: 'accepted',
          rejectedOutcome: 'rejected',
        },
        transitions: {
          accepted: 'implement',
          rejected: 'plan',
        },
      };

      // when
      const retained = reconcileRun(run, loadedWorkflow(retainedRaw), 5);
      const invalidated = reconcileRun(run, loadedWorkflow(invalidatedRaw), 5);

      // then
      expect(retained.run?.reviewedArtifact).toBe(artifact);
      expect(retained.run?.reviewedFeedback).toBe(feedback);
      expect(invalidated.run?.reviewedArtifact).toBe('');
      expect(invalidated.run?.reviewedFeedback).toBe('');
    });

    test('configuration rewind restores feedback from the retained approval when artifacts are identical', () => {
      // given
      const raw = baseWorkflow();
      raw.start = 'gate-a';
      raw.steps = {
        'gate-a': {
          prompt: 'First gate',
          gate: {
            submitOutcome: 'submit',
            approvedOutcome: 'approved',
            rejectedOutcome: 'rejected',
          },
          transitions: {
            approved: 'middle',
            rejected: '$pause',
          },
        },
        middle: {
          prompt: 'Middle',
          transitions: {
            done: 'gate-b',
          },
        },
        'gate-b': {
          prompt: 'Second gate',
          gate: {
            submitOutcome: 'submit',
            approvedOutcome: 'approved',
            rejectedOutcome: 'rejected',
          },
          transitions: {
            approved: 'implement',
            rejected: '$pause',
          },
        },
        implement: {
          prompt: 'Implement',
          transitions: {
            done: '$done',
          },
        },
      };
      const original = loadedWorkflow(raw);
      const artifact = 'identical approved artifact';
      let run = createRun(original, '', [], 'identical-approval-pairs', 1);
      run = beginGate(
        original,
        run,
        'submit',
        artifact,
        'first-review',
        2,
        'First gate ready',
      );
      run = resolveGate(
        original,
        run,
        { approved: true, feedback: 'first feedback', resolvedAt: 3 },
        3,
      );
      run = advanceRun(original, run, 'done', 'Middle complete', 4);
      run = beginGate(
        original,
        run,
        'submit',
        artifact,
        'second-review',
        5,
        'Second gate ready',
      );
      run = resolveGate(
        original,
        run,
        { approved: true, feedback: 'second feedback', resolvedAt: 6 },
        6,
      );
      expect(
        run.history
          .filter((entry) => entry.approval)
          .map((entry) => entry.approval?.requestId),
      ).toEqual(['first-review', 'second-review']);

      const changedRaw = structuredClone(raw);
      const changedSteps = changedRaw.steps as Record<
        string,
        Record<string, unknown>
      >;
      changedSteps.middle = {
        ...changedSteps.middle,
        prompt: 'Changed middle',
      };

      // when
      const reconciled = reconcileRun(run, loadedWorkflow(changedRaw), 7);

      // then
      expect(reconciled.run?.history.map((entry) => entry.stepId)).toEqual([
        'gate-a',
      ]);
      expect(reconciled.run?.reviewedArtifact).toBe(artifact);
      expect(reconciled.run?.reviewedFeedback).toBe('first feedback');
      expect(reconciled.run?.history[0]?.approval?.requestId).toBe(
        'first-review',
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

    test('an approved gate artifact survives a planning prompt reload', () => {
      // given
      const raw = baseWorkflow();
      raw.start = 'plan';
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
          transitions: {
            approved: 'implement',
            rejected: 'plan',
          },
        },
        implement: {
          prompt: 'Implement',
          transitions: {
            done: '$done',
            blocked: '$pause',
          },
        },
      };
      const original = loadedWorkflow(raw);
      const artifact = '# Human-approved plan';
      let run = createRun(original, '', [], 'approved-plan-reload', 1);
      run = beginGate(
        original,
        run,
        'submit',
        artifact,
        'review-request',
        2,
        'Plan ready',
      );
      run = resolveGate(
        original,
        run,
        { approved: true, feedback: '', resolvedAt: 3 },
        3,
      );
      run = pauseRun(run, 'Runtime repaired', 4);
      const changedRaw = structuredClone(raw);
      const changedSteps = changedRaw.steps as Record<
        string,
        Record<string, unknown>
      >;
      changedSteps.plan = {
        ...changedSteps.plan,
        prompt: 'Updated completion instructions',
      };
      const changed = loadedWorkflow(changedRaw);

      // when
      const result = reconcileRun(run, changed, 5);

      // then
      expect(result.changed).toBe(true);
      expect(result.restartedStep).toBe(undefined);
      expect(result.run?.currentStepId).toBe('implement');
      expect(result.run?.status).toBe('paused');
      expect(result.run?.reviewedArtifact).toBe(artifact);
      expect(result.run?.history).toHaveLength(1);
      expect(result.run?.history[0]?.summary).toBe('Plan ready');
      expect(result.run?.history[0]?.stepDigest).toBe(changed.stepDigests.plan);
      expect(result.run?.history[0]?.approval?.stepStructuralDigest).toBe(
        original.stepStructuralDigests.plan,
      );
      expect(changed.stepStructuralDigests.plan).toBe(
        original.stepStructuralDigests.plan,
      );
    });

    test('approved gate structural changes restart instead of refreshing history', () => {
      // given
      const raw = baseWorkflow();
      raw.start = 'plan';
      raw.steps = {
        plan: {
          prompt: 'Plan',
          permissions: {
            tools: ['read'],
            extensions: ['plannotator'],
          },
          requires: {
            extensions: ['plannotator'],
          },
          gate: {
            provider: 'prompt',
            submitOutcome: 'submit',
            approvedOutcome: 'approved',
            rejectedOutcome: 'rejected',
          },
          transitions: {
            approved: 'implement',
            rejected: '$pause',
          },
        },
        implement: {
          prompt: 'Implement',
          transitions: {
            done: '$done',
          },
        },
        audit: {
          prompt: 'Audit',
          transitions: {
            done: '$done',
          },
        },
      };
      const original = loadedWorkflow(raw);
      let run = createRun(original, '', [], 'structural-gate-reload', 1);
      run = beginGate(
        original,
        run,
        'submit',
        'approved artifact',
        'structural-review',
        2,
        'Plan ready',
      );
      run = resolveGate(
        original,
        run,
        { approved: true, feedback: 'approved feedback', resolvedAt: 3 },
        3,
      );

      const approvedTargetChanged = structuredClone(raw);
      const approvedTargetSteps = approvedTargetChanged.steps as Record<
        string,
        Record<string, unknown>
      >;
      approvedTargetSteps.plan = {
        ...approvedTargetSteps.plan,
        transitions: {
          approved: 'audit',
          rejected: '$pause',
        },
      };

      const providerChanged = structuredClone(raw);
      const providerSteps = providerChanged.steps as Record<
        string,
        Record<string, unknown>
      >;
      providerSteps.plan = {
        ...providerSteps.plan,
        gate: {
          provider: 'plannotator',
          submitOutcome: 'submit',
          approvedOutcome: 'approved',
          rejectedOutcome: 'rejected',
        },
      };

      const gateConfigChanged = structuredClone(raw);
      const gateConfigSteps = gateConfigChanged.steps as Record<
        string,
        Record<string, unknown>
      >;
      gateConfigSteps.plan = {
        ...gateConfigSteps.plan,
        gate: {
          provider: 'prompt',
          submitOutcome: 'submit',
          approvedOutcome: 'approved',
          rejectedOutcome: 'changes-requested',
        },
        transitions: {
          approved: 'implement',
          'changes-requested': '$pause',
        },
      };

      const permissionsChanged = structuredClone(raw);
      const permissionSteps = permissionsChanged.steps as Record<
        string,
        Record<string, unknown>
      >;
      permissionSteps.plan = {
        ...permissionSteps.plan,
        permissions: {
          tools: ['read', 'grep'],
          extensions: ['plannotator'],
        },
      };

      // when
      const changedWorkflows = [
        approvedTargetChanged,
        providerChanged,
        gateConfigChanged,
        permissionsChanged,
      ].map(loadedWorkflow);

      // then
      expect(
        changedWorkflows.map(
          (changed) =>
            changed.stepStructuralDigests.plan ===
            original.stepStructuralDigests.plan,
        ),
      ).toEqual([false, false, false, false]);
      const reconciled = changedWorkflows.map((changed) =>
        reconcileRun(run, changed, 4),
      );
      expect(reconciled.map((result) => result.restartedStep)).toEqual([
        'plan',
        'plan',
        'plan',
        'plan',
      ]);
      expect(reconciled.map((result) => result.run?.currentStepId)).toEqual([
        'plan',
        'plan',
        'plan',
        'plan',
      ]);
      expect(reconciled.map((result) => result.run?.history)).toEqual([
        [],
        [],
        [],
        [],
      ]);
      expect(reconciled.map((result) => result.run?.reviewedArtifact)).toEqual([
        '',
        '',
        '',
        '',
      ]);
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
      expect(run.failedStepId).toBe('implement');
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

    test('rejects semantically forged checkpoints before reconciliation', () => {
      const workflow = loadedWorkflow();
      const initial = createRun(workflow, '', [], 'forged-checkpoint', 1);
      const afterInspect = advanceRun(
        workflow,
        initial,
        'ready',
        'Inspected',
        2,
      );
      const completed = advanceRun(
        workflow,
        afterInspect,
        'done',
        'Implemented',
        3,
      );

      const forgedVisits = reconcileRun(
        { ...initial, visits: { inspect: 0 } },
        workflow,
        4,
      );
      const forgedHistory = reconcileRun(
        {
          ...afterInspect,
          history: [{ ...afterInspect.history[0]!, outcome: 'invented' }],
        },
        workflow,
        4,
      );
      const forgedCurrent = reconcileRun(
        {
          ...initial,
          currentStepId: 'implement',
          currentStepDigest: workflow.stepDigests.implement!,
          visits: { implement: 1 },
        },
        workflow,
        4,
      );
      const globalChange = {
        ...workflow,
        digest: 'global-configuration-change',
      };
      const forgedCompletedDigest = reconcileRun(
        { ...completed, currentStepDigest: 'forged-current-digest' },
        globalChange,
        4,
      );

      expect(forgedVisits.error).toMatch(/visit counts/);
      expect(forgedHistory.error).toMatch(/outcome "invented"/);
      expect(forgedCurrent.error).toMatch(/does not match reachable step/);
      expect(forgedCompletedDigest.error).toMatch(
        /current-step digest does not match its terminal history/,
      );
      expect(forgedVisits.run).toBeUndefined();
      expect(forgedHistory.run).toBeUndefined();
      expect(forgedCurrent.run).toBeUndefined();
      expect(forgedCompletedDigest.run).toBeUndefined();
    });

    test('rejects missing gate approval and a forged reviewed pair', () => {
      const raw = baseWorkflow();
      raw.start = 'plan';
      raw.steps = {
        plan: {
          prompt: 'Plan',
          gate: {
            provider: 'prompt',
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
          transitions: { done: '$done' },
        },
      };
      const workflow = loadedWorkflow(raw);
      let approved = createRun(workflow, '', [], 'forged-gate-checkpoint', 1);
      approved = beginGate(
        workflow,
        approved,
        'submit',
        '# Approved plan',
        'approval-request',
        2,
        'Plan ready',
      );
      approved = resolveGate(
        workflow,
        approved,
        { approved: true, feedback: 'Approved', resolvedAt: 3 },
        3,
      );
      approved = pauseRun(approved, 'inspect checkpoint', 4);
      const approvedEntry = approved.history[0]!;
      const missingApproval = {
        ...approved,
        history: [
          {
            ...approvedEntry,
            artifact: undefined,
            approval: undefined,
          },
        ],
        reviewedArtifact: '',
        reviewedFeedback: '',
      };
      const forgedReviewedPair = {
        ...approved,
        reviewedArtifact: '# Unapproved replacement',
        reviewedFeedback: 'Forged feedback',
      };

      expect(isWorkflowRun(missingApproval)).toBe(true);
      expect(isWorkflowRun(forgedReviewedPair)).toBe(true);
      const missingResult = reconcileRun(missingApproval, workflow, 5);
      const forgedPairResult = reconcileRun(forgedReviewedPair, workflow, 5);
      expect(missingResult.error).toMatch(
        /missing authoritative gate approval/,
      );
      expect(forgedPairResult.error).toMatch(
        /do not match authoritative approval history/,
      );
      expect(missingResult.run).toBeUndefined();
      expect(forgedPairResult.run).toBeUndefined();
    });

    test('configuration rewind discards a removed suffix after an earlier change', () => {
      const originalRaw = baseWorkflow();
      const originalSteps = originalRaw.steps as Record<
        string,
        Record<string, unknown>
      >;
      originalSteps.implement = {
        ...originalSteps.implement,
        transitions: { ready: 'verify' },
      };
      originalSteps.verify = {
        prompt: 'Verify',
        transitions: { done: '$done' },
      };
      const original = loadedWorkflow(originalRaw);
      let run = createRun(original, '', [], 'removed-suffix', 1);
      run = advanceRun(original, run, 'ready', 'Inspected', 2);
      run = advanceRun(original, run, 'ready', 'Implemented', 3);

      const changedRaw = baseWorkflow();
      changedRaw.steps = {
        inspect: {
          prompt: 'Changed inspection',
          transitions: { ready: 'replacement' },
        },
        replacement: {
          prompt: 'Replacement',
          transitions: { done: '$done' },
        },
      };
      const reconciled = reconcileRun(run, loadedWorkflow(changedRaw), 4);

      expect(reconciled.error).toBeUndefined();
      expect(reconciled.restartedStep).toBe('inspect');
      expect(reconciled.run?.currentStepId).toBe('inspect');
      expect(reconciled.run?.history).toEqual([]);
      expect(reconciled.run?.status).toBe('paused');
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
        beginGate(
          workflow,
          run,
          'approved',
          '# Plan',
          'request-1',
          2,
          'Plan ready',
        ),
      ).toThrow(/expects outcome/);
      expect(() =>
        beginGate(workflow, run, 'submit', ' ', 'request-1', 2, 'Plan ready'),
      ).toThrow(/non-empty artifact/);
      expect(() =>
        beginGate(workflow, run, 'submit', '# Plan', 'request-1', 2, ' '),
      ).toThrow(/non-empty summary/);
      expect(() =>
        beginGate(workflow, run, 'submit', '# Plan', '', 2, 'Plan ready'),
      ).toThrow(/request id/);
      expect(() =>
        beginGate(
          workflow,
          { ...run, status: 'completed' },
          'submit',
          '# Plan',
          'request-1',
          2,
          'Plan ready',
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
        'Plan ready',
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
      expect(failGate(pending, 'offline', 3)).toMatchObject({
        gateArtifact: '# Plan',
        gateFeedback: 'offline',
      });
      const failedPausedGate = failGate(
        pauseRun(pending, 'temporarily paused', 3),
        'offline',
        4,
      );
      expect(failedPausedGate.status).toBe('running');
      expect(failedPausedGate.pausedFrom).toBeUndefined();
      expect(isWorkflowRun(failedPausedGate)).toBe(true);
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
      delete legacyRun.gateArtifact;
      expect(isWorkflowRun(legacyRun)).toBe(true);
      expect(isWorkflowRun({ ...run, stepHandoff: 42 })).toBe(false);
      expect(isWorkflowRun({ ...run, reviewedArtifact: 42 })).toBe(false);
      expect(isWorkflowRun({ ...run, gateArtifact: 42 })).toBe(false);
      expect(
        isWorkflowRun({
          ...run,
          gateFeedback: 'x'.repeat(MAX_GATE_FEEDBACK_CHARS + 1),
        }),
      ).toBe(false);
      expect(
        isWorkflowRun({
          ...run,
          reviewedFeedback: 'x'.repeat(MAX_GATE_FEEDBACK_CHARS + 1),
        }),
      ).toBe(false);
      expect(isWorkflowRun({ ...run, resumeInput: 'try again' })).toBe(true);
      expect(
        isWorkflowRun({
          ...run,
          resumeInput: 'x'.repeat(MAX_RESUME_INPUT_CHARS + 1),
        }),
      ).toBe(false);
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
        'Review ready',
      );
      expect(isWorkflowRun(awaiting)).toBe(true);
    });
  });

  describe('usage accounting', () => {
    test('normalizes real Pi usage with a nested cost object', () => {
      const native = {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        cost: {
          input: 0.001,
          output: 0.002,
          cacheRead: 0.0005,
          cacheWrite: 0.0001,
          total: 0.0036,
        },
      };
      expect(normalizeUsage(native)).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        inputCostUsd: 0.001,
        outputCostUsd: 0.002,
        cacheReadCostUsd: 0.0005,
        cacheWriteCostUsd: 0.0001,
        otherCostUsd: 0,
        totalCostUsd: 0.0036,
      });
    });

    test('rejects malformed, negative, NaN, and inconsistent usage', () => {
      expect(normalizeUsage(null)).toBeUndefined();
      expect(normalizeUsage({ input: -1 })).toBeUndefined();
      expect(normalizeUsage({ input: NaN })).toBeUndefined();
      expect(normalizeUsage({ input: Infinity })).toBeUndefined();
      expect(normalizeUsage({ cost: { total: -0.1 } })).toBeUndefined();
      expect(normalizeUsage({ cost: { total: NaN } })).toBeUndefined();
      expect(
        normalizeUsage({ inputCost: 0.01, outputCost: 0.02, cost: 0.02 }),
      ).toBeUndefined();
    });

    test('validates usage aggregates and rejects duplicate model keys', () => {
      const modelUsage = {
        provider: 'openai',
        model: 'gpt-4',
        usage: normalizeUsage({
          input: 1,
          output: 1,
          cost: { input: 0.001, output: 0.002, total: 0.003 },
        }) as UsageTotals,
      };
      const aggregate = {
        usage: modelUsage.usage,
        models: [modelUsage] as const,
      };
      expect(isUsageAggregate(aggregate)).toBe(true);
      expect(
        isUsageAggregate({
          usage: addUsage(modelUsage.usage, modelUsage.usage),
          models: [modelUsage, modelUsage],
        }),
      ).toBe(false);
    });

    test('records finalized usage on the exact attempt and durable aggregate', () => {
      const workflow = loadedWorkflow();
      let run = createRun(workflow, '', [], 'run-usage', 1);
      run = beginMainStepAttempt(run, 'req-1', 'task', 2);
      const aggregate = usageAggregateFromModels([
        {
          provider: 'openai',
          model: 'gpt-4',
          usage: normalizeUsage({
            input: 3,
            output: 2,
            cost: { input: 0.001, output: 0.002, total: 0.003 },
          }) as UsageTotals,
        },
      ]);
      run = recordCurrentStepUsage(run, 'req-1', aggregate, 3);
      expect(run.currentStepUsage).toEqual(aggregate);
      expect(run.currentStepAttempts?.[0]?.usage).toEqual(aggregate);
      expect(recordCurrentStepUsage(run, 'unknown', aggregate, 4)).toBe(run);
    });

    test('reconciliation retains prior attempt usage for a changed step retry', () => {
      const original = loadedWorkflow();
      const oldUsage = usageAggregateFromModels([
        {
          provider: 'openai',
          model: 'gpt-4',
          usage: normalizeUsage({
            input: 3,
            output: 2,
            cost: { input: 0.001, output: 0.002, total: 0.003 },
          }) as UsageTotals,
        },
      ]);
      const retryUsage = usageAggregateFromModels([
        {
          provider: 'anthropic',
          model: 'claude-3',
          usage: normalizeUsage({
            input: 5,
            output: 4,
            cost: { input: 0.004, output: 0.005, total: 0.009 },
          }) as UsageTotals,
        },
      ]);
      let run = createRun(original, '', [], 'reconciled-usage', 1);
      run = beginMainStepAttempt(run, 'old-request', 'old task', 2);
      run = recordCurrentStepUsage(run, 'old-request', oldUsage, 3);
      run = advanceRun(original, run, 'ready', 'Inspected', 4);

      const changedRaw = baseWorkflow();
      const changedSteps = changedRaw.steps as Record<
        string,
        Record<string, unknown>
      >;
      changedSteps.inspect = {
        ...changedSteps.inspect,
        prompt: 'Changed inspection prompt',
      };
      const reconciled = reconcileRun(run, loadedWorkflow(changedRaw), 5);
      if (!reconciled.run) throw new Error('reconciliation should restart');
      run = beginMainStepAttempt(
        reconciled.run,
        'retry-request',
        'retry task',
        6,
      );
      run = recordCurrentStepUsage(run, 'retry-request', retryUsage, 7);

      expect(run.currentStepUsage).toEqual(
        usageAggregateFromModels([...oldUsage.models, ...retryUsage.models]),
      );
      expect(isWorkflowRun(structuredClone(run))).toBe(true);
    });

    test('durable current-step usage survives attempt eviction', () => {
      const workflow = loadedWorkflow();
      const base = createRun(workflow, '', [], 'run-compact', 1);
      const aggregate = usageAggregateFromModels([
        {
          provider: 'openai',
          model: 'gpt-4',
          usage: normalizeUsage({
            input: 100,
            output: 50,
            cost: { input: 0.01, output: 0.02, total: 0.03 },
          }) as UsageTotals,
        },
      ]);
      const run = {
        ...base,
        currentStepAttempts: [],
        currentStepOmittedAttempts: 1,
        currentStepUsage: aggregate,
      };
      expect(isWorkflowRun(run)).toBe(true);
      expect(run.currentStepUsage?.usage.totalCostUsd).toBe(0.03);
    });
  });
});
