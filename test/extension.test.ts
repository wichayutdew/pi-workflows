import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import piWorkflowsExtension from '../src/index.ts';

describe('when testing extension', () => {
  describe('should satisfy its behavioral contract', () => {
    test('extension entry point registers the default harness surface', async () => {
      // given
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-extension-default-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;
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
      try {
        await piWorkflowsExtension(pi);

        // then
        expect(tools.has('workflow_complete_step')).toBe(true);
        expect(commands.has('workflow-start')).toBe(true);
        expect(commands.has('workflow-pause')).toBe(true);
        expect(commands.has('workflow-resume')).toBe(true);
        expect(commands.has('workflow-restart')).toBe(true);
        expect(commands.has('workflow-status')).toBe(true);
        expect(shortcuts.has('ctrl+alt+w')).toBe(true);
        expect(events.has('before_agent_start')).toBe(true);
        expect(events.has('session_start')).toBe(true);
        expect(channels.has('plannotator:review-result')).toBe(true);
        expect(channels.has('prompt-template:subagent:response')).toBe(false);
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('the entry point registers the configured status shortcut before startup', async () => {
      // given
      const directory = await mkdtemp(
        join(tmpdir(), 'pi-workflows-extension-shortcut-'),
      );
      const previousDirectory = process.env.PI_WORKFLOWS_DIR;
      process.env.PI_WORKFLOWS_DIR = directory;
      await writeFile(
        join(directory, 'settings.yaml'),
        'version: 1\nstatusShortcut: ctrl+shift+y\n',
        'utf8',
      );
      const shortcuts = new Set<string>();
      const pi = {
        registerCommand() {},
        registerTool() {},
        registerShortcut(shortcut: string) {
          shortcuts.add(shortcut);
        },
        on() {},
        events: {
          on() {
            return () => undefined;
          },
          emit() {},
        },
      } as unknown as ExtensionAPI;

      // when / then
      try {
        await piWorkflowsExtension(pi);
        expect(shortcuts).toEqual(new Set(['ctrl+shift+y']));
      } finally {
        if (previousDirectory === undefined)
          delete process.env.PI_WORKFLOWS_DIR;
        else process.env.PI_WORKFLOWS_DIR = previousDirectory;
        await rm(directory, { recursive: true, force: true });
      }
    });

    test('the entry point installs an inert policy listener in pi-subagents children', async () => {
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
        await piWorkflowsExtension(pi);
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
