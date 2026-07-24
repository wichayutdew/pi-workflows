export interface StepResultPolicy {
  policyDigest: string;
  outcomes: string[];
  summaryMaxChars: number;
  gateSubmitOutcome?: string;
}

export interface WorkflowStepResult {
  version: 1;
  policyDigest: string;
  outcome: string;
  summary: string;
  artifact?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseWorkflowStepResult(
  value: unknown,
  policy: StepResultPolicy,
): WorkflowStepResult {
  if (!isObject(value))
    throw new Error('workflow step result must be an object');
  const allowedKeys = new Set([
    'version',
    'policyDigest',
    'outcome',
    'summary',
    'artifact',
  ]);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new Error(
      `workflow step result has unknown property "${unknownKey}"`,
    );
  }
  if (value.version !== 1)
    throw new Error('unsupported workflow step result version');
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
  if (value.artifact !== undefined && typeof value.artifact !== 'string') {
    throw new Error('workflow step artifact must be a string');
  }
  const artifact =
    typeof value.artifact === 'string' ? value.artifact : undefined;
  if (artifact !== undefined && artifact.length > 200_000) {
    throw new Error('workflow step artifact exceeds 200000 characters');
  }
  if (
    value.outcome === policy.gateSubmitOutcome &&
    (!artifact || !artifact.trim())
  ) {
    throw new Error('workflow gate outcome requires a non-empty artifact');
  }
  return {
    version: 1,
    policyDigest: policy.policyDigest,
    outcome: value.outcome,
    summary,
    ...(artifact !== undefined ? { artifact } : {}),
  };
}
