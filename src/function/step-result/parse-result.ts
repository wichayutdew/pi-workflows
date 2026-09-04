import { isAbsolute } from 'node:path';
import {
  MAX_ARTIFACT_CHARS,
  MAX_WORKSPACE_PATH_CHARS,
  RESULT_KEYS,
  type StepResultPolicy,
  type WorkflowCheckpointProgress,
  type WorkflowResultWorkspace,
  type WorkflowStepResult,
} from '../../domain/index.ts';

const isObject = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const isPlaceholder = (value: string): boolean =>
  /^(?:p?placeholder|dummy)$/i.test(value.trim());

const listItems = (summary: string, label: string): ReadonlyArray<string> => {
  const section = new RegExp(
    `^\\s*\\*\\*${label}:\\*\\*\\s*\\n((?:\\s*-\\s+.+(?:\\n|$))+)`,
    'm',
  ).exec(summary)?.[1];
  return section
    ? [...section.matchAll(/^\s*-\s+(.+)$/gm)].map((match) =>
        (match[1] ?? '').trim(),
      )
    : [];
};

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

function validateNonSuccessSummary(outcome: string, summary: string): void {
  const completed = listItems(summary, 'Completed');
  const remaining = listItems(summary, 'Remaining');
  if (
    !/^# [^:\n]+:\s+.+/m.test(summary) ||
    completed.length === 0 ||
    remaining.length === 0 ||
    !completed.every(isSpecificCompletedItem) ||
    !remaining.every(isSpecificRemainingItem)
  ) {
    throw new Error(
      'step summary must list specific completed and remaining work',
    );
  }
  if (outcome === 'blocked') {
    const question = /^\s*\*\*Question:\*\*\s*(.+\?)\s*$/m.exec(summary)?.[1];
    if (!question || isPlaceholder(question)) {
      throw new Error('blocked summary must ask a clarifying question');
    }
    const isActionable =
      /^# Blocked:\s+.+/m.test(summary) &&
      /^\s*\*\*Action:\*\*\s+.+/m.test(summary) &&
      /^\s*\*\*Next:\*\*\s+.+/m.test(summary);
    if (!isActionable) {
      throw new Error(
        'blocked summary must identify the missing user prerequisite and next action',
      );
    }
  }
  if (outcome === 'retry') {
    const describesTransientFailure = /\btransient\b/i.test(summary);
    const hasSafeRetryCondition =
      /\b(safe (retry|to retry)|retry (when|after|once))\b/i.test(summary);
    const requestsUserInput =
      /\b(provide|confirm|choose|approve|decide)\b/i.test(summary);
    if (
      !/^# Retry:\s+.+/m.test(summary) ||
      !describesTransientFailure ||
      !hasSafeRetryCondition ||
      requestsUserInput
    ) {
      throw new Error(
        'retry summary must identify a transient failure and safe retry condition',
      );
    }
  }
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
    if (value !== undefined) {
      throw new Error('workflow step workspace is forbidden for this outcome');
    }
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error(
      `workflow step outcome "${outcome}" requires workspace.cwd`,
    );
  }
  const unknownKey = Object.keys(value).find((key) => key !== 'cwd');
  if (unknownKey) {
    throw new Error(
      `workflow step workspace has unknown property "${unknownKey}"`,
    );
  }
  if (typeof value.cwd !== 'string') {
    throw new Error('workflow step workspace cwd must be a string');
  }
  const cwd = value.cwd;
  if (!cwd || cwd.includes('\0') || !isAbsolute(cwd)) {
    throw new Error('workflow step workspace cwd must be an absolute path');
  }
  if (cwd.length > MAX_WORKSPACE_PATH_CHARS) {
    throw new Error(
      `workflow step workspace cwd exceeds ${MAX_WORKSPACE_PATH_CHARS} characters`,
    );
  }
  return { cwd };
}

/**
 * Validates and normalizes the structured result returned by a workflow step.
 *
 * @param value - Untrusted structured output from the agent.
 * @param policy - Result constraints for the active workflow step.
 * @returns A normalized workflow-step result.
 * @throws When the result violates the active policy or result schema.
 */
export function parseWorkflowStepResult(
  value: unknown,
  policy: StepResultPolicy,
): WorkflowStepResult {
  if (!isObject(value)) {
    throw new Error('workflow step result must be an object');
  }

  const unknownKey = Object.keys(value).find((key) => !RESULT_KEYS.has(key));
  if (unknownKey) {
    throw new Error(
      `workflow step result has unknown property "${unknownKey}"`,
    );
  }
  if (value.version !== 1) {
    throw new Error('unsupported workflow step result version');
  }
  if (value.policyDigest !== policy.policyDigest) {
    throw new Error('workflow step result does not match the active policy');
  }
  if (
    typeof value.outcome !== 'string' ||
    !policy.outcomes.includes(value.outcome)
  ) {
    throw new Error(
      `workflow step returned invalid outcome "${String(value.outcome)}"`,
    );
  }
  if (typeof value.summary !== 'string') {
    throw new Error('workflow step summary must be a string');
  }
  const summary = value.summary.trim();
  if (!summary) {
    throw new Error('workflow step summary must not be empty');
  }
  if (summary.length > policy.summaryMaxChars) {
    throw new Error(
      `workflow step summary exceeds ${policy.summaryMaxChars} characters`,
    );
  }
  validateNonSuccessSummary(value.outcome, summary);
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
