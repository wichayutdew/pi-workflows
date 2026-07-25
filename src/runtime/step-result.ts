const MAX_ARTIFACT_CHARS = 200_000;
const RESULT_KEYS = new Set([
  'version',
  'policyDigest',
  'outcome',
  'summary',
  'artifact',
]);

/**
 * Result constraints derived from the active workflow step.
 */
export type StepResultPolicy = {
  readonly policyDigest: string;
  readonly outcomes: ReadonlyArray<string>;
  readonly summaryMaxChars: number;
  readonly gateSubmitOutcome?: string;
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
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

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
  return {
    version: 1,
    policyDigest: policy.policyDigest,
    outcome: value.outcome,
    summary,
    ...(artifact !== undefined ? { artifact } : {}),
  };
}
