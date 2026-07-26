import { isAbsolute, win32 } from 'node:path';
import {
  MAX_WORKSPACE_ALLOWED_ROOTS,
  MAX_WORKSPACE_PATH_CHARS,
  type PromptSpec,
  type StepWorkspaceBinding,
  type WorkflowGate,
  type WorkflowStep,
} from '../types.ts';
import { parsePermissions, parseRequirements } from './permissions.ts';
import {
  isJsonObject,
  OUTCOME_PATTERN,
  readInteger,
  readString,
  readStringList,
  rejectUnknownKeys,
  type ValidationErrors,
} from './shared.ts';
import { parseStepSubagent } from './subagent.ts';

function parsePrompt(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): PromptSpec | undefined {
  if (typeof value === 'string') {
    const inline = readString(value, path, errors);
    return inline ? { inline } : undefined;
  }
  if (!isJsonObject(value)) {
    errors.push(`${path}: expected a string or an object`);
    return undefined;
  }
  rejectUnknownKeys(value, ['file'], path, errors);
  const file = readString(value.file, `${path}.file`, errors);
  if (!file) return undefined;
  if (file.startsWith('/') || file.includes('\0')) {
    errors.push(`${path}.file: expected a safe relative path`);
    return undefined;
  }
  return { file };
}

function parseTransitions(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): Record<string, string> {
  if (!isJsonObject(value)) {
    errors.push(`${path}: expected an object`);
    return {};
  }
  const transitions = Object.entries(value).reduce<Record<string, string>>(
    (result, [outcome, targetValue]) => {
      if (!OUTCOME_PATTERN.test(outcome)) {
        errors.push(`${path}: invalid outcome "${outcome}"`);
        return result;
      }
      const target = readString(targetValue, `${path}.${outcome}`, errors);
      return target ? { ...result, [outcome]: target } : result;
    },
    {},
  );
  if (Object.keys(transitions).length === 0) {
    errors.push(`${path}: at least one transition is required`);
  }
  return transitions;
}

function parseGate(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): WorkflowGate | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    errors.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(
    value,
    [
      'provider',
      'submitOutcome',
      'approvedOutcome',
      'rejectedOutcome',
      'timeoutMs',
    ],
    path,
    errors,
  );

  const providerValue =
    value.provider === undefined
      ? 'prompt'
      : readString(value.provider, `${path}.provider`, errors);
  const provider =
    providerValue === 'prompt' || providerValue === 'plannotator'
      ? providerValue
      : undefined;
  if (!provider) {
    errors.push(`${path}.provider: expected prompt or plannotator`);
  }
  const submitOutcome = readString(
    value.submitOutcome,
    `${path}.submitOutcome`,
    errors,
    { pattern: OUTCOME_PATTERN },
  );
  const approvedOutcome = readString(
    value.approvedOutcome,
    `${path}.approvedOutcome`,
    errors,
    { pattern: OUTCOME_PATTERN },
  );
  const rejectedOutcome = readString(
    value.rejectedOutcome,
    `${path}.rejectedOutcome`,
    errors,
    { pattern: OUTCOME_PATTERN },
  );
  if (provider === 'prompt' && value.timeoutMs !== undefined) {
    errors.push(`${path}.timeoutMs: only valid with provider "plannotator"`);
  }
  if (!submitOutcome || !approvedOutcome || !rejectedOutcome || !provider) {
    return undefined;
  }
  if (approvedOutcome === rejectedOutcome) {
    errors.push(`${path}: approvedOutcome and rejectedOutcome must differ`);
  }

  return provider === 'prompt'
    ? {
        provider,
        submitOutcome,
        approvedOutcome,
        rejectedOutcome,
      }
    : {
        provider,
        submitOutcome,
        approvedOutcome,
        rejectedOutcome,
        timeoutMs: readInteger(
          value.timeoutMs,
          30_000,
          `${path}.timeoutMs`,
          errors,
          { min: 1_000, max: 30_000 },
        ),
      };
}

function parseWorkspaceRoots(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): Array<string> {
  if (value === undefined) return ['.'];
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array of relative paths`);
    return [];
  }
  if (value.length > MAX_WORKSPACE_ALLOWED_ROOTS) {
    errors.push(
      `${path}: at most ${MAX_WORKSPACE_ALLOWED_ROOTS} relative paths are allowed`,
    );
  }

  const roots = value
    .slice(0, MAX_WORKSPACE_ALLOWED_ROOTS)
    .reduce<Array<string>>((result, item, index) => {
      const itemPath = `${path}[${index}]`;
      if (typeof item !== 'string' || !item || item.trim() !== item) {
        errors.push(`${itemPath}: expected a non-empty relative path`);
        return result;
      }
      const root = item;
      if (root.length > MAX_WORKSPACE_PATH_CHARS) {
        errors.push(
          `${itemPath}: path exceeds ${MAX_WORKSPACE_PATH_CHARS} characters`,
        );
        return result;
      }
      if (
        root.includes('\0') ||
        isAbsolute(root) ||
        win32.parse(root).root !== ''
      ) {
        errors.push(`${itemPath}: expected a relative path`);
        return result;
      }
      if (result.includes(root)) {
        errors.push(`${itemPath}: duplicate value "${root}"`);
        return result;
      }
      return [...result, root];
    }, []);
  if (roots.length === 0) {
    errors.push(`${path}: at least one relative path is required`);
  }
  return roots;
}

function parseWorkspace(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): StepWorkspaceBinding | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    errors.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(value, ['bindOn', 'allowedRoots'], path, errors);
  const bindOn = readStringList(
    value.bindOn,
    `${path}.bindOn`,
    errors,
    OUTCOME_PATTERN,
  );
  if (bindOn.length === 0) {
    errors.push(`${path}.bindOn: at least one outcome is required`);
  }
  const allowedRoots = parseWorkspaceRoots(
    value.allowedRoots,
    `${path}.allowedRoots`,
    errors,
  );
  return { bindOn, allowedRoots };
}

/** Parse one workflow step and validate relationships within that step. */
export function parseWorkflowStep(
  value: unknown,
  stepId: string,
  path: string,
  errors: ValidationErrors,
): WorkflowStep | undefined {
  if (!isJsonObject(value)) {
    errors.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(
    value,
    [
      'title',
      'prompt',
      'subagent',
      'permissions',
      'requires',
      'transitions',
      'gate',
      'workspace',
    ],
    path,
    errors,
  );

  const title =
    value.title === undefined
      ? stepId
      : readString(value.title, `${path}.title`, errors);
  const prompt = parsePrompt(value.prompt, `${path}.prompt`, errors);
  const subagent = parseStepSubagent(
    value.subagent,
    `${path}.subagent`,
    errors,
  );
  const permissions = parsePermissions(
    value.permissions,
    `${path}.permissions`,
    errors,
  );
  const requires = parseRequirements(
    value.requires,
    permissions,
    `${path}.requires`,
    errors,
  );
  const transitions = parseTransitions(
    value.transitions,
    `${path}.transitions`,
    errors,
  );
  const gate = parseGate(value.gate, `${path}.gate`, errors);
  const workspace = parseWorkspace(
    value.workspace,
    `${path}.workspace`,
    errors,
  );

  if (gate) {
    if (!Object.hasOwn(transitions, gate.approvedOutcome)) {
      errors.push(
        `${path}.transitions: missing gate outcome "${gate.approvedOutcome}"`,
      );
    }
    if (!Object.hasOwn(transitions, gate.rejectedOutcome)) {
      errors.push(
        `${path}.transitions: missing gate outcome "${gate.rejectedOutcome}"`,
      );
    }
    if (Object.hasOwn(transitions, gate.submitOutcome)) {
      errors.push(
        `${path}.transitions: submitOutcome is handled by the gate and must not be a transition`,
      );
    }
  }
  if (workspace) {
    workspace.bindOn.forEach((outcome) => {
      if (!Object.hasOwn(transitions, outcome)) {
        errors.push(
          `${path}.workspace.bindOn: unknown transition outcome "${outcome}"`,
        );
      }
    });
  }

  if (!title || !prompt) return undefined;
  return {
    title,
    prompt,
    ...(subagent ? { subagent } : {}),
    permissions,
    requires,
    transitions,
    ...(gate ? { gate } : {}),
    ...(workspace ? { workspace } : {}),
  };
}
