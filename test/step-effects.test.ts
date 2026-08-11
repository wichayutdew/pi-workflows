import { describe, expect, test } from 'bun:test';
import { createRun } from '../src/engine/state.ts';
import { resolveStepEffects } from '../src/harness/step-effects.ts';
import type { WorkflowStepResult } from '../src/runtime/step-result.ts';
import { baseWorkflow, expectTruthy, loadedWorkflow } from './helpers.ts';

function fixture() {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  steps.inspect = {
    ...steps.inspect,
    agent: 'worker',
    workspace: { bindOn: ['ready'], allowedRoots: ['..'] },
  };
  steps.implement = {
    ...steps.implement,
    agent: 'worker',
  };
  const workflow = loadedWorkflow(raw);
  const step = workflow.definition.steps.inspect;
  expectTruthy(step);
  const run = createRun(
    workflow,
    '',
    [],
    'effects-run',
    1,
    '/repository/source',
  );
  return { run, step };
}

const result = (
  outcome: string,
  workspace?: { readonly cwd: string },
): WorkflowStepResult => ({
  version: 1,
  policyDigest: 'policy',
  outcome,
  summary: 'Complete',
  ...(workspace ? { workspace } : {}),
});

describe('when resolving structured workflow step effects', () => {
  test('passes only YAML-authorized path data to the filesystem boundary', () => {
    const { run, step } = fixture();
    const calls: Array<unknown> = [];

    expect(
      resolveStepEffects(
        run,
        step,
        result('ready', { cwd: '/repository/worktrees/task' }),
        {
          resolveWorkspaceDirectory: (options) => {
            calls.push(options);
            return '/canonical/task';
          },
        },
      ),
    ).toEqual({ workspaceCwd: '/canonical/task' });
    expect(calls).toEqual([
      {
        candidateCwd: '/repository/worktrees/task',
        startCwd: '/repository/source',
        allowedRoots: ['..'],
      },
    ]);
  });

  test('requires an authorized result and permits only the same later binding', () => {
    const { run, step } = fixture();
    const dependencies = {
      resolveWorkspaceDirectory: () => '/canonical/other',
    };

    expect(() =>
      resolveStepEffects(run, step, result('ready'), dependencies),
    ).toThrow(/requires a workspace result/);
    expect(() =>
      resolveStepEffects(
        run,
        step,
        result('blocked', { cwd: '/candidate' }),
        dependencies,
      ),
    ).toThrow(/not allowed to bind/);
    expect(() =>
      resolveStepEffects(
        { ...run, startCwd: undefined, cwd: undefined },
        step,
        result('ready', { cwd: '/candidate' }),
        dependencies,
      ),
    ).toThrow(/no starting directory/);

    const boundRun = {
      ...run,
      cwd: '/canonical/first',
      history: [
        {
          stepId: 'inspect',
          stepDigest: 'digest',
          outcome: 'ready',
          summary: 'Prepared',
          workspaceCwd: '/canonical/first',
          completedAt: 2,
        },
      ],
    };
    expect(
      resolveStepEffects(
        boundRun,
        step,
        result('ready', { cwd: '/candidate' }),
        {
          resolveWorkspaceDirectory: () => '/canonical/first',
        },
      ),
    ).toEqual({ workspaceCwd: '/canonical/first' });
    expect(() =>
      resolveStepEffects(
        boundRun,
        step,
        result('ready', { cwd: '/candidate' }),
        dependencies,
      ),
    ).toThrow(/already bound/);
  });
});
