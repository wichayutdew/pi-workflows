import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractApprovedBashCommands,
  narrowApprovedBashCommands,
  resolveReviewedRepositoryCwd,
  reviewedCommandShapeError,
} from '../src/policy/approved-commands.ts';

describe('when testing approved commands', () => {
  describe('should satisfy its behavioral contract', () => {
    test('extracts exact worker and reviewer commands from reviewed JSON', () => {
      // given
      // when
      const artifact = [
        '# Verification contract',
        '',
        '```json',
        JSON.stringify({
          repositories: [
            {
              worker: [
                { command: 'sh -c test' },
                { command: 'npm test -- --runInBand' },
                { command: 'npm --prefix /tmp/package publish' },
                { command: 'npm --prefix /tmp/package pub' },
                { command: 'npm --prefix /tmp/package publi' },
                { command: 'docker --context production push image:tag' },
                { command: 'git push origin HEAD' },
                { command: 'git -C /tmp/worktree commit -m reviewed' },
                { command: 'git -c alias.run=!sh run' },
              ],
              reviewer: [
                { command: 'npm run lint' },
                { command: 'gh api repos/example/project' },
              ],
            },
          ],
        }),
        '```',
      ].join('\n');

      // then
      expect(
        extractApprovedBashCommands(artifact, ['verification-worker']),
      ).toEqual([
        'npm test -- --runInBand',
        'git -C /tmp/worktree commit -m reviewed',
      ]);
      expect(
        extractApprovedBashCommands(artifact, ['verification-reviewer']),
      ).toEqual(['npm run lint']);
    });

    test('extracts only exact non-force remote actions', () => {
      // given
      // when
      const artifact = JSON.stringify({
        actions: [
          {
            toolName: 'bash',
            input: {
              command: 'git -C /tmp/worktree push origin HEAD:refs/heads/topic',
            },
          },
          {
            toolName: 'bash',
            input: { command: 'git push --force-with-lease origin topic' },
          },
          {
            toolName: 'bash',
            input: { command: 'git push -fu origin topic' },
          },
          {
            toolName: 'bash',
            input: { command: 'git push --delete origin obsolete' },
          },
          {
            toolName: 'bash',
            input: { command: 'git push --del origin obsolete' },
          },
          {
            toolName: 'bash',
            input: { command: 'git push --force-wi origin topic' },
          },
          {
            toolName: 'bash',
            input: { command: 'git push origin :obsolete' },
          },
          {
            toolName: 'bash',
            input: { command: 'git push origin refs/heads/topic:' },
          },
          {
            toolName: 'bash',
            input: {
              command: 'glab api projects/1/merge_requests/2/notes -f body=ok',
            },
          },
          {
            toolName: 'bash',
            input: {
              command:
                "glab api projects/1/merge_requests/2/notes -f body='Use #tag and call fn()'",
            },
          },
          {
            toolName: 'bash',
            input: { command: 'curl https://example.invalid' },
          },
          {
            toolName: 'bash',
            input: { command: 'gh api repos/example/project -XDELETE' },
          },
        ],
      });

      // then
      expect(extractApprovedBashCommands(artifact, ['remote-actions'])).toEqual(
        [
          'git -C /tmp/worktree push origin HEAD:refs/heads/topic',
          'glab api projects/1/merge_requests/2/notes -f body=ok',
          "glab api projects/1/merge_requests/2/notes -f body='Use #tag and call fn()'",
        ],
      );
    });

    test('ignores prose and malformed or composed command contracts', () => {
      // given
      // when
      const artifact = [
        'npm test',
        '```json',
        '{"repositories":[{"worker":[{"command":"npm test && git push"}]}]}',
        '```',
        '```json',
        'not-json',
        '```',
      ].join('\n');
      // then
      expect(
        extractApprovedBashCommands(artifact, ['verification-worker']),
      ).toEqual([]);
    });

    test('rejects Bun install commands with global cwd ordering', () => {
      const artifact = JSON.stringify({
        repositories: [
          {
            worker: [
              {
                command:
                  'bun --cwd /tmp/reviewed-worktree install --frozen-lockfile',
              },
            ],
          },
        ],
      });

      expect(reviewedCommandShapeError(artifact)).toBe(
        'Invalid Bun install command: "bun --cwd /tmp/reviewed-worktree install --frozen-lockfile". `--cwd` appears before `install`, so Bun interprets `install` as a package script. Use `bun install --cwd <absolute-cwd> --frozen-lockfile`, preserving the reviewed path and any other intended install flags, then resubmit the plan.',
      );
      expect(
        reviewedCommandShapeError(
          JSON.stringify({
            repositories: [
              {
                reviewer: [
                  {
                    command:
                      'bun install --cwd /tmp/reviewed-worktree --frozen-lockfile',
                  },
                ],
              },
            ],
          }),
        ),
      ).toBe(undefined);
    });

    test('an unreviewed handoff can only narrow approved commands', () => {
      // given
      const command = (value: string) => ({
        toolName: 'bash',
        input: { command: value },
      });
      const retained =
        'glab api projects/1/merge_requests/2/notes -f body=retained';
      const removed =
        'glab api projects/1/merge_requests/2/notes -f body=removed';
      const injected =
        'glab api projects/1/merge_requests/2/notes -f body=injected';
      const artifact = JSON.stringify({
        actions: [command(retained), command(removed)],
      });
      const handoff = JSON.stringify({
        actions: [command(retained), command(injected)],
      });

      // when
      const commands = narrowApprovedBashCommands(artifact, handoff, [
        'remote-actions',
      ]);

      // then
      expect(commands).toEqual([retained]);
      expect(
        narrowApprovedBashCommands(artifact, '', ['remote-actions']),
      ).toEqual([]);
    });

    describe('reviewed repository cwd recovery', () => {
      let directory: string;
      let secondDirectory: string;
      let filePath: string;

      beforeAll(() => {
        directory = mkdtempSync(join(tmpdir(), 'pi-workflows-reviewed-cwd-'));
        secondDirectory = join(directory, 'second');
        filePath = join(directory, 'file.txt');
        mkdirSync(secondDirectory);
        writeFileSync(filePath, 'not a directory');
      });

      afterAll(() => {
        rmSync(directory, { recursive: true, force: true });
      });

      test('distinguishes artifacts without a repository contract', () => {
        expect(resolveReviewedRepositoryCwd('')).toEqual({ kind: 'none' });
        expect(resolveReviewedRepositoryCwd('Reviewed prose only')).toEqual({
          kind: 'none',
        });
        expect(
          resolveReviewedRepositoryCwd(
            ['```', '', '```', '```json', '{"actions":[]}', '```'].join('\n'),
          ),
        ).toEqual({ kind: 'none' });
      });

      test('resolves one absolute existing repository directory', () => {
        const artifact = [
          '# Reviewed contract',
          '```json',
          JSON.stringify({ repositories: [{ cwd: directory }] }),
          '```',
        ].join('\n');

        expect(resolveReviewedRepositoryCwd(artifact)).toEqual({
          kind: 'resolved',
          cwd: directory,
          repositoryCwd: directory,
          bootstrapping: false,
        });
      });

      test('accepts duplicate references to the same directory', () => {
        const artifact = [
          '```json',
          JSON.stringify({
            repositories: [{ cwd: directory }, { cwd: directory }],
          }),
          '```',
          '```json',
          JSON.stringify({ repositories: [{ cwd: directory }] }),
          '```',
        ].join('\n');

        expect(resolveReviewedRepositoryCwd(artifact)).toEqual({
          kind: 'resolved',
          cwd: directory,
          repositoryCwd: directory,
          bootstrapping: false,
        });
      });

      test('bootstraps a missing target only from one reviewed existing source', () => {
        const repositoryCwd = join(directory, 'missing-target');
        const artifact = JSON.stringify({
          repositories: [{ cwd: repositoryCwd, sourceCwd: directory }],
        });

        expect(resolveReviewedRepositoryCwd(artifact)).toEqual({
          kind: 'resolved',
          cwd: directory,
          repositoryCwd,
          bootstrapping: true,
        });
      });

      test('rejects ambiguous and relative repository directories', () => {
        expect(
          resolveReviewedRepositoryCwd(
            JSON.stringify({
              repositories: [{ cwd: directory }, { cwd: secondDirectory }],
            }),
          ),
        ).toEqual({
          kind: 'invalid',
          reason:
            'Reviewed repository contract is ambiguous: expected exactly one repository cwd',
        });
        expect(
          resolveReviewedRepositoryCwd(
            JSON.stringify({ repositories: [{ cwd: 'relative/path' }] }),
          ),
        ).toEqual({
          kind: 'invalid',
          reason:
            'Reviewed repository contract repository cwd must be an absolute path',
        });
      });

      test('rejects unusable existing targets and missing bootstrap sources', () => {
        expect(
          resolveReviewedRepositoryCwd(
            JSON.stringify({ repositories: [{ cwd: filePath }] }),
          ),
        ).toEqual({
          kind: 'invalid',
          reason: `Reviewed repository cwd is not an accessible directory: ${filePath}`,
        });
        expect(
          resolveReviewedRepositoryCwd(
            JSON.stringify({
              repositories: [{ cwd: join(directory, 'missing') }],
            }),
          ),
        ).toEqual({
          kind: 'invalid',
          reason:
            'Reviewed repository target is missing and requires exactly one absolute sourceCwd',
        });
      });

      test('rejects invalid or ambiguous bootstrap sources', () => {
        const repositoryCwd = join(directory, 'missing-target');
        const missingSource = join(directory, 'missing-source');

        expect(
          resolveReviewedRepositoryCwd(
            JSON.stringify({
              repositories: [
                { cwd: repositoryCwd, sourceCwd: 'relative/source' },
              ],
            }),
          ),
        ).toEqual({
          kind: 'invalid',
          reason:
            'Reviewed repository contract sourceCwd must be an absolute path',
        });
        expect(
          resolveReviewedRepositoryCwd(
            JSON.stringify({
              repositories: [
                { cwd: repositoryCwd, sourceCwd: directory },
                { cwd: repositoryCwd, sourceCwd: secondDirectory },
              ],
            }),
          ),
        ).toEqual({
          kind: 'invalid',
          reason:
            'Reviewed repository contract is ambiguous: expected at most one sourceCwd',
        });
        for (const sourceCwd of [missingSource, filePath]) {
          expect(
            resolveReviewedRepositoryCwd(
              JSON.stringify({
                repositories: [{ cwd: repositoryCwd, sourceCwd }],
              }),
            ),
          ).toEqual({
            kind: 'invalid',
            reason: `Reviewed repository sourceCwd is not an existing directory: ${sourceCwd}`,
          });
        }
      });

      test('rejects malformed or incomplete repository contracts', () => {
        expect(resolveReviewedRepositoryCwd('{not-json')).toEqual({
          kind: 'invalid',
          reason: 'Reviewed repository contract contains malformed JSON',
        });
        expect(resolveReviewedRepositoryCwd('```json\nnot JSON\n```')).toEqual({
          kind: 'invalid',
          reason: 'Reviewed repository contract contains malformed JSON',
        });
        expect(
          resolveReviewedRepositoryCwd(
            [
              '# Reviewed contract',
              '```json',
              JSON.stringify({ repositories: [{ cwd: directory }] }),
              '```',
              '```json',
              'not JSON',
              '```',
            ].join('\n'),
          ),
        ).toEqual({
          kind: 'invalid',
          reason: 'Reviewed repository contract contains malformed JSON',
        });

        for (const repositories of [[], 'invalid']) {
          expect(
            resolveReviewedRepositoryCwd(JSON.stringify({ repositories })),
          ).toEqual({
            kind: 'invalid',
            reason:
              'Reviewed repository contract must contain a non-empty repositories array',
          });
        }
        expect(
          resolveReviewedRepositoryCwd(
            JSON.stringify({ repositories: [null] }),
          ),
        ).toEqual({
          kind: 'invalid',
          reason:
            'Reviewed repository contract contains a malformed repository entry',
        });
        for (const repository of [{}, { cwd: 42 }, { cwd: '/tmp/\0bad' }]) {
          expect(
            resolveReviewedRepositoryCwd(
              JSON.stringify({ repositories: [repository] }),
            ),
          ).toEqual({
            kind: 'invalid',
            reason:
              'Reviewed repository contract repository cwd must be an absolute path',
          });
        }
        expect(
          resolveReviewedRepositoryCwd(
            JSON.stringify({
              repositories: [{ cwd: directory, sourceCwd: '/tmp/\0bad' }],
            }),
          ),
        ).toEqual({
          kind: 'invalid',
          reason:
            'Reviewed repository contract sourceCwd must be an absolute path',
        });
      });
    });
  });
});
