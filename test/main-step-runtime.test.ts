import { describe, expect, test } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { MainStepRuntime } from '../src/runtime/main-step-runtime.ts';
import { WORKFLOW_COMPLETION_TOOL } from '../src/runtime/completion-tool.ts';

describe('when testing main step runtime', () => {
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
        outcomes: ['done'],
        summaryMaxChars: 20,
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
        approvedBashCommands: [],
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
        summary: ' finished ',
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
          summary: 'finished',
        },
      ]);
      expect(runtime.activeStepId).toBe(undefined);
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
        outcomes: ['done'],
        summaryMaxChars: 20,
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
        approvedBashCommands: [],
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
