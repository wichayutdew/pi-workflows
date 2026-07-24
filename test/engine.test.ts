import assert from 'node:assert/strict';
import test from 'node:test';
import { createRun, isWorkflowRun } from '../src/engine/state.ts';
import {
  advanceRun,
  beginGate,
  pauseRun,
  reconcileRun,
  resolveGate,
  resumeRun,
} from '../src/engine/transitions.ts';
import { buildDelegatedStepTask } from '../src/prompt.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';

test('advances through configured steps and completes', () => {
  const workflow = loadedWorkflow();
  let run = createRun(workflow, 'request', ['read', 'edit'], 'run-1', 1);
  run = advanceRun(workflow, run, 'ready', 'inspection complete', 2);
  assert.equal(run.status, 'running');
  assert.equal(run.currentStepId, 'implement');
  assert.equal(run.history.length, 1);

  run = advanceRun(workflow, run, 'done', 'implemented', 3);
  assert.equal(run.status, 'completed');
  assert.equal(run.history.length, 2);
});

test('pause target checkpoints the same step and resumes it', () => {
  const workflow = loadedWorkflow();
  let run = createRun(workflow, '', ['read'], 'run-2', 1);
  run = advanceRun(workflow, run, 'blocked', 'fix configuration', 2);
  assert.equal(run.status, 'paused');
  assert.equal(run.currentStepId, 'inspect');
  assert.equal(run.history.length, 0);
  assert.equal(resumeRun(run, 3).status, 'running');
});

test('paused attempts preserve the incoming step handoff for resume', () => {
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
  run = advanceRun(
    workflow,
    run,
    'ready',
    'Approved implementation contract',
    2,
  );
  assert.equal(run.reviewedArtifact, '');
  run = advanceRun(
    workflow,
    run,
    'blocked',
    'Tooling failed after partial work',
    3,
  );

  assert.equal(run.stepHandoff, 'Approved implementation contract');
  assert.equal(run.lastSummary, 'Tooling failed after partial work');
  const resumed = resumeRun(run, 4);
  const task = buildDelegatedStepTask(workflow, resumed, 'policy');
  assert.match(
    task,
    /Incoming approved or previous-step handoff:\nApproved implementation contract/,
  );
  assert.match(
    task,
    /Latest paused attempt:\nTooling failed after partial work/,
  );
});

test('manual pause preserves an in-flight gate', () => {
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
  run = pauseRun(run, 'repair integration', 3);
  assert.equal(run.status, 'paused');
  assert.equal(run.pausedFrom, 'awaiting-gate');
  assert.equal(run.pendingGate?.artifact, '# Plan');
});

test('gate rejection follows its configured transition with feedback', () => {
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
  run = resolveGate(
    workflow,
    run,
    { approved: false, feedback: 'Add rollback', resolvedAt: 3 },
    3,
  );
  assert.equal(run.status, 'running');
  assert.equal(run.currentStepId, 'plan');
  assert.equal(run.gateFeedback, 'Add rollback');
});

test('gate approval uses the reviewed artifact as the delegated step handoff', () => {
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
  run = resolveGate(
    workflow,
    run,
    { approved: true, feedback: '', resolvedAt: 3 },
    3,
  );
  assert.equal(run.status, 'completed');
  assert.equal(run.lastSummary, '# Plan');
  assert.equal(run.stepHandoff, '# Plan');
  assert.equal(run.reviewedArtifact, '# Plan');
  assert.equal(run.history.at(-1)?.summary, '# Plan');
});

test('configuration rewind never promotes legacy gate summaries to reviewed artifacts', () => {
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
  const artifact = '{"repositories":[{"worker":[{"command":"npm publish"}]}]}';
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
  const changed = loadedWorkflow(changedRaw);

  assert.equal(reconcileRun(run, changed, 5).run?.reviewedArtifact, artifact);
  const legacyRun = { ...run };
  delete legacyRun.reviewedArtifact;
  assert.equal(reconcileRun(legacyRun, changed, 5).run?.reviewedArtifact, '');
});

test('configuration changes restart the earliest changed completed step', () => {
  const original = loadedWorkflow();
  let run = createRun(original, '', ['read'], 'run-5', 1);
  run = advanceRun(original, run, 'ready', 'done', 2);

  const changedRaw = baseWorkflow();
  const steps = changedRaw.steps as Record<string, Record<string, unknown>>;
  steps.inspect = { ...steps.inspect, prompt: 'Changed inspection prompt' };
  const changed = loadedWorkflow(changedRaw);
  const result = reconcileRun(run, changed, 3);
  assert.equal(result.changed, true);
  assert.equal(result.restartedStep, 'inspect');
  assert.equal(result.run?.currentStepId, 'inspect');
  assert.equal(result.run?.history.length, 0);
  assert.equal(result.run?.status, 'paused');
});

test('persisted state validator rejects malformed history and gates', () => {
  const workflow = loadedWorkflow();
  const run = createRun(workflow, '', ['read'], 'run-6', 1);
  assert.equal(isWorkflowRun(run), true);
  const legacyRun = { ...run };
  delete legacyRun.stepHandoff;
  delete legacyRun.reviewedArtifact;
  assert.equal(isWorkflowRun(legacyRun), true);
  assert.equal(isWorkflowRun({ ...run, stepHandoff: 42 }), false);
  assert.equal(isWorkflowRun({ ...run, reviewedArtifact: 42 }), false);
  assert.equal(isWorkflowRun({ ...run, history: [{}] }), false);
  assert.equal(
    isWorkflowRun({
      ...run,
      pendingGate: {
        provider: 'plannotator',
        requestId: 'request-3',
        stepId: 'inspect',
      },
    }),
    false,
  );
  assert.equal(
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
    false,
  );
  assert.equal(isWorkflowRun({ ...run, pausedFrom: 'anything' }), false);
  assert.equal(isWorkflowRun({ ...run, status: 'awaiting-gate' }), false);
  assert.doesNotThrow(() => isWorkflowRun({ ...run, pendingGate: null }));
  assert.equal(isWorkflowRun({ ...run, pendingGate: null }), false);
  assert.equal(isWorkflowRun({ ...run, pendingGate: 42 }), false);
});
