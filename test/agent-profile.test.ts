import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  loadAgentProfile,
  parseAgentProfile,
  THINKING_LEVELS,
} from '../src/agents/profile.ts';
import {
  directWorkerCommand,
  directWorkerResponse,
  workerProgressFromJsonLine,
} from '../src/integrations/subagents/client.ts';

describe('when loading workflow agent profiles', () => {
  test('passes a profile model and thinking level to its direct Pi worker', () => {
    const profile = parseAgentProfile(
      '---\nmodel: provider/model\nthinking: xhigh\n---\n\nRole prompt',
      'example',
    );

    expect(profile).toEqual({
      model: 'provider/model',
      thinking: 'xhigh',
      prompt: 'Role prompt',
    });
    expect(
      directWorkerCommand({
        version: 1,
        requestId: 'request',
        agent: 'example',
        task: 'task',
        cwd: '/workspace',
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.thinking ? { thinking: profile.thinking } : {}),
      }),
    ).toEqual([
      '--no-session',
      '--mode',
      'json',
      '--model',
      'provider/model',
      '--thinking',
      'xhigh',
      '--print',
      'task',
    ]);
  });

  test('rejects malformed profile metadata', () => {
    expect(() =>
      parseAgentProfile('---\nthinking: impossible\n---\n\nRole prompt', 'bad'),
    ).toThrow(`must be one of ${THINKING_LEVELS.join(', ')}`);
    expect(() =>
      parseAgentProfile('---\nunexpected: true\n---\n\nRole prompt', 'bad'),
    ).toThrow('unknown metadata');
  });

  test('uses a user-owned profile before the bundled fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-agents-'));
    const agentsDirectory = join(directory, 'agents');
    await mkdir(agentsDirectory);
    await writeFile(
      join(agentsDirectory, 'worker.md'),
      '---\nmodel: provider/worker\nthinking: max\n---\n\nUser role prompt',
      'utf8',
    );
    try {
      expect(loadAgentProfile('worker', directory)).toEqual({
        model: 'provider/worker',
        thinking: 'max',
        prompt: 'User role prompt',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('uses the starter-kit profile when the user has not customized it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-workflows-agents-'));
    try {
      expect(loadAgentProfile('worker', directory).prompt).toContain(
        'implementation role',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('reports direct-worker activity without exposing tool input', () => {
    expect(
      workerProgressFromJsonLine('{"type":"agent_start"}', 'request', 0),
    ).toEqual({
      toolCount: 0,
      responseText: '',
      update: { requestId: 'request', activity: 'thinking', toolCount: 0 },
    });
    expect(
      workerProgressFromJsonLine(
        '{"type":"tool_execution_start","toolName":"bash","args":{"command":"secret"}}',
        'request',
        0,
      ),
    ).toEqual({
      toolCount: 1,
      responseText: '',
      update: {
        requestId: 'request',
        currentTool: 'bash',
        detail: 'call bash {"command":"secret"}',
        toolCount: 1,
      },
    });
    expect(
      workerProgressFromJsonLine(
        '{"type":"tool_execution_start","toolName":"bash","args":{"token":"private"}}',
        'request',
        0,
      ).update?.detail,
    ).toBe('call bash {"token":"[redacted]"}');
    expect(
      workerProgressFromJsonLine(
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Working on it"}}',
        'request',
        1,
        'Still ',
      ),
    ).toEqual({
      toolCount: 1,
      responseText: 'Still Working on it',
      update: {
        requestId: 'request',
        activity: 'responding',
        detail: 'response: Still Working on it',
        toolCount: 1,
      },
    });
  });

  test('ignores successful worker startup notices on stderr', () => {
    const request = {
      version: 1 as const,
      requestId: 'request',
      agent: 'worker',
      task: 'task',
      cwd: '/workspace',
    };
    expect(
      directWorkerResponse(request, 0, null, 'MCP: startup notice'),
    ).toEqual({
      requestId: 'request',
      agent: 'worker',
      status: 'completed',
      exitCode: 0,
    });
    expect(
      directWorkerResponse(request, 1, null, 'terminal failure'),
    ).toMatchObject({ status: 'failed', error: 'terminal failure' });
  });
});
