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
      steps.inspect = {
        ...steps.inspect,
        subagent: { agent: 'scout' },
        prompt: 'Use this handoff: {{last.summary}}',
      };
      const delegatedWorkflow = loadedWorkflow(delegatedRaw);
      const delegatedRun = {
        ...createRun(delegatedWorkflow, '', [], 'run-2', 1),
        stepHandoff: 'compact previous-step result',
        lastSummary: 'compact previous-step result',
      };
      const delegatedTask = buildDelegatedStepTask(
        delegatedWorkflow,
        delegatedRun,
        'policy envelope',
      );
      expect(delegatedTask).toMatch(/Agent profile: scout/);
      expect(delegatedTask).toMatch(/Context: fresh workflow-step context/);
      expect(delegatedTask.match(/compact previous-step result/g)).toHaveLength(
        1,
      );
      expect(delegatedTask).toMatch(/Never call `contact_supervisor`/);
      expect(delegatedTask).toMatch(/incoming handoff as the final/);
      expect(delegatedTask).toMatch(/use a pause outcome \(blocked\)/);
      expect(delegatedTask).toMatch(/Call `structured_output` exactly once/);

      const noPauseRaw = baseWorkflow();
      const noPauseSteps = noPauseRaw.steps as Record<
        string,
        Record<string, unknown>
      >;
      noPauseSteps.inspect = {
        ...noPauseSteps.inspect,
        subagent: { agent: 'worker' },
        transitions: { done: '$done' },
      };
      delete noPauseSteps.implement;
      const noPauseWorkflow = loadedWorkflow(noPauseRaw);
      const noPauseRun = createRun(
        noPauseWorkflow,
        'finish without questions',
        [],
        'run-3',
        1,
      );
      const noPauseTask = buildDelegatedStepTask(
        noPauseWorkflow,
        noPauseRun,
        'policy envelope',
      );
      expect(noPauseTask).toMatch(
        /do not fabricate success or call the completion tool/,
      );
      expect(noPauseTask).not.toMatch(/use a pause outcome/);

      expect(buildMainWorkflowNotice(delegatedWorkflow, delegatedRun)).toMatch(
        /Active subagent workflow/,
      );
      expect(() =>
        buildMainWorkflowNotice(workflow, { ...run, currentStepId: 'missing' }),
      ).toThrow(/unknown workflow step/);
    });
  });
});
