import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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

test('child runtime narrows tools, enforces Bash, and writes a correlated result', async () => {
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

  try {
    await writeFile(policy.capabilityPath, policy.capabilityToken, {
      encoding: 'utf8',
      mode: 0o600,
    });
    registerSubagentChildRuntime(pi, { childAgent: policy.agent });
    assert.deepEqual(activeTools, []);
    assert.equal(completionTool, undefined);

    const toolCall = handlers.get('tool_call')?.[0];
    assert.ok(toolCall);
    assert.equal(
      toolCall({
        type: 'tool_call',
        toolCallId: 'before-policy',
        toolName: 'read',
        input: { path: 'README.md' },
      }),
      undefined,
    );

    const input = handlers.get('input')?.[0];
    assert.ok(input);
    assert.equal(
      input({
        type: 'input',
        source: 'rpc',
        text: 'Review this ordinary subagent task.',
      }),
      undefined,
    );
    assert.deepEqual(activeTools, []);
    assert.equal(completionTool, undefined);

    const transformed = input({
      type: 'input',
      source: 'rpc',
      text: `${encodeChildPolicy(policy)}\n\nInspect now.`,
    }) as { action: string; text: string };
    assert.deepEqual(transformed, {
      action: 'transform',
      text: 'Inspect now.',
    });
    assert.deepEqual(activeTools.at(-1), [
      'read',
      'bash',
      CHILD_COMPLETION_TOOL,
    ]);
    await assert.rejects(readFile(policy.capabilityPath, 'utf8'), /ENOENT/);

    assert.match(
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
      /not enabled by subagent "worker"/,
    );
    assert.equal(
      (
        toolCall({
          type: 'tool_call',
          toolCallId: 'unsafe',
          toolName: 'bash',
          input: { command: 'npm test' },
        }) as { block?: boolean }
      ).block,
      true,
    );
    assert.equal(
      toolCall({
        type: 'tool_call',
        toolCallId: 'safe',
        toolName: 'bash',
        input: { command: 'git status --short' },
      }),
      undefined,
    );

    const activeCompletionTool = completionTool as
      RegisteredToolLike | undefined;
    assert.ok(activeCompletionTool);
    const completion = await activeCompletionTool.execute('complete', {
      outcome: 'ready',
      summary: 'Inspection complete',
    });
    assert.equal(completion.terminate, true);
    const stored = JSON.parse(
      await readFile(policy.resultPath, 'utf8'),
    ) as unknown;
    assert.deepEqual(parseDelegatedStepResult(stored, policy), {
      version: 1,
      policyDigest: policy.policyDigest,
      outcome: 'ready',
      summary: 'Inspection complete',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
