import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  loadAgentProfile,
  parseAgentProfile,
  THINKING_LEVELS,
} from '../src/agents/profile.ts';
import { directWorkerCommand } from '../src/integrations/subagents/client.ts';

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
});
