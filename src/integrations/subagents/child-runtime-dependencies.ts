import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type { SubagentChildRuntimeDependencies } from './child-runtime-types.ts';

const tokensAreEqual = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
};

export const DEFAULT_CHILD_RUNTIME_DEPENDENCIES = {
  fileSystem: {
    exists: existsSync,
    inspect: lstatSync,
    readText: (path: string) => readFileSync(path, 'utf8'),
    realPath: realpathSync,
    rename: renameSync,
    stat: statSync,
    unlink: unlinkSync,
    writeExclusive: (path: string, content: string) => {
      writeFileSync(path, content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    },
  },
  createUniqueId: randomUUID,
  currentWorkingDirectory: () => process.cwd(),
  environmentChildAgent: () =>
    process.env.PI_SUBAGENT_CHILD_AGENT?.trim() || undefined,
  temporaryDirectory: tmpdir,
  tokensAreEqual,
} as const satisfies SubagentChildRuntimeDependencies;
