import { describe, expect, test } from 'bun:test';
import { preflightStep } from '../../src/function/preflight/index.ts';
import { loadedWorkflow } from '../helpers.ts';

describe('when testing preflight', () => {
  describe('should satisfy its behavioral contract', () => {
    test('does not require optional tools, MCP selectors, or skills', () => {
      // given
      const workflow = loadedWorkflow({
        version: 1,
        id: 'portable',
        command: 'portable',
        description: 'Portable workflow',
        start: 'run',
        steps: {
          run: {
            prompt: { file: 'run.md' },
            permissions: {
              tools: ['read'],
              mcp: ['gitlab/get_merge_request'],
              skills: ['planning'],
            },
            transitions: { ready: '$done' },
          },
        },
      });

      // when
      const errors = preflightStep(workflow.definition.steps.run!, {
        tools: [],
        commands: [],
        skills: new Set(),
      });

      // then
      expect(errors).toEqual([]);
    });

    test('requires Plannotator only for gates', () => {
      // given
      const workflow = loadedWorkflow({
        version: 1,
        id: 'reviewed',
        command: 'reviewed',
        description: 'Reviewed workflow',
        start: 'plan',
        steps: {
          plan: {
            prompt: { file: 'plan.md' },
            gate: {},
            transitions: {
              ready: '$done',
              handoff: 'plan',
            },
          },
        },
      });
      const step = workflow.definition.steps.plan!;

      // when
      const missing = preflightStep(step, {
        tools: [],
        commands: [],
        skills: new Set(),
      });
      const present = preflightStep(step, {
        tools: [
          {
            name: 'plannotator',
            sourceInfo: { path: '/extensions/plannotator/index.ts' },
          },
        ],
        commands: [],
        skills: new Set(),
      });

      // then
      expect(missing).toEqual([
        'Plannotator is required by this gate, but its extension is not installed or detectable',
      ]);
      expect(present).toEqual([]);
    });
  });
});
