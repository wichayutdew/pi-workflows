import { isAbsolute } from 'node:path';
import {
  MAX_ARTIFACT_CHARS,
  MAX_WORKSPACE_PATH_CHARS,
  RESULT_KEYS,
  type StepResultPolicy,
  type WorkflowCheckpointProgress,
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

function parseHandoff(
  value: Record<string, unknown>,
  outcome: string,
): WorkflowHandoffInput {
  const state = parseText(value.state, 'state');
  const completed = parseItems(
    value.completed,
    'completed',
    isSpecificCompletedItem,
  );
  const remaining = parseItems(
    value.remaining,
    'remaining',
    isSpecificRemainingItem,
  );
  const hasBlockedFields = ['question', 'action', 'next'].some(
    (key) => value[key] !== undefined,
  );
  const hasRetryFields = ['transientFailure', 'retryWhen'].some(
    (key) => value[key] !== undefined,
  );

  if (outcome === 'blocked') {
    if (hasRetryFields)
      throw new Error('workflow step blocked result has retry-only fields');
    const question = parseText(value.question, 'question');
    if (!question.endsWith('?')) {
      throw new Error('workflow step blocked question must end in "?"');
    }
    return {
      state,
      completed,
      remaining,
      question,
      action: parseText(value.action, 'action'),
      next: parseText(value.next, 'next'),
    };
  }

  if (outcome === 'retry') {
    if (hasBlockedFields)
      throw new Error('workflow step retry result has blocked-only fields');
    return {
      state,
      completed,
      remaining,
      transientFailure: parseText(value.transientFailure, 'transientFailure'),
      retryWhen: parseText(value.retryWhen, 'retryWhen'),
    };
  }

  if (hasBlockedFields || hasRetryFields) {
    throw new Error(
      'workflow step result has outcome-incompatible handoff fields',
    );
  }
  return { state, completed, remaining };
}

export function formatWorkflowStepSummary(
  outcome: string,
  handoff: WorkflowHandoffInput,
): string {
  const heading = outcome.charAt(0).toUpperCase() + outcome.slice(1);
  return [
    `# ${heading}: ${handoff.state}`,
    '**Completed:**',
    ...handoff.completed.map((item) => `- ${item}`),
    '**Remaining:**',
    ...handoff.remaining.map((item) => `- ${item}`),
    ...(handoff.question ? [`**Question:** ${handoff.question}`] : []),
    ...(handoff.action ? [`**Action:** ${handoff.action}`] : []),
    ...(handoff.next ? [`**Next:** ${handoff.next}`] : []),
    ...(handoff.transientFailure
      ? [`**Transient failure:** ${handoff.transientFailure}`]
      : []),
    ...(handoff.retryWhen ? [`**Retry when:** ${handoff.retryWhen}`] : []),
  ].join('\n');
}

function parseCheckpointProgress(
  value: unknown,
  outcome: string,
): WorkflowCheckpointProgress | undefined {
  if (outcome !== 'checkpoint') return undefined;
  if (!isObject(value)) throw new Error('checkpoint outcome requires progress');
  const { feature, commit, changedFiles, verification, remaining } = value;
  if (
    typeof feature !== 'string' ||
    !feature.trim() ||
    typeof commit !== 'string' ||
    !commit.trim() ||
    !Array.isArray(changedFiles) ||
    changedFiles.length === 0 ||
    !changedFiles.every((item) => typeof item === 'string' && item) ||
    !Array.isArray(verification) ||
    verification.length === 0 ||
    !verification.every((item) => typeof item === 'string' && item) ||
    !Array.isArray(remaining) ||
    !remaining.every((item) => typeof item === 'string' && item)
  )
    throw new Error(
      'checkpoint progress must identify feature, commit, changed files, verification, and remaining work',
    );
  return {
    feature: feature.trim(),
    commit: commit.trim(),
    changedFiles,
    verification,
    remaining,
  };
}

function parseResultWorkspace(
  value: unknown,
  outcome: string,
  policy: StepResultPolicy,
): WorkflowResultWorkspace | undefined {
  const requiresWorkspace = policy.workspace?.bindOn.includes(outcome) === true;
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

  const handoff = parseHandoff(value, value.outcome);
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
  if (
    value.outcome === policy.gateSubmitOutcome &&
    (!artifact || !artifact.trim())
  ) {
    throw new Error('workflow gate outcome requires a non-empty artifact');
  }
  const workspace = parseResultWorkspace(
    value.workspace,
    value.outcome,
    policy,
  );
  const progress = parseCheckpointProgress(value.progress, value.outcome);
  return {
    version: 1,
    policyDigest: policy.policyDigest,
    outcome: value.outcome,
    summary,
    ...(artifact !== undefined ? { artifact } : {}),
    ...(workspace ? { workspace } : {}),
    ...(progress ? { progress } : {}),
  };
}
