import { isAbsolute, win32 } from 'node:path';
import {
  MAX_WORKSPACE_ALLOWED_ROOTS,
  MAX_WORKSPACE_PATH_CHARS,
  type ChildStepPolicy,
  type StepPermissions,
} from '../../domain/index.ts';

type PolicySections = Pick<
  ChildStepPolicy,
  | 'permissions'
  | 'outcomes'
  | 'pauseOutcomes'
  | 'summaryMaxChars'
  | 'gateSubmitOutcome'
  | 'workspace'
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringArray = (value: unknown): value is Array<string> =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean => Object.keys(value).every((key) => allowed.has(key));

const isStepPermissions = (value: unknown): value is StepPermissions => {
  if (!isRecord(value) || !isRecord(value.bash)) return false;

  const bash = value.bash;
  const bashRules = Array.isArray(bash.allow) ? bash.allow : undefined;
  const isValidMode =
    bash.mode === 'deny' ||
    bash.mode === 'allow-list' ||
    bash.mode === 'unrestricted';
  const hasValidRules =
    bashRules !== undefined &&
    bashRules.every(
      (rule) =>
        isRecord(rule) &&
        hasOnlyKeys(rule, new Set(['executable', 'argsPrefix'])) &&
        typeof rule.executable === 'string' &&
        isStringArray(rule.argsPrefix),
    );
  return (
    hasOnlyKeys(
      value,
      new Set(['tools', 'mcp', 'extensions', 'skills', 'bash']),
    ) &&
    hasOnlyKeys(bash, new Set(['mode', 'allow'])) &&
    isStringArray(value.tools) &&
    isStringArray(value.mcp) &&
    isStringArray(value.extensions) &&
    isStringArray(value.skills) &&
    isValidMode &&
    hasValidRules &&
    (bash.mode !== 'allow-list' || bashRules.length > 0)
  );
};

const parsePermissions = (
  value: Readonly<Record<string, unknown>>,
): Pick<PolicySections, 'permissions'> => {
  if (!isStepPermissions(value.permissions)) {
    throw new Error('child policy permissions are invalid');
  }
  return { permissions: value.permissions };
};

const parseOutcomes = (
  value: Readonly<Record<string, unknown>>,
): Pick<
  PolicySections,
  'outcomes' | 'pauseOutcomes' | 'summaryMaxChars' | 'gateSubmitOutcome'
> => {
  const outcomes = value.outcomes;
  if (
    !isStringArray(outcomes) ||
    outcomes.length === 0 ||
    new Set(outcomes).size !== outcomes.length
  ) {
    throw new Error('child policy outcomes are invalid');
  }
  const pauseOutcomes = value.pauseOutcomes;
  if (
    !isStringArray(pauseOutcomes) ||
    new Set(pauseOutcomes).size !== pauseOutcomes.length ||
    pauseOutcomes.some((outcome) => !outcomes.includes(outcome))
  ) {
    throw new Error('child policy pause outcomes are invalid');
  }
  const summaryMaxChars = value.summaryMaxChars;
  if (
    typeof summaryMaxChars !== 'number' ||
    !Number.isInteger(summaryMaxChars) ||
    summaryMaxChars < 100 ||
    summaryMaxChars > 50_000
  ) {
    throw new Error('child policy summaryMaxChars is invalid');
  }
  const gateSubmitOutcome = value.gateSubmitOutcome;
  if (
    gateSubmitOutcome !== undefined &&
    (typeof gateSubmitOutcome !== 'string' ||
      !outcomes.includes(gateSubmitOutcome))
  ) {
    throw new Error('child policy gate outcome is invalid');
  }
  return {
    outcomes,
    pauseOutcomes,
    summaryMaxChars,
    ...(gateSubmitOutcome === undefined ? {} : { gateSubmitOutcome }),
  };
};

const parseWorkspace = (
  value: Readonly<Record<string, unknown>>,
  outcomes: ReadonlyArray<string>,
): Pick<PolicySections, 'workspace'> => {
  if (value.workspace === undefined) return {};
  if (
    !isRecord(value.workspace) ||
    !hasOnlyKeys(value.workspace, new Set(['bindOn', 'allowedRoots']))
  ) {
    throw new Error('child policy workspace is invalid');
  }
  const bindOn = value.workspace.bindOn;
  const allowedRoots = value.workspace.allowedRoots;
  if (
    !isStringArray(bindOn) ||
    bindOn.length === 0 ||
    new Set(bindOn).size !== bindOn.length ||
    bindOn.some((outcome) => !outcomes.includes(outcome))
  ) {
    throw new Error('child policy workspace bindOn outcomes are invalid');
  }
  if (
    !isStringArray(allowedRoots) ||
    allowedRoots.length === 0 ||
    allowedRoots.length > MAX_WORKSPACE_ALLOWED_ROOTS ||
    new Set(allowedRoots).size !== allowedRoots.length ||
    allowedRoots.some(
      (root) =>
        !root.trim() ||
        root !== root.trim() ||
        root.length > MAX_WORKSPACE_PATH_CHARS ||
        root.includes('\0') ||
        (win32.parse(root).root !== '' && !isAbsolute(root)),
    )
  ) {
    throw new Error('child policy workspace allowed roots are invalid');
  }
  return { workspace: { bindOn, allowedRoots } };
};

/**
 * Parses permission and outcome sections of a child policy.
 */
export const parseChildPolicySections = (
  value: Readonly<Record<string, unknown>>,
): PolicySections => {
  const outcomeSections = parseOutcomes(value);
  return {
    ...parsePermissions(value),
    ...outcomeSections,
    ...parseWorkspace(value, outcomeSections.outcomes),
  };
};
