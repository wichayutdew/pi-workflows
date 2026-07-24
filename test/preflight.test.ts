import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightStep } from '../src/preflight.ts';
import { loadedWorkflow } from './helpers.ts';

test('preflight checks required tools, extensions, and skills', () => {
  const workflow = loadedWorkflow({
    version: 1,
    id: 'preflight',
    command: 'preflight',
    description: 'Preflight',
    start: 'run',
    steps: {
      run: {
        subagent: {},
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
  const step = workflow.definition.steps.run!;
  assert.deepEqual(
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
    [],
  );

  const errors = preflightStep(step, {
    tools: [],
    commands: [],
    skills: new Set(),
  });
  assert.match(errors.join('\n'), /required tool "read"/);
  assert.match(errors.join('\n'), /required extension "plannotator"/);
  assert.match(errors.join('\n'), /required skill "planning"/);
  assert.match(errors.join('\n'), /pi-subagents is required/);
});

test('main-agent steps and prompt gates need no optional integration', () => {
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

  assert.deepEqual(
    preflightStep(workflow.definition.steps.plan!, {
      tools: [],
      commands: [],
      skills: new Set(),
    }),
    [],
  );
});

test('Plannotator gates require only the Plannotator integration', () => {
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
  const errors = preflightStep(workflow.definition.steps.plan!, {
    tools: [],
    commands: [],
    skills: new Set(),
  });
  assert.match(errors.join('\n'), /Plannotator is required/);
  assert.doesNotMatch(errors.join('\n'), /pi-subagents/);
});
