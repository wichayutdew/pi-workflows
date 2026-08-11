import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  MAX_STEP_TRACE_ATTEMPTS,
  MAX_STEP_TRACE_LOG_EVENT_CHARS,
  MAX_STEP_TRACE_LOG_EVENTS,
  MAX_STEP_TRACE_TASK_CHARS,
  MAX_WORKFLOW_TRACE_CHARS,
  createRun,
  isWorkflowRun,
} from '../src/engine/state.ts';
import {
  appendMainStepLog,
  attachSubagentTranscript,
  beginMainStepAttempt,
  beginSubagentStepAttempt,
  recordCurrentGateDecision,
  recordCurrentStepResult,
  workflowTraceChars,
} from '../src/engine/step-trace.ts';
import {
  advanceRun,
  beginGate,
  failRun,
  resolveGate,
  resumeRun,
} from '../src/engine/transitions.ts';
import type { HarnessActionContext } from '../src/harness/action-context.ts';
import { createStepExecutionActions } from '../src/harness/step-execution-actions.ts';
import type { WorkflowStepResult } from '../src/runtime/step-result.ts';
import {
  redactStepLogText,
  redactStepLogValue,
  stepLogLinesFromMessage,
  textOnlyUserMessage,
} from '../src/step-log.ts';
import {
  readStepTranscript,
  WorkflowStatusView,
  type WorkflowStatusSnapshot,
} from '../src/workflow-status.ts';
import {
  renderLiveWorkerActivity,
  renderStepDetail,
} from '../src/workflow-status/render-step-detail.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';

const plainTheme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as unknown as Theme;

function result(
  outcome: string,
  summary: string,
  artifact?: string,
): WorkflowStepResult {
  return {
    version: 1,
    policyDigest: 'trace-policy',
    outcome,
    summary,
    ...(artifact === undefined ? {} : { artifact }),
  };
}

describe('when exploring workflow step evidence', () => {
  test('free-text trace redaction covers standalone and prefixed credential labels', () => {
    const redacted = redactStepLogText(
      [
        'OPENAI_API_KEY=sk-value-openai',
        'GITHUB_TOKEN=ghp-value-github',
        'secret=plain-value',
        'private_key=key-material',
        'credential: credential-material',
        'AWS_SECRET_ACCESS_KEY=aws-material',
        'https://example.test?access_token=url-material',
        'note: use GITHUB_TOKEN=inline-material',
      ].join('\n'),
    );

    expect(redacted.match(/\[redacted\]/g)).toHaveLength(8);
    expect(redacted).not.toContain('sk-value-openai');
    expect(redacted).not.toContain('ghp-value-github');
    expect(redacted).not.toContain('plain-value');
    expect(redacted).not.toContain('key-material');
    expect(redacted).not.toContain('credential-material');
    expect(redacted).not.toContain('aws-material');
    expect(redacted).not.toContain('url-material');
    expect(redacted).not.toContain('inline-material');
  });

  test('structured trace projection redacts nested arrays and fails closed on unsupported values', () => {
    const structured = redactStepLogValue([
      { apiKey: 'array-secret', nested: { password: 'nested-secret' } },
      'safe value',
    ]);

    expect(structured).toContain('"apiKey": "[redacted]"');
    expect(structured).toContain('"password": "[redacted]"');
    expect(structured).toContain('safe value');
    expect(structured).not.toContain('array-secret');
    expect(structured).not.toContain('nested-secret');
    expect(redactStepLogValue(1n)).toBe('[unserializable value]');
    expect(
      stepLogLinesFromMessage({
        role: 'toolResult',
        toolName: 'read',
        content: [{ type: 'binary', data: 'not persisted' }],
      }),
    ).toEqual(['tool result · read']);
    expect(
      textOnlyUserMessage({
        role: 'user',
        content: [{ type: 'image', data: 'not a workflow task' }],
      }),
    ).toBeUndefined();
  });

  test('normal and compacted attempt traces round-trip without blocking transitions', () => {
    const workflow = loadedWorkflow();
    let run = createRun(workflow, 'inspect', [], 'trace-round-trip', 1);
    run = beginMainStepAttempt(run, 'main-1', 'exact normal task', 2);

    expect(isWorkflowRun(JSON.parse(JSON.stringify(run)))).toBeTrue();
    expect(run.currentStepAttempts?.[0]?.task).toBe('exact normal task');
    expect(
      beginMainStepAttempt(run, 'main-1', 'duplicate request task', 3),
    ).toBe(run);

    run = beginMainStepAttempt(
      run,
      'main-oversized',
      'x'.repeat(MAX_STEP_TRACE_TASK_CHARS + 25),
      3,
    );
    expect(run.currentStepAttempts?.[1]).toMatchObject({
      taskTruncated: true,
      omittedTaskChars: 25,
    });
    for (let index = 0; index < MAX_STEP_TRACE_ATTEMPTS + 5; index += 1) {
      run = beginMainStepAttempt(run, `resume-${index}`, `task ${index}`, 4);
    }

    expect(run.currentStepAttempts).toHaveLength(MAX_STEP_TRACE_ATTEMPTS);
    expect(run.currentStepOmittedAttempts).toBe(7);
    expect(isWorkflowRun(JSON.parse(JSON.stringify(run)))).toBeTrue();

    run = recordCurrentStepResult(run, result('ready', 'still executes'), 5);
    const advanced = advanceRun(workflow, run, 'ready', 'still executes', 6);
    expect(advanced.status).toBe('running');
    expect(advanced.currentStepId).toBe('implement');
  });

  test('main-agent logs are redacted, prefix-bounded, resumable, and checkpoint-valid', () => {
    const workflow = loadedWorkflow();
    let run = createRun(workflow, '', [], 'trace-main-log', 1);
    run = beginMainStepAttempt(run, 'main-first', 'first task', 2);
    run = appendMainStepLog(
      run,
      'main-first',
      [
        'assistant\nAuthorization: Bearer checkpoint-secret',
        ...Array.from(
          { length: MAX_STEP_TRACE_LOG_EVENTS + 4 },
          (_, index) => `assistant\nevent ${index}`,
        ),
      ],
      3,
    );

    const first = run.currentStepAttempts?.[0];
    expect(first?.kind).toBe('main');
    if (first?.kind !== 'main') throw new Error('expected main attempt');
    expect(first.log).toHaveLength(MAX_STEP_TRACE_LOG_EVENTS);
    expect(first.logTruncated).toBe(true);
    expect(first.omittedLogEvents).toBe(5);
    expect(first.log?.join('\n')).toContain('[redacted]');
    expect(first.log?.join('\n')).not.toContain('checkpoint-secret');
    expect(isWorkflowRun(JSON.parse(JSON.stringify(run)))).toBeTrue();

    run = failRun(run, 'retry', 4);
    run = resumeRun(run, 5);
    run = beginMainStepAttempt(run, 'main-resumed', 'resumed task', 6);
    const stale = appendMainStepLog(
      run,
      'main-first',
      ['assistant\nlate stale event'],
      7,
    );
    expect(stale).toBe(run);
    run = appendMainStepLog(
      run,
      'main-resumed',
      ['assistant\ncurrent resumed event'],
      8,
    );
    const resumedAttempt = run.currentStepAttempts?.at(-1);
    expect(resumedAttempt?.kind).toBe('main');
    expect(resumedAttempt?.kind === 'main' && resumedAttempt.log).toEqual([
      'assistant\ncurrent resumed event',
    ]);
    expect(isWorkflowRun(JSON.parse(JSON.stringify(run)))).toBeTrue();

    const oversizedLine = {
      ...run.currentStepAttempts?.at(-1),
      log: ['x'.repeat(MAX_STEP_TRACE_LOG_EVENT_CHARS + 1)],
    };
    expect(
      isWorkflowRun({
        ...run,
        currentStepAttempts: [
          ...(run.currentStepAttempts?.slice(0, -1) ?? []),
          oversizedLine,
        ],
      }),
    ).toBeFalse();
  });

  test('aggregate compaction bounds logs, results, and gate decisions while a long run completes', () => {
    const raw = baseWorkflow();
    raw.start = 'loop';
    raw.maxStepVisits = 40;
    raw.steps = {
      loop: {
        prompt: 'Loop',
        transitions: { again: 'loop', done: '$done' },
      },
    };
    const workflow = loadedWorkflow(raw);
    let run = createRun(workflow, '', [], 'trace-main-budget', 1);
    const largeTurn = Array.from(
      { length: 130 },
      (_, index) => `assistant\n${index}:${'x'.repeat(990)}`,
    );
    for (let visit = 1; visit <= 40; visit += 1) {
      const requestId = `main-log-${visit}`;
      run = beginMainStepAttempt(run, requestId, `task ${visit}`, visit * 3);
      run = appendMainStepLog(run, requestId, largeTurn, visit * 3 + 1);
      const outcome = visit === 40 ? 'done' : 'again';
      run = recordCurrentStepResult(
        run,
        result(
          outcome,
          `visit ${visit}:${'s'.repeat(9_000)}`,
          `artifact ${visit}:${'a'.repeat(17_000)}`,
        ),
        visit * 3 + 2,
      );
      run = recordCurrentGateDecision(
        run,
        {
          provider: 'prompt',
          requestId: `gate-${visit}`,
          approved: true,
          feedback: `feedback ${visit}:${'f'.repeat(9_000)}`,
          resolvedAt: visit * 3 + 2,
        },
        visit * 3 + 2,
      );
      run = advanceRun(workflow, run, outcome, `visit ${visit}`, visit * 3 + 2);
    }

    expect(run.status).toBe('completed');
    expect(workflowTraceChars(run)).toBeLessThanOrEqual(
      MAX_WORKFLOW_TRACE_CHARS,
    );
    expect(
      run.history.some((entry) =>
        entry.attempts?.some(
          (attempt) => attempt.kind === 'main' && attempt.logTruncated,
        ),
      ),
    ).toBeTrue();
    expect(
      run.history.some((entry) =>
        entry.attempts?.some(
          (attempt) =>
            attempt.result?.summary.length === 512 &&
            attempt.result.artifact?.length === 512 &&
            attempt.gateDecision?.feedback.length === 512 &&
            attempt.result.summaryTruncated === true &&
            attempt.result.artifactTruncated === true &&
            attempt.gateDecision.feedbackTruncated === true,
        ),
      ),
    ).toBeTrue();
    expect(isWorkflowRun(JSON.parse(JSON.stringify(run)))).toBeTrue();
  });

  test('stale main callbacks cannot replace context or finish a resumed attempt', async () => {
    const workflow = loadedWorkflow();
    let run = createRun(workflow, '', [], 'trace-stale-settlement', 1);
    run = beginMainStepAttempt(run, 'main-old', 'old task', 2);
    run = failRun(run, 'retry', 3);
    run = resumeRun(run, 4);
    run = beginMainStepAttempt(run, 'main-current', 'current task', 5);
    const currentContext = {} as ExtensionContext;
    const staleContext = {} as ExtensionContext;
    const fixture = {
      isSessionActive: true,
      sessionEpoch: 1,
      run,
      latestContext: currentContext,
    };
    const actions = createStepExecutionActions();
    const staleIdentity = {
      requestId: 'main-old',
      runId: run.runId,
      stepId: run.currentStepId,
      stepDigest: run.currentStepDigest,
      sessionEpoch: 1,
    };

    await actions.recordMainStepLog.call(
      fixture as unknown as HarnessActionContext,
      staleIdentity,
      ['assistant\nstale log'],
      staleContext,
    );
    await actions.finishMainStep.call(
      fixture as unknown as HarnessActionContext,
      staleIdentity,
      result('ready', 'stale result'),
      staleContext,
    );

    expect(fixture.latestContext).toBe(currentContext);
    expect(fixture.run).toBe(run);
    expect(fixture.run.status).toBe('running');
    expect(fixture.run.currentStepAttempts?.at(-1)?.requestId).toBe(
      'main-current',
    );
  });

  test('a long looping run stays under the aggregate trace budget and completes', () => {
    const raw = baseWorkflow();
    raw.start = 'loop';
    raw.maxStepVisits = 100;
    raw.steps = {
      loop: {
        prompt: 'Loop',
        transitions: { again: 'loop', done: '$done' },
      },
    };
    const workflow = loadedWorkflow(raw);
    let run = createRun(workflow, '', [], 'trace-budget', 1);
    for (let visit = 1; visit <= 100; visit += 1) {
      run = beginSubagentStepAttempt(
        run,
        `attempt-${visit}`,
        `agent-${'a'.repeat(30_000)}`,
        `${visit}:${'x'.repeat(MAX_STEP_TRACE_TASK_CHARS - 4)}`,
        visit * 2,
      );
      const outcome = visit === 100 ? 'done' : 'again';
      run = recordCurrentStepResult(
        run,
        result(outcome, `visit ${visit}`),
        visit * 2 + 1,
      );
      run = advanceRun(workflow, run, outcome, `visit ${visit}`, visit * 2 + 1);
    }

    expect(run.status).toBe('completed');
    expect(run.history).toHaveLength(100);
    expect(workflowTraceChars(run)).toBeLessThanOrEqual(
      MAX_WORKFLOW_TRACE_CHARS,
    );
    expect(
      run.history.some((entry) => (entry.omittedAttempts ?? 0) > 0),
    ).toBeTrue();
    expect(isWorkflowRun(JSON.parse(JSON.stringify(run)))).toBeTrue();
  });

  test('compacted traces retain their original chronological attempt numbers', () => {
    const workflow = loadedWorkflow();
    let run = createRun(workflow, '', [], 'trace-ordinals', 1);
    const totalAttempts = MAX_STEP_TRACE_ATTEMPTS + 3;
    for (let ordinal = 1; ordinal <= totalAttempts; ordinal += 1) {
      run = beginMainStepAttempt(
        run,
        `ordinal-${ordinal}`,
        `task ${ordinal}`,
        ordinal + 1,
      );
    }

    expect(run.currentStepOmittedAttempts).toBe(3);
    expect(run.currentStepAttempts?.map((attempt) => attempt.ordinal)).toEqual([
      1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    expect(isWorkflowRun(JSON.parse(JSON.stringify(run)))).toBeTrue();

    const output = renderStepDetail(
      plainTheme,
      { run, workflow, now: 30 },
      0,
      new Map(),
      180,
    ).join('\n');
    expect(output).toContain('Attempt 1 · main agent');
    expect(output).toContain('Attempt 5 · main agent');
    expect(output).toContain('Attempt 19 · main agent');
    expect(output).not.toContain('Attempt 4 · main agent');
    expect(output).toContain('preserve the chronological gap');
  });

  test('renders live worker activity inside the current step explorer', () => {
    const workflow = loadedWorkflow();
    let run = createRun(workflow, '', [], 'live-step-activity', 1);
    run = beginSubagentStepAttempt(
      run,
      'request-live',
      'worker',
      'Inspect src/index.ts and report the current behavior.',
      2,
    );
    const snapshot = {
      run,
      workflow,
      execution: {
        kind: 'subagent' as const,
        agent: 'worker',
        requestId: 'request-live',
        progress: 'responding, 1 calls',
        activityLog: [
          'call read {"path":"src/index.ts"}',
          'response: The worker is checking the entry point.',
        ],
      },
      now: 2,
    };
    const output = renderLiveWorkerActivity(plainTheme, snapshot, 0, 180).join(
      '\n',
    );

    expect(output).toContain('Live Worker Session');
    expect(output).toContain('Input prompt');
    expect(output).toContain('Inspect src/index.ts');
    expect(output).toContain('Tool call');
    expect(output).toContain('worker is checking the entry point');
    expect(
      renderStepDetail(plainTheme, snapshot, 0, new Map(), 180).join('\n'),
    ).not.toContain('Live Worker Session');
  });

  test('failed and resumed child attempts retain only confined transcript references', () => {
    const workflow = loadedWorkflow();
    let run = createRun(workflow, '', [], 'trace-resume', 1);
    run = beginSubagentStepAttempt(
      run,
      'request-failed',
      'pi-workflows.step',
      'inspect safely',
      2,
    );
    const trustedRoot = '/tmp/pi-workflows-sessions';
    run = attachSubagentTranscript(
      run,
      'request-failed',
      {
        trustedRoot,
        sessionFile: join(trustedRoot, 'child-run', 'run-0', 'session.jsonl'),
        runId: 'child-run',
        childIndex: 0,
      },
      3,
    );
    const attached = run.currentStepAttempts?.[0];
    expect(attached?.kind === 'subagent' && attached.transcript).toBeTruthy();

    const unchanged = attachSubagentTranscript(
      run,
      'request-failed',
      {
        trustedRoot,
        sessionFile: join(trustedRoot, 'escape', 'run-0', 'session.jsonl'),
        runId: '../escape',
        childIndex: 0,
      },
      4,
    );
    expect(unchanged).toBe(run);

    run = failRun(run, 'child failed', 5);
    expect(isWorkflowRun(JSON.parse(JSON.stringify(run)))).toBeTrue();
    run = resumeRun(run, 6);
    run = beginSubagentStepAttempt(
      run,
      'request-resumed',
      'pi-workflows.step',
      'inspect with resume guidance',
      7,
    );
    expect(run.currentStepAttempts).toHaveLength(2);
    expect(run.currentStepAttempts?.[0]).toEqual(attached);
  });

  test('rejected and approved gate decisions stay paired with their attempts', () => {
    const raw = baseWorkflow();
    raw.start = 'review';
    raw.steps = {
      review: {
        prompt: 'Review',
        gate: {
          provider: 'prompt',
          submitOutcome: 'submit',
          approvedOutcome: 'approved',
          rejectedOutcome: 'rejected',
        },
        transitions: { approved: '$done', rejected: '$pause' },
      },
    };
    const workflow = loadedWorkflow(raw);
    let run = createRun(workflow, '', [], 'trace-gates', 1);
    run = beginMainStepAttempt(run, 'review-1', 'draft the plan', 2);
    run = recordCurrentStepResult(
      run,
      result('submit', 'first plan', '# First'),
      3,
    );
    run = beginGate(
      workflow,
      run,
      'submit',
      '# First',
      'gate-1',
      4,
      'first plan',
    );
    run = resolveGate(
      workflow,
      run,
      { approved: false, feedback: 'add evidence', resolvedAt: 5 },
      5,
    );
    expect(run.status).toBe('paused');
    expect(run.currentStepAttempts?.[0]?.gateDecision).toMatchObject({
      approved: false,
      feedback: 'add evidence',
    });

    run = resumeRun(run, 6);
    run = beginMainStepAttempt(run, 'review-2', 'revise with evidence', 7);
    run = recordCurrentStepResult(
      run,
      result('submit', 'second plan', '# Second'),
      8,
    );
    run = beginGate(
      workflow,
      run,
      'submit',
      '# Second',
      'gate-2',
      9,
      'second plan',
    );
    run = resolveGate(
      workflow,
      run,
      { approved: true, feedback: 'ship it', resolvedAt: 10 },
      10,
    );

    expect(run.status).toBe('completed');
    expect(
      run.history[0]?.attempts?.map((attempt) => attempt.gateDecision),
    ).toMatchObject([
      { approved: false, feedback: 'add evidence' },
      { approved: true, feedback: 'ship it' },
    ]);
    expect(isWorkflowRun(JSON.parse(JSON.stringify(run)))).toBeTrue();
  });

  test('arrow and vim keys select, inspect, scroll, return, and close', () => {
    const workflow = loadedWorkflow();
    let run = createRun(workflow, '', [], 'trace-keys', 1);
    run = beginMainStepAttempt(run, 'inspect-1', 'exact inspect task', 2);
    run = appendMainStepLog(
      run,
      'inspect-1',
      [
        'assistant\nI inspected the exact requirement',
        ...Array.from(
          { length: 40 },
          (_, index) => `assistant\nDetail log line ${index + 1}`,
        ),
      ],
      2,
    );
    run = recordCurrentStepResult(run, result('ready', 'inspected'), 3);
    run = advanceRun(workflow, run, 'ready', 'inspected', 3);
    run = beginMainStepAttempt(run, 'implement-1', 'exact implement task', 4);
    const snapshot: WorkflowStatusSnapshot = { run, workflow, now: 5 };
    let closed = 0;
    const renders: Array<boolean | undefined> = [];
    const view = new WorkflowStatusView(
      () => snapshot,
      {
        requestRender: (force) => renders.push(force),
        terminal: { rows: 20 },
      },
      plainTheme,
      () => {
        closed += 1;
      },
    );

    expect(view.render(100).join('\n')).toContain('implement');
    view.handleInput('\u001b[A');
    view.handleInput('\u001b[C');
    const detailPage = view.render(100);
    const detail = detailPage.join('\n');
    expect(detail).toContain('Step Explorer · inspect');
    expect(detail).toContain('exact inspect task');
    expect(detailPage.at(-1)).toMatch(
      /Ctrl\+D\/U half-page.*gg\/G top\/bottom.*rows 1-18\//,
    );

    view.handleInput('\u0004');
    expect(closed).toBe(0);
    const halfPageDown = view.render(100);
    expect(halfPageDown.at(-1)).toMatch(/rows 10-27\//);
    view.handleInput('\u0015');
    const halfPageUp = view.render(100);
    expect(halfPageUp.at(-1)).toMatch(/rows 1-18\//);

    view.handleInput('G');
    const bottomHint = view.render(100).at(-1) ?? '';
    const bottomRows = bottomHint.match(/rows (\d+)-(\d+)\/(\d+)/);
    expect(bottomRows?.[2]).toBe(bottomRows?.[3]);

    view.handleInput('g');
    expect(view.render(100).at(-1)).toBe(bottomHint);
    view.handleInput('g');
    expect(view.render(100).at(-1)).toMatch(/rows 1-18\//);

    view.handleInput('g');
    view.handleInput('j');
    const scrolledDetailPage = view.render(100);
    const scrolledDetail = scrolledDetailPage.join('\n');
    expect(scrolledDetail).toContain('I inspected the exact requirement');
    expect(scrolledDetailPage.at(-1)).toMatch(/rows 2-/);
    view.handleInput('gg');
    expect(view.render(100).at(-1)).toMatch(/rows 1-18\//);

    view.handleInput('h');
    expect(view.render(100).join('\n')).toContain('Execution Path');
    view.handleInput('l');
    expect(view.render(100).join('\n')).toContain('Step Explorer');
    view.handleInput('\u001b');
    expect(closed).toBe(0);
    view.handleInput('\u001b');
    expect(closed).toBe(1);
    expect(renders.length).toBeGreaterThan(0);
  });

  test('the detail view loads and caches one trusted child transcript', async () => {
    const workflow = loadedWorkflow();
    let run = createRun(workflow, '', [], 'trace-async-view', 1);
    run = beginSubagentStepAttempt(
      run,
      'request-view',
      'worker',
      'exact delegated task',
      2,
    );
    const trustedRoot = '/tmp/pi-workflows-view-sessions';
    run = attachSubagentTranscript(
      run,
      'request-view',
      {
        trustedRoot,
        sessionFile: join(trustedRoot, 'child-view', 'run-0', 'session.jsonl'),
        runId: 'child-view',
        childIndex: 0,
      },
      3,
    );
    const renders: Array<boolean | undefined> = [];
    let loads = 0;
    const view = new WorkflowStatusView(
      () => ({ run, workflow, now: 4 }),
      { requestRender: (force) => renders.push(force) },
      plainTheme,
      () => undefined,
      undefined,
      {
        loadStepTranscript: async () => {
          loads += 1;
          return {
            status: 'available',
            lines: [
              'assistant\nI inspected the repository',
              'tool call · read\n{"path":"README.md"}',
              'tool result · read\nready',
            ],
            truncated: false,
          };
        },
      },
    );

    view.render(100);
    view.handleInput('l');
    expect(loads).toBe(1);
    expect(view.render(100).join('\n')).toContain('Loading trusted');
    await Promise.resolve();
    await Promise.resolve();
    const detail = view.render(100).join('\n');
    expect(detail).toContain('I inspected the repository');
    expect(detail).toContain('tool call · read');
    expect(renders).toContain(true);
    view.render(100);
    expect(loads).toBe(1);
  });

  test('trusted transcript logs are chronological, bounded, and redact credentials', async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'pi-workflows-status-test-'),
    );
    try {
      const trustedRoot = join(temporaryRoot, 'parent-session');
      const sessionDirectory = join(trustedRoot, 'child-1', 'run-0');
      const sessionFile = join(sessionDirectory, 'session.jsonl');
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(
        sessionFile,
        [
          JSON.stringify({
            type: 'message',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'I will inspect' },
                {
                  type: 'toolCall',
                  id: 'call-1',
                  name: 'bash',
                  arguments: {
                    command:
                      "curl -H 'Authorization: Bearer top-secret' https://example.test",
                    password: 'also-secret',
                  },
                },
              ],
            },
          }),
          JSON.stringify({
            type: 'message',
            message: {
              role: 'toolResult',
              toolName: 'bash',
              toolCallId: 'call-1',
              isError: false,
              content: [
                {
                  type: 'text',
                  text: 'Authorization: Basic result-secret',
                },
              ],
            },
          }),
        ].join('\n'),
      );

      const log = await readStepTranscript({
        trustedRoot,
        sessionFile,
        runId: 'child-1',
        childIndex: 0,
      });
      expect(log.status).toBe('available');
      const output = log.status === 'available' ? log.lines.join('\n') : '';
      expect(output).toContain('I will inspect');
      expect(output).toContain('tool call · bash');
      expect(output).toContain('tool result · bash');
      expect(output).toContain('[redacted]');
      expect(output).not.toContain('top-secret');
      expect(output).not.toContain('also-secret');
      expect(output).not.toContain('result-secret');

      const rejected = await readStepTranscript({
        trustedRoot,
        sessionFile,
        runId: '../child-1',
        childIndex: 0,
      });
      expect(rejected).toMatchObject({ status: 'unavailable' });

      const redirectedRun = join(trustedRoot, 'redirected-child');
      await symlink(join(trustedRoot, 'child-1'), redirectedRun);
      const redirected = await readStepTranscript({
        trustedRoot,
        sessionFile: join(redirectedRun, 'run-0', 'session.jsonl'),
        runId: 'redirected-child',
        childIndex: 0,
      });
      expect(redirected).toMatchObject({ status: 'unavailable' });
    } finally {
      await rm(temporaryRoot, { recursive: true });
    }
  });
});
