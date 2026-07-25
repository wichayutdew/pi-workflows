import { isAbsolute, resolve } from 'node:path';
import type { StepPermissions } from '../../config/types.ts';
import type { ChildStepPolicy } from './child-policy-types.ts';

type PolicySections = Pick<
  ChildStepPolicy,
  | 'permissions'
  | 'approvedBashCommands'
  | 'repositoryCwd'
  | 'bootstrapCwd'
  | 'outcomes'
  | 'pauseOutcomes'
  | 'summaryMaxChars'
  | 'gateSubmitOutcome'
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringArray = (value: unknown): value is Array<string> =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isStepPermissions = (value: unknown): value is StepPermissions => {
  if (!isRecord(value) || !isRecord(value.bash)) return false;

  const bash = value.bash;
  const bashRules = Array.isArray(bash.allow) ? bash.allow : undefined;
  const isValidMode =
    bash.mode === 'deny' ||
    bash.mode === 'read-only' ||
    bash.mode === 'allow-list' ||
    bash.mode === 'unrestricted';
  const hasValidRules =
    bashRules !== undefined &&
    bashRules.every(
      (rule) =>
        isRecord(rule) &&
        typeof rule.executable === 'string' &&
        isStringArray(rule.argsPrefix),
    );
  const hasValidApprovedSources =
    bash.approvedSources === undefined ||
    (isStringArray(bash.approvedSources) &&
      new Set(bash.approvedSources).size === bash.approvedSources.length &&
      bash.approvedSources.every(
        (source) =>
          source === 'verification-worker' ||
          source === 'verification-reviewer' ||
          source === 'remote-actions',
      ));
  const hasValidApprovalShape =
    bash.mode === 'allow-list'
      ? (bashRules?.length ?? 0) > 0 ||
        (Array.isArray(bash.approvedSources) && bash.approvedSources.length > 0)
      : bash.approvedSources === undefined;

  return (
    isStringArray(value.tools) &&
    isStringArray(value.mcp) &&
    isStringArray(value.extensions) &&
    isStringArray(value.skills) &&
    isValidMode &&
    hasValidRules &&
    hasValidApprovedSources &&
    hasValidApprovalShape
  );
};

const parsePermissions = (
  value: Readonly<Record<string, unknown>>,
): Pick<PolicySections, 'permissions' | 'approvedBashCommands'> => {
  if (!isStepPermissions(value.permissions)) {
    throw new Error('child policy permissions are invalid');
  }
  const approvedBashCommands = value.approvedBashCommands;
  if (
    approvedBashCommands !== undefined &&
    (!isStringArray(approvedBashCommands) ||
      new Set(approvedBashCommands).size !== approvedBashCommands.length)
  ) {
    throw new Error('child policy approved Bash commands are invalid');
  }
  return {
    permissions: value.permissions,
    ...(approvedBashCommands === undefined ? {} : { approvedBashCommands }),
  };
};

const parseRepositoryPaths = (
  value: Readonly<Record<string, unknown>>,
): Pick<PolicySections, 'repositoryCwd' | 'bootstrapCwd'> => {
  const repositoryCwd = value.repositoryCwd;
  const bootstrapCwd = value.bootstrapCwd;
  if (
    repositoryCwd !== undefined &&
    (typeof repositoryCwd !== 'string' ||
      !isAbsolute(repositoryCwd) ||
      repositoryCwd.includes('\0'))
  ) {
    throw new Error('child policy repository cwd is invalid');
  }
  if (
    bootstrapCwd !== undefined &&
    (typeof bootstrapCwd !== 'string' ||
      !isAbsolute(bootstrapCwd) ||
      bootstrapCwd.includes('\0') ||
      typeof repositoryCwd !== 'string' ||
      resolve(bootstrapCwd) === resolve(repositoryCwd))
  ) {
    throw new Error('child policy bootstrap cwd is invalid');
  }
  return {
    ...(repositoryCwd === undefined ? {} : { repositoryCwd }),
    ...(bootstrapCwd === undefined ? {} : { bootstrapCwd }),
  };
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

/**
 * Parses permission, repository, and outcome sections of a child policy.
 */
export const parseChildPolicySections = (
  value: Readonly<Record<string, unknown>>,
): PolicySections => ({
  ...parsePermissions(value),
  ...parseRepositoryPaths(value),
  ...parseOutcomes(value),
});
