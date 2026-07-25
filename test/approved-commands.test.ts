import { describe, expect, test } from 'bun:test';
import { extractApprovedBashCommands } from '../src/policy/approved-commands.ts';

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
  });
});
