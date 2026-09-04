import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';

const RESULT_FILE_NAME = 'result.json';
const CAPABILITY_FILE_NAME = 'capability';
const RESULT_DIRECTORY_PREFIX = 'pi-workflows-step-';

export type ChildPolicyEnvironment = {
  readonly temporaryDirectory: () => string;
};

export const DEFAULT_CHILD_POLICY_ENVIRONMENT = {
  temporaryDirectory: tmpdir,
} as const satisfies ChildPolicyEnvironment;

type SafeStepFileOptions = {
  readonly path: string;
  readonly expectedName: string;
  readonly environment: ChildPolicyEnvironment;
};

const isSafeStepFilePath = ({
  path,
  expectedName,
  environment,
}: SafeStepFileOptions): boolean => {
  const temporaryRoot = resolve(environment.temporaryDirectory());
  const candidate = resolve(path);
  const relativePath = relative(temporaryRoot, candidate);

  return (
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !relativePath.includes('\0') &&
    basename(candidate) === expectedName &&
    basename(dirname(candidate)).startsWith(RESULT_DIRECTORY_PREFIX)
  );
};

/**
 * Returns whether a delegated result path is confined to its temporary step
 * directory.
 */
export const isSafeStepResultPath = (
  path: string,
  environment: ChildPolicyEnvironment = DEFAULT_CHILD_POLICY_ENVIRONMENT,
): boolean =>
  isSafeStepFilePath({
    path,
    expectedName: RESULT_FILE_NAME,
    environment,
  });

/**
 * Returns whether a delegated capability path is confined to its temporary
 * step directory.
 */
export const isSafeStepCapabilityPath = (
  path: string,
  environment: ChildPolicyEnvironment = DEFAULT_CHILD_POLICY_ENVIRONMENT,
): boolean =>
  isSafeStepFilePath({
    path,
    expectedName: CAPABILITY_FILE_NAME,
    environment,
  });
