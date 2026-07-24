import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDelegatedStepTask,
  buildMainStepTask,
  buildMainWorkflowNotice,
  renderTemplate,
} from '../src/prompt.ts';
import { createRun } from '../src/engine/state.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';

test('renders workflow prompts, notices, and an explicit missing-step error', () => {
  const workflow = loadedWorkflow();
  const run = createRun(workflow, 'request', ['read'], 'run-1', 1);

  assert.equal(
    renderTemplate('Hello {{ name }} {{missing}}', { name: 'Pi' }),
    'Hello Pi ',
  );
  assert.match(
    buildMainStepTask(workflow, run),
    /Main-agent declarative workflow step/,
  );
  assert.match(
    buildDelegatedStepTask(workflow, run, 'policy envelope'),
    /policy envelope/,
  );
  assert.match(
    buildMainWorkflowNotice(workflow, run),
    /Active main-agent workflow/,
  );

  const delegatedRaw = baseWorkflow();
  const steps = delegatedRaw.steps as Record<string, Record<string, unknown>>;
  steps.inspect = { ...steps.inspect, subagent: {} };
  const delegatedWorkflow = loadedWorkflow(delegatedRaw);
  const delegatedRun = createRun(delegatedWorkflow, '', [], 'run-2', 1);
  assert.match(
    buildMainWorkflowNotice(delegatedWorkflow, delegatedRun),
    /Active subagent workflow/,
  );
  assert.throws(
    () =>
      buildMainWorkflowNotice(workflow, { ...run, currentStepId: 'missing' }),
    /unknown workflow step/,
  );
});
