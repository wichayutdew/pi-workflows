import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { readLatestCheckpoint } from '../src/engine/checkpoint.ts';
import { createRun, isWorkflowRun } from '../src/engine/state.ts';
import {
  beginMainStepAttempt,
  recordCurrentStepUsage,
  usageAggregateFromModels,
} from '../src/engine/step-trace.ts';
import { advanceRun } from '../src/engine/transitions.ts';
import {
  emptyUsage,
  normalizeUsage,
  type UsageTotals,
} from '../src/engine/usage.ts';
import { flushUnwrittenSession } from '../src/harness/session-persistence.ts';
import { loadedWorkflow } from './helpers.ts';

const STATE_ENTRY_TYPE = 'pi-workflows-state-v1';

describe('when persisting a workflow-only Pi session', () => {
  test('does not create a file when Pi cannot adopt it afterward', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-workflows-session-'));
    const sessionFile = join(root, 'unadoptable.jsonl');

    try {
      expect(() =>
        flushUnwrittenSession({
          getEntries: () => [],
          getHeader: () => ({
            type: 'session',
            id: 'session-1',
            timestamp: new Date().toISOString(),
            cwd: root,
          }),
          getSessionFile: () => sessionFile,
        }),
      ).toThrow('cannot adopt a materialized workflow session file');
      expect(existsSync(sessionFile)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('materializes the first checkpoint before shutdown and lets Pi append later checkpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-workflows-session-'));
    const sessionDirectory = join(root, 'sessions');
    await mkdir(sessionDirectory);

    try {
      const manager = SessionManager.create(root, sessionDirectory);
      const workflow = loadedWorkflow();
      let run = createRun(
        workflow,
        'continue after reopen',
        ['read'],
        'run-1',
        1,
        root,
      );
      run = advanceRun(workflow, run, 'ready', 'Inspected the repository', 2);
      expect(run).toMatchObject({
        status: 'running',
        history: [{ stepId: 'inspect', summary: 'Inspected the repository' }],
      });
      manager.appendCustomEntry(STATE_ENTRY_TYPE, run);
      const sessionFile = manager.getSessionFile();
      expect(sessionFile).toBeDefined();
      if (!sessionFile) throw new Error('session file is unavailable');
      expect(existsSync(sessionFile)).toBe(false);

      expect(flushUnwrittenSession(manager)).toBe(true);
      expect(existsSync(sessionFile)).toBe(true);
      expect(flushUnwrittenSession(manager)).toBe(false);

      const completedRun = advanceRun(
        workflow,
        run,
        'done',
        'Implemented the requested change',
        3,
      );
      manager.appendCustomEntry(STATE_ENTRY_TYPE, completedRun);
      expect(() =>
        manager.appendMessage({
          role: 'assistant',
          content: [],
          api: 'openai-completions',
          provider: 'openai',
          model: 'test-model',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'stop',
          timestamp: Date.now(),
        }),
      ).not.toThrow();

      const reopened = SessionManager.open(sessionFile);
      expect(
        readLatestCheckpoint(reopened.getBranch(), STATE_ENTRY_TYPE),
      ).toEqual({ status: 'valid', run: completedRun });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists per-step usage aggregates across session reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-workflows-session-'));
    const sessionDirectory = join(root, 'sessions');
    await mkdir(sessionDirectory);

    try {
      const manager = SessionManager.create(root, sessionDirectory);
      const workflow = loadedWorkflow();
      let run = createRun(
        workflow,
        'continue after reopen',
        ['read'],
        'run-usage-persist',
        1,
        root,
      );
      run = beginMainStepAttempt(run, 'req-usage', 'task', 2);
      const aggregate = usageAggregateFromModels([
        {
          provider: 'openai',
          model: 'gpt-4',
          usage: normalizeUsage({
            input: 5,
            output: 3,
            cacheRead: 1,
            cacheWrite: 0,
            totalTokens: 9,
            cost: {
              input: 0.001,
              output: 0.002,
              cacheRead: 0.0003,
              cacheWrite: 0,
              total: 0.0033,
            },
          }) as UsageTotals,
        },
      ]);
      run = recordCurrentStepUsage(run, 'req-usage', aggregate, 3);
      run = advanceRun(workflow, run, 'ready', 'Inspected the repository', 4);
      manager.appendCustomEntry(STATE_ENTRY_TYPE, run);
      expect(flushUnwrittenSession(manager)).toBe(true);

      const reopened = SessionManager.open(manager.getSessionFile() as string);
      const latest = readLatestCheckpoint(
        reopened.getBranch(),
        STATE_ENTRY_TYPE,
      );
      expect(latest.status).toBe('valid');
      if (latest.status !== 'valid') {
        throw new Error('checkpoint should be valid');
      }
      expect(latest.run.history[0]?.usage).toEqual(aggregate);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects persisted checkpoints with malformed usage aggregates', () => {
    const workflow = loadedWorkflow();
    const run = advanceRun(
      workflow,
      createRun(workflow, '', ['read'], 'run-bad-usage', 1),
      'ready',
      'Summary',
      2,
    );
    const badHistoryEntry = {
      ...run.history[0],
      usage: {
        usage: { ...emptyUsage(), totalCostUsd: -1 },
        models: [],
      },
    };
    expect(isWorkflowRun({ ...run, history: [badHistoryEntry] })).toBe(false);
  });
});
