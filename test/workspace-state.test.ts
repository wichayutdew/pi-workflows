import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createRun, isWorkflowRun } from '../src/engine/state.ts';
import { advanceRun, reconcileRun } from '../src/engine/transitions.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';
import { createDelegationPlan } from '../src/harness/delegation-plan.ts';

function workspaceWorkflow() {
  const raw = baseWorkflow();
  raw.start = 'prepare';
  raw.steps = {
    prepare: {
      prompt: 'Select a workspace',
      subagent: { agent: 'worker' },
      workspace: {
        bindOn: ['ready'],
        allowedRoots: ['..'],
      },
      transitions: {
        ready: 'implement',
        retry: 'prepare',
        blocked: '$pause',
      },
    },
    implement: {
      prompt: 'Implement',
      subagent: { agent: 'worker' },
      transitions: {
        ready: 'verify',
        retry: 'implement',
        blocked: '$pause',
      },
    },
    verify: {
      prompt: 'Verify',
      subagent: { agent: 'reviewer' },
      transitions: {
        passed: '$done',
        failed: 'implement',
        blocked: '$pause',
      },
    },
  };
  return { raw, workflow: loadedWorkflow(raw) };
}

const sessionContext = (cwd: string): ExtensionContext =>
  ({
    cwd,
    sessionManager: { getSessionFile: () => undefined },
  }) as unknown as ExtensionContext;

describe('when persisting a workflow workspace binding', () => {
  test('binds once and carries the selected cwd through downstream cycles', () => {
    const { workflow } = workspaceWorkflow();
    const startCwd = '/repository/source';
    const workspaceCwd = '/repository/worktrees/task';
    let run = createRun(
      workflow,
      'request',
      ['read'],
      'workspace-run',
      1,
      startCwd,
    );

    expect(run.startCwd).toBe(startCwd);
    expect(run.cwd).toBe(startCwd);
    expect(() => advanceRun(workflow, run, 'ready', 'Prepared', 2)).toThrow(
      /requires a validated workspace binding/,
    );

    run = advanceRun(workflow, run, 'ready', 'Prepared', 2, {
      workspaceCwd,
    });
    expect(run.currentStepId).toBe('implement');
    expect(run.cwd).toBe(workspaceCwd);
    expect(run.history[0]?.workspaceCwd).toBe(workspaceCwd);
    const step = workflow.definition.steps.implement;
    if (!step) throw new Error('implement step is missing');
    const plan = createDelegationPlan(
      {
        workflow,
        run,
        step,
        sessionEpoch: 1,
        latestContext: sessionContext(startCwd),
        recovery: undefined,
      },
      {
        createRequestId: () => 'workspace-delegation',
        createDelegationWorkspace: () => ({
          resultDirectory: join(tmpdir(), 'workspace-delegation'),
          capabilityPath: join(tmpdir(), 'workspace-delegation', 'capability'),
          capabilityToken: 'a'.repeat(64),
          resultPath: join(tmpdir(), 'workspace-delegation', 'result.json'),
        }),
        resolveWorkspaceDirectory: ({ candidateCwd }) => candidateCwd,
      },
    );
    expect(plan.kind).toBe('ready');
    if (plan.kind === 'ready') {
      expect(plan.request.cwd).toBe(workspaceCwd);
      expect(plan.active.policy.cwd).toBe(workspaceCwd);
    }
    const movedPlan = createDelegationPlan(
      {
        workflow,
        run,
        step,
        sessionEpoch: 1,
        latestContext: sessionContext(startCwd),
        recovery: undefined,
      },
      {
        createRequestId: () => 'moved-workspace-delegation',
        createDelegationWorkspace: () => ({
          resultDirectory: join(tmpdir(), 'moved-workspace-delegation'),
          capabilityPath: join(
            tmpdir(),
            'moved-workspace-delegation',
            'capability',
          ),
          capabilityToken: 'b'.repeat(64),
          resultPath: join(
            tmpdir(),
            'moved-workspace-delegation',
            'result.json',
          ),
        }),
        resolveWorkspaceDirectory: ({ candidateCwd, allowedRoots }) =>
          allowedRoots[0] === '.' ? candidateCwd : '/repository/outside/task',
      },
    );
    expect(movedPlan).toEqual({
      kind: 'invalid',
      reason:
        'Workflow workspace no longer resolves to the bound canonical directory',
    });

    expect(() =>
      advanceRun(workflow, run, 'retry', 'Retry', 3, {
        workspaceCwd,
      }),
    ).toThrow(/cannot bind a workspace/);
    run = advanceRun(workflow, run, 'ready', 'Implemented', 3);
    run = advanceRun(workflow, run, 'failed', 'Fix finding', 4);
    expect(run.currentStepId).toBe('implement');
    expect(run.cwd).toBe(workspaceCwd);
    expect(isWorkflowRun(run)).toBe(true);
  });

  test('reaffirms the same binding after a bounded workspace refresh cycle', () => {
    const { raw } = workspaceWorkflow();
    const steps = raw.steps as Record<string, Record<string, unknown>>;
    steps.prepare = {
      ...steps.prepare,
      transitions: {
        ready: 'plan',
        retry: 'prepare',
        blocked: '$pause',
      },
    };
    steps.plan = {
      prompt: 'Inspect the prepared workspace',
      subagent: { agent: 'planner' },
      transitions: {
        ready: 'implement',
        'workspace-refresh': 'prepare',
        blocked: '$pause',
      },
    };
    const workflow = loadedWorkflow(raw);
    const workspaceCwd = '/repository/worktrees/task';
    let run = createRun(
      workflow,
      'request',
      ['read'],
      'workspace-refresh-run',
      1,
      '/repository/source',
    );

    run = advanceRun(workflow, run, 'ready', 'Initially prepared', 2, {
      workspaceCwd,
    });
    run = advanceRun(
      workflow,
      run,
      'workspace-refresh',
      'Refresh the same workspace',
      3,
    );
    expect(run.currentStepId).toBe('prepare');
    expect(run.cwd).toBe(workspaceCwd);

    run = advanceRun(workflow, run, 'ready', 'Workspace refreshed', 4, {
      workspaceCwd,
    });

    expect(run.currentStepId).toBe('plan');
    expect(run.cwd).toBe(workspaceCwd);
    expect(run.visits.prepare).toBe(2);
    expect(
      run.history
        .filter((entry) => entry.workspaceCwd)
        .map((entry) => entry.workspaceCwd),
    ).toEqual([workspaceCwd, workspaceCwd]);
    expect(isWorkflowRun(run)).toBe(true);
  });

  test('rejects checkpoints whose current cwd disagrees with binding history', () => {
    const { workflow } = workspaceWorkflow();
    let run = createRun(
      workflow,
      '',
      [],
      'invalid-workspace-state',
      1,
      '/repository/source',
    );
    run = advanceRun(workflow, run, 'ready', 'Prepared', 2, {
      workspaceCwd: '/repository/worktrees/task',
    });

    expect(isWorkflowRun(run)).toBe(true);
    expect(isWorkflowRun({ ...run, cwd: '/repository/other' })).toBe(false);
    expect(isWorkflowRun({ ...run, startCwd: undefined })).toBe(false);
    expect(
      isWorkflowRun({
        ...run,
        history: [
          ...run.history,
          {
            stepId: 'other',
            stepDigest: 'digest',
            outcome: 'done',
            summary: 'Changed workspace',
            workspaceCwd: '/repository/worktrees/other',
            completedAt: 3,
          },
        ],
        cwd: '/repository/worktrees/other',
      }),
    ).toBe(false);
  });

  test('reconciliation rolls back only when it truncates the binding entry', () => {
    const { raw, workflow } = workspaceWorkflow();
    const startCwd = '/repository/source';
    const workspaceCwd = '/repository/worktrees/task';
    let run = createRun(workflow, '', [], 'workspace-reconcile', 1, startCwd);
    run = advanceRun(workflow, run, 'ready', 'Prepared', 2, {
      workspaceCwd,
    });
    run = advanceRun(workflow, run, 'ready', 'Implemented', 3);

    const laterChange = structuredClone(raw);
    const laterSteps = laterChange.steps as Record<
      string,
      Record<string, unknown>
    >;
    laterSteps.implement = {
      ...laterSteps.implement,
      prompt: 'Changed implementation',
    };
    const retained = reconcileRun(run, loadedWorkflow(laterChange), 4);
    expect(retained.restartedStep).toBe('implement');
    expect(retained.run?.cwd).toBe(workspaceCwd);
    expect(retained.run?.history[0]?.workspaceCwd).toBe(workspaceCwd);

    const bindingChange = structuredClone(raw);
    const bindingSteps = bindingChange.steps as Record<
      string,
      Record<string, unknown>
    >;
    bindingSteps.prepare = {
      ...bindingSteps.prepare,
      prompt: 'Changed workspace preparation',
    };
    const rolledBack = reconcileRun(run, loadedWorkflow(bindingChange), 5);
    expect(rolledBack.restartedStep).toBe('prepare');
    expect(rolledBack.run?.cwd).toBe(startCwd);
    expect(rolledBack.run?.history).toHaveLength(0);
  });
});
