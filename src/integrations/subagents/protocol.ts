import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  SubagentDelegationRequest as UpstreamDelegationRequest,
  SubagentDelegationResponse as UpstreamDelegationResponse,
  SubagentDelegationStatus as UpstreamDelegationStatus,
  SubagentDelegationUpdate as UpstreamDelegationUpdate,
} from 'pi-subagents/delegation';
import {
  SUBAGENT_RUNTIME_NAME_PATTERN,
  type StepPermissions,
} from '../../config/types.ts';
import {
  parseWorkflowStepResult,
  type WorkflowStepResult,
} from '../../runtime/step-result.ts';

// These released v1 transport values are duplicated as literals because
// pi-subagents 0.36.0 exports TypeScript source. Node's native type stripping
// cannot execute TypeScript below node_modules; the public types above remain
// the compile-time compatibility check.
export const SUBAGENT_DELEGATION_PROTOCOL_VERSION = 1 as const;
export const SUBAGENT_DELEGATION_REQUEST_EVENT =
  'prompt-template:subagent:request';
export const SUBAGENT_DELEGATION_STARTED_EVENT =
  'prompt-template:subagent:started';
export const SUBAGENT_DELEGATION_UPDATE_EVENT =
  'prompt-template:subagent:update';
export const SUBAGENT_DELEGATION_RESPONSE_EVENT =
  'prompt-template:subagent:response';
export const SUBAGENT_DELEGATION_CANCEL_EVENT =
  'prompt-template:subagent:cancel';

const CHILD_POLICY_OPEN = '<pi-workflows-policy-v1>';
const CHILD_POLICY_CLOSE = '</pi-workflows-policy-v1>';
const UPSTREAM_TASK_PREFIX = 'Task: ';
const UPSTREAM_TASK_FILE_OPEN = '<file name="';
const UPSTREAM_TASK_FILE_HEADER_CLOSE = '">\n';
const UPSTREAM_TASK_FILE_CLOSE = '\n</file>\n';
const UPSTREAM_TASK_DIRECTORY_PREFIX = 'pi-subagent-';
const POLICY_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CAPABILITY_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const RESULT_FILE_NAME = 'result.json';
const CAPABILITY_FILE_NAME = 'capability';
const RESULT_DIRECTORY_PREFIX = 'pi-workflows-step-';

export type SubagentDelegationRequest = UpstreamDelegationRequest;
export type SubagentDelegationUpdate = UpstreamDelegationUpdate;
export type SubagentDelegationStatus = UpstreamDelegationStatus;
export type SubagentDelegationResponse = UpstreamDelegationResponse;

export interface ChildStepPolicy {
  version: 1;
  requestId: string;
  agent: string;
  workflowId: string;
  runId: string;
  stepId: string;
  stepTitle: string;
  policyDigest: string;
  capabilityPath: string;
  capabilityToken: string;
  resultPath: string;
  permissions: StepPermissions;
  /** Exact Bash command strings extracted from a reviewed gate artifact. */
  approvedBashCommands?: string[];
  /** Reviewed repository root that file mutations must remain inside. */
  repositoryCwd?: string;
  /** Existing reviewed source directory used only to bootstrap repositoryCwd. */
  bootstrapCwd?: string;
  outcomes: string[];
  /** Outcomes that pause instead of advancing to another workflow step. */
  pauseOutcomes: string[];
  summaryMaxChars: number;
  gateSubmitOutcome?: string;
}

export type DelegatedStepResult = WorkflowStepResult;

export interface ExtractedChildPolicy {
  policy: ChildStepPolicy;
  task: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isStepPermissions(value: unknown): value is StepPermissions {
  if (!isObject(value) || !isObject(value.bash)) return false;
  const bash = value.bash;
  const modeIsValid =
    bash.mode === 'deny' ||
    bash.mode === 'read-only' ||
    bash.mode === 'allow-list' ||
    bash.mode === 'unrestricted';
  const rulesAreValid =
    Array.isArray(bash.allow) &&
    bash.allow.every(
      (rule) =>
        isObject(rule) &&
        typeof rule.executable === 'string' &&
        isStringArray(rule.argsPrefix),
    );
  const approvedSourcesAreValid =
    bash.approvedSources === undefined ||
    (isStringArray(bash.approvedSources) &&
      new Set(bash.approvedSources).size === bash.approvedSources.length &&
      bash.approvedSources.every(
        (source) =>
          source === 'verification-worker' ||
          source === 'verification-reviewer' ||
          source === 'remote-actions',
      ));
  const approvalShapeIsValid =
    bash.mode === 'allow-list'
      ? (bash.allow as unknown[]).length > 0 ||
        (Array.isArray(bash.approvedSources) && bash.approvedSources.length > 0)
      : bash.approvedSources === undefined;
  return (
    isStringArray(value.tools) &&
    isStringArray(value.mcp) &&
    isStringArray(value.extensions) &&
    isStringArray(value.skills) &&
    modeIsValid &&
    rulesAreValid &&
    approvedSourcesAreValid &&
    approvalShapeIsValid
  );
}

function isSafeStepFilePath(path: string, expectedName: string): boolean {
  const base = resolve(tmpdir());
  const candidate = resolve(path);
  const fromBase = relative(base, candidate);
  return (
    fromBase !== '' &&
    !fromBase.startsWith('..') &&
    !fromBase.includes('\0') &&
    basename(candidate) === expectedName &&
    basename(dirname(candidate)).startsWith(RESULT_DIRECTORY_PREFIX)
  );
}

export function isSafeStepResultPath(path: string): boolean {
  return isSafeStepFilePath(path, RESULT_FILE_NAME);
}

export function isSafeStepCapabilityPath(path: string): boolean {
  return isSafeStepFilePath(path, CAPABILITY_FILE_NAME);
}

export function isSubagentRuntimeName(
  name: string | undefined,
): name is string {
  return Boolean(name && SUBAGENT_RUNTIME_NAME_PATTERN.test(name));
}

function parseChildPolicy(value: unknown): ChildStepPolicy {
  if (!isObject(value)) throw new Error('child policy must be an object');
  const allowedKeys = new Set([
    'version',
    'requestId',
    'agent',
    'workflowId',
    'runId',
    'stepId',
    'stepTitle',
    'policyDigest',
    'capabilityPath',
    'capabilityToken',
    'resultPath',
    'permissions',
    'approvedBashCommands',
    'repositoryCwd',
    'bootstrapCwd',
    'outcomes',
    'pauseOutcomes',
    'summaryMaxChars',
    'gateSubmitOutcome',
  ]);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new Error(`child policy has unknown property "${unknownKey}"`);
  }
  const stringFields = [
    'requestId',
    'agent',
    'workflowId',
    'runId',
    'stepId',
    'stepTitle',
    'policyDigest',
    'capabilityPath',
    'capabilityToken',
    'resultPath',
  ] as const;
  for (const field of stringFields) {
    if (typeof value[field] !== 'string' || !value[field]) {
      throw new Error(`child policy ${field} must be a non-empty string`);
    }
  }
  if (value.version !== 1) throw new Error('unsupported child policy version');
  if (!POLICY_DIGEST_PATTERN.test(value.policyDigest as string)) {
    throw new Error('child policy digest is invalid');
  }
  if (!isSubagentRuntimeName(value.agent as string)) {
    throw new Error('child policy agent is not a valid subagent runtime name');
  }
  if (!CAPABILITY_TOKEN_PATTERN.test(value.capabilityToken as string)) {
    throw new Error('child policy capability token is invalid');
  }
  if (!isSafeStepCapabilityPath(value.capabilityPath as string)) {
    throw new Error(
      'child policy capability path is outside its temporary directory',
    );
  }
  if (!isSafeStepResultPath(value.resultPath as string)) {
    throw new Error(
      'child policy result path is outside its temporary directory',
    );
  }
  if (
    dirname(resolve(value.capabilityPath as string)) !==
    dirname(resolve(value.resultPath as string))
  ) {
    throw new Error('child policy files must share one temporary directory');
  }
  if (!isStepPermissions(value.permissions)) {
    throw new Error('child policy permissions are invalid');
  }
  if (
    value.approvedBashCommands !== undefined &&
    (!isStringArray(value.approvedBashCommands) ||
      new Set(value.approvedBashCommands).size !==
        value.approvedBashCommands.length)
  ) {
    throw new Error('child policy approved Bash commands are invalid');
  }
  if (
    value.repositoryCwd !== undefined &&
    (typeof value.repositoryCwd !== 'string' ||
      !isAbsolute(value.repositoryCwd) ||
      value.repositoryCwd.includes('\0'))
  ) {
    throw new Error('child policy repository cwd is invalid');
  }
  if (
    value.bootstrapCwd !== undefined &&
    (typeof value.bootstrapCwd !== 'string' ||
      !isAbsolute(value.bootstrapCwd) ||
      value.bootstrapCwd.includes('\0') ||
      typeof value.repositoryCwd !== 'string' ||
      resolve(value.bootstrapCwd) === resolve(value.repositoryCwd))
  ) {
    throw new Error('child policy bootstrap cwd is invalid');
  }
  if (
    !isStringArray(value.outcomes) ||
    value.outcomes.length === 0 ||
    new Set(value.outcomes).size !== value.outcomes.length
  ) {
    throw new Error('child policy outcomes are invalid');
  }
  if (
    !isStringArray(value.pauseOutcomes) ||
    new Set(value.pauseOutcomes).size !== value.pauseOutcomes.length ||
    value.pauseOutcomes.some(
      (outcome) => !(value.outcomes as string[]).includes(outcome),
    )
  ) {
    throw new Error('child policy pause outcomes are invalid');
  }
  if (
    !Number.isInteger(value.summaryMaxChars) ||
    (value.summaryMaxChars as number) < 100 ||
    (value.summaryMaxChars as number) > 50_000
  ) {
    throw new Error('child policy summaryMaxChars is invalid');
  }
  if (
    value.gateSubmitOutcome !== undefined &&
    (typeof value.gateSubmitOutcome !== 'string' ||
      !value.outcomes.includes(value.gateSubmitOutcome))
  ) {
    throw new Error('child policy gate outcome is invalid');
  }

  return value as unknown as ChildStepPolicy;
}

export function encodeChildPolicy(policy: ChildStepPolicy): string {
  const encoded = Buffer.from(JSON.stringify(policy), 'utf8').toString(
    'base64url',
  );
  return `${CHILD_POLICY_OPEN}${encoded}${CHILD_POLICY_CLOSE}`;
}

function unwrapUpstreamTask(text: string): string | undefined {
  if (text.startsWith(CHILD_POLICY_OPEN)) return text;
  if (text.startsWith(`${UPSTREAM_TASK_PREFIX}${CHILD_POLICY_OPEN}`)) {
    return text.slice(UPSTREAM_TASK_PREFIX.length);
  }
  if (
    !text.startsWith(UPSTREAM_TASK_FILE_OPEN) ||
    !text.endsWith(UPSTREAM_TASK_FILE_CLOSE)
  ) {
    return undefined;
  }

  const pathStart = UPSTREAM_TASK_FILE_OPEN.length;
  const headerEnd = text.indexOf(UPSTREAM_TASK_FILE_HEADER_CLOSE, pathStart);
  if (headerEnd === -1) return undefined;
  const taskFilePath = text.slice(pathStart, headerEnd);
  const taskDirectory = dirname(resolve(taskFilePath));
  if (
    basename(taskFilePath) !== 'task.md' ||
    !basename(taskDirectory).startsWith(UPSTREAM_TASK_DIRECTORY_PREFIX) ||
    dirname(taskDirectory) !== resolve(tmpdir())
  ) {
    return undefined;
  }

  const bodyStart = headerEnd + UPSTREAM_TASK_FILE_HEADER_CLOSE.length;
  const body = text.slice(bodyStart, -UPSTREAM_TASK_FILE_CLOSE.length);
  if (!body.startsWith(`${UPSTREAM_TASK_PREFIX}${CHILD_POLICY_OPEN}`)) {
    return undefined;
  }
  return body.slice(UPSTREAM_TASK_PREFIX.length);
}

export function extractChildPolicy(
  text: string,
): ExtractedChildPolicy | undefined {
  const taskWithPolicy = unwrapUpstreamTask(text);
  if (taskWithPolicy === undefined) return undefined;
  const payloadStart = CHILD_POLICY_OPEN.length;
  const end = taskWithPolicy.indexOf(CHILD_POLICY_CLOSE, payloadStart);
  if (
    end === -1 ||
    taskWithPolicy.indexOf(CHILD_POLICY_OPEN, payloadStart) !== -1
  ) {
    throw new Error('delegated task contains an invalid child policy envelope');
  }
  const encoded = taskWithPolicy.slice(payloadStart, end);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('delegated task child policy cannot be decoded');
  }
  const task = taskWithPolicy.slice(end + CHILD_POLICY_CLOSE.length).trim();
  if (!task) throw new Error('delegated task is empty after policy extraction');
  return { policy: parseChildPolicy(decoded), task };
}

export function parseDelegatedStepResult(
  value: unknown,
  policy: ChildStepPolicy,
): DelegatedStepResult {
  try {
    return parseWorkflowStepResult(value, policy);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll('workflow step', 'delegated step'), {
      cause: error,
    });
  }
}
