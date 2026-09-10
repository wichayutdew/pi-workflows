import { isAbsolute } from 'node:path';
import {
  MAX_ARTIFACT_CHARS,
  MAX_WORKSPACE_PATH_CHARS,
  RESULT_KEYS,
  type StepResultPolicy,
  type WorkflowHandoffInput,
  type WorkflowResultWorkspace,
  type WorkflowStepResult,
} from '../../domain/index.ts';

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isPlaceholder = (value: string): boolean =>
  /^(?:p?placeholder|dummy)$/i.test(value.trim());

const hasFormattingSyntax = (value: string): boolean =>
  /[\r\n\u2500-\u257f]|^(?:[-*+]\s|#{1,6}\s|\d+\.\s)/.test(value);

const isSpecificCompletedItem = (item: string): boolean =>
  !isPlaceholder(item) &&
  !/^(?:work done|completed|done|none\.?)$/i.test(item) &&
  /`[^`]+`|(?:^|\s)(?:[\w.-]+\/)+[\w.-]+|(?:^|\s)[A-Z][A-Z0-9]+-\d+\b|\b(?:approved|rejected|selected|confirmed|provided)\b/i.test(
    item,
  );

const isSpecificRemainingItem = (item: string): boolean =>
  !isPlaceholder(item) &&
  !/^(?:more work|remaining work|continue(?: work)?|next step|follow[- ]?up|todo|tbd)$/i.test(
    item,
  );

function parseText(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`workflow step ${name} must be a string`);
  }
  const text = value.trim();
  if (!text || isPlaceholder(text) || hasFormattingSyntax(text)) {
    throw new Error(`workflow step ${name} must be plain non-placeholder text`);
  }
  return text;
}

function parseItems(
  value: unknown,
  name: 'completed' | 'remaining',
  validate: (item: string) => boolean,
): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`workflow step ${name} must contain one or more items`);
  }
  const items = value.map((item) => parseText(item, `${name} item`));
  if (!items.every(validate)) {
    throw new Error(
      `workflow step ${name} items must be specific and actionable`,
    );
  }
  return items;
}

function parseHandoff(value: Record<string, unknown>): WorkflowHandoffInput {
  return {
    completed: parseItems(
      value.completed,
      'completed',
      isSpecificCompletedItem,
    ),
    remaining: parseItems(
      value.remaining,
      'remaining',
      isSpecificRemainingItem,
    ),
  };
}

export function formatWorkflowStepSummary(
  outcome: string,
  handoff: WorkflowHandoffInput,
): string {
  const heading = outcome.charAt(0).toUpperCase() + outcome.slice(1);
  return [
    `# ${heading}`,
    '**Completed:**',
    ...handoff.completed.map((item) => `- ${item}`),
    '**Remaining:**',
    ...handoff.remaining.map((item) => `- ${item}`),
  ].join('\n');
}

function parseResultWorkspace(
  value: unknown,
  outcome: string,
  policy: StepResultPolicy,
): WorkflowResultWorkspace | undefined {
  const requiresWorkspace =
    policy.workspace !== undefined && outcome === 'ready';
  if (!requiresWorkspace) {
    if (value !== undefined)
      throw new Error('workflow step workspace is forbidden for this outcome');
    return undefined;
  }
  if (!isObject(value))
    throw new Error(
      `workflow step outcome "${outcome}" requires workspace.cwd`,
    );
  const unknownKey = Object.keys(value).find((key) => key !== 'cwd');
  if (unknownKey)
    throw new Error(
      `workflow step workspace has unknown property "${unknownKey}"`,
    );
  if (typeof value.cwd !== 'string')
    throw new Error('workflow step workspace cwd must be a string');
  const cwd = value.cwd;
  if (!cwd || cwd.includes('\0') || !isAbsolute(cwd))
    throw new Error('workflow step workspace cwd must be an absolute path');
  if (cwd.length > MAX_WORKSPACE_PATH_CHARS)
    throw new Error(
      `workflow step workspace cwd exceeds ${MAX_WORKSPACE_PATH_CHARS} characters`,
    );
  return { cwd };
}

/** Validates and normalizes the structured result returned by a workflow step. */
export function parseWorkflowStepResult(
  value: unknown,
  policy: StepResultPolicy,
): WorkflowStepResult {
  if (!isObject(value))
    throw new Error('workflow step result must be an object');
  const unknownKey = Object.keys(value).find((key) => !RESULT_KEYS.has(key));
  if (unknownKey)
    throw new Error(
      `workflow step result has unknown property "${unknownKey}"`,
    );
  if (value.version !== 1)
    throw new Error('unsupported workflow step result version');
  if (value.policyDigest !== policy.policyDigest)
    throw new Error('workflow step result does not match the active policy');
  if (
    typeof value.outcome !== 'string' ||
    !policy.outcomes.includes(value.outcome)
  ) {
    throw new Error(
      `workflow step returned invalid outcome "${String(value.outcome)}"`,
    );
  }

  const handoff = parseHandoff(value);
  if (
    value.outcome === 'ready' &&
    (handoff.remaining.length !== 1 ||
      handoff.remaining[0] !== 'No active-step work remains.')
  ) {
    throw new Error('ready result must have no active-step work remaining');
  }
  if (
    value.outcome === 'blocked' &&
    !handoff.remaining.some((item) => item.endsWith('?'))
  ) {
    throw new Error('blocked result must include a user question in remaining');
  }
  if (
    (value.outcome === 'handoff' || value.outcome === 'gaps') &&
    handoff.remaining.some((item) => item.endsWith('?'))
  ) {
    throw new Error(`${value.outcome} result must not include a user question`);
  }
  const summary = formatWorkflowStepSummary(value.outcome, handoff);
  if (summary.length > policy.summaryMaxChars) {
    throw new Error(
      `workflow step summary exceeds ${policy.summaryMaxChars} characters`,
    );
  }
  if (value.artifact !== undefined && typeof value.artifact !== 'string') {
    throw new Error('workflow step artifact must be a string');
  }
  const artifact =
    typeof value.artifact === 'string' ? value.artifact : undefined;
  if (artifact !== undefined && artifact.length > MAX_ARTIFACT_CHARS) {
    throw new Error(
      `workflow step artifact exceeds ${MAX_ARTIFACT_CHARS} characters`,
    );
  }
  if (policy.gateSubmitOutcome === 'ready' && (!artifact || !artifact.trim())) {
    throw new Error('workflow gate outcome requires a non-empty artifact');
  }
  const workspace = parseResultWorkspace(
    value.workspace,
    value.outcome,
    policy,
  );
  return {
    version: 1,
    policyDigest: policy.policyDigest,
    outcome: value.outcome,
    summary,
    ...(artifact !== undefined ? { artifact } : {}),
    ...(workspace ? { workspace } : {}),
  };
}
