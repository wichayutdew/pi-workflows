import { isAbsolute, win32 } from 'node:path';
import {
  MAX_WORKSPACE_ALLOWED_ROOTS,
  MAX_WORKSPACE_PATH_CHARS,
  type ArtifactContract,
  type PromptSpec,
  type RequiredHeading,
  type StepWorkspaceBinding,
  type WorkflowGate,
  type WorkflowStep,
  AGENT_PROFILE_NAME_PATTERN,
  type StepAgent,
} from '../../../domain/index.ts';
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

const WORKFLOW_OUTCOMES = new Set(['ready', 'blocked', 'handoff', 'gaps']);

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
      if (!WORKFLOW_OUTCOMES.has(outcome)) {
        errors.push(`${path}: unsupported outcome "${outcome}"`);
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

function parseArtifactContract(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): ArtifactContract | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    errors.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(value, ['maxChars', 'requiredHeadings'], path, errors);
  if (value.maxChars === undefined) {
    errors.push(`${path}.maxChars: expected an integer from 1 to 200000`);
  }
  const maxChars = readInteger(
    value.maxChars,
    200_000,
    `${path}.maxChars`,
    errors,
    { min: 1, max: 200_000 },
  );
  if (!Array.isArray(value.requiredHeadings)) {
    errors.push(`${path}.requiredHeadings: expected a non-empty array`);
    return { maxChars, requiredHeadings: [] };
  }
  if (value.requiredHeadings.length === 0) {
    errors.push(`${path}.requiredHeadings: at least one heading is required`);
  }
  if (value.requiredHeadings.length > 32) {
    errors.push(`${path}.requiredHeadings: at most 32 headings are allowed`);
  }
  const requiredHeadings = value.requiredHeadings.reduce<Array<RequiredHeading>>(
    (headings, item, index) => {
      const headingPath = `${path}.requiredHeadings[${index}]`;
      if (!isJsonObject(item)) {
        errors.push(`${headingPath}: expected an object`);
        return headings;
      }
      rejectUnknownKeys(item, ['level', 'title', 'guidance'], headingPath, errors);
      const level = item.level;
      const validLevel = level === 1 || level === 2 || level === 3;
      if (!validLevel) {
        errors.push(`${headingPath}.level: expected 1, 2, or 3`);
      }
      const title = readString(item.title, `${headingPath}.title`, errors);
      const guidance = readString(item.guidance, `${headingPath}.guidance`, errors);
      if (!validLevel || !title || !guidance) return headings;
      if (title.length > 1_024) {
        errors.push(`${headingPath}.title: exceeds 1024 characters`);
      }
      if (guidance.length > 1_024) {
        errors.push(`${headingPath}.guidance: exceeds 1024 characters`);
      }
      const heading = { level, title, guidance } as const;
      if (headings.some((other) => other.level === level && other.title === title)) {
        errors.push(`${headingPath}: duplicate heading "${'#'.repeat(level)} ${title}"`);
        return headings;
      }
      return [...headings, heading];
    },
    [],
  );
  return { maxChars, requiredHeadings };
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
    ['provider', 'timeoutMs', 'artifactContract'],
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
  const artifactContract = parseArtifactContract(
    value.artifactContract,
    `${path}.artifactContract`,
    errors,
  );
  if (provider === 'prompt' && value.timeoutMs !== undefined) {
    errors.push(`${path}.timeoutMs: only valid with provider "plannotator"`);
  }
  if (!provider) return undefined;

  return provider === 'prompt'
    ? {
        provider,
        submitOutcome: 'ready',
        approvedOutcome: 'ready',
        rejectedOutcome: 'handoff',
        ...(artifactContract ? { artifactContract } : {}),
      }
    : {
        provider,
        submitOutcome: 'ready',
        approvedOutcome: 'ready',
        rejectedOutcome: 'handoff',
        ...(artifactContract ? { artifactContract } : {}),
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
    errors.push(`${path}: expected an array of workspace paths`);
    return [];
  }
  if (value.length > MAX_WORKSPACE_ALLOWED_ROOTS) {
    errors.push(
      `${path}: at most ${MAX_WORKSPACE_ALLOWED_ROOTS} workspace paths are allowed`,
    );
  }

  const roots = value
    .slice(0, MAX_WORKSPACE_ALLOWED_ROOTS)
    .reduce<Array<string>>((result, item, index) => {
      const itemPath = `${path}[${index}]`;
      if (typeof item !== 'string' || !item || item.trim() !== item) {
        errors.push(`${itemPath}: expected a non-empty workspace path`);
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
        (win32.parse(root).root !== '' && !isAbsolute(root))
      ) {
        errors.push(
          `${itemPath}: expected a relative, absolute, or home-relative path`,
        );
        return result;
      }
      if (result.includes(root)) {
        errors.push(`${itemPath}: duplicate value "${root}"`);
        return result;
      }
      return [...result, root];
    }, []);
  if (roots.length === 0) {
    errors.push(`${path}: at least one workspace path is required`);
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
  if (bindOn.length !== 1 || bindOn[0] !== 'ready') {
    errors.push(`${path}.bindOn: must contain only "ready"`);
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
      'agent',
      'maxToolCalls',
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
  const agentName =
    value.agent === undefined
      ? undefined
      : readString(value.agent, `${path}.agent`, errors, {
          pattern: AGENT_PROFILE_NAME_PATTERN,
        });
  const agent: StepAgent | undefined = agentName
    ? { name: agentName }
    : undefined;
  const maxToolCalls =
    value.maxToolCalls === undefined
      ? undefined
      : readInteger(value.maxToolCalls, 1, `${path}.maxToolCalls`, errors, {
          min: 1,
          max: 100_000,
        });
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

  if (transitions.blocked && transitions.blocked !== '$pause') {
    errors.push(`${path}.transitions.blocked: must target "$pause"`);
  }
  if (transitions.handoff && transitions.handoff !== stepId) {
    errors.push(`${path}.transitions.handoff: must target "${stepId}"`);
  }
  if (transitions.ready === '$pause' || transitions.ready === stepId) {
    errors.push(
      `${path}.transitions.ready: must target another step or "$done"`,
    );
  }

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
  }
  if (agent && maxToolCalls !== undefined) {
    if (!Object.hasOwn(transitions, 'handoff')) {
      errors.push(
        `${path}.transitions: maxToolCalls requires a "handoff" transition`,
      );
    } else if (transitions.handoff !== stepId) {
      errors.push(
        `${path}.transitions: handoff transition must target "${stepId}"`,
      );
    }
  }
  if (workspace && !Object.hasOwn(transitions, 'ready')) {
    errors.push(`${path}.workspace: requires a "ready" transition`);
  }

  if (!title || !prompt) return undefined;
  return {
    title,
    prompt,
    ...(agent ? { agent } : {}),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    permissions,
    requires,
    transitions,
    ...(gate ? { gate } : {}),
    ...(workspace ? { workspace } : {}),
  };
}
