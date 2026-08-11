import { describe, expect, test } from 'bun:test';
import { createRun, isWorkflowRun } from '../src/engine/state.ts';
import { advanceRun, restartRun } from '../src/engine/transitions.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';

function workspaceWorkflow() {
  const raw = baseWorkflow();
  raw.start = 'prepare';
  raw.steps = {
    prepare: {
      prompt: 'Prepare the workspace',
      agent: 'worker',
      workspace: { bindOn: ['ready'], allowedRoots: ['../worktrees'] },
      transitions: { ready: 'implement', blocked: '$pause' },
    },
    implement: {
      prompt: 'Implement',
      agent: 'worker',
      transitions: { ready: 'verify', blocked: '$pause' },
    },
    verify: {
      prompt: 'Verify',
      agent: 'reviewer',
      transitions: { passed: '$done', blocked: '$pause' },
    },
  };
  return loadedWorkflow(raw);
}

describe('when restarting a completed workflow iteration', () => {
  test('resets execution state while preserving the worktree lineage and final handoff', () => {
    const workflow = workspaceWorkflow();
    const sourceCwd = '/repository/source';
    const workspaceCwd = '/repository/worktrees/task';
    let completed = createRun(
      workflow,
      'first iteration',
      ['read'],
      'stable-worktree-run',
      1,
      sourceCwd,
    );
    completed = advanceRun(workflow, completed, 'ready', 'Workspace ready', 2, {
      workspaceCwd,
    });
    completed = advanceRun(workflow, completed, 'ready', 'Implemented', 3);
    completed = advanceRun(
      workflow,
      completed,
      'passed',
      'Verified first work',
      4,
    );

    const restarted = restartRun(
      workflow,
      completed,
      'add the next enhancement',
      ['read', 'bash'],
      5,
    );

    expect(restarted).toMatchObject({
      runId: 'stable-worktree-run',
      iteration: 2,
      input: 'add the next enhancement',
      status: 'running',
      currentStepId: 'prepare',
      visits: { prepare: 1 },
      history: [],
      startCwd: sourceCwd,
      cwd: sourceCwd,
      restartWorkspaceCwd: workspaceCwd,
      stepHandoff: 'Verified first work',
      lastSummary: 'Verified first work',
      reviewedArtifact: '',
      reviewedFeedback: '',
      gateArtifact: '',
      gateFeedback: '',
    });
    expect(isWorkflowRun(restarted)).toBe(true);

    expect(() =>
      advanceRun(
        workflow,
        restarted,
        'ready',
        'Bound a replacement worktree',
        6,
        { workspaceCwd: '/repository/worktrees/replacement' },
      ),
    ).toThrow(/must rebind workspace/);

    const rebound = advanceRun(
      workflow,
      restarted,
      'ready',
      'Reused the existing worktree',
      6,
      { workspaceCwd },
    );
    expect(rebound.cwd).toBe(workspaceCwd);
    expect(rebound.restartWorkspaceCwd).toBeUndefined();
    expect(isWorkflowRun(rebound)).toBe(true);
  });

  test('uses the first iteration for legacy checkpoints without an iteration field', () => {
    const workflow = workspaceWorkflow();
    let completed = createRun(
      workflow,
      'first iteration',
      [],
      'legacy-worktree-run',
      1,
      '/repository/source',
    );
    completed = advanceRun(workflow, completed, 'ready', 'Workspace ready', 2, {
      workspaceCwd: '/repository/worktrees/task',
    });
    completed = advanceRun(workflow, completed, 'ready', 'Implemented', 3);
    completed = advanceRun(workflow, completed, 'passed', 'Verified', 4);

    const restarted = restartRun(
      workflow,
      { ...completed, iteration: undefined },
      '',
      [],
      5,
    );

    expect(restarted.iteration).toBe(2);
    expect(restarted.input).toBe('');
  });
});
