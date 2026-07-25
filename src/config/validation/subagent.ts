import {
  DEFAULT_STEP_SUBAGENT,
  SUBAGENT_RUNTIME_NAME_PATTERN,
  type StepSubagent,
  type SubagentContext,
  type SubagentPermissionCeiling,
  type SubagentToolBudget,
  type SubagentTurnBudget,
} from '../types.ts';
import {
  isJsonObject,
  readBoolean,
  readInteger,
  readString,
  readStringList,
  rejectUnknownKeys,
  RESOURCE_SELECTOR_PATTERN,
  TOOL_PATTERN,
  type ValidationErrors,
} from './shared.ts';

function parseSubagentTurnBudget(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): SubagentTurnBudget | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
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
  errors: ValidationErrors,
): SubagentToolBudget | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
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

  let block: Array<string> | '*' | undefined;
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

/** Parse an optional isolated-step subagent configuration. */
export function parseStepSubagent(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): StepSubagent | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const agent =
      readString(value, path, errors, {
        pattern: SUBAGENT_RUNTIME_NAME_PATTERN,
      }) ?? DEFAULT_STEP_SUBAGENT.agent;
    return { ...DEFAULT_STEP_SUBAGENT, agent };
  }
  if (!isJsonObject(value)) {
    errors.push(`${path}: expected an agent profile name or object`);
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
      'retryToolFailures',
    ],
    path,
    errors,
  );

  const agent =
    value.agent === undefined
      ? DEFAULT_STEP_SUBAGENT.agent
      : (readString(value.agent, `${path}.agent`, errors, {
          pattern: SUBAGENT_RUNTIME_NAME_PATTERN,
        }) ?? DEFAULT_STEP_SUBAGENT.agent);
  const contextValue =
    value.context === undefined
      ? DEFAULT_STEP_SUBAGENT.context
      : readString(value.context, `${path}.context`, errors);
  const context: SubagentContext = DEFAULT_STEP_SUBAGENT.context;
  if (contextValue !== 'fresh') {
    errors.push(`${path}.context: expected fresh`);
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
  const retryToolFailures = readBoolean(
    value.retryToolFailures,
    DEFAULT_STEP_SUBAGENT.retryToolFailures,
    `${path}.retryToolFailures`,
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
    retryToolFailures,
  };
}

/** Parse the subagent limits inside the user permission ceiling. */
export function parseSubagentPermissionCeiling(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): SubagentPermissionCeiling | undefined {
  if (!isJsonObject(value)) {
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
      'retryToolFailures',
    ],
    path,
    errors,
  );
  const agents = readStringList(
    value.agents,
    `${path}.agents`,
    errors,
    SUBAGENT_RUNTIME_NAME_PATTERN,
  );
  const contexts = readStringList(
    value.contexts,
    `${path}.contexts`,
    errors,
    /^fresh$/,
  ).filter((context): context is SubagentContext => context === 'fresh');
  const models = readStringList(
    value.models,
    `${path}.models`,
    errors,
    RESOURCE_SELECTOR_PATTERN,
  );
  if (agents.length === 0) {
    errors.push(`${path}.agents: at least one subagent is required`);
  }
  if (contexts.length === 0) {
    errors.push(`${path}.contexts: at least one context mode is required`);
  }
  (
    [
      'maxTimeoutMs',
      'maxTurns',
      'maxGraceTurns',
      'maxToolCalls',
      'artifacts',
    ] as const
  )
    .filter((field) => value[field] === undefined)
    .forEach((field) => errors.push(`${path}.${field}: required`));

  return {
    agents,
    contexts,
    models,
    maxTimeoutMs: readInteger(
      value.maxTimeoutMs,
      0,
      `${path}.maxTimeoutMs`,
      errors,
      { min: 1_000, max: 86_400_000 },
    ),
    maxTurns: readInteger(value.maxTurns, 0, `${path}.maxTurns`, errors, {
      min: 1,
      max: 1_000,
    }),
    maxGraceTurns: readInteger(
      value.maxGraceTurns,
      0,
      `${path}.maxGraceTurns`,
      errors,
      { min: 0, max: 100 },
    ),
    maxToolCalls: readInteger(
      value.maxToolCalls,
      0,
      `${path}.maxToolCalls`,
      errors,
      { min: 1, max: 100_000 },
    ),
    artifacts: readBoolean(value.artifacts, false, `${path}.artifacts`, errors),
    retryToolFailures: readBoolean(
      value.retryToolFailures,
      false,
      `${path}.retryToolFailures`,
      errors,
    ),
  };
}
