import { describe, expect, test } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import piWorkflowsExtension from '../src/index.ts';

describe('when testing extension', () => {
  describe('should satisfy its behavioral contract', () => {
    test('extension entry point registers the harness surface', () => {
      // given
      const commands = new Set<string>();
      const tools = new Set<string>();
      const events = new Set<string>();
      const channels = new Set<string>();
      const shortcuts = new Set<string>();
      const pi = {
        registerCommand(name: string) {
          commands.add(name);
        },
        registerTool(tool: { name: string }) {
          tools.add(tool.name);
        },
        registerShortcut(shortcut: string) {
          shortcuts.add(shortcut);
        },
        on(event: string) {
          events.add(event);
        },
        events: {
          on(channel: string) {
            channels.add(channel);
            return () => undefined;
          },
          emit() {},
        },
      } as unknown as ExtensionAPI;

      // when
      piWorkflowsExtension(pi);

      // then
      expect(tools.has('workflow_complete_step')).toBe(true);
      expect(commands.has('workflow-start')).toBe(true);
      expect(commands.has('workflow-pause')).toBe(true);
      expect(commands.has('workflow-resume')).toBe(true);
      expect(commands.has('workflow-status')).toBe(false);
      expect(shortcuts.has('ctrl+alt+w')).toBe(true);
      expect(events.has('before_agent_start')).toBe(true);
      expect(events.has('session_start')).toBe(true);
      expect(channels.has('plannotator:review-result')).toBe(true);
      expect(channels.has('prompt-template:subagent:response')).toBe(false);
    });

    test('the entry point installs an inert policy listener in pi-subagents children', () => {
      // given
      const previousChild = process.env.PI_SUBAGENT_CHILD;
      const previousAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
      process.env.PI_SUBAGENT_CHILD = '1';
      process.env.PI_SUBAGENT_CHILD_AGENT = 'reviewer';
      const commands = new Set<string>();
      const tools = new Set<string>();
      const events = new Set<string>();
      const activeTools: string[][] = [];
      // when
      const pi = {
        registerCommand(name: string) {
          commands.add(name);
        },
        registerTool(tool: { name: string }) {
          tools.add(tool.name);
        },
        on(event: string) {
          events.add(event);
        },
        setActiveTools(value: string[]) {
          activeTools.push(value);
        },
      } as unknown as ExtensionAPI;

      // then
      try {
        piWorkflowsExtension(pi);
        expect([...commands]).toEqual([]);
        expect([...tools]).toEqual([]);
        expect(events.has('input')).toBe(true);
        expect(events.has('before_agent_start')).toBe(true);
        expect(events.has('tool_call')).toBe(true);
        expect(events.has('session_start')).toBe(false);
        expect(activeTools).toEqual([]);
      } finally {
        if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
        else process.env.PI_SUBAGENT_CHILD = previousChild;
        if (previousAgent === undefined)
          delete process.env.PI_SUBAGENT_CHILD_AGENT;
        else process.env.PI_SUBAGENT_CHILD_AGENT = previousAgent;
      }
    });
  });
});
