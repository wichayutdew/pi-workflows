import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolveWorkspaceDirectory } from '../src/harness/workspace-directory.ts';

describe('when resolving a workflow workspace directory', () => {
  const temporaryRoots: Array<string> = [];

  const temporaryRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'pi-workflows-cwd-'));
    temporaryRoots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('canonicalizes an existing directory inside a relative allowed root', () => {
    const root = temporaryRoot();
    const startCwd = join(root, 'source');
    const candidateCwd = join(root, 'worktrees', 'task');
    const candidateLink = join(root, 'selected');
    mkdirSync(startCwd);
    mkdirSync(candidateCwd, { recursive: true });
    symlinkSync(candidateCwd, candidateLink);

    expect(
      resolveWorkspaceDirectory({
        candidateCwd: candidateLink,
        startCwd,
        allowedRoots: ['..'],
      }),
    ).toBe(realpathSync(candidateCwd));
  });

  test('rejects malformed, missing, non-directory, and out-of-root targets', () => {
    const root = temporaryRoot();
    const startCwd = join(root, 'source');
    const allowedRoot = join(startCwd, 'allowed');
    const outsideCwd = join(root, 'outside');
    const file = join(allowedRoot, 'file.txt');
    mkdirSync(allowedRoot, { recursive: true });
    mkdirSync(outsideCwd);
    writeFileSync(file, 'not a directory');

    const invalid: Array<
      [Parameters<typeof resolveWorkspaceDirectory>[0], RegExp]
    > = [
      [
        {
          candidateCwd: 'relative',
          startCwd,
          allowedRoots: ['.'],
        },
        /absolute path/,
      ],
      [
        {
          candidateCwd: allowedRoot,
          startCwd: 'relative',
          allowedRoots: ['.'],
        },
        /start cwd/,
      ],
      [
        {
          candidateCwd: allowedRoot,
          startCwd,
          allowedRoots: [],
        },
        /declare an allowed root/,
      ],
      [
        {
          candidateCwd: allowedRoot,
          startCwd,
          allowedRoots: [allowedRoot],
        },
        /relative paths/,
      ],
      [
        {
          candidateCwd: allowedRoot,
          startCwd,
          allowedRoots: ['C:..\\outside'],
        },
        /relative paths/,
      ],
      [
        {
          candidateCwd: file,
          startCwd,
          allowedRoots: ['allowed'],
        },
        /resolve to a directory/,
      ],
      [
        {
          candidateCwd: outsideCwd,
          startCwd,
          allowedRoots: ['allowed'],
        },
        /outside the YAML-authorized roots/,
      ],
    ];

    for (const [options, message] of invalid) {
      expect(() => resolveWorkspaceDirectory(options)).toThrow(message);
    }
    expect(() =>
      resolveWorkspaceDirectory({
        candidateCwd: join(allowedRoot, 'missing'),
        startCwd,
        allowedRoots: ['allowed'],
      }),
    ).toThrow();
  });
});
