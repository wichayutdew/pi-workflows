import { RESERVED_COMMAND_NAMES } from '../../command-names.ts';
import {
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type WorkflowStep,
} from '../types.ts';
import {
  IDENTIFIER_PATTERN,
  isJsonObject,
  readInteger,
  readString,
  rejectUnknownKeys,
  type ValidationErrors,
  type ValidationResult,
} from './shared.ts';
import { parseWorkflowStep } from './step.ts';

function parseSteps(
  value: unknown,
  errors: ValidationErrors,
): Record<string, WorkflowStep> {
  if (!isJsonObject(value)) {
    errors.push('workflow.steps: expected an object');
    return {};
  }

  const steps = Object.entries(value).reduce<Record<string, WorkflowStep>>(
    (result, [stepId, stepValue]) => {
      if (!IDENTIFIER_PATTERN.test(stepId)) {
        errors.push(`workflow.steps: invalid step id "${stepId}"`);
        return result;
      }
      const step = parseWorkflowStep(
        stepValue,
        stepId,
        `workflow.steps.${stepId}`,
        errors,
      );
      return step ? { ...result, [stepId]: step } : result;
    },
    {},
  );
  if (Object.keys(steps).length === 0) {
    errors.push('workflow.steps: at least one step is required');
  }
  return steps;
}

function validateGraph(
  steps: Readonly<Record<string, WorkflowStep>>,
  start: string | undefined,
  errors: ValidationErrors,
): void {
  if (start && !Object.hasOwn(steps, start)) {
    errors.push(`workflow.start: unknown step "${start}"`);
  }
  Object.entries(steps).forEach(([stepId, step]) => {
    Object.entries(step.transitions).forEach(([outcome, target]) => {
      if (
        target !== '$done' &&
        target !== '$pause' &&
        !Object.hasOwn(steps, target)
      ) {
        errors.push(
          `workflow.steps.${stepId}.transitions.${outcome}: unknown target "${target}"`,
        );
      }
    });
  });
  validateWorkspaceGraph(steps, errors);
}

function validateWorkspaceGraph(
  steps: Readonly<Record<string, WorkflowStep>>,
  errors: ValidationErrors,
): void {
  const binders = Object.entries(steps).filter(
    (
      entry,
    ): entry is [
      string,
      WorkflowStep & { workspace: NonNullable<WorkflowStep['workspace']> },
    ] => entry[1].workspace !== undefined,
  );
  const firstBinderId = binders[0]?.[0];

  binders.forEach(([stepId, step], index) => {
    const workspacePath = `workflow.steps.${stepId}.workspace`;
    if (index > 0) {
      errors.push(
        `${workspacePath}: only one workspace-binding step is allowed; "${firstBinderId}" also configures workspace binding`,
      );
    }
    if (step.gate) {
      errors.push(
        `${workspacePath}: workspace binding is not allowed on a gated step`,
      );
    }

    const downstream = step.workspace.bindOn.flatMap((outcome) => {
      const target = step.transitions[outcome];
      if (target === '$done' || target === '$pause') {
        errors.push(
          `workflow.steps.${stepId}.transitions.${outcome}: workspace-binding outcome must target an ordinary step`,
        );
        return [];
      }
      return target && Object.hasOwn(steps, target) ? [target] : [];
    });
    validateWorkspaceDescendants(steps, downstream);
  });
}

function validateWorkspaceDescendants(
  steps: Readonly<Record<string, WorkflowStep>>,
  initialStepIds: ReadonlyArray<string>,
): void {
  const pending = [...initialStepIds];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const stepId = pending.pop();
    if (!stepId || visited.has(stepId)) continue;
    visited.add(stepId);
    const step = steps[stepId];
    if (!step) continue;
    Object.values(step.transitions).forEach((target) => {
      if (
        target !== '$done' &&
        target !== '$pause' &&
        Object.hasOwn(steps, target) &&
        !visited.has(target)
      ) {
        pending.push(target);
      }
    });
  }
}

/** Validate and normalize an untrusted workflow definition. */
export function validateWorkflow(
  value: unknown,
): ValidationResult<WorkflowDefinition> {
  const errors: ValidationErrors = [];
  if (!isJsonObject(value)) {
    return { errors: ['workflow: expected an object'] };
  }
  rejectUnknownKeys(
    value,
    [
      '$schema',
      'version',
      'id',
      'command',
      'description',
      'start',
      'maxStepVisits',
      'summaryMaxChars',
      'steps',
    ],
    'workflow',
    errors,
  );
  if (value.$schema !== undefined && typeof value.$schema !== 'string') {
    errors.push('workflow.$schema: expected a string');
  }
  if (value.version !== WORKFLOW_SCHEMA_VERSION) {
    errors.push(`workflow.version: expected ${WORKFLOW_SCHEMA_VERSION}`);
  }

  const id = readString(value.id, 'workflow.id', errors, {
    pattern: IDENTIFIER_PATTERN,
  });
  const command = readString(value.command, 'workflow.command', errors, {
    pattern: IDENTIFIER_PATTERN,
  });
  const description = readString(
    value.description,
    'workflow.description',
    errors,
  );
  const start = readString(value.start, 'workflow.start', errors, {
    pattern: IDENTIFIER_PATTERN,
  });
  const maxStepVisits = readInteger(
    value.maxStepVisits,
    5,
    'workflow.maxStepVisits',
    errors,
    { min: 1, max: 100 },
  );
  const summaryMaxChars = readInteger(
    value.summaryMaxChars,
    4_000,
    'workflow.summaryMaxChars',
    errors,
    { min: 100, max: 50_000 },
  );

  if (command && RESERVED_COMMAND_NAMES.has(command)) {
    errors.push(
      `workflow.command: "${command}" is reserved by Pi or the harness`,
    );
  }

  const steps = parseSteps(value.steps, errors);
  validateGraph(steps, start, errors);
  if (errors.length > 0 || !id || !command || !description || !start) {
    return { errors };
  }
  return {
    value: {
      version: WORKFLOW_SCHEMA_VERSION,
      id,
      command,
      description,
      start,
      maxStepVisits,
      summaryMaxChars,
      steps,
    },
    errors,
  };
}
