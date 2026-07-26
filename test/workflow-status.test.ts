import { describe, expect, jest, test } from 'bun:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { beginGate, failRun, pauseRun } from '../src/engine/transitions.ts';
import { createRun } from '../src/engine/state.ts';
import {
  formatWorkflowProgressStatus,
  formatWorkflowStatusBoard,
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
    test('the persistent progress line identifies the workflow and current step', () => {
      // given
      const raw = baseWorkflow();
      const steps = raw.steps as Record<string, Record<string, unknown>>;
      steps.implement = {
        ...steps.implement,
        title: 'Implement the approved change',
      };
      const workflow = loadedWorkflow(raw);
      const initial = createRun(
        workflow,
        'make the change',
        [],
        'run-progress-status',
        1_000,
      );
      const run = {
        ...initial,
        currentStepId: 'implement',
        currentStepDigest: workflow.stepDigests.implement ?? '',
      };

      // when
      const output = formatWorkflowProgressStatus(
        { run, workflow, now: 1_000 },
        'Ctrl+Alt+W',
      );

      // then
      expect(output).toBe(
        '◐ example · step Implement the approved change (implement) · working · Ctrl+Alt+W',
      );

      expect(
        formatWorkflowProgressStatus(
          {
            run: { ...run, status: 'awaiting-gate' },
            workflow,
            now: 1_000,
          },
          'Ctrl+Alt+W',
        ),
      ).toBe(
        '◆ example · step Implement the approved change (implement) · awaiting review · Ctrl+Alt+W',
      );
    });

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
      expect(output).toMatch(/\/example/);
      expect(output).toMatch(/workflow\s+example/);
      expect(output).toMatch(/command\s+\/example/);
      expect(output).toMatch(/about\s+Example workflow/);
      expect(output).toMatch(/\[RUNNING\]/);
      expect(output).toMatch(/inspect/);
      expect(output).toMatch(/COMPLETED · ready/);
      expect(output).toMatch(/implement/);
      expect(output).toMatch(/✓ inspect/);
      expect(output).toMatch(/◐ implement/);
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

    test('the status board clamps an oversized failure reason', () => {
      // given
      const workflow = loadedWorkflow();
      const running = createRun(workflow, '', [], 'run-long-failure', 1_000);
      const reason = `Subagent failed: ${'very long diagnostic context '.repeat(200)}TAIL`;
      const run = pauseRun(running, reason, 4_000);

      // when
      const lines = renderSnapshot({ run, workflow, now: 90_000 }, 48);
      const board = lines.join('\n');
      const fallback = formatWorkflowStatusText({
        run,
        workflow,
        now: 90_000,
      });

      // then
      expect(lines.length).toBeLessThanOrEqual(30);
      expect(lines.every((line) => visibleWidth(line) <= 48)).toBeTruthy();
      expect(board).toContain('…');
      expect(board).not.toContain('TAIL');
      expect(fallback).toContain('TAIL');
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
        'Plan ready',
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
      expect(output).toMatch(/Workflow ID: example/);
      expect(output).toMatch(/Command: \/example/);
      expect(output).toMatch(/Description: Example workflow/);
      expect(output).toMatch(/Run: run-text-status/);
      expect(output).toMatch(/Status: running/);
      expect(output).toMatch(
        /Subagent: pi-workflows\.step \(request-text-status\)/,
      );
      expect(output).toMatch(/Progress: starting/);
    });

    test('the overlay board renders the full workflow status', () => {
      // given
      const raw = baseWorkflow();
      (raw.steps as Record<string, unknown>).verify = {
        title: 'Verify changes',
        prompt: 'Verify',
        transitions: { done: '$done' },
      };
      const workflow = loadedWorkflow(raw);
      const initial = createRun(workflow, '', [], 'run-progress-widget', 1_000);
      const run = {
        ...initial,
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
        ],
      };

      // when
      const lines = formatWorkflowStatusBoard({
        run,
        workflow,
        now: 3_000,
      });

      // then
      expect(lines.join('\n')).toMatch(/✦ Workflow Status/);
      expect(lines.join('\n')).toMatch(/\[RUNNING\]/);
      expect(lines.join('\n')).toMatch(/✓ inspect/);
      expect(lines.join('\n')).toMatch(/◐ implement/);
    });

    test('the overlay board distinguishes paused, failed, aborted, and completed current steps', () => {
      // given
      const workflow = loadedWorkflow();
      const running = createRun(workflow, '', [], 'run-progress-states', 1_000);
      const paused = pauseRun(running, 'Waiting for review', 2_000);
      const failed = failRun(running, 'Step failed', 2_000);
      const awaitingReview = {
        ...running,
        status: 'awaiting-gate' as const,
      };
      const aborted = {
        ...running,
        status: 'aborted' as const,
        pauseReason: 'Stopped',
      };
      const completed = {
        ...running,
        status: 'completed' as const,
      };

      // when / then
      expect(
        formatWorkflowStatusBoard({
          run: paused,
          workflow,
          now: 3_000,
        }).join('\n'),
      ).toMatch(/◆ inspect/);
      expect(
        formatWorkflowStatusBoard({
          run: failed,
          workflow,
          now: 3_000,
        }).join('\n'),
      ).toMatch(/✕ inspect/);
      expect(
        formatWorkflowStatusBoard({
          run: awaitingReview,
          workflow,
          now: 3_000,
        }).join('\n'),
      ).toMatch(/◆ inspect/);
      expect(
        formatWorkflowStatusBoard({
          run: aborted,
          workflow,
          now: 3_000,
        }).join('\n'),
      ).toMatch(/✕ inspect/);
      expect(
        formatWorkflowStatusBoard({
          run: completed,
          workflow,
          now: 3_000,
        }).join('\n'),
      ).toMatch(/✓ inspect/);
    });

    test('the overlay board falls back to known checkpoint steps when config is unavailable', () => {
      // given
      const workflow = loadedWorkflow();
      const initial = createRun(
        workflow,
        '',
        [],
        'run-progress-fallback',
        1_000,
      );
      const run = {
        ...initial,
        currentStepId: 'implement',
        currentStepDigest: workflow.stepDigests.implement ?? '',
        history: [
          {
            stepId: 'inspect',
            stepDigest: workflow.stepDigests.inspect ?? '',
            outcome: 'ready',
            summary: 'Inspected',
            completedAt: 2_000,
          },
        ],
      };

      // when
      const lines = formatWorkflowStatusBoard({ run, now: 3_000 });

      // then
      expect(lines.join('\n')).toMatch(/✓ inspect/);
      expect(lines.join('\n')).toMatch(/◐ implement/);
    });

    test('the running icon advances through spinner frames', () => {
      // given
      const workflow = loadedWorkflow();
      const run = createRun(workflow, '', [], 'run-spinner', 1_000);

      // when / then
      expect(
        formatWorkflowStatusBoard({ run, workflow, now: 0 }).join('\n'),
      ).toMatch(/◐ inspect/);
      expect(
        formatWorkflowStatusBoard({ run, workflow, now: 250 }).join('\n'),
      ).toMatch(/◓ inspect/);
    });

    test('a short terminal can scroll the entire overlay instead of clipping it', () => {
      // given
      const workflow = loadedWorkflow();
      const run = createRun(workflow, '', [], 'run-scroll-status', 1_000);
      const repaintRequests: Array<boolean | undefined> = [];
      const view = new WorkflowStatusView(
        () => ({ run, workflow, now: 2_000 }),
        {
          requestRender: (force) => repaintRequests.push(force),
          terminal: { rows: 10 },
        },
        plainTheme,
        () => undefined,
      );

      // when
      const firstPage = view.render(120);
      view.handleInput('\u001b[6~');
      const secondPage = view.render(120);

      // then
      expect(firstPage).toHaveLength(9);
      expect(firstPage.at(-1)).toMatch(/rows 1-8\//);
      expect(secondPage.at(-1)).toMatch(/rows 8-15\//);
      expect(firstPage).not.toEqual(secondPage);
      expect(repaintRequests).toEqual([true]);
      expect(
        secondPage.every((line) => visibleWidth(line) <= 120),
      ).toBeTruthy();
    });

    test('the configured shortcut, q, and Escape close the board', () => {
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

      let shortcutClosed = 0;
      const shortcutView = new WorkflowStatusView(
        () => ({ run, workflow, now: 2_000 }),
        { requestRender() {} },
        plainTheme,
        () => {
          shortcutClosed += 1;
        },
        'ctrl+x',
      );
      expect(shortcutView.render(80).at(-1)).toMatch(/Ctrl\+X/);
      shortcutView.handleInput('\u0018');
      expect(shortcutClosed).toBe(1);
    });

    test('renders and disposes an empty live status board', () => {
      // given
      jest.useFakeTimers();
      const renders: Array<boolean | undefined> = [];
      const view = new WorkflowStatusView(
        () => undefined,
        { requestRender: (force) => renders.push(force) },
        plainTheme,
        () => undefined,
      );

      try {
        // when
        view.start();
        jest.advanceTimersByTime(1_000);
        const output = view.render(40).join('\n');
        view.dispose();
        view.invalidate();

        // then
        expect(output).toMatch(/No workflow checkpoint/);
        expect(renders).toEqual([undefined]);
      } finally {
        view.dispose();
        jest.useRealTimers();
      }
    });
  });
});
