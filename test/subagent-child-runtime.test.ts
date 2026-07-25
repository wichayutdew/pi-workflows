import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  CHILD_COMPLETION_TOOL,
  registerSubagentChildRuntime,
} from '../src/integrations/subagents/child-runtime.ts';
import {
  encodeChildPolicy,
  parseDelegatedStepResult,
  type ChildStepPolicy,
} from '../src/integrations/subagents/protocol.ts';
import { expectTruthy } from './helpers.ts';

describe('when testing subagent child runtime', () => {
  type Handler = (event: Record<string, unknown>) => unknown;

  interface RegisteredToolLike {
    name: string;
    execute: (
      toolCallId: string,
      params: { outcome: string; summary: string; artifact?: string },
    ) => Promise<{
      terminate?: boolean;
      content: Array<{ type: string; text: string }>;
    }>;
  }

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
      summaryMaxChars: 500,
      ...overrides,
    };
  }

  function runtime(
    childAgent: string | undefined,
    profileTools = ['read', 'bash'],
  ) {
    const handlers = new Map<string, Handler[]>();
    const activeTools: string[][] = [];
    let currentActiveTools = [...profileTools];
    let completionTool: RegisteredToolLike | undefined;
    const inventory = [
      { name: 'read', sourceInfo: { source: 'builtin' } },
      { name: 'write', sourceInfo: { source: 'builtin' } },
      { name: 'bash', sourceInfo: { source: 'builtin' } },
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
        completionTool = tool as RegisteredToolLike;
        inventory.push({
          name: completionTool.name,
          sourceInfo: {
            source: 'extension',
            path: '/packages/pi-workflows/index.ts',
          },
        });
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
    });
    return {
      handlers,
      activeTools,
      completionTool: () => completionTool,
    };
  }

  describe('should satisfy its behavioral contract', () => {
    test('child runtime narrows tools, enforces Bash, and writes a correlated result', async () => {
      // given
      const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-step-'));
      const policy: ChildStepPolicy = {
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
        summaryMaxChars: 500,
      };
      const handlers = new Map<string, Handler[]>();
      const activeTools: string[][] = [];
      let currentActiveTools = ['read', 'bash'];
      let completionTool: RegisteredToolLike | undefined;
      const inventory = [
        { name: 'read', sourceInfo: { source: 'builtin' } },
        { name: 'write', sourceInfo: { source: 'builtin' } },
        { name: 'bash', sourceInfo: { source: 'builtin' } },
        {
          name: 'mcp',
          sourceInfo: {
            source: 'extension',
            path: '/packages/pi-mcp-adapter/index.ts',
          },
        },
      ];
      // when
      const pi = {
        on(event: string, handler: Handler) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        registerTool(tool: unknown) {
          completionTool = tool as RegisteredToolLike;
          inventory.push({
            name: completionTool.name,
            sourceInfo: {
              source: 'extension',
              path: '/packages/pi-workflows/index.ts',
            },
          });
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

      // then
      try {
        await writeFile(policy.capabilityPath, policy.capabilityToken, {
          encoding: 'utf8',
          mode: 0o600,
        });
        registerSubagentChildRuntime(pi, { childAgent: policy.agent });
        expect(activeTools).toEqual([]);
        expect(completionTool).toBe(undefined);

        const toolCall = handlers.get('tool_call')?.[0];
        expectTruthy(toolCall);
        expect(
          toolCall({
            type: 'tool_call',
            toolCallId: 'before-policy',
            toolName: 'read',
            input: { path: 'README.md' },
          }),
        ).toBe(undefined);

        const input = handlers.get('input')?.[0];
        expectTruthy(input);
        expect(
          input({
            type: 'input',
            source: 'rpc',
            text: 'Review this ordinary subagent task.',
          }),
        ).toBe(undefined);
        expect(activeTools).toEqual([]);
        expect(completionTool).toBe(undefined);

        const transformed = input({
          type: 'input',
          source: 'rpc',
          text: `${encodeChildPolicy(policy)}\n\nInspect now.`,
        }) as { action: string; text: string };
        expect(transformed).toEqual({
          action: 'transform',
          text: 'Inspect now.',
        });
        expect(activeTools.at(-1)).toEqual([
          'read',
          'bash',
          CHILD_COMPLETION_TOOL,
        ]);
        await expect(readFile(policy.capabilityPath, 'utf8')).rejects.toThrow(
          /ENOENT/,
        );

        expect(
          (
            toolCall({
              type: 'tool_call',
              toolCallId: 'profile-denied',
              toolName: 'mcp',
              input: {
                server: 'gitlab',
                tool: 'get_merge_request',
              },
            }) as { reason?: string }
          ).reason ?? '',
        ).toMatch(/not enabled by subagent "worker"/);
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

        const activeCompletionTool = completionTool as
          RegisteredToolLike | undefined;
        expectTruthy(activeCompletionTool);
        const completion = await activeCompletionTool.execute('complete', {
          outcome: 'ready',
          summary: 'Inspection complete',
        });
        expect(completion.terminate).toBe(true);
        const stored = JSON.parse(
          await readFile(policy.resultPath, 'utf8'),
        ) as unknown;
        expect(parseDelegatedStepResult(stored, policy)).toEqual({
          version: 1,
          policyDigest: policy.policyDigest,
          outcome: 'ready',
          summary: 'Inspection complete',
        });
        await expect(
          activeCompletionTool.execute('complete-again', {
            outcome: 'ready',
            summary: 'Duplicate',
          }),
        ).rejects.toThrow(/already produced a result/);
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
        const completionInput = { outcome: 'ready' };
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
        const completion = rig.completionTool();
        expectTruthy(completion);

        // then
        expect(started.systemPrompt).toContain('# Pi Workflows delegated step');
        expect(started.systemPrompt).toContain(
          'Outcome "ready" requires the complete gate artifact.',
        );
        expect(mixed.block).toBe(true);
        expect(mixed.reason).toMatch(/must be the only tool call/);
        expect(isolated).toBe(undefined);
        expect(Object.isFrozen(completionInput)).toBe(true);
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
        await expect(
          completion.execute('completion-after-error', {
            outcome: 'ready',
            summary: 'Done',
          }),
        ).rejects.toThrow(/more than one workflow policy/);
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

        const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-step-'));
        directories.push(directory);
        const policy = childPolicy(directory);
        await writeFile(policy.capabilityPath, policy.capabilityToken);
        const rig = runtime(policy.agent);
        const input = rig.handlers.get('input')?.[0];
        expectTruthy(input);
        input({ text: `${encodeChildPolicy(policy)}\n\nInspect.` });
        await rm(directory, { recursive: true, force: true });
        const completion = rig.completionTool();
        expectTruthy(completion);

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
        await expect(
          completion.execute('missing-result-directory', {
            outcome: 'ready',
            summary: 'Done',
          }),
        ).rejects.toThrow();
      } finally {
        await Promise.all(
          directories.map((directory) =>
            rm(directory, { recursive: true, force: true }),
          ),
        );
      }
    });
  });
});
