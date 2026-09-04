import { describe, expect, test } from 'bun:test';
import { preflightStep } from '../../src/function/preflight/index.ts';
import { loadedWorkflow } from '../helpers.ts';

describe('when testing preflight', () => {
  describe('should satisfy its behavioral contract', () => {
    test('preflight checks required tools, extensions, and skills', () => {
      // given
      const workflow = loadedWorkflow({
        version: 1,
        id: 'preflight',
        command: 'preflight',
        description: 'Preflight',
        start: 'run',
        steps: {
          run: {
            agent: 'worker',
            prompt: 'Run',
            permissions: {
              tools: ['read'],
              extensions: ['plannotator'],
              skills: ['planning'],
            },
            requires: {
              tools: ['read'],
              extensions: ['plannotator'],
              skills: ['planning'],
            },
            transitions: { done: '$done' },
          },
        },
      });
      // when
      const step = workflow.definition.steps.run!;
      // then
      expect(
        preflightStep(step, {
          tools: [
            { name: 'read', sourceInfo: { source: 'builtin' } },
            {
              name: 'subagent',
              sourceInfo: { path: '/packages/pi-subagents/index.ts' },
            },
          ],
          commands: [
            {
              name: 'plannotator',
              sourceInfo: { path: '/packages/plannotator/index.ts' },
            },
          ],
          skills: new Set(['planning']),
        }),
      ).toEqual([]);

      const errors = preflightStep(step, {
        tools: [],
        commands: [],
        skills: new Set(),
      });
      expect(errors.join('\n')).toMatch(/required tool "read"/);
      expect(errors.join('\n')).toMatch(/required extension "plannotator"/);
      expect(errors.join('\n')).toMatch(/required skill "planning"/);
    });

    test('main-agent steps and prompt gates need no optional integration', () => {
      // given
      // when
      const workflow = loadedWorkflow({
        version: 1,
        id: 'portable',
        command: 'portable',
        description: 'Portable workflow',
        start: 'plan',
        steps: {
          plan: {
            prompt: 'Plan',
            gate: {
              submitOutcome: 'submit',
              approvedOutcome: 'approved',
              rejectedOutcome: 'rejected',
            },
            transitions: {
              approved: '$done',
              rejected: 'plan',
            },
          },
        },
      });

      // then
      expect(
        preflightStep(workflow.definition.steps.plan!, {
          tools: [],
          commands: [],
          skills: new Set(),
        }),
      ).toEqual([]);
    });

    test('Plannotator gates require only the Plannotator integration', () => {
      // given
      const workflow = loadedWorkflow({
        version: 1,
        id: 'reviewed',
        command: 'reviewed',
        description: 'Reviewed workflow',
        start: 'plan',
        steps: {
          plan: {
            prompt: 'Plan',
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
        },
      });
      // when
      const errors = preflightStep(workflow.definition.steps.plan!, {
        tools: [],
        commands: [],
        skills: new Set(),
      });
      // then
      expect(errors.join('\n')).toMatch(/Plannotator is required/);
      expect(errors.join('\n')).not.toMatch(/pi-subagents/);
    });

    test('MCP selectors are optional unless the proxy tool is required', () => {
      // given
      const workflow = loadedWorkflow({
        version: 1,
        id: 'mcp',
        command: 'mcp',
        description: 'MCP workflow',
        start: 'run',
        steps: {
          run: {
            prompt: 'Run',
            permissions: { mcp: ['gitlab/get_merge_request'] },
            transitions: { done: '$done' },
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

      const requiredWorkflow = loadedWorkflow({
        version: 1,
        id: 'mcp-required',
        command: 'mcp-required',
        description: 'Required MCP workflow',
        start: 'run',
        steps: {
          run: {
            prompt: 'Run',
            permissions: { mcp: ['gitlab/get_merge_request'] },
            requires: { tools: ['mcp'] },
            transitions: { done: '$done' },
          },
        },
      });
      expect(
        preflightStep(requiredWorkflow.definition.steps.run!, {
          tools: [],
          commands: [],
          skills: new Set(),
        }),
      ).toEqual(['required tool "mcp" is not installed']);

      const plannotatorWorkflow = loadedWorkflow({
        version: 1,
        id: 'plannotator-present',
        command: 'plannotator-present',
        description: 'Plannotator present',
        start: 'run',
        steps: {
          run: {
            prompt: 'Run',
            gate: {
              provider: 'plannotator',
              submitOutcome: 'submit',
              approvedOutcome: 'approved',
              rejectedOutcome: 'rejected',
            },
            transitions: { approved: '$done', rejected: 'run' },
          },
        },
      });
      expect(
        preflightStep(plannotatorWorkflow.definition.steps.run!, {
          tools: [
            {
              name: 'plannotator',
              sourceInfo: { path: '/extensions/plannotator/index.ts' },
            },
          ],
          commands: [],
          skills: new Set(),
        }),
      ).toEqual([]);
    });
  });
});
