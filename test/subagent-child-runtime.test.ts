import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  CHILD_COMPLETION_TOOL,
  registerSubagentChildRuntime,
  type SubagentChildRuntimeDependencies,
} from '../src/integrations/subagents/child-runtime.ts';
import { DEFAULT_CHILD_RUNTIME_DEPENDENCIES } from '../src/integrations/subagents/child-runtime-dependencies.ts';
import {
  encodeChildPolicy,
  parseDelegatedStepResult,
  type ChildStepPolicy,
} from '../src/integrations/subagents/protocol.ts';
import { expectTruthy } from './helpers.ts';

describe('when testing subagent child runtime', () => {
  type Handler = (event: Record<string, unknown>) => unknown;

  function childPolicy(
    directory: string,
    overrides: Partial<ChildStepPolicy> = {},
  ): ChildStepPolicy {
    return {
      version: 1,
      requestId: 'request-child',
      agent: 'worker',
      workflowId: 'example',
      runId: 'run-child',
      stepId: 'inspect',
      stepTitle: 'Inspect',
      policyDigest: 'c'.repeat(64),
      capabilityPath: join(directory, 'capability'),
      capabilityToken: 'd'.repeat(64),
      resultPath: join(directory, 'result.json'),
      permissions: {
        tools: ['read', 'bash'],
        mcp: ['gitlab/get_merge_request'],
        extensions: [],
        skills: [],
        bash: { mode: 'read-only', allow: [] },
      },
      outcomes: ['ready', 'blocked'],
      pauseOutcomes: ['blocked'],
      summaryMaxChars: 500,
      ...overrides,
    };
  }

  function runtime(
    childAgent: string | undefined,
    profileTools = ['read', 'bash', CHILD_COMPLETION_TOOL],
    dependencies?: SubagentChildRuntimeDependencies,
  ) {
    const handlers = new Map<string, Handler[]>();
    const activeTools: string[][] = [];
    let currentActiveTools = [...profileTools];
    const registeredTools: unknown[] = [];
    const inventory = [
      { name: 'read', sourceInfo: { source: 'builtin' } },
      { name: 'edit', sourceInfo: { source: 'builtin' } },
      { name: 'write', sourceInfo: { source: 'builtin' } },
      { name: 'bash', sourceInfo: { source: 'builtin' } },
      {
        name: CHILD_COMPLETION_TOOL,
        sourceInfo: {
          source: 'extension',
          path: '/packages/pi-subagents/structured-output.ts',
        },
      },
      {
        name: 'contact_supervisor',
        sourceInfo: {
          source: 'extension',
          path: '/packages/pi-subagents/index.ts',
        },
      },
      {
        name: 'intercom',
        sourceInfo: {
          source: 'extension',
          path: '/packages/pi-subagents/index.ts',
        },
      },
      {
        name: 'mcp',
        sourceInfo: {
          source: 'extension',
          path: '/packages/pi-mcp-adapter/index.ts',
        },
      },
    ];
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerTool(tool: unknown) {
        registeredTools.push(tool);
      },
      getAllTools() {
        return inventory;
      },
      getActiveTools() {
        return [...currentActiveTools];
      },
      setActiveTools(tools: string[]) {
        currentActiveTools = [...tools];
        activeTools.push(tools);
      },
    } as unknown as ExtensionAPI;
    registerSubagentChildRuntime(pi, {
      ...(childAgent ? { childAgent } : {}),
      ...(dependencies ? { dependencies } : {}),
    });
    return {
      handlers,
      activeTools,
      registeredTools,
    };
  }

  describe('should satisfy its behavioral contract', () => {
    test('child runtime narrows tools, enforces Bash, and writes a correlated result', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-step-'));
      const policy = childPolicy(directory, { repositoryCwd: directory });
      const rig = runtime(policy.agent);

      // when
      try {
        await writeFile(policy.capabilityPath, policy.capabilityToken, {
          encoding: 'utf8',
          mode: 0o600,
        });
        expect(rig.activeTools).toEqual([]);
        expect(rig.registeredTools).toEqual([]);

        const toolCall = rig.handlers.get('tool_call')?.[0];
        expectTruthy(toolCall);
        expect(
          toolCall({
            type: 'tool_call',
            toolCallId: 'before-policy',
            toolName: 'read',
            input: { path: 'README.md' },
          }),
        ).toBe(undefined);

        const input = rig.handlers.get('input')?.[0];
        const beforeAgentStart = rig.handlers.get('before_agent_start')?.[0];
        expectTruthy(input);
        expectTruthy(beforeAgentStart);
        expect(
          input({
            type: 'input',
            source: 'rpc',
            text: 'Review this ordinary subagent task.',
          }),
        ).toBe(undefined);
        expect(rig.activeTools).toEqual([]);
        expect(rig.registeredTools).toEqual([]);

        const transformed = input({
          type: 'input',
          source: 'rpc',
          text: `<file name="${join(tmpdir(), 'pi-subagent-long-task', 'task.md')}">\nTask: ${encodeChildPolicy(policy)}\n\nInspect now.\n</file>\n`,
        }) as { action: string; text: string };
        expect(transformed).toEqual({
          action: 'transform',
          text: 'Inspect now.',
        });
        expect(rig.activeTools.at(-1)).toEqual([
          'read',
          'bash',
          CHILD_COMPLETION_TOOL,
          'mcp',
        ]);
        const started = beforeAgentStart({
          systemPrompt: 'Base child prompt',
        }) as { systemPrompt: string };
        expect(started.systemPrompt).toContain(
          'finish with a pause outcome and describe the unresolved contract',
        );
        expect(started.systemPrompt).toContain(
          'Keep every edit and write inside the reviewed repository root.',
        );
        await expect(readFile(policy.capabilityPath, 'utf8')).rejects.toThrow(
          /ENOENT/,
        );

        expect(
          toolCall({
            type: 'tool_call',
            toolCallId: 'workflow-enabled',
            toolName: 'mcp',
            input: {
              server: 'gitlab',
              tool: 'get_merge_request',
            },
          }),
        ).toBe(undefined);
        expect(
          (
            toolCall({
              type: 'tool_call',
              toolCallId: 'workflow-denied',
              toolName: 'edit',
              input: { path: 'README.md', oldText: 'a', newText: 'b' },
            }) as { reason?: string }
          ).reason ?? '',
        ).toMatch(/not allowed for this workflow step/);
        expect(
          (
            toolCall({
              type: 'tool_call',
              toolCallId: 'unsafe',
              toolName: 'bash',
              input: { command: 'npm test' },
            }) as { block?: boolean }
          ).block,
        ).toBe(true);
        expect(
          toolCall({
            type: 'tool_call',
            toolCallId: 'safe',
            toolName: 'bash',
            input: { command: 'git status --short' },
          }),
        ).toBe(undefined);

        const invalidStructuredInputs = [
          {
            input: null,
            reason: /input must be an object/,
          },
          {
            input: {},
            reason: /input must contain only value/,
          },
          {
            input: { value: 'not-an-object' },
            reason: /value must be an object/,
          },
          {
            input: {
              value: {
                outcome: 'ready',
                summary: 'Inspection complete',
                extra: true,
              },
            },
            reason: /unknown property "extra"/,
          },
          {
            input: {
              value: {
                outcome: 'unknown',
                summary: 'Inspection complete',
              },
            },
            reason: /invalid outcome/,
          },
        ];
        for (const [index, scenario] of invalidStructuredInputs.entries()) {
          const rejected = toolCall({
            type: 'tool_call',
            toolCallId: `invalid-structured-${index}`,
            toolName: CHILD_COMPLETION_TOOL,
            input: scenario.input,
          }) as { block: boolean; reason: string };
          expect(rejected.block).toBe(true);
          expect(rejected.reason).toMatch(scenario.reason);
        }

        const completionInput = {
          value: {
            outcome: 'ready',
            summary: 'Inspection complete',
          },
        };
        expect(
          toolCall({
            type: 'tool_call',
            toolCallId: 'complete',
            toolName: CHILD_COMPLETION_TOOL,
            input: completionInput,
          }),
        ).toBe(undefined);
        expect(Object.isFrozen(completionInput)).toBe(true);
        expect(Object.isFrozen(completionInput.value)).toBe(true);
        const stored = JSON.parse(
          await readFile(policy.resultPath, 'utf8'),
        ) as unknown;
        expect(parseDelegatedStepResult(stored, policy)).toEqual({
          version: 1,
          policyDigest: policy.policyDigest,
          outcome: 'ready',
          summary: 'Inspection complete',
        });
        expect(
          toolCall({
            type: 'tool_call',
            toolCallId: 'complete-again',
            toolName: CHILD_COMPLETION_TOOL,
            input: {
              value: {
                outcome: 'ready',
                summary: 'Duplicate',
              },
            },
          }),
        ).toEqual({
          block: true,
          reason: 'Delegated workflow step already produced a result',
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('applies the delegated lifecycle prompt and completion isolation', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-step-'));
      const policy = childPolicy(directory, { gateSubmitOutcome: 'ready' });
      const rig = runtime(policy.agent);

      // when
      try {
        await writeFile(policy.capabilityPath, policy.capabilityToken);
        const input = rig.handlers.get('input')?.[0];
        const beforeAgentStart = rig.handlers.get('before_agent_start')?.[0];
        const turnStart = rig.handlers.get('turn_start')?.[0];
        const messageEnd = rig.handlers.get('message_end')?.[0];
        const toolCall = rig.handlers.get('tool_call')?.[0];
        expectTruthy(input);
        expectTruthy(beforeAgentStart);
        expectTruthy(turnStart);
        expectTruthy(messageEnd);
        expectTruthy(toolCall);
        expect(
          input({
            text: `${encodeChildPolicy(policy)}\n\nInspect now.`,
            images: ['diagram'],
          }),
        ).toEqual({
          action: 'transform',
          text: 'Inspect now.',
          images: ['diagram'],
        });
        const started = beforeAgentStart({
          systemPrompt: 'Base child prompt',
        }) as { systemPrompt: string };
        messageEnd({
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'complete-mixed',
                name: CHILD_COMPLETION_TOOL,
              },
              { type: 'toolCall', id: 'read-mixed', name: 'read' },
            ],
          },
        });
        const mixed = toolCall({
          toolCallId: 'complete-mixed',
          toolName: CHILD_COMPLETION_TOOL,
          input: {},
        }) as { block: boolean; reason: string };
        turnStart({});
        const completionInput = {
          value: {
            outcome: 'ready',
            summary: 'Ready for review',
            artifact: '# Complete plan',
          },
        };
        const isolated = toolCall({
          toolCallId: 'complete-isolated',
          toolName: CHILD_COMPLETION_TOOL,
          input: completionInput,
        });
        messageEnd({
          message: { role: 'assistant', content: [{ type: 'text' }] },
        });
        const duplicate = input({
          text: `${encodeChildPolicy(policy)}\n\nInspect twice.`,
          images: ['diagram'],
        }) as { text: string };

        // then
        expect(started.systemPrompt).toContain('# Pi Workflows delegated step');
        expect(started.systemPrompt).toContain(
          'call `structured_output` exactly once',
        );
        expect(started.systemPrompt).toContain(
          'Outcome "ready" requires the complete gate artifact.',
        );
        expect(started.systemPrompt).toMatch(/non-interactive workflow child/i);
        expect(started.systemPrompt).toMatch(
          /every unresolved decision in the gate artifact/i,
        );
        expect(started.systemPrompt).toContain(
          'choose a pause outcome (blocked)',
        );
        expect(
          toolCall({
            toolCallId: 'supervisor',
            toolName: 'contact_supervisor',
            input: { reason: 'need_decision', message: 'Question?' },
          }),
        ).toEqual({
          block: true,
          reason:
            'workflow children are non-interactive; use structured_output with a pause outcome and describe the unresolved contract in summary',
        });
        expect(mixed.block).toBe(true);
        expect(mixed.reason).toMatch(/must be the only tool call/);
        expect(isolated).toBe(undefined);
        expect(Object.isFrozen(completionInput)).toBe(true);
        expect(Object.isFrozen(completionInput.value)).toBe(true);
        expect(duplicate.text).toMatch(/more than one workflow policy/);
        expect(
          toolCall({
            toolCallId: 'completion-after-error',
            toolName: CHILD_COMPLETION_TOOL,
            input: {},
          }),
        ).toEqual({
          block: true,
          reason: 'child received more than one workflow policy',
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('confines bootstrap file mutations to the reviewed repository root', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-step-'));
      const repositoryCwd = join(directory, 'reviewed-repository');
      const outsideDirectory = join(directory, 'outside-repository');
      const policy = childPolicy(directory, {
        repositoryCwd,
        bootstrapCwd: process.cwd(),
        permissions: {
          tools: ['edit', 'write'],
          mcp: [],
          extensions: [],
          skills: [],
          bash: { mode: 'deny', allow: [] },
        },
      });
      const rig = runtime(policy.agent, [
        'edit',
        'write',
        CHILD_COMPLETION_TOOL,
      ]);

      // when
      try {
        await writeFile(policy.capabilityPath, policy.capabilityToken);
        const input = rig.handlers.get('input')?.[0];
        const beforeAgentStart = rig.handlers.get('before_agent_start')?.[0];
        const toolCall = rig.handlers.get('tool_call')?.[0];
        expectTruthy(input);
        expectTruthy(beforeAgentStart);
        expectTruthy(toolCall);
        input({ text: `${encodeChildPolicy(policy)}\n\nBootstrap worktree.` });
        const started = beforeAgentStart({
          systemPrompt: 'Base child prompt',
        }) as { systemPrompt: string };
        const missingPath = toolCall({
          toolCallId: 'missing-path',
          toolName: 'write',
          input: {},
        });
        const relativePath = toolCall({
          toolCallId: 'relative-path',
          toolName: 'edit',
          input: { path: 'src/outside.ts' },
        });
        const missingRoot = toolCall({
          toolCallId: 'missing-root',
          toolName: 'write',
          input: { path: join(repositoryCwd, 'src', 'before-setup.ts') },
        });
        await mkdir(repositoryCwd);
        await mkdir(outsideDirectory);
        await symlink(
          outsideDirectory,
          join(repositoryCwd, 'outside-link'),
          'dir',
        );
        await symlink(
          join(outsideDirectory, 'missing-target'),
          join(repositoryCwd, 'broken-link'),
          'dir',
        );
        const parentPath = toolCall({
          toolCallId: 'parent-path',
          toolName: 'write',
          input: { path: directory },
        });
        const symlinkPath = toolCall({
          toolCallId: 'symlink-path',
          toolName: 'write',
          input: {
            path: join(repositoryCwd, 'outside-link', 'escaped.ts'),
          },
        });
        const brokenSymlinkPath = toolCall({
          toolCallId: 'broken-symlink-path',
          toolName: 'write',
          input: {
            path: join(repositoryCwd, 'broken-link', 'escaped.ts'),
          },
        });
        const approvedInput = {
          path: join(repositoryCwd, 'src', 'inside.ts'),
          content: 'approved',
        };
        const approvedPath = toolCall({
          toolCallId: 'approved-path',
          toolName: 'write',
          input: approvedInput,
        });

        // then
        expect(started.systemPrompt).toContain(
          `Reviewed repository root: ${repositoryCwd}`,
        );
        expect(started.systemPrompt).toContain(
          `Bootstrap directory: ${process.cwd()}`,
        );
        expect(started.systemPrompt).toMatch(
          /use absolute paths under the reviewed repository root/i,
        );
        expect(missingPath).toEqual({
          block: true,
          reason: 'write must name a path inside the reviewed repository root',
        });
        expect(relativePath).toEqual({
          block: true,
          reason: `edit path is outside the reviewed repository root "${repositoryCwd}"`,
        });
        expect(missingRoot).toEqual({
          block: true,
          reason: `reviewed repository root is not an existing directory: ${repositoryCwd}`,
        });
        expect(parentPath).toEqual({
          block: true,
          reason: `write path is outside the reviewed repository root "${repositoryCwd}"`,
        });
        expect(symlinkPath).toEqual({
          block: true,
          reason: `write path is outside the reviewed repository root "${repositoryCwd}"`,
        });
        expect(brokenSymlinkPath).toEqual({
          block: true,
          reason: `write path is outside the reviewed repository root "${repositoryCwd}"`,
        });
        expect(approvedPath).toBe(undefined);
        expect(Object.isFrozen(approvedInput)).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('does not invent a pause outcome when the workflow has none', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-step-'));
      const policy = childPolicy(directory, {
        outcomes: ['done'],
        pauseOutcomes: [],
      });
      const rig = runtime(policy.agent);

      // when
      try {
        await writeFile(policy.capabilityPath, policy.capabilityToken);
        const input = rig.handlers.get('input')?.[0];
        const beforeAgentStart = rig.handlers.get('before_agent_start')?.[0];
        expectTruthy(input);
        expectTruthy(beforeAgentStart);
        input({ text: `${encodeChildPolicy(policy)}\n\nFinish now.` });
        const started = beforeAgentStart({
          systemPrompt: 'Base child prompt',
        }) as { systemPrompt: string };

        // then
        expect(started.systemPrompt).toContain(
          'do not fabricate success or call the completion tool',
        );
        expect(started.systemPrompt).not.toContain('choose a pause outcome');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('fails closed for malformed policies, capabilities, and result paths', async () => {
      // given
      const directories: string[] = [];
      const malformed = runtime('worker');
      const malformedInput = malformed.handlers.get('input')?.[0];
      const malformedStart = malformed.handlers.get('before_agent_start')?.[0];
      const malformedTool = malformed.handlers.get('tool_call')?.[0];
      expectTruthy(malformedInput);
      expectTruthy(malformedStart);
      expectTruthy(malformedTool);

      // when
      const malformedResult = malformedInput({
        text: '<pi-workflows-policy-v1>%%%invalid%%%</pi-workflows-policy-v1> task',
        images: ['evidence'],
      }) as { text: string; images: string[] };
      const missingStart = malformedStart({ systemPrompt: 'base' });
      const blockedWithoutPolicy = malformedTool({
        toolCallId: 'blocked',
        toolName: 'read',
        input: {},
      });
      const capabilityErrors: string[] = [];
      try {
        for (const scenario of ['agent', 'missing', 'token'] as const) {
          const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-step-'));
          directories.push(directory);
          const policy = childPolicy(directory);
          if (scenario !== 'missing') {
            await writeFile(
              policy.capabilityPath,
              scenario === 'token' ? 'invalid-token' : policy.capabilityToken,
            );
          }
          const rig = runtime(scenario === 'agent' ? 'reviewer' : policy.agent);
          const input = rig.handlers.get('input')?.[0];
          expectTruthy(input);
          const result = input({
            text: `${encodeChildPolicy(policy)}\n\nInspect.`,
          }) as { text: string };
          capabilityErrors.push(result.text);
        }

        const unavailableDirectory = await mkdtemp(
          join(tmpdir(), 'pi-workflows-step-'),
        );
        directories.push(unavailableDirectory);
        const unavailablePolicy = childPolicy(unavailableDirectory);
        await writeFile(
          unavailablePolicy.capabilityPath,
          unavailablePolicy.capabilityToken,
        );
        const unavailable = runtime(unavailablePolicy.agent, ['read', 'bash']);
        const unavailableInput = unavailable.handlers.get('input')?.[0];
        expectTruthy(unavailableInput);
        const unavailableResult = unavailableInput({
          text: `${encodeChildPolicy(unavailablePolicy)}\n\nInspect.`,
        }) as { text: string };

        const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-step-'));
        directories.push(directory);
        const policy = childPolicy(directory);
        await writeFile(policy.capabilityPath, policy.capabilityToken);
        const rig = runtime(policy.agent);
        const input = rig.handlers.get('input')?.[0];
        const toolCall = rig.handlers.get('tool_call')?.[0];
        expectTruthy(input);
        expectTruthy(toolCall);
        input({ text: `${encodeChildPolicy(policy)}\n\nInspect.` });
        await rm(directory, { recursive: true, force: true });
        const missingResultDirectory = toolCall({
          toolCallId: 'missing-result-directory',
          toolName: CHILD_COMPLETION_TOOL,
          input: {
            value: {
              outcome: 'ready',
              summary: 'Done',
            },
          },
        }) as { block: boolean; reason: string };

        // then
        expect(malformedResult.images).toEqual(['evidence']);
        expect(malformedResult.text).toMatch(/cannot be decoded/);
        expect(missingStart).toBe(undefined);
        expect(blockedWithoutPolicy).toEqual({
          block: true,
          reason: 'delegated task child policy cannot be decoded',
        });
        expect(capabilityErrors.join('\n')).toMatch(
          /child agent does not match/,
        );
        expect(capabilityErrors.join('\n')).toMatch(/capability is missing/);
        expect(capabilityErrors.join('\n')).toMatch(/capability is invalid/);
        expect(unavailableResult.text).toMatch(
          /structured_output completion is unavailable/,
        );
        expect(unavailable.activeTools.at(-1)).toEqual([]);
        expect(missingResultDirectory.block).toBe(true);
        expect(missingResultDirectory.reason).toMatch(/ENOENT/);
      } finally {
        await Promise.all(
          directories.map((directory) =>
            rm(directory, { recursive: true, force: true }),
          ),
        );
      }
    });

    test('uses injected process and file-system boundaries', () => {
      // given
      const temporaryRoot = '/virtual-pi-temp';
      const directory = join(
        temporaryRoot,
        'pi-workflows-step-injected-runtime',
      );
      const policy = childPolicy(directory);
      const files = new Map([[policy.capabilityPath, policy.capabilityToken]]);
      const inspection = {
        isDirectory: () => true,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
      const dependencies: SubagentChildRuntimeDependencies = {
        fileSystem: {
          exists: (path) => files.has(path),
          inspect: () => inspection,
          readText: (path) => {
            const content = files.get(path);
            if (content === undefined) throw new Error('missing file');
            return content;
          },
          realPath: (path) => path,
          rename: (source, destination) => {
            const content = files.get(source);
            if (content === undefined) throw new Error('missing source');
            files.delete(source);
            files.set(destination, content);
          },
          stat: () => inspection,
          unlink: (path) => {
            files.delete(path);
          },
          writeExclusive: (path, content) => {
            if (files.has(path)) throw new Error('file exists');
            files.set(path, content);
          },
        },
        createUniqueId: () => 'injected-id',
        currentWorkingDirectory: () => '/virtual-workspace',
        environmentChildAgent: () => policy.agent,
        temporaryDirectory: () => temporaryRoot,
        tokensAreEqual: (actual, expected) => actual === expected,
      };
      const rig = runtime(undefined, undefined, dependencies);
      const input = rig.handlers.get('input')?.[0];
      const toolCall = rig.handlers.get('tool_call')?.[0];
      expectTruthy(input);
      expectTruthy(toolCall);

      // when
      const transformed = input({
        type: 'input',
        source: 'rpc',
        text: `${encodeChildPolicy(policy)}\n\nFinish in memory.`,
      });
      const completionInput = {
        value: {
          outcome: 'ready',
          summary: 'Completed through injected boundaries',
        },
      };
      const completionResult = toolCall({
        type: 'tool_call',
        toolCallId: 'injected-completion',
        toolName: CHILD_COMPLETION_TOOL,
        input: completionInput,
      });

      // then
      expect(transformed).toEqual({
        action: 'transform',
        text: 'Finish in memory.',
      });
      expect(completionResult).toBe(undefined);
      expect(files.has(policy.capabilityPath)).toBe(false);
      expect(JSON.parse(files.get(policy.resultPath) ?? '')).toEqual({
        version: 1,
        policyDigest: policy.policyDigest,
        outcome: 'ready',
        summary: 'Completed through injected boundaries',
      });
      expect(Object.isFrozen(completionInput)).toBe(true);
    });

    test('normalizes the default child-agent environment boundary', () => {
      // given
      const previousChildAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
      process.env.PI_SUBAGENT_CHILD_AGENT = ' worker ';

      try {
        // when
        const childAgent =
          DEFAULT_CHILD_RUNTIME_DEPENDENCIES.environmentChildAgent();

        // then
        expect(childAgent).toBe('worker');
      } finally {
        if (previousChildAgent === undefined) {
          delete process.env.PI_SUBAGENT_CHILD_AGENT;
        } else {
          process.env.PI_SUBAGENT_CHILD_AGENT = previousChildAgent;
        }
      }
    });
  });
});
