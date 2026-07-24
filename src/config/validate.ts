import {
  DEFAULT_SETTINGS,
  DEFAULT_STEP_SUBAGENT,
  EMPTY_PERMISSIONS,
  EMPTY_REQUIREMENTS,
  WORKFLOW_SUBAGENT_NAMESPACE,
  WORKFLOW_SCHEMA_VERSION,
  type BashMode,
  type BashApprovalSource,
  type BashPermission,
  type BashRule,
  type PermissionCeiling,
  type PromptSpec,
  type StepPermissions,
  type StepRequirements,
  type StepSubagent,
  type SubagentContext,
  type SubagentPermissionCeiling,
  type SubagentToolBudget,
  type SubagentTurnBudget,
  type WorkflowDefinition,
  type WorkflowGate,
  type WorkflowSettings,
  type WorkflowStep,
} from './types.ts';
import { RESERVED_COMMAND_NAMES } from '../command-names.ts';

export interface ValidationResult<T> {
  value?: T;
  errors: string[];
}

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const OUTCOME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const TOOL_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const RESOURCE_SELECTOR_PATTERN = /^[A-Za-z0-9_@./:+-]+$/;
const WORKFLOW_SUBAGENT_PATTERN =
  /^pi-workflows\.[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
const MCP_SELECTOR_PATTERN = /^[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)?$/;
const EXECUTABLE_PATTERN = /^[A-Za-z0-9_./+-]+$/;
const BASH_APPROVAL_SOURCE_PATTERN =
  /^(verification-worker|verification-reviewer|remote-actions)$/;
const PROMPT_VARIABLES = new Set([
  'workflow.input',
  'workflow.id',
  'run.id',
  'step.id',
  'step.title',
  'last.summary',
  'gate.feedback',
]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      errors.push(`${path}: unknown property "${key}"`);
    }
  }
}

function readString(
  value: unknown,
  path: string,
  errors: string[],
  options: { pattern?: RegExp; nonEmpty?: boolean } = {},
): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${path}: expected a string`);
    return undefined;
  }

  const result = value.trim();
  if ((options.nonEmpty ?? true) && !result) {
    errors.push(`${path}: must not be empty`);
    return undefined;
  }
  if (options.pattern && !options.pattern.test(result)) {
    errors.push(`${path}: invalid value "${result}"`);
    return undefined;
  }
  return result;
}

function readInteger(
  value: unknown,
  fallback: number,
  path: string,
  errors: string[],
  limits: { min: number; max: number },
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isInteger(value) ||
    (value as number) < limits.min ||
    (value as number) > limits.max
  ) {
    errors.push(
      `${path}: expected an integer from ${limits.min} to ${limits.max}`,
    );
    return fallback;
  }
  return value as number;
}

function readBoolean(
  value: unknown,
  fallback: boolean,
  path: string,
  errors: string[],
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    errors.push(`${path}: expected a boolean`);
    return fallback;
  }
  return value;
}

function readStringList(
  value: unknown,
  path: string,
  errors: string[],
  pattern: RegExp,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array of strings`);
    return [];
  }

  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const parsed = readString(item, `${path}[${index}]`, errors, { pattern });
    if (!parsed) return;
    if (seen.has(parsed)) {
      errors.push(`${path}[${index}]: duplicate value "${parsed}"`);
      return;
    }
    seen.add(parsed);
    result.push(parsed);
  });
  return result;
}

function parseBashRule(
  value: unknown,
  path: string,
  errors: string[],
): BashRule[] {
  if (!isObject(value)) {
    errors.push(`${path}: expected an object`);
    return [];
  }
  rejectUnknownKeys(
    value,
    ['executable', 'argsPrefix', 'argsPrefixes'],
    path,
    errors,
  );

  const executable = readString(
    value.executable,
    `${path}.executable`,
    errors,
    {
      pattern: EXECUTABLE_PATTERN,
    },
  );
  if (value.argsPrefix !== undefined && value.argsPrefixes !== undefined) {
    errors.push(`${path}: argsPrefix and argsPrefixes are mutually exclusive`);
  }

  if (value.argsPrefixes !== undefined) {
    if (!Array.isArray(value.argsPrefixes)) {
      errors.push(`${path}.argsPrefixes: expected an array of argument arrays`);
      return [];
    }
    if (value.argsPrefixes.length === 0) {
      errors.push(`${path}.argsPrefixes: at least one prefix is required`);
    }
    const prefixes: string[][] = [];
    const seen = new Set<string>();
    value.argsPrefixes.forEach((candidate, index) => {
      const prefixPath = `${path}.argsPrefixes[${index}]`;
      const prefix = readStringList(candidate, prefixPath, errors, /^[^\s]+$/);
      if (Array.isArray(candidate) && candidate.length === 0) {
        errors.push(`${prefixPath}: at least one argument is required`);
        return;
      }
      if (prefix.length === 0) return;
      const key = JSON.stringify(prefix);
      if (seen.has(key)) {
        errors.push(`${prefixPath}: duplicate argument prefix`);
        return;
      }
      seen.add(key);
      prefixes.push(prefix);
    });
    return executable
      ? prefixes.map((argsPrefix) => ({ executable, argsPrefix }))
      : [];
  }

  const argsPrefix = readStringList(
    value.argsPrefix,
    `${path}.argsPrefix`,
    errors,
    /^[^\s]+$/,
  );
  return executable ? [{ executable, argsPrefix }] : [];
}

function parseBashPermission(
  value: unknown,
  path: string,
  errors: string[],
): BashPermission {
  if (value === undefined) {
    return { ...EMPTY_PERMISSIONS.bash, allow: [] };
  }
  if (!isObject(value)) {
    errors.push(`${path}: expected an object`);
    return { ...EMPTY_PERMISSIONS.bash, allow: [] };
  }
  rejectUnknownKeys(value, ['mode', 'allow', 'approvedSources'], path, errors);

  const mode = readString(value.mode, `${path}.mode`, errors) as
    BashMode | undefined;
  const validMode =
    mode === 'deny' ||
    mode === 'read-only' ||
    mode === 'allow-list' ||
    mode === 'unrestricted';
  if (!validMode) {
    errors.push(
      `${path}.mode: expected deny, read-only, allow-list, or unrestricted`,
    );
  }

  const allow: BashRule[] = [];
  if (value.allow !== undefined) {
    if (!Array.isArray(value.allow)) {
      errors.push(`${path}.allow: expected an array`);
    } else {
      value.allow.forEach((rule, index) => {
        allow.push(...parseBashRule(rule, `${path}.allow[${index}]`, errors));
      });
    }
  }

  const approvedSources = (
    value.approvedSources === undefined
      ? []
      : readStringList(
          value.approvedSources,
          `${path}.approvedSources`,
          errors,
          BASH_APPROVAL_SOURCE_PATTERN,
        )
  ).filter((source): source is BashApprovalSource => {
    const valid =
      source === 'verification-worker' ||
      source === 'verification-reviewer' ||
      source === 'remote-actions';
    if (!valid) {
      errors.push(
        `${path}.approvedSources: expected verification-worker, verification-reviewer, or remote-actions`,
      );
    }
    return valid;
  });

  const normalizedMode = validMode ? mode : 'deny';
  if (normalizedMode !== 'allow-list' && allow.length > 0) {
    errors.push(`${path}.allow: only valid when mode is "allow-list"`);
  }
  if (normalizedMode === 'allow-list' && allow.length === 0) {
    if (approvedSources.length === 0) {
      errors.push(
        `${path}: allow-list mode requires an allow rule or an approved command source`,
      );
    }
  }
  if (normalizedMode !== 'allow-list' && approvedSources.length > 0) {
    errors.push(
      `${path}.approvedSources: only valid when mode is "allow-list"`,
    );
  }
  return {
    mode: normalizedMode,
    allow,
    ...(approvedSources.length > 0 ? { approvedSources } : {}),
  };
}

function parsePermissions(
  value: unknown,
  path: string,
  errors: string[],
): StepPermissions {
  if (value === undefined) {
    return {
      tools: [],
      mcp: [],
      extensions: [],
      skills: [],
      bash: { mode: 'deny', allow: [] },
    };
  }
  if (!isObject(value)) {
    errors.push(`${path}: expected an object`);
    return {
      tools: [],
      mcp: [],
      extensions: [],
      skills: [],
      bash: { mode: 'deny', allow: [] },
    };
  }
  rejectUnknownKeys(
    value,
    ['tools', 'mcp', 'extensions', 'skills', 'bash'],
    path,
    errors,
  );

  const permissions: StepPermissions = {
    tools: readStringList(value.tools, `${path}.tools`, errors, TOOL_PATTERN),
    mcp: readStringList(value.mcp, `${path}.mcp`, errors, MCP_SELECTOR_PATTERN),
    extensions: readStringList(
      value.extensions,
      `${path}.extensions`,
      errors,
      RESOURCE_SELECTOR_PATTERN,
    ),
    skills: readStringList(
      value.skills,
      `${path}.skills`,
      errors,
      RESOURCE_SELECTOR_PATTERN,
    ),
    bash: parseBashPermission(value.bash, `${path}.bash`, errors),
  };

  if (permissions.bash.mode !== 'deny' && !permissions.tools.includes('bash')) {
    errors.push(`${path}.tools: must include "bash" when Bash is enabled`);
  }
  return permissions;
}

function parseRequirements(
  value: unknown,
  permissions: StepPermissions,
  path: string,
  errors: string[],
): StepRequirements {
  if (value === undefined) {
    return {
      tools: [],
      extensions: [],
      skills: [],
    };
  }
  if (!isObject(value)) {
    errors.push(`${path}: expected an object`);
    return {
      tools: [],
      extensions: [],
      skills: [],
    };
  }
  rejectUnknownKeys(value, ['tools', 'extensions', 'skills'], path, errors);

  const requirements: StepRequirements = {
    tools: readStringList(value.tools, `${path}.tools`, errors, TOOL_PATTERN),
    extensions: readStringList(
      value.extensions,
      `${path}.extensions`,
      errors,
      RESOURCE_SELECTOR_PATTERN,
    ),
    skills: readStringList(
      value.skills,
      `${path}.skills`,
      errors,
      RESOURCE_SELECTOR_PATTERN,
    ),
  };

  for (const tool of requirements.tools) {
    if (
      !permissions.tools.includes(tool) &&
      !(tool === 'mcp' && permissions.mcp.length > 0)
    ) {
      errors.push(
        `${path}.tools: required tool "${tool}" is not allowed by this step`,
      );
    }
  }
  for (const extension of requirements.extensions) {
    if (!permissions.extensions.includes(extension)) {
      errors.push(
        `${path}.extensions: required extension "${extension}" is not allowed by this step`,
      );
    }
  }
  for (const skill of requirements.skills) {
    if (!permissions.skills.includes(skill)) {
      errors.push(
        `${path}.skills: required skill "${skill}" is not allowed by this step`,
      );
    }
  }
  return requirements;
}

function parseSubagentTurnBudget(
  value: unknown,
  path: string,
  errors: string[],
): SubagentTurnBudget | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    errors.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(value, ['maxTurns', 'graceTurns'], path, errors);
  const maxTurns = readInteger(value.maxTurns, 0, `${path}.maxTurns`, errors, {
    min: 1,
    max: 1_000,
  });
  const graceTurns =
    value.graceTurns === undefined
      ? undefined
      : readInteger(value.graceTurns, 0, `${path}.graceTurns`, errors, {
          min: 0,
          max: 100,
        });
  if (maxTurns === 0) return undefined;
  return {
    maxTurns,
    ...(graceTurns !== undefined ? { graceTurns } : {}),
  };
}

function parseSubagentToolBudget(
  value: unknown,
  path: string,
  errors: string[],
): SubagentToolBudget | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    errors.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(value, ['soft', 'hard', 'block'], path, errors);
  const hard = readInteger(value.hard, 0, `${path}.hard`, errors, {
    min: 1,
    max: 100_000,
  });
  const soft =
    value.soft === undefined
      ? undefined
      : readInteger(value.soft, 0, `${path}.soft`, errors, {
          min: 1,
          max: 100_000,
        });

  let block: string[] | '*' | undefined;
  if (value.block === '*') {
    block = '*';
  } else if (value.block !== undefined) {
    block = readStringList(value.block, `${path}.block`, errors, TOOL_PATTERN);
    if (block.length === 0) {
      errors.push(`${path}.block: expected "*" or at least one tool name`);
    }
  }
  if (soft !== undefined && hard > 0 && soft > hard) {
    errors.push(`${path}.soft: must not exceed hard`);
  }
  if (hard === 0) return undefined;
  return {
    hard,
    ...(soft !== undefined ? { soft } : {}),
    ...(block !== undefined ? { block } : {}),
  };
}

function parseStepSubagent(
  value: unknown,
  path: string,
  errors: string[],
): StepSubagent | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const agent =
      readString(value, path, errors, {
        pattern: WORKFLOW_SUBAGENT_PATTERN,
      }) ?? DEFAULT_STEP_SUBAGENT.agent;
    return { ...DEFAULT_STEP_SUBAGENT, agent };
  }
  if (!isObject(value)) {
    errors.push(`${path}: expected a workflow subagent name or object`);
    return undefined;
  }
  rejectUnknownKeys(
    value,
    [
      'agent',
      'context',
      'model',
      'timeoutMs',
      'turnBudget',
      'toolBudget',
      'artifacts',
    ],
    path,
    errors,
  );

  const agent =
    value.agent === undefined
      ? DEFAULT_STEP_SUBAGENT.agent
      : (readString(value.agent, `${path}.agent`, errors, {
          pattern: WORKFLOW_SUBAGENT_PATTERN,
        }) ?? DEFAULT_STEP_SUBAGENT.agent);
  if (!agent.startsWith(WORKFLOW_SUBAGENT_NAMESPACE)) {
    errors.push(
      `${path}.agent: must use the "${WORKFLOW_SUBAGENT_NAMESPACE}" workflow-agent namespace`,
    );
  }
  const contextValue =
    value.context === undefined
      ? DEFAULT_STEP_SUBAGENT.context
      : readString(value.context, `${path}.context`, errors);
  const context: SubagentContext =
    contextValue === 'fork' || contextValue === 'fresh'
      ? contextValue
      : DEFAULT_STEP_SUBAGENT.context;
  if (contextValue !== 'fork' && contextValue !== 'fresh') {
    errors.push(`${path}.context: expected fresh or fork`);
  }
  const model =
    value.model === undefined
      ? undefined
      : readString(value.model, `${path}.model`, errors, {
          pattern: RESOURCE_SELECTOR_PATTERN,
        });
  const timeoutMs = readInteger(
    value.timeoutMs,
    DEFAULT_STEP_SUBAGENT.timeoutMs,
    `${path}.timeoutMs`,
    errors,
    { min: 1_000, max: 86_400_000 },
  );
  const turnBudget = parseSubagentTurnBudget(
    value.turnBudget,
    `${path}.turnBudget`,
    errors,
  );
  const toolBudget = parseSubagentToolBudget(
    value.toolBudget,
    `${path}.toolBudget`,
    errors,
  );
  const artifacts = readBoolean(
    value.artifacts,
    DEFAULT_STEP_SUBAGENT.artifacts,
    `${path}.artifacts`,
    errors,
  );
  return {
    agent,
    context,
    ...(model ? { model } : {}),
    timeoutMs,
    ...(turnBudget ? { turnBudget } : {}),
    ...(toolBudget ? { toolBudget } : {}),
    artifacts,
  };
}

function parsePrompt(
  value: unknown,
  path: string,
  errors: string[],
): PromptSpec | undefined {
  if (typeof value === 'string') {
    const inline = readString(value, path, errors);
    return inline ? { inline } : undefined;
  }
  if (!isObject(value)) {
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
  errors: string[],
): Record<string, string> {
  if (!isObject(value)) {
    errors.push(`${path}: expected an object`);
    return {};
  }
  const transitions: Record<string, string> = {};
  for (const [outcome, targetValue] of Object.entries(value)) {
    if (!OUTCOME_PATTERN.test(outcome)) {
      errors.push(`${path}: invalid outcome "${outcome}"`);
      continue;
    }
    const target = readString(targetValue, `${path}.${outcome}`, errors);
    if (target) transitions[outcome] = target;
  }
  if (Object.keys(transitions).length === 0) {
    errors.push(`${path}: at least one transition is required`);
  }
  return transitions;
}

function parseGate(
  value: unknown,
  path: string,
  errors: string[],
): WorkflowGate | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
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
    {
      pattern: OUTCOME_PATTERN,
    },
  );
  const approvedOutcome = readString(
    value.approvedOutcome,
    `${path}.approvedOutcome`,
    errors,
    {
      pattern: OUTCOME_PATTERN,
    },
  );
  const rejectedOutcome = readString(
    value.rejectedOutcome,
    `${path}.rejectedOutcome`,
    errors,
    {
      pattern: OUTCOME_PATTERN,
    },
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
  if (provider === 'prompt') {
    return {
      provider,
      submitOutcome,
      approvedOutcome,
      rejectedOutcome,
    };
  }
  return {
    provider,
    submitOutcome,
    approvedOutcome,
    rejectedOutcome,
    timeoutMs: readInteger(
      value.timeoutMs,
      5_000,
      `${path}.timeoutMs`,
      errors,
      {
        min: 1_000,
        max: 30_000,
      },
    ),
  };
}

function parseStep(
  value: unknown,
  stepId: string,
  path: string,
  errors: string[],
): WorkflowStep | undefined {
  if (!isObject(value)) {
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

  if (!title || !prompt) return undefined;
  return {
    title,
    prompt,
    ...(subagent ? { subagent } : {}),
    permissions,
    requires,
    transitions,
    ...(gate ? { gate } : {}),
  };
}

export function validatePromptText(text: string, path: string): string[] {
  const errors: string[] = [];
  for (const match of text.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const variable = match[1]?.trim() ?? '';
    if (!PROMPT_VARIABLES.has(variable)) {
      errors.push(`${path}: unknown prompt variable "{{${variable}}}"`);
    }
  }
  return errors;
}

export function validateWorkflow(
  value: unknown,
): ValidationResult<WorkflowDefinition> {
  const errors: string[] = [];
  if (!isObject(value)) {
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
    {
      min: 1,
      max: 100,
    },
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

  const steps: Record<string, WorkflowStep> = {};
  if (!isObject(value.steps)) {
    errors.push('workflow.steps: expected an object');
  } else {
    for (const [stepId, stepValue] of Object.entries(value.steps)) {
      if (!IDENTIFIER_PATTERN.test(stepId)) {
        errors.push(`workflow.steps: invalid step id "${stepId}"`);
        continue;
      }
      const step = parseStep(
        stepValue,
        stepId,
        `workflow.steps.${stepId}`,
        errors,
      );
      if (step) steps[stepId] = step;
    }
  }

  if (Object.keys(steps).length === 0) {
    errors.push('workflow.steps: at least one step is required');
  }
  if (start && !Object.hasOwn(steps, start)) {
    errors.push(`workflow.start: unknown step "${start}"`);
  }
  for (const [stepId, step] of Object.entries(steps)) {
    for (const [outcome, target] of Object.entries(step.transitions)) {
      if (
        target !== '$done' &&
        target !== '$pause' &&
        !Object.hasOwn(steps, target)
      ) {
        errors.push(
          `workflow.steps.${stepId}.transitions.${outcome}: unknown target "${target}"`,
        );
      }
    }
  }

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

function parsePermissionCeiling(
  value: unknown,
  path: string,
  errors: string[],
): PermissionCeiling | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    errors.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(
    value,
    ['tools', 'mcp', 'extensions', 'skills', 'bash', 'subagent'],
    path,
    errors,
  );
  const permissions = parsePermissions(
    {
      ...(value.tools !== undefined ? { tools: value.tools } : {}),
      ...(value.mcp !== undefined ? { mcp: value.mcp } : {}),
      ...(value.extensions !== undefined
        ? { extensions: value.extensions }
        : {}),
      ...(value.skills !== undefined ? { skills: value.skills } : {}),
      ...(value.bash !== undefined ? { bash: value.bash } : {}),
    },
    path,
    errors,
  );
  const subagent =
    value.subagent === undefined
      ? undefined
      : parseSubagentPermissionCeiling(
          value.subagent,
          `${path}.subagent`,
          errors,
        );
  return {
    ...permissions,
    ...(subagent ? { subagent } : {}),
  };
}

function parseSubagentPermissionCeiling(
  value: unknown,
  path: string,
  errors: string[],
): SubagentPermissionCeiling | undefined {
  if (!isObject(value)) {
    errors.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(
    value,
    [
      'agents',
      'contexts',
      'models',
      'maxTimeoutMs',
      'maxTurns',
      'maxGraceTurns',
      'maxToolCalls',
      'artifacts',
    ],
    path,
    errors,
  );
  const agents = readStringList(
    value.agents,
    `${path}.agents`,
    errors,
    WORKFLOW_SUBAGENT_PATTERN,
  );
  const contexts = readStringList(
    value.contexts,
    `${path}.contexts`,
    errors,
    /^(?:fresh|fork)$/,
  ) as SubagentContext[];
  const models = readStringList(
    value.models,
    `${path}.models`,
    errors,
    RESOURCE_SELECTOR_PATTERN,
  );
  if (agents.length === 0) {
    errors.push(`${path}.agents: at least one workflow agent is required`);
  }
  if (contexts.length === 0) {
    errors.push(`${path}.contexts: at least one context mode is required`);
  }
  for (const field of [
    'maxTimeoutMs',
    'maxTurns',
    'maxGraceTurns',
    'maxToolCalls',
    'artifacts',
  ] as const) {
    if (value[field] === undefined) {
      errors.push(`${path}.${field}: required`);
    }
  }
  const maxTimeoutMs = readInteger(
    value.maxTimeoutMs,
    0,
    `${path}.maxTimeoutMs`,
    errors,
    { min: 1_000, max: 86_400_000 },
  );
  const maxTurns = readInteger(value.maxTurns, 0, `${path}.maxTurns`, errors, {
    min: 1,
    max: 1_000,
  });
  const maxGraceTurns = readInteger(
    value.maxGraceTurns,
    0,
    `${path}.maxGraceTurns`,
    errors,
    { min: 0, max: 100 },
  );
  const maxToolCalls = readInteger(
    value.maxToolCalls,
    0,
    `${path}.maxToolCalls`,
    errors,
    { min: 1, max: 100_000 },
  );
  const artifacts = readBoolean(
    value.artifacts,
    false,
    `${path}.artifacts`,
    errors,
  );
  return {
    agents,
    contexts,
    models,
    maxTimeoutMs,
    maxTurns,
    maxGraceTurns,
    maxToolCalls,
    artifacts,
  };
}

export function validateSettings(
  value: unknown,
): ValidationResult<WorkflowSettings> {
  const errors: string[] = [];
  if (!isObject(value)) {
    return { errors: ['settings: expected an object'] };
  }
  rejectUnknownKeys(
    value,
    ['$schema', 'version', 'allowProjectWorkflows', 'permissionCeiling'],
    'settings',
    errors,
  );
  if (value.$schema !== undefined && typeof value.$schema !== 'string') {
    errors.push('settings.$schema: expected a string');
  }
  if (value.version !== WORKFLOW_SCHEMA_VERSION) {
    errors.push(`settings.version: expected ${WORKFLOW_SCHEMA_VERSION}`);
  }
  let allowProjectWorkflows = false;
  if (typeof value.allowProjectWorkflows === 'boolean') {
    allowProjectWorkflows = value.allowProjectWorkflows;
  } else if (value.allowProjectWorkflows !== undefined) {
    errors.push('settings.allowProjectWorkflows: expected a boolean');
  }
  const permissionCeiling = parsePermissionCeiling(
    value.permissionCeiling,
    'settings.permissionCeiling',
    errors,
  );
  if (allowProjectWorkflows && !permissionCeiling) {
    errors.push(
      'settings.permissionCeiling: required when project workflows are enabled',
    );
  }
  if (errors.length > 0) return { errors };
  return {
    value: {
      ...DEFAULT_SETTINGS,
      allowProjectWorkflows,
      ...(permissionCeiling ? { permissionCeiling } : {}),
    },
    errors,
  };
}

export function cloneEmptyRequirements(): StepRequirements {
  return {
    tools: [...EMPTY_REQUIREMENTS.tools],
    extensions: [...EMPTY_REQUIREMENTS.extensions],
    skills: [...EMPTY_REQUIREMENTS.skills],
  };
}
