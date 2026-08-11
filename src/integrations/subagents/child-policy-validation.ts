import { dirname, isAbsolute, resolve } from 'node:path';
import { AGENT_PROFILE_NAME_PATTERN } from '../../config/types.ts';
import {
  DEFAULT_CHILD_POLICY_ENVIRONMENT,
  isSafeStepCapabilityPath,
  isSafeStepResultPath,
} from './child-policy-paths.ts';
import type { ChildPolicyEnvironment } from './child-policy-paths.ts';
import { parseChildPolicySections } from './child-policy-sections.ts';
import type { ChildStepPolicy } from './child-policy-types.ts';

const POLICY_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CAPABILITY_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const POLICY_KEYS: ReadonlySet<string> = new Set([
  'version',
  'requestId',
  'agent',
  'workflowId',
  'runId',
  'stepId',
  'stepTitle',
  'cwd',
  'policyDigest',
  'capabilityPath',
  'capabilityToken',
  'resultPath',
  'permissions',
  'outcomes',
  'pauseOutcomes',
  'summaryMaxChars',
  'gateSubmitOutcome',
  'workspace',
]);

type RequiredStringField =
  | 'requestId'
  | 'agent'
  | 'workflowId'
  | 'runId'
  | 'stepId'
  | 'stepTitle'
  | 'cwd'
  | 'policyDigest'
  | 'capabilityPath'
  | 'capabilityToken'
  | 'resultPath';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const requiredString = (
  value: Readonly<Record<string, unknown>>,
  field: RequiredStringField,
): string => {
  const candidate = value[field];
  if (typeof candidate !== 'string' || !candidate) {
    throw new Error(`child policy ${field} must be a non-empty string`);
  }
  return candidate;
};

/**
 * Returns whether a name follows the runtime naming contract used by
 * workflow agent profiles.
 */
export const isAgentProfileName = (name: string | undefined): name is string =>
  Boolean(name && AGENT_PROFILE_NAME_PATTERN.test(name));

const rejectUnknownProperties = (
  value: Readonly<Record<string, unknown>>,
): void => {
  const unknownKey = Object.keys(value).find((key) => !POLICY_KEYS.has(key));
  if (unknownKey) {
    throw new Error(`child policy has unknown property "${unknownKey}"`);
  }
};

type IdentityAndPaths = Pick<
  ChildStepPolicy,
  | 'version'
  | 'requestId'
  | 'agent'
  | 'workflowId'
  | 'runId'
  | 'stepId'
  | 'stepTitle'
  | 'cwd'
  | 'policyDigest'
  | 'capabilityPath'
  | 'capabilityToken'
  | 'resultPath'
>;

const parseIdentityAndPaths = (
  value: Readonly<Record<string, unknown>>,
  environment: ChildPolicyEnvironment,
): IdentityAndPaths => {
  const requestId = requiredString(value, 'requestId');
  const agent = requiredString(value, 'agent');
  const workflowId = requiredString(value, 'workflowId');
  const runId = requiredString(value, 'runId');
  const stepId = requiredString(value, 'stepId');
  const stepTitle = requiredString(value, 'stepTitle');
  const cwd = requiredString(value, 'cwd');
  const policyDigest = requiredString(value, 'policyDigest');
  const capabilityPath = requiredString(value, 'capabilityPath');
  const capabilityToken = requiredString(value, 'capabilityToken');
  const resultPath = requiredString(value, 'resultPath');

  if (value.version !== 1) throw new Error('unsupported child policy version');
  if (!isAbsolute(cwd)) {
    throw new Error('child policy cwd must be an absolute path');
  }
  if (!POLICY_DIGEST_PATTERN.test(policyDigest)) {
    throw new Error('child policy digest is invalid');
  }
  if (!isAgentProfileName(agent)) {
    throw new Error('child policy agent is not a valid agent profile name');
  }
  if (!CAPABILITY_TOKEN_PATTERN.test(capabilityToken)) {
    throw new Error('child policy capability token is invalid');
  }
  if (!isSafeStepCapabilityPath(capabilityPath, environment)) {
    throw new Error(
      'child policy capability path is outside its temporary directory',
    );
  }
  if (!isSafeStepResultPath(resultPath, environment)) {
    throw new Error(
      'child policy result path is outside its temporary directory',
    );
  }
  if (dirname(resolve(capabilityPath)) !== dirname(resolve(resultPath))) {
    throw new Error('child policy files must share one temporary directory');
  }
  return {
    version: 1,
    requestId,
    agent,
    workflowId,
    runId,
    stepId,
    stepTitle,
    cwd,
    policyDigest,
    capabilityPath,
    capabilityToken,
    resultPath,
  };
};

/**
 * Validates untrusted delegated policy data and returns its narrow domain type.
 *
 * @throws When the value does not satisfy the child policy contract.
 */
export const parseChildPolicy = (
  value: unknown,
  environment: ChildPolicyEnvironment = DEFAULT_CHILD_POLICY_ENVIRONMENT,
): ChildStepPolicy => {
  if (!isRecord(value)) throw new Error('child policy must be an object');

  rejectUnknownProperties(value);
  return {
    ...parseIdentityAndPaths(value, environment),
    ...parseChildPolicySections(value),
  };
};
