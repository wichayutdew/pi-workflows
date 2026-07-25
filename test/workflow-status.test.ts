import { describe, expect, test } from 'bun:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { beginGate, failRun, pauseRun } from '../src/engine/transitions.ts';
import { createRun } from '../src/engine/state.ts';
import {
  formatWorkflowStatusText,
  WorkflowStatusView,
  type WorkflowStatusSnapshot,
} from '../src/workflow-status.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';

describe('when testing workflow status', () => {
  const plainTheme = {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  } as unknown as Theme;

  function renderSnapshot(
    snapshot: WorkflowStatusSnapshot,
    width = 120,
  ): string[] {
    const view = new WorkflowStatusView(
      () => snapshot,
      { requestRender() {} },
      plainTheme,
      () => undefined,
    );
    return view.render(width);
  }

  describe('should satisfy its behavioral contract', () => {
    test('the status board shows the live run summary and execution path', () => {
      // given
      const workflow = loadedWorkflow();
      let run = createRun(
        workflow,
        'inspect the repository',
        ['read'],
        'run-live-status',
        1_000,
      );
      run = {
        ...run,
        status: 'running',
        currentStepId: 'implement',
        currentStepDigest: workflow.stepDigests.implement ?? '',
        visits: { inspect: 1, implement: 1 },
        history: [
          {
            stepId: 'inspect',
            stepDigest: workflow.stepDigests.inspect ?? '',
            outcome: 'ready',
            summary: 'Inspection complete',
            completedAt: 2_000,
          },
        ],
        updatedAt: 2_000,
      };
      const lines = renderSnapshot({
        run,
        workflow,
        execution: {
          kind: 'subagent',
          agent: 'pi-workflows.step',
          requestId: 'request-status-1',
          progress: 'checking implementation details',
        },
        now: 63_000,
      });
      // when
      const output = lines.join('\n');

      // then
      expect(output).toMatch(/✦ Workflow Status/);
      expect(output).toMatch(/example/);
      expect(output).toMatch(/\[RUNNING\]/);
      expect(output).toMatch(/inspect/);
      expect(output).toMatch(/COMPLETED · ready/);
      expect(output).toMatch(/implement/);
      expect(output).toMatch(/✓ inspect/);
      expect(output).toMatch(/↻ implement/);
      expect(output).toMatch(/pi-workflows\.step/);
      expect(output).toMatch(/checking/);
      expect(output).toMatch(/implementation details/);
      expect(output).toMatch(/1m 2s/);
      expect(lines.every((line) => visibleWidth(line) <= 120)).toBeTruthy();
    });

    test('completed runs render completed attempts without a running row', () => {
      // given
      const workflow = loadedWorkflow();
      let run = createRun(workflow, '', [], 'run-completed-status', 1_000);
      run = {
        ...run,
        status: 'completed',
        currentStepId: 'implement',
        currentStepDigest: workflow.stepDigests.implement ?? '',
        visits: { inspect: 1, implement: 1 },
        history: [
          {
            stepId: 'inspect',
            stepDigest: workflow.stepDigests.inspect ?? '',
            outcome: 'ready',
            summary: 'Inspected',
            completedAt: 2_000,
          },
          {
            stepId: 'implement',
            stepDigest: workflow.stepDigests.implement ?? '',
            outcome: 'done',
            summary: 'Implemented',
            completedAt: 3_000,
          },
        ],
        updatedAt: 3_000,
      };
      // when
      const output = renderSnapshot({
        run,
        workflow,
        now: 99_000,
      }).join('\n');

      // then
      expect(output).toMatch(/\[COMPLETED\]/);
      expect(output).toMatch(/2 completed attempts/);
      expect(output).toMatch(/COMPLETED · ready/);
      expect(output).toMatch(/COMPLETED · done/);
      expect(output).toMatch(/✓ implement/);
      expect(output).not.toMatch(/\bRUNNING\b/);
    });

    test('paused runs wrap a failure reason within a narrow Unicode-safe board', () => {
      // given
      const workflow = loadedWorkflow();
      const running = createRun(workflow, '', [], 'run-paused-status', 1_000);
      const reason =
        'ขั้นตอนล้มเหลว: ตรวจสอบรายละเอียด 🚧 before resuming the workflow';
      const run = pauseRun(running, reason, 4_000);
      const lines = renderSnapshot({ run, workflow, now: 90_000 }, 48);
      // when
      const output = lines.join('\n');

      // then
      expect(output).toMatch(/\[PAUSED\]/);
      expect(output).toMatch(/◆ inspect/);
      expect(output).toMatch(/reason/);
      expect(output).toMatch(/ขั้นตอนล้มเหลว/);
      expect(lines.every((line) => visibleWidth(line) <= 48)).toBeTruthy();
    });

    test('failed steps render a cross while remaining resumable', () => {
      // given
      const workflow = loadedWorkflow();
      const running = createRun(workflow, '', [], 'run-failed-status', 1_000);
      const run = failRun(running, 'Subagent failed', 4_000);

      // when
      const output = renderSnapshot({ run, workflow, now: 90_000 }).join('\n');

      // then
      expect(run.status).toBe('paused');
      expect(output).toMatch(/✕ inspect/);
      expect(output).toMatch(/\[PAUSED\]/);
    });

    test('a pending gate shows its review identifier and waiting state', () => {
      // given
      const raw = baseWorkflow();
      raw.steps = {
        review: {
          prompt: 'Review',
          gate: {
            provider: 'plannotator',
            submitOutcome: 'submit',
            approvedOutcome: 'approved',
            rejectedOutcome: 'rejected',
          },
          transitions: {
            approved: '$done',
            rejected: 'review',
          },
        },
      };
      raw.start = 'review';
      const workflow = loadedWorkflow(raw);
      let run = createRun(workflow, '', [], 'run-review-status', 1_000);
      run = beginGate(
        workflow,
        run,
        'submit',
        '# Plan',
        'request-review',
        2_000,
      );
      run = {
        ...run,
        pendingGate: {
          ...run.pendingGate!,
          reviewId: 'review-status-42',
        },
      };
      // when
      const output = renderSnapshot({
        run,
        workflow,
        now: 3_000,
      }).join('\n');

      // then
      expect(output).toMatch(/\[AWAITING REVIEW\]/);
      expect(output).toMatch(/plannotator · review-status-42/);
    });

    test('the text fallback preserves checkpoint and execution details', () => {
      // given
      const workflow = loadedWorkflow();
      const run = createRun(workflow, '', [], 'run-text-status', 1_000);
      // when
      const output = formatWorkflowStatusText({
        run,
        workflow,
        execution: {
          kind: 'subagent',
          agent: 'pi-workflows.step',
          requestId: 'request-text-status',
          progress: 'starting',
        },
        now: 2_000,
      });

      // then
      expect(output).toMatch(/Workflow: example/);
      expect(output).toMatch(/Run: run-text-status/);
      expect(output).toMatch(/Status: running/);
      expect(output).toMatch(
        /Subagent: pi-workflows\.step \(request-text-status\)/,
      );
      expect(output).toMatch(/Progress: starting/);
    });

    test('q and Escape close the board once and force a repaint', () => {
      // given
      const workflow = loadedWorkflow();
      const run = createRun(workflow, '', [], 'run-close-status', 1_000);
      let qClosed = 0;
      const qRenders: Array<boolean | undefined> = [];
      const qView = new WorkflowStatusView(
        () => ({ run, workflow, now: 2_000 }),
        { requestRender: (force) => qRenders.push(force) },
        plainTheme,
        () => {
          qClosed += 1;
        },
      );

      qView.handleInput('q');
      // when
      qView.handleInput('q');
      // then
      expect(qClosed).toBe(1);
      expect(qRenders).toEqual([true]);

      let escapeClosed = 0;
      const escapeView = new WorkflowStatusView(
        () => ({ run, workflow, now: 2_000 }),
        { requestRender() {} },
        plainTheme,
        () => {
          escapeClosed += 1;
        },
      );
      escapeView.handleInput('\u001b');
      expect(escapeClosed).toBe(1);
    });

    test('renders and disposes an empty live status board', () => {
      // given
      const renders: Array<boolean | undefined> = [];
      const view = new WorkflowStatusView(
        () => undefined,
        { requestRender: (force) => renders.push(force) },
        plainTheme,
        () => undefined,
      );

      // when
      view.start();
      const output = view.render(40).join('\n');
      view.dispose();
      view.invalidate();

      // then
      expect(output).toMatch(/No workflow checkpoint/);
      expect(renders).toEqual([]);
    });
  });
});
