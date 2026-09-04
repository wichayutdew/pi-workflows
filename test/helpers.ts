import { expect } from 'bun:test';
import { digest } from '../src/function/digest.ts';
import type {
  LoadedWorkflow,
  WorkflowDefinition,
} from '../src/domain/index.ts';
import { validateWorkflow } from '../src/function/config/index.ts';
import {
  digestWorkflowStep,
  digestWorkflowStepStructure,
} from '../src/function/config/step-digests.ts';

export function expectTruthy<T>(value: T): asserts value {
  expect(value).toBeTruthy();
}

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
        agent: 'scout',
        permissions: {
          tools: ['read', 'bash'],
          bash: {
            mode: 'allow-list',
            allow: [{ executable: 'git', argsPrefix: ['status'] }],
          },
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
        agent: 'worker',
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
  expect(result.value).toBeTruthy();
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
      digestWorkflowStep(step, prompts[stepId] ?? ''),
    ]),
  );
  const stepStructuralDigests = Object.fromEntries(
    Object.entries(definition.steps).map(([stepId, step]) => [
      stepId,
      digestWorkflowStepStructure(step),
    ]),
  );
  return {
    definition,
    prompts,
    stepDigests,
    stepStructuralDigests,
    digest: digest({ definition, prompts }),
    sourcePath: '/tmp/example.workflow.yaml',
    sourceKind: 'user',
  };
}
