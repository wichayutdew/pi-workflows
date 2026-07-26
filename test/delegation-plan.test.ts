import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createRun } from '../src/engine/state.ts';
import { createDelegationPlan } from '../src/harness/delegation-plan.ts';
import { extractChildPolicy } from '../src/integrations/subagents/protocol.ts';
import { baseWorkflow, expectTruthy, loadedWorkflow } from './helpers.ts';

function delegatedWorkflow() {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  steps.inspect = {
    ...steps.inspect,
    subagent: {
      agent: 'worker',
      turnBudget: { maxTurns: 5, graceTurns: 1 },
      toolBudget: { hard: 8, soft: 5, block: ['write'] },
    },
  };
  return loadedWorkflow(raw);
}

function workspaceDelegatedWorkflow() {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  steps.inspect = {
    ...steps.inspect,
    subagent: { agent: 'workspace-preparer' },
    workspace: {
      bindOn: ['ready'],
      allowedRoots: ['../worktrees'],
    },
  };
  steps.implement = {
    ...steps.implement,
    subagent: { agent: 'worker' },
  };
  return loadedWorkflow(raw);
}

const dependencies = {
  createRequestId: () => 'delegation-1',
  createDelegationWorkspace: () => ({
    resultDirectory: join(tmpdir(), 'pi-workflows-step-test'),
    capabilityPath: join(tmpdir(), 'pi-workflows-step-test', 'capability'),
    capabilityToken: 'a'.repeat(64),
    resultPath: join(tmpdir(), 'pi-workflows-step-test', 'result.json'),
  }),
  resolveWorkspaceDirectory: ({
    candidateCwd,
  }: {
    readonly candidateCwd: string;
  }) => candidateCwd,
};

const sessionContext = (cwd: string): ExtensionContext =>
  ({
    cwd,
    sessionManager: { getSessionFile: () => undefined },
  }) as unknown as ExtensionContext;

describe('when creating a delegation plan', () => {
  test('copies readonly workflow budgets into the mutable transport shape', () => {
    const workflow = delegatedWorkflow();
    const run = createRun(
      workflow,
      'input',
      ['read'],
      'run-1',
      1,
      '/repository',
    );
    const step = workflow.definition.steps.inspect;
    expectTruthy(step);

    const plan = createDelegationPlan(
      {
        workflow,
        run,
        step,
        sessionEpoch: 1,
        latestContext: sessionContext('/repository'),
        recovery: undefined,
      },
      dependencies,
    );

    expect(plan.kind).toBe('ready');
    if (plan.kind !== 'ready') return;
    expect(plan.request.turnBudget).toEqual({
      maxTurns: 5,
      graceTurns: 1,
    });
    expect(plan.request.toolBudget).toEqual({
      hard: 8,
      soft: 5,
      block: ['write'],
    });
  });

  test('rejects a main-agent step at the delegation boundary', () => {
    const workflow = loadedWorkflow();
    const run = createRun(workflow, 'input', ['read'], 'run-1', 1);
    const step = workflow.definition.steps.inspect;
    expectTruthy(step);

    const plan = createDelegationPlan(
      {
        workflow,
        run,
        step,
        sessionEpoch: 1,
        latestContext: sessionContext('/existing-worktree'),
        recovery: undefined,
      },
      dependencies,
    );

    expect(plan).toEqual({
      kind: 'invalid',
      reason: 'Step "inspect" has no subagent configuration',
    });
  });

  test('fails closed when a legacy run has no captured directory', () => {
    const workflow = delegatedWorkflow();
    const run = createRun(workflow, 'input', ['read'], 'run-1', 1);
    const step = workflow.definition.steps.inspect;
    expectTruthy(step);

    expect(
      createDelegationPlan(
        {
          workflow,
          run,
          step,
          sessionEpoch: 1,
          latestContext: undefined,
          recovery: undefined,
        },
        dependencies,
      ),
    ).toEqual({
      kind: 'invalid',
      reason:
        'Workflow run has no captured working directory; abort it and start a new run',
    });
  });

  test('keeps every delegated visit in the workflow starting directory', () => {
    const workflow = delegatedWorkflow();
    const run = createRun(
      workflow,
      'input',
      ['read'],
      'run-1',
      1,
      '/existing-worktree',
    );
    const step = workflow.definition.steps.inspect;
    expectTruthy(step);

    const plan = createDelegationPlan(
      {
        workflow,
        run,
        step,
        sessionEpoch: 1,
        latestContext: sessionContext('/existing-worktree'),
        recovery: undefined,
      },
      dependencies,
    );

    expect(plan.kind).toBe('ready');
    if (plan.kind !== 'ready') return;
    expect(plan.request.cwd).toBe('/existing-worktree');
    expect(plan.active.policy.cwd).toBe('/existing-worktree');
    expect(extractChildPolicy(plan.request.task)?.policy.cwd).toBe(
      '/existing-worktree',
    );
    expect(plan.active.policy).not.toHaveProperty('repositoryCwd');

    const otherRun = createRun(
      workflow,
      'input',
      ['read'],
      'run-1',
      1,
      '/other-worktree',
    );
    const otherPlan = createDelegationPlan(
      {
        workflow,
        run: otherRun,
        step,
        sessionEpoch: 1,
        latestContext: sessionContext('/other-worktree'),
        recovery: undefined,
      },
      dependencies,
    );
    expect(otherPlan.kind).toBe('ready');
    if (otherPlan.kind !== 'ready') return;
    expect(otherPlan.active.policy.policyDigest).not.toBe(
      plan.active.policy.policyDigest,
    );

    const redirected = createDelegationPlan(
      {
        workflow,
        run: {
          ...run,
          startCwd: '/forged-worktree',
          cwd: '/forged-worktree',
        },
        step,
        sessionEpoch: 1,
        latestContext: sessionContext('/existing-worktree'),
        recovery: undefined,
      },
      dependencies,
    );
    expect(redirected).toEqual({
      kind: 'invalid',
      reason:
        'Current session cwd does not match the captured workflow start directory',
    });
  });

  test('binds workspace result rules into child policy and output schema', () => {
    const workflow = workspaceDelegatedWorkflow();
    const run = createRun(
      workflow,
      'input',
      ['read'],
      'run-workspace',
      1,
      '/repository',
    );
    const step = workflow.definition.steps.inspect;
    expectTruthy(step);

    const plan = createDelegationPlan(
      {
        workflow,
        run,
        step,
        sessionEpoch: 1,
        latestContext: sessionContext('/repository'),
        recovery: undefined,
      },
      dependencies,
    );

    expect(plan.kind).toBe('ready');
    if (plan.kind !== 'ready') return;
    expect(plan.active.policy.workspace).toEqual({
      bindOn: ['ready'],
      allowedRoots: ['../worktrees'],
    });
    expect(extractChildPolicy(plan.request.task)?.policy.workspace).toEqual(
      plan.active.policy.workspace,
    );
    const outputSchema = plan.request.outputSchema;
    expectTruthy(outputSchema);
    expect(
      (outputSchema.properties as Record<string, unknown>).workspace,
    ).toBeDefined();
  });
});
