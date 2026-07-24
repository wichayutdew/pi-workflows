import assert from 'node:assert/strict';
import test from 'node:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { beginGate, pauseRun } from '../src/engine/transitions.ts';
import { createRun } from '../src/engine/state.ts';
import {
  formatWorkflowStatusText,
  WorkflowStatusView,
  type WorkflowStatusSnapshot,
} from '../src/workflow-status.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';

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

test('the status board shows the live run summary and execution path', () => {
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
  const output = lines.join('\n');

  assert.match(output, /✦ Workflow Status/);
  assert.match(output, /example/);
  assert.match(output, /\[RUNNING\]/);
  assert.match(output, /inspect/);
  assert.match(output, /COMPLETED · ready/);
  assert.match(output, /implement/);
  assert.match(output, /pi-workflows\.step/);
  assert.match(output, /checking/);
  assert.match(output, /implementation details/);
  assert.match(output, /1m 2s/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
});

test('completed runs render completed attempts without a running row', () => {
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
  const output = renderSnapshot({
    run,
    workflow,
    now: 99_000,
  }).join('\n');

  assert.match(output, /\[COMPLETED\]/);
  assert.match(output, /2 completed attempts/);
  assert.match(output, /COMPLETED · ready/);
  assert.match(output, /COMPLETED · done/);
  assert.doesNotMatch(output, /\bRUNNING\b/);
});

test('paused runs wrap a failure reason within a narrow Unicode-safe board', () => {
  const workflow = loadedWorkflow();
  const running = createRun(workflow, '', [], 'run-paused-status', 1_000);
  const reason =
    'ขั้นตอนล้มเหลว: ตรวจสอบรายละเอียด 🚧 before resuming the workflow';
  const run = pauseRun(running, reason, 4_000);
  const lines = renderSnapshot({ run, workflow, now: 90_000 }, 48);
  const output = lines.join('\n');

  assert.match(output, /\[PAUSED\]/);
  assert.match(output, /reason/);
  assert.match(output, /ขั้นตอนล้มเหลว/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 48));
});

test('a pending gate shows its review identifier and waiting state', () => {
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
  run = beginGate(workflow, run, 'submit', '# Plan', 'request-review', 2_000);
  run = {
    ...run,
    pendingGate: {
      ...run.pendingGate!,
      reviewId: 'review-status-42',
    },
  };
  const output = renderSnapshot({
    run,
    workflow,
    now: 3_000,
  }).join('\n');

  assert.match(output, /\[AWAITING REVIEW\]/);
  assert.match(output, /plannotator · review-status-42/);
});

test('the text fallback preserves checkpoint and execution details', () => {
  const workflow = loadedWorkflow();
  const run = createRun(workflow, '', [], 'run-text-status', 1_000);
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

  assert.match(output, /Workflow: example/);
  assert.match(output, /Run: run-text-status/);
  assert.match(output, /Status: running/);
  assert.match(output, /Subagent: pi-workflows\.step \(request-text-status\)/);
  assert.match(output, /Progress: starting/);
});

test('q and Escape close the board once and force a repaint', () => {
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
  qView.handleInput('q');
  assert.equal(qClosed, 1);
  assert.deepEqual(qRenders, [true]);

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
  assert.equal(escapeClosed, 1);
});
