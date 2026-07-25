import { describe, expect, test } from 'bun:test';
import {
  buildDelegatedStepTask,
  buildMainStepTask,
  buildMainWorkflowNotice,
  renderTemplate,
} from '../src/prompt.ts';
import { createRun } from '../src/engine/state.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';

describe('when testing prompt', () => {
  describe('should satisfy its behavioral contract', () => {
    test('renders workflow prompts, notices, and an explicit missing-step error', () => {
      // given
      const workflow = loadedWorkflow();
      // when
      const run = createRun(workflow, 'request', ['read'], 'run-1', 1);

      // then
      expect(
        renderTemplate('Hello {{ name }} {{missing}}', { name: 'Pi' }),
      ).toBe('Hello Pi ');
      expect(buildMainStepTask(workflow, run)).toMatch(
        /Main-agent declarative workflow step/,
      );
      expect(buildDelegatedStepTask(workflow, run, 'policy envelope')).toMatch(
        /policy envelope/,
      );
      expect(buildMainWorkflowNotice(workflow, run)).toMatch(
        /Active main-agent workflow/,
      );

      const delegatedRaw = baseWorkflow();
      const steps = delegatedRaw.steps as Record<
        string,
        Record<string, unknown>
      >;
      steps.inspect = { ...steps.inspect, subagent: {} };
      const delegatedWorkflow = loadedWorkflow(delegatedRaw);
      const delegatedRun = createRun(delegatedWorkflow, '', [], 'run-2', 1);
      expect(buildMainWorkflowNotice(delegatedWorkflow, delegatedRun)).toMatch(
        /Active subagent workflow/,
      );
      expect(() =>
        buildMainWorkflowNotice(workflow, { ...run, currentStepId: 'missing' }),
      ).toThrow(/unknown workflow step/);
    });
  });
});
