import { describe, expect, test } from 'bun:test';
import {
  authorizeBash,
  tokenizeRestrictedCommand,
} from '../src/policy/bash.ts';
import {
  authorizeMcpProxy,
  authorizeToolCall,
  resolveActiveTools,
} from '../src/policy/tools.ts';
import { loadedWorkflow } from './helpers.ts';

describe('when testing policy', () => {
  describe('should satisfy its behavioral contract', () => {
    test('Bash allow-lists enforce generic token rules without command semantics', () => {
      // given
      const policy = {
        mode: 'allow-list' as const,
        allow: [
          { executable: 'git', argsPrefix: ['status'] },
          { executable: 'rg', argsPrefix: [] },
        ],
      };
      // then
      expect(authorizeBash('git status --short', policy).allowed).toBe(true);
      expect(authorizeBash('git checkout main', policy).allowed).toBe(false);
      expect(authorizeBash('rg TODO src', policy).allowed).toBe(true);
      expect(authorizeBash('git status && rm -rf tmp', policy).allowed).toBe(
        false,
      );
      expect(
        authorizeBash("rg 'literal #tag and fn()' src", policy).allowed,
      ).toBe(true);
      expect(authorizeBash('rg "unsafe $HOME" src', policy).allowed).toBe(
        false,
      );
      expect(authorizeBash("rg -g '*.ts' TODO .", policy).allowed).toBe(true);
    });

    test('Bash allow-list matches executable and argument prefix', () => {
      // given
      // when
      const policy = {
        mode: 'allow-list' as const,
        allow: [{ executable: 'npm', argsPrefix: ['test'] }],
      };
      // then
      expect(authorizeBash('npm test -- --runInBand', policy).allowed).toBe(
        true,
      );
      expect(authorizeBash('npm run build', policy).allowed).toBe(false);
      expect(
        authorizeBash('/bin/sh -c harmless', {
          mode: 'allow-list',
          allow: [{ executable: '/bin/sh', argsPrefix: ['-c'] }],
        }).allowed,
      ).toBe(false);
      expect(
        authorizeBash('git diff --output=/tmp/leak', {
          mode: 'allow-list',
          allow: [{ executable: 'git', argsPrefix: ['diff'] }],
        }).allowed,
      ).toBe(true);
      expect(
        authorizeBash('git diff --ext-diff', {
          mode: 'allow-list',
          allow: [{ executable: 'git', argsPrefix: ['diff'] }],
        }).allowed,
      ).toBe(true);
      const hostedApiPolicy = {
        mode: 'allow-list' as const,
        allow: [{ executable: 'glab', argsPrefix: ['api'] }],
      };
      expect(
        authorizeBash(
          'glab api projects/1/merge_requests/2/discussions --paginate',
          hostedApiPolicy,
        ).allowed,
      ).toBe(true);
      expect(
        authorizeBash(
          'glab api projects/1/merge_requests/2/notes -f body=posted',
          hostedApiPolicy,
        ).allowed,
      ).toBe(true);
      expect(
        authorizeBash(
          'glab api projects/1/merge_requests/2 --method DELETE',
          hostedApiPolicy,
        ).allowed,
      ).toBe(true);
    });

    test('MCP proxy requires an explicit allowed server and tool', () => {
      // given
      // when
      const selectors = ['gitlab/get_merge_request'];
      // then
      expect(
        authorizeMcpProxy(
          { server: 'gitlab', tool: 'get_merge_request', args: '{}' },
          selectors,
        ).allowed,
      ).toBe(true);
      expect(
        authorizeMcpProxy({ tool: 'get_merge_request', args: '{}' }, selectors)
          .allowed,
      ).toBe(false);
      expect(
        authorizeMcpProxy(
          { server: 'github', tool: 'get_merge_request', args: '{}' },
          selectors,
        ).allowed,
      ).toBe(false);
      expect(
        authorizeMcpProxy({ server: 'gitlab', search: 'merge' }, ['gitlab'])
          .allowed,
      ).toBe(false);
    });

    test('tool policy enforces Bash rules after exact tool permission', () => {
      // given
      const workflow = loadedWorkflow();
      // when
      const step = workflow.definition.steps.inspect!;
      // then
      expect(
        authorizeToolCall('bash', { command: 'git status' }, step, [
          { name: 'bash', sourceInfo: { source: 'builtin' } },
        ]).allowed,
      ).toBe(true);
      expect(
        authorizeToolCall('bash', { command: 'npm test' }, step, [
          { name: 'bash', sourceInfo: { source: 'builtin' } },
        ]).allowed,
      ).toBe(false);
    });

    test('active tool selection includes exact tools and allowed extension tools', () => {
      // given
      const workflow = loadedWorkflow({
        version: 1,
        id: 'extensions',
        command: 'extensions',
        description: 'Extension selection',
        start: 'run',
        steps: {
          run: {
            prompt: 'Run',
            permissions: {
              tools: ['read'],
              extensions: ['plannotator'],
            },
            transitions: { done: '$done' },
          },
        },
      });
      // when
      const selected = resolveActiveTools(
        [
          { name: 'read', sourceInfo: { source: 'builtin' } },
          {
            name: 'annotate',
            sourceInfo: {
              source: 'extension',
              path: '/packages/@plannotator/pi-extension/index.ts',
            },
          },
          { name: 'write', sourceInfo: { source: 'builtin' } },
          {
            name: 'workflow_complete_step',
            sourceInfo: { source: 'extension' },
          },
        ],
        workflow.definition.steps.run!,
        'workflow_complete_step',
      );
      // then
      expect(selected).toEqual(['read', 'annotate', 'workflow_complete_step']);
    });

    test('extension selectors do not widen direct MCP access', () => {
      // given
      const workflow = loadedWorkflow({
        version: 1,
        id: 'mcp-extension',
        command: 'mcp-extension',
        description: 'MCP extension',
        start: 'run',
        steps: {
          run: {
            prompt: 'Run',
            permissions: {
              extensions: ['pi-mcp-adapter'],
            },
            transitions: { done: '$done' },
          },
        },
      });
      const directTool = {
        name: 'gitlab_get_merge_request',
        sourceInfo: {
          source: 'extension',
          path: '/packages/pi-mcp-adapter/index.ts',
        },
      };
      // when
      const step = workflow.definition.steps.run!;
      // then
      expect(
        resolveActiveTools(
          [
            directTool,
            {
              name: 'workflow_complete_step',
              sourceInfo: { source: 'extension' },
            },
          ],
          step,
          'workflow_complete_step',
        ),
      ).toEqual(['workflow_complete_step']);
      expect(
        authorizeToolCall('gitlab_get_merge_request', {}, step, [directTool])
          .allowed,
      ).toBe(false);
    });

    test('covers restricted Bash tokenization and terminal policy modes', () => {
      // given
      const allowList = {
        mode: 'allow-list' as const,
        allow: [{ executable: 'printf', argsPrefix: [] }],
      };

      // when
      const results = [
        tokenizeRestrictedCommand("'line\nbreak'"),
        tokenizeRestrictedCommand('"line\nbreak"'),
        tokenizeRestrictedCommand('line\\\nbreak'),
        tokenizeRestrictedCommand('hello\\ world'),
        tokenizeRestrictedCommand('"hello world"'),
      ];

      // then
      expect(results.slice(0, 3).every((result) => result.error)).toBe(true);
      expect(results[3]).toEqual({ tokens: ['hello world'] });
      expect(
        authorizeBash('anything', { mode: 'unrestricted', allow: [] }).allowed,
      ).toBe(true);
      expect(
        authorizeBash('anything', { mode: 'deny', allow: [] }).allowed,
      ).toBe(false);
      expect(authorizeBash('NAME=value', allowList).allowed).toBe(false);
    });

    test('covers disabled MCP and all terminal tool authorization paths', () => {
      // given
      const workflow = loadedWorkflow();
      const step = workflow.definition.steps.inspect!;
      const inventory = [
        { name: 'read', sourceInfo: { source: 'builtin' } },
        { name: 'bash', sourceInfo: { source: 'builtin' } },
      ];

      // when
      const results = [
        authorizeMcpProxy({}, []),
        authorizeMcpProxy({ server: 'gitlab' }, ['gitlab']),
        authorizeToolCall('mcp', {}, step, inventory),
        authorizeToolCall('bash', {}, step, inventory),
        authorizeToolCall('read', {}, step, inventory),
      ];
      const extensionWorkflow = loadedWorkflow({
        version: 1,
        id: 'extension-tool',
        command: 'extension-tool',
        description: 'Extension tool',
        start: 'run',
        steps: {
          run: {
            prompt: 'Run',
            permissions: { extensions: ['annotator'] },
            transitions: { done: '$done' },
          },
        },
      });
      results.push(
        authorizeToolCall(
          'annotate',
          {},
          extensionWorkflow.definition.steps.run!,
          [
            {
              name: 'annotate',
              sourceInfo: { path: '/extensions/annotator/index.ts' },
            },
          ],
        ),
      );

      // then
      expect(results.map((result) => result.allowed)).toEqual([
        false,
        false,
        false,
        false,
        true,
        true,
      ]);
    });
  });
});
