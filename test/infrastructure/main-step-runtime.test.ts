import { describe, expect, test } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  normalizeUsage,
  type ModelUsage,
  type UsageTotals,
} from '../../src/function/engine/usage.ts';
import { mainTurnUsage } from '../../src/infrastructure/runtime/main-step-trace.ts';
import { MainStepRuntime } from '../../src/infrastructure/runtime/main-step-runtime.ts';
import { WORKFLOW_COMPLETION_TOOL } from '../../src/infrastructure/runtime/completion-tool.ts';

describe('when testing main step runtime', () => {
  const doneSummary =
    '# Done: Implementation is complete.\n**Completed:**\n- Implemented `src/example.ts` and ran `bun test`.\n**Remaining:**\n- None; workflow is complete.';
  type Handler = (event: Record<string, unknown>, context?: unknown) => unknown;

  describe('should satisfy its behavioral contract', () => {
    test('main step runtime enforces policy, captures completion, and settles the step', async () => {
      // given
      const handlers = new Map<string, Handler>();
      const activeTools: string[][] = [];
      let completion:
        | {
            execute: (
              id: string,
              params: Record<string, unknown>,
            ) => Promise<unknown>;
          }
        | undefined;
      const availableTools = [
        { name: 'read', sourceInfo: { source: 'builtin' } },
        { name: 'bash', sourceInfo: { source: 'builtin' } },
        { name: 'edit', sourceInfo: { source: 'builtin' } },
      ];
      const pi = {
        on(name: string, handler: Handler) {
          handlers.set(name, handler);
        },
        registerTool(tool: typeof completion) {
          completion = tool;
          availableTools.push({
            name: WORKFLOW_COMPLETION_TOOL,
            sourceInfo: { source: 'extension' },
          });
        },
        getAllTools: () => availableTools,
        getActiveTools: () => ['read', WORKFLOW_COMPLETION_TOOL],
        setActiveTools(tools: string[]) {
          activeTools.push(tools);
        },
      } as unknown as ExtensionAPI;
      const settled: unknown[] = [];
      // when
      const runtime = new MainStepRuntime(pi);

      // then
      await expect(
        completion!.execute('call-0', { outcome: 'done', summary: 'done' }),
      ).rejects.toThrow(/No main-agent workflow step is active/);
      runtime.activate({
        workflowId: 'workflow',
        runId: 'run',
        stepId: 'step',
        stepDigest: 'step-digest',
        policyDigest: 'policy-digest',
        task: 'Do exact work',
        outcomes: ['done'],
        summaryMaxChars: 1_000,
        workspace: { bindOn: ['done'], allowedRoots: ['.'] },
        step: {
          title: 'Step',
          prompt: { inline: 'Do work' },
          permissions: {
            tools: ['read'],
            extensions: [],
            mcp: [],
            skills: [],
            bash: { mode: 'deny', allow: [] },
          },
          requires: { tools: [], extensions: [], skills: [] },
          transitions: { done: '$done' },
          workspace: { bindOn: ['done'], allowedRoots: ['.'] },
        },
        onTrace: () => undefined,
        onSettled: (result) => {
          settled.push(result);
        },
      });
      expect(runtime.activeStepId).toBe('step');
      expect(activeTools.at(-1)).toEqual(['read', WORKFLOW_COMPLETION_TOOL]);
      expect(
        handlers.get('tool_call')!({
          toolName: 'edit',
          toolCallId: 'edit-1',
          input: {},
        }),
      ).toEqual({
        block: true,
        reason: 'tool "edit" is not allowed for this workflow step',
      });
      handlers.get('message_end')!({
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'complete-1',
              name: WORKFLOW_COMPLETION_TOOL,
            },
            { type: 'toolCall', id: 'read-1', name: 'read' },
          ],
        },
      });
      expect(
        handlers.get('tool_call')!({
          toolName: WORKFLOW_COMPLETION_TOOL,
          toolCallId: 'complete-1',
          input: {},
        }),
      ).toEqual({
        block: true,
        reason: `${WORKFLOW_COMPLETION_TOOL} must be the only tool call in its message`,
      });
      handlers.get('turn_start')!({});
      expect(
        handlers.get('tool_call')!({
          toolName: WORKFLOW_COMPLETION_TOOL,
          toolCallId: 'complete-1',
          input: {},
        }),
      ).toBe(undefined);
      const result = await completion!.execute('complete-1', {
        outcome: 'done',
        summary: doneSummary,
        workspace: { cwd: '/tmp/worktree' },
      });
      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Captured workflow step outcome "done".' },
        ],
        details: {
          workflowId: 'workflow',
          runId: 'run',
          stepId: 'step',
          outcome: 'done',
        },
        terminate: true,
      });
      await handlers.get('agent_settled')!({}, {});
      expect(settled).toEqual([
        {
          version: 1,
          policyDigest: 'policy-digest',
          outcome: 'done',
          summary: doneSummary,
          workspace: { cwd: '/tmp/worktree' },
        },
      ]);
      expect(runtime.activeStepId).toBe(undefined);
    });

    test('mainTurnUsage attributes assistant and tool-result usage to the assistant model', () => {
      const assistantUsage = {
        input: 4,
        output: 2,
        cost: { input: 0.001, output: 0.002, total: 0.003 },
      };
      const toolUsage = {
        input: 1,
        output: 0,
        cost: { input: 0.0005, total: 0.0005 },
      };
      const usage = mainTurnUsage({
        message: {
          role: 'assistant',
          provider: 'openai',
          model: 'gpt-4',
          usage: assistantUsage,
        },
        toolResults: [
          {
            role: 'toolResult',
            toolCallId: 'read-1',
            toolName: 'read',
            isError: false,
            content: [],
            usage: toolUsage,
          },
        ],
      });
      expect(usage).toEqual([
        {
          provider: 'openai',
          model: 'gpt-4',
          usage: normalizeUsage(assistantUsage) as UsageTotals,
        },
        {
          provider: 'openai',
          model: 'gpt-4',
          usage: normalizeUsage(toolUsage) as UsageTotals,
        },
      ]);
    });

    test('main step trace arms on its exact task, captures ordered safe turns, and closes after completion', async () => {
      const handlers = new Map<string, Handler>();
      let completion:
        | {
            execute: (
              id: string,
              params: Record<string, unknown>,
            ) => Promise<unknown>;
          }
        | undefined;
      const availableTools = [
        { name: 'read', sourceInfo: { source: 'builtin' } },
      ];
      const pi = {
        on(name: string, handler: Handler) {
          handlers.set(name, handler);
        },
        registerTool(tool: typeof completion) {
          completion = tool;
          availableTools.push({
            name: WORKFLOW_COMPLETION_TOOL,
            sourceInfo: { source: 'extension' },
          });
        },
        getAllTools: () => availableTools,
        getActiveTools: () => ['read'],
        setActiveTools() {},
      } as unknown as ExtensionAPI;
      const turns: Array<ReadonlyArray<string>> = [];
      const usages: Array<ReadonlyArray<ModelUsage>> = [];
      const runtime = new MainStepRuntime(pi);
      runtime.activate({
        workflowId: 'workflow',
        runId: 'run',
        stepId: 'step',
        stepDigest: 'digest',
        policyDigest: 'policy',
        task: 'Exact workflow task',
        outcomes: ['done'],
        summaryMaxChars: 1_000,
        step: {
          title: 'Step',
          prompt: { inline: 'Do work' },
          permissions: {
            tools: ['read'],
            extensions: [],
            mcp: [],
            skills: [],
            bash: { mode: 'deny', allow: [] },
          },
          requires: { tools: [], extensions: [], skills: [] },
          transitions: { done: '$done' },
        },
        onTrace: (lines, _context, usage) => {
          turns.push(lines);
          if (usage && usage.length > 0) usages.push(usage);
          if (
            lines.some((line) =>
              line.startsWith(`tool call · ${WORKFLOW_COMPLETION_TOOL}`),
            )
          ) {
            throw new Error('simulated trace checkpoint failure');
          }
        },
        onSettled: () => undefined,
      });

      await handlers.get('turn_end')!(
        {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'unrelated parent response' }],
          },
          toolResults: [],
        },
        {},
      );
      handlers.get('message_end')!({
        message: { role: 'user', content: 'Different user message' },
      });
      await handlers.get('turn_end')!(
        {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'still unrelated' }],
          },
          toolResults: [],
        },
        {},
      );
      expect(turns).toEqual([]);

      handlers.get('message_end')!({
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Exact workflow task' }],
        },
      });
      const assistantUsage = {
        input: 3,
        output: 2,
        cost: { input: 0.001, output: 0.002, total: 0.003 },
      };
      const toolUsage = {
        input: 1,
        output: 0,
        cost: { input: 0.0005, total: 0.0005 },
      };
      await handlers.get('turn_end')!(
        {
          message: {
            role: 'assistant',
            provider: 'openai',
            model: 'gpt-4',
            usage: assistantUsage,
            content: [
              { type: 'thinking', thinking: 'private reasoning' },
              {
                type: 'text',
                text: 'Inspect with Authorization: Bearer assistant-secret',
              },
              {
                type: 'toolCall',
                id: 'read-1',
                name: 'read',
                arguments: {
                  path: 'README.md',
                  password: 'argument-secret',
                },
              },
            ],
          },
          toolResults: [
            {
              role: 'toolResult',
              toolCallId: 'read-1',
              toolName: 'read',
              isError: true,
              usage: toolUsage,
              content: [
                {
                  type: 'text',
                  text: 'authorization=tool-result-secret',
                },
              ],
            },
          ],
        },
        {},
      );
      await handlers.get('turn_end')!(
        {
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage:
              'Retry failed with Authorization: Bearer retry-secret',
          },
          toolResults: [],
        },
        {},
      );

      await completion!.execute('complete', {
        outcome: 'done',
        summary: doneSummary,
      });
      await handlers.get('turn_end')!(
        {
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'complete',
                name: WORKFLOW_COMPLETION_TOOL,
                arguments: { outcome: 'done', summary: doneSummary },
              },
            ],
          },
          toolResults: [
            {
              role: 'toolResult',
              toolCallId: 'complete',
              toolName: WORKFLOW_COMPLETION_TOOL,
              isError: false,
              content: [{ type: 'text', text: 'Captured outcome' }],
            },
          ],
        },
        {},
      );
      await handlers.get('turn_end')!(
        {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'queued unrelated continuation' }],
          },
          toolResults: [],
        },
        {},
      );

      expect(turns).toHaveLength(3);
      expect(usages).toHaveLength(1);
      expect(usages[0]).toEqual([
        {
          provider: 'openai',
          model: 'gpt-4',
          usage: normalizeUsage(assistantUsage) as UsageTotals,
        },
        {
          provider: 'openai',
          model: 'gpt-4',
          usage: normalizeUsage(toolUsage) as UsageTotals,
        },
      ]);
      expect(turns[0]?.map((line) => line.split('\n')[0])).toEqual([
        'assistant',
        'tool call · read',
        'tool error · read',
      ]);
      expect(turns[1]?.[0]).toMatch(/^assistant error\nRetry failed/);
      expect(turns[2]?.map((line) => line.split('\n')[0])).toEqual([
        `tool call · ${WORKFLOW_COMPLETION_TOOL}`,
        `tool result · ${WORKFLOW_COMPLETION_TOOL}`,
      ]);
      const output = turns.flat().join('\n');
      expect(output).toContain('[redacted]');
      expect(output).not.toContain('private reasoning');
      expect(output).not.toContain('assistant-secret');
      expect(output).not.toContain('argument-secret');
      expect(output).not.toContain('tool-result-secret');
      expect(output).not.toContain('retry-secret');
      expect(output).not.toContain('queued unrelated continuation');
    });

    test('suspending blocks tools until released and lifecycle reset restores ordinary tools', () => {
      // given
      const handlers = new Map<string, Handler>();
      const activeTools: string[][] = [];
      const pi = {
        on(name: string, handler: Handler) {
          handlers.set(name, handler);
        },
        registerTool() {},
        getAllTools: () => [],
        getActiveTools: () => ['read', WORKFLOW_COMPLETION_TOOL],
        setActiveTools(tools: string[]) {
          activeTools.push(tools);
        },
      } as unknown as ExtensionAPI;
      const runtime = new MainStepRuntime(pi);
      // when
      runtime.activate({
        workflowId: 'workflow',
        runId: 'run',
        stepId: 'step',
        stepDigest: 'digest',
        policyDigest: 'policy',
        task: 'Do exact work',
        outcomes: ['done'],
        summaryMaxChars: 1_000,
        step: {
          title: 'Step',
          prompt: { inline: 'Do work' },
          permissions: {
            tools: [],
            extensions: [],
            mcp: [],
            skills: [],
            bash: { mode: 'deny', allow: [] },
          },
          requires: { tools: [], extensions: [], skills: [] },
          transitions: { done: '$done' },
        },
        onTrace: () => undefined,
        onSettled: () => undefined,
      });
      // then
      expect(runtime.suspend()).toBe(true);
      expect(activeTools.at(-1)).toEqual([]);
      expect(
        handlers.get('tool_call')!({
          toolName: 'read',
          toolCallId: 'read-1',
          input: {},
        }),
      ).toEqual({
        block: true,
        reason: 'Main-agent workflow step is suspended',
      });
      runtime.release();
      expect(
        handlers.get('tool_call')!({
          toolName: WORKFLOW_COMPLETION_TOOL,
          toolCallId: 'complete',
          input: {},
        }),
      ).toEqual({
        block: true,
        reason: 'No main-agent workflow step is active',
      });
      handlers.get('session_start')!({});
      expect(activeTools.at(-1)).toEqual(['read']);
      handlers.get('session_shutdown')!({});
      expect(runtime.activeStepId).toBe(undefined);
    });
  });
});
