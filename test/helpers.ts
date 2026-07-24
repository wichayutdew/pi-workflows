import assert from 'node:assert/strict';
import { digest } from '../src/digest.ts';
import type {
  LoadedWorkflow,
  WorkflowDefinition,
} from '../src/config/types.ts';
import { validateWorkflow } from '../src/config/validate.ts';

export function baseWorkflow(): Record<string, unknown> {
  return {
    version: 1,
    id: 'example',
    command: 'example',
    description: 'Example workflow',
    start: 'inspect',
    maxStepVisits: 3,
    steps: {
      inspect: {
        prompt: 'Inspect {{workflow.input}}',
        permissions: {
          tools: ['read', 'bash'],
          bash: { mode: 'read-only' },
        },
        requires: {
          tools: ['read'],
        },
        transitions: {
          ready: 'implement',
          blocked: '$pause',
        },
      },
      implement: {
        prompt: 'Implement',
        permissions: {
          tools: ['read', 'edit'],
        },
        transitions: {
          done: '$done',
        },
      },
    },
  };
}

export function loadedWorkflow(raw = baseWorkflow()): LoadedWorkflow {
  const result = validateWorkflow(raw);
  assert.ok(result.value, result.errors.join('\n'));
  const definition = result.value as WorkflowDefinition;
  const prompts = Object.fromEntries(
    Object.entries(definition.steps).map(([stepId, step]) => [
      stepId,
      'inline' in step.prompt ? step.prompt.inline : `prompt:${stepId}`,
    ]),
  );
  const stepDigests = Object.fromEntries(
    Object.entries(definition.steps).map(([stepId, step]) => [
      stepId,
      digest({ step, prompt: prompts[stepId] }),
    ]),
  );
  return {
    definition,
    prompts,
    stepDigests,
    digest: digest({ definition, prompts }),
    sourcePath: '/tmp/example.workflow.yaml',
    sourceKind: 'user',
  };
}
