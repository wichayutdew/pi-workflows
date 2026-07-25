import { basename, dirname, resolve } from 'node:path';
import { DEFAULT_CHILD_POLICY_ENVIRONMENT } from './child-policy-paths.ts';
import type { ChildPolicyEnvironment } from './child-policy-paths.ts';
import type {
  ChildStepPolicy,
  ExtractedChildPolicy,
} from './child-policy-types.ts';
import { parseChildPolicy } from './child-policy-validation.ts';

const CHILD_POLICY_OPEN = '<pi-workflows-policy-v1>';
const CHILD_POLICY_CLOSE = '</pi-workflows-policy-v1>';
const UPSTREAM_TASK_PREFIX = 'Task: ';
const UPSTREAM_TASK_FILE_OPEN = '<file name="';
const UPSTREAM_TASK_FILE_HEADER_CLOSE = '">\n';
const UPSTREAM_TASK_FILE_CLOSE = '\n</file>\n';
const UPSTREAM_TASK_DIRECTORY_PREFIX = 'pi-subagent-';

/**
 * Encodes a validated child policy into the delegated task envelope.
 */
export const encodeChildPolicy = (policy: ChildStepPolicy): string => {
  const encoded = Buffer.from(JSON.stringify(policy), 'utf8').toString(
    'base64url',
  );
  return `${CHILD_POLICY_OPEN}${encoded}${CHILD_POLICY_CLOSE}`;
};

type UnwrapTaskFileOptions = {
  readonly text: string;
  readonly environment: ChildPolicyEnvironment;
};

const unwrapTaskFile = ({
  text,
  environment,
}: UnwrapTaskFileOptions): string | undefined => {
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
  const isExpectedTaskFile =
    basename(taskFilePath) === 'task.md' &&
    basename(taskDirectory).startsWith(UPSTREAM_TASK_DIRECTORY_PREFIX) &&
    dirname(taskDirectory) === resolve(environment.temporaryDirectory());
  if (!isExpectedTaskFile) return undefined;

  const bodyStart = headerEnd + UPSTREAM_TASK_FILE_HEADER_CLOSE.length;
  const body = text.slice(bodyStart, -UPSTREAM_TASK_FILE_CLOSE.length);
  if (!body.startsWith(`${UPSTREAM_TASK_PREFIX}${CHILD_POLICY_OPEN}`)) {
    return undefined;
  }
  return body.slice(UPSTREAM_TASK_PREFIX.length);
};

type UnwrapUpstreamTaskOptions = {
  readonly text: string;
  readonly environment: ChildPolicyEnvironment;
};

const unwrapUpstreamTask = ({
  text,
  environment,
}: UnwrapUpstreamTaskOptions): string | undefined => {
  if (text.startsWith(CHILD_POLICY_OPEN)) return text;
  if (text.startsWith(`${UPSTREAM_TASK_PREFIX}${CHILD_POLICY_OPEN}`)) {
    return text.slice(UPSTREAM_TASK_PREFIX.length);
  }
  return unwrapTaskFile({ text, environment });
};

const decodePolicy = (encoded: string): unknown => {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('delegated task child policy cannot be decoded');
  }
};

/**
 * Extracts and validates a child policy from a supported delegated task shape.
 *
 * @returns The validated policy and task, or `undefined` for ordinary input.
 * @throws When a policy envelope is present but malformed.
 */
export const extractChildPolicy = (
  text: string,
  environment: ChildPolicyEnvironment = DEFAULT_CHILD_POLICY_ENVIRONMENT,
): ExtractedChildPolicy | undefined => {
  const taskWithPolicy = unwrapUpstreamTask({ text, environment });
  if (taskWithPolicy === undefined) return undefined;

  const payloadStart = CHILD_POLICY_OPEN.length;
  const payloadEnd = taskWithPolicy.indexOf(CHILD_POLICY_CLOSE, payloadStart);
  const hasNestedEnvelope =
    taskWithPolicy.indexOf(CHILD_POLICY_OPEN, payloadStart) !== -1;
  if (payloadEnd === -1 || hasNestedEnvelope) {
    throw new Error('delegated task contains an invalid child policy envelope');
  }

  const encoded = taskWithPolicy.slice(payloadStart, payloadEnd);
  const task = taskWithPolicy
    .slice(payloadEnd + CHILD_POLICY_CLOSE.length)
    .trim();
  if (!task) throw new Error('delegated task is empty after policy extraction');

  return {
    policy: parseChildPolicy(decodePolicy(encoded), environment),
    task,
  };
};
