import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import piWorkflowsExtension from '../src/index.ts';

test('extension entry point registers the harness surface', () => {
  const commands = new Set<string>();
  const tools = new Set<string>();
  const events = new Set<string>();
  const channels = new Set<string>();
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
    events: {
      on(channel: string) {
        channels.add(channel);
        return () => undefined;
      },
      emit() {},
    },
  } as unknown as ExtensionAPI;

  piWorkflowsExtension(pi);

  assert.equal(tools.has('workflow_complete_step'), true);
  assert.equal(commands.has('workflow-start'), true);
  assert.equal(commands.has('workflow-pause'), true);
  assert.equal(commands.has('workflow-resume'), true);
  assert.equal(events.has('before_agent_start'), true);
  assert.equal(events.has('session_start'), true);
  assert.equal(channels.has('plannotator:review-result'), true);
  assert.equal(channels.has('prompt-template:subagent:response'), false);
});

test('the entry point leaves unrelated pi-subagents children untouched', () => {
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  const previousAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
  process.env.PI_SUBAGENT_CHILD = '1';
  process.env.PI_SUBAGENT_CHILD_AGENT = 'reviewer';
  const commands = new Set<string>();
  const tools = new Set<string>();
  const events = new Set<string>();
  const activeTools: string[][] = [];
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

  try {
    piWorkflowsExtension(pi);
    assert.deepEqual([...commands], []);
    assert.deepEqual([...tools], []);
    assert.deepEqual([...events], []);
    assert.deepEqual(activeTools, []);
  } finally {
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
    if (previousAgent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = previousAgent;
  }
});
