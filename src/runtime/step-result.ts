import { isAbsolute } from 'node:path';
import {
  MAX_WORKSPACE_PATH_CHARS,
  type StepWorkspaceBinding,
} from '../config/types.ts';

const MAX_ARTIFACT_CHARS = 200_000;
const RESULT_KEYS = new Set([
  'version',
  'policyDigest',
  'outcome',
  'summary',
  'artifact',
  'workspace',
]);

/**
 * Result constraints derived from the active workflow step.
 */
export type StepResultPolicy = {
  readonly policyDigest: string;
  readonly outcomes: ReadonlyArray<string>;
  readonly summaryMaxChars: number;
  readonly gateSubmitOutcome?: string;
  readonly workspace?: StepWorkspaceBinding;
};

export type WorkflowResultWorkspace = {
  readonly cwd: string;
};

/**
 * Validated result handed back to the workflow engine.
 */
export type WorkflowStepResult = {
  readonly version: 1;
  readonly policyDigest: string;
  readonly outcome: string;
  readonly summary: string;
  readonly artifact?: string;
  readonly workspace?: WorkflowResultWorkspace;
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

function validateNonSuccessSummary(outcome: string, summary: string): void {
  if (outcome === 'blocked') {
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
  return {
    version: 1,
    policyDigest: policy.policyDigest,
    outcome: value.outcome,
    summary,
    ...(artifact !== undefined ? { artifact } : {}),
    ...(workspace ? { workspace } : {}),
  };
}
