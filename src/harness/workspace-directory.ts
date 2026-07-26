import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

export type ResolveWorkspaceDirectoryOptions = {
  readonly candidateCwd: string;
  readonly startCwd: string;
  readonly allowedRoots: ReadonlyArray<string>;
};

const isWithin = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
};

/**
 * Canonicalizes and validates one YAML-authorized execution directory.
 *
 * This boundary intentionally knows only filesystem paths. The workflow prompt
 * owns how the directory was selected or created.
 */
export function resolveWorkspaceDirectory({
  candidateCwd,
  startCwd,
  allowedRoots,
}: ResolveWorkspaceDirectoryOptions): string {
  if (
    !candidateCwd ||
    !isAbsolute(candidateCwd) ||
    candidateCwd.includes('\0')
  ) {
    throw new Error('workspace cwd must be a non-empty absolute path');
  }
  if (!startCwd || !isAbsolute(startCwd) || startCwd.includes('\0')) {
    throw new Error('workflow start cwd must be a non-empty absolute path');
  }
  if (allowedRoots.length === 0) {
    throw new Error('workspace binding must declare an allowed root');
  }

  const canonicalStart = realpathSync(startCwd);
  const canonicalRoots = allowedRoots.map((allowedRoot) => {
    if (
      !allowedRoot ||
      isAbsolute(allowedRoot) ||
      win32.parse(allowedRoot).root !== '' ||
      allowedRoot.includes('\0')
    ) {
      throw new Error(
        'workspace allowed roots must be non-empty relative paths',
      );
    }
    return realpathSync(resolve(canonicalStart, allowedRoot));
  });
  const canonicalCwd = realpathSync(candidateCwd);
  if (!statSync(canonicalCwd).isDirectory()) {
    throw new Error('workspace cwd must resolve to a directory');
  }
  if (!canonicalRoots.some((root) => isWithin(root, canonicalCwd))) {
    throw new Error('workspace cwd is outside the YAML-authorized roots');
  }
  return canonicalCwd;
}
