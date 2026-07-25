import { describe, expect, test } from 'bun:test';
import { createRun } from '../src/engine/state.ts';
import { createDelegationPlan } from '../src/harness/delegation-plan.ts';
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

const dependencies = {
  createRequestId: () => 'delegation-1',
  currentWorkingDirectory: () => '/repository',
  createDelegationWorkspace: () => ({
    resultDirectory: '/tmp/pi-workflows-step-test',
    capabilityPath: '/tmp/pi-workflows-step-test/capability',
    capabilityToken: 'a'.repeat(64),
    resultPath: '/tmp/pi-workflows-step-test/result.json',
  }),
};

describe('when creating a delegation plan', () => {
  test('copies readonly workflow budgets into the mutable transport shape', () => {
    const workflow = delegatedWorkflow();
    const run = createRun(workflow, 'input', ['read'], 'run-1', 1);
    const step = workflow.definition.steps.inspect;
    expectTruthy(step);

    const plan = createDelegationPlan(
      {
        workflow,
        run,
        step,
        sessionEpoch: 1,
        latestContext: undefined,
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
        latestContext: undefined,
        recovery: undefined,
      },
      dependencies,
    );

    expect(plan).toEqual({
      kind: 'invalid',
      reason: 'Step "inspect" has no subagent configuration',
    });
  });
});
