import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  StepExecutionAttempt,
  SubagentTranscriptReference,
  WorkflowRun,
} from '../../src/domain/index.ts';
import {
  MAX_STEP_TRACE_LOG_CHARS,
  MAX_STEP_TRACE_LOG_EVENT_CHARS,
  MAX_STEP_TRACE_LOG_EVENTS,
  createRun,
} from '../../src/domain/index.ts';
import {
  normalizeUsage,
  type UsageTotals,
} from '../../src/function/engine/usage.ts';
import {
  renderStepDetail,
  stepTranscriptCacheKey,
  type StepTranscriptViewCache,
} from '../../src/ui/render-step-detail.ts';
import { readStepTranscript } from '../../src/infrastructure/fs/transcript-reader.ts';
import type {
  WorkflowStatusSnapshot,
  WorkflowStatusTheme,
} from '../../src/ui/types.ts';
import { loadedWorkflow } from '../helpers.ts';

const plainTheme: WorkflowStatusTheme = {
  fg: (_color, value) => value,
  bg: (_color, value) => value,
  bold: (value) => value,
};

function render(
  snapshot: WorkflowStatusSnapshot,
  selectedIndex = 0,
  cache: StepTranscriptViewCache = new Map(),
  width = 180,
): string {
  return renderStepDetail(
    plainTheme,
    snapshot,
    selectedIndex,
    cache,
    width,
  ).join('\n');
}

function transcriptReference(
  trustedRoot: string,
  runId: string,
  childIndex = 0,
): SubagentTranscriptReference {
  return {
    trustedRoot,
    runId,
    childIndex,
    sessionFile: join(trustedRoot, runId, `run-${childIndex}`, 'session.jsonl'),
  };
}

async function writeTranscript(
  trustedRoot: string,
  runId: string,
  content: string,
  childIndex = 0,
): Promise<SubagentTranscriptReference> {
  const reference = transcriptReference(trustedRoot, runId, childIndex);
  await mkdir(join(trustedRoot, runId, `run-${childIndex}`), {
    recursive: true,
  });
  await writeFile(reference.sessionFile, content, 'utf8');
  return reference;
}

describe('when rendering less common workflow step evidence', () => {
  test('renders bounded results, workspace, main logs, and both gate decisions', () => {
    const workflow = loadedWorkflow();
    const initial = createRun(
      workflow,
      '',
      [],
      'detail-completed',
      1,
      '/tmp/detail-start',
    );
    const attempts: ReadonlyArray<StepExecutionAttempt> = [
      {
        kind: 'main',
        requestId: 'main-legacy',
        ordinal: 1,
        task: 'legacy task',
        startedAt: 2,
      },
      {
        kind: 'main',
        requestId: 'main-approved',
        ordinal: 2,
        task: 'bounded task prefix',
        taskTruncated: true,
        omittedTaskChars: 9,
        log: [
          'assistant\nImplemented the change',
          'tool call · bash\nAuthorization: Bearer render-secret',
        ],
        logTruncated: true,
        omittedLogEvents: 1,
        startedAt: 3,
        usage: {
          usage: normalizeUsage({
            input: 4,
            output: 2,
            cost: { input: 0.001, output: 0.002, total: 0.003 },
          }) as UsageTotals,
          models: [
            {
              provider: 'openai',
              model: 'gpt-4',
              usage: normalizeUsage({
                input: 4,
                output: 2,
                cost: { input: 0.001, output: 0.002, total: 0.003 },
              }) as UsageTotals,
            },
          ],
        },
        result: {
          outcome: 'submit',
          summary:
            '## Result\n- `branch`: `feat/example`\n- `commit`: `abc123`',
          summaryTruncated: true,
          artifact: 'result artifact',
          artifactTruncated: true,
          workspaceCwd: '/tmp/detail-worktree',
        },
        gateDecision: {
          provider: 'plannotator',
          requestId: 'gate-approved',
          approved: true,
          feedback: 'Approved feedback',
          feedbackTruncated: true,
          resolvedAt: 4,
          reviewId: 'review-42',
        },
      },
      {
        kind: 'main',
        requestId: 'main-rejected',
        ordinal: 3,
        task: 'second review task',
        log: [],
        logTruncated: true,
        omittedLogEvents: 3,
        startedAt: 5,
        gateDecision: {
          provider: 'prompt',
          requestId: 'gate-rejected',
          approved: false,
          feedback: '',
          resolvedAt: 6,
        },
      },
    ];
    const run: WorkflowRun = {
      ...initial,
      status: 'completed',
      currentStepId: 'inspect',
      history: [
        {
          stepId: 'inspect',
          stepDigest: workflow.stepDigests.inspect ?? '',
          outcome: 'ready',
          summary: '## Completed\n- `status`: clean\n- `review`: passed',
          workspaceCwd: '/tmp/detail-worktree',
          artifact: `${'F'.repeat(20_001)}TAIL`,
          attempts,
          completedAt: 7,
        },
      ],
      cwd: '/tmp/detail-worktree',
      updatedAt: 7,
    };

    const output = render({ run, workflow, now: 8 });

    expect(output).toContain('Final/review artifact');
    expect(output).toContain('artifact truncated in status display');
    expect(output).not.toContain('TAIL');
    expect(output).toContain('No main-agent reaction log was recorded');
    expect(output).toContain('Implemented the change');
    expect(output).toContain('Authorization=[redacted]');
    expect(output).not.toContain('render-secret');
    expect(output).toContain('1 later event omitted');
    expect(output).toContain('3 later events omitted');
    expect(output).toContain('Submitted result');
    expect(output).toMatch(
      /summary[^\n]*\n│ ## Result[^\n]*\n│ - `branch`: `feat\/example`[^\n]*\n│ - `commit`: `abc123`/,
    );
    expect(output).toMatch(
      /summary[^\n]*\n│ ## Completed[^\n]*\n│ - `status`: clean[^\n]*\n│ - `review`: passed/,
    );
    expect(output).not.toContain('summary ## Result - `branch`');
    expect(output).toContain('trace truncated');
    expect(output).toContain('artifact truncated in status trace');
    expect(output).toContain('/tmp/detail-worktree');
    expect(output).toContain('decision approved');
    expect(output).toContain('decision rejected');
    expect(output).toContain('review-42');
    expect(output).toContain('Approved feedback');
    expect(output).toContain('$0.00');
    expect(output).toContain('openai/gpt-4');
    expect(output).toContain('4 in');
    expect(output).toContain('2 out');
  });

  test('renders current pause evidence, legacy numbering, no trace, and narrow invalid selections', () => {
    const workflow = loadedWorkflow();
    const initial = createRun(workflow, '', [], 'detail-current', 1);
    const paused: WorkflowRun = {
      ...initial,
      status: 'paused',
      pausedFrom: 'awaiting-gate',
      pauseReason: 'Waiting for a safe retry',
      gateFeedback: 'Retry with additional evidence',
      cwd: '/tmp/detail-current',
      pendingGate: {
        provider: 'prompt',
        requestId: 'pending-gate',
        stepId: 'inspect',
        artifact: 'Current review artifact',
        submittedOutcome: 'submit',
        requestedAt: 2,
      },
      updatedAt: 2,
    };

    const noTrace = render({ run: paused, workflow, now: 3 });
    expect(noTrace).toContain('Waiting for a safe retry');
    expect(noTrace).toContain('Retry with additional evidence');
    expect(noTrace).toContain('/tmp/detail-current');
    expect(noTrace).toContain('Current review artifact');
    expect(noTrace).toContain('No execution trace was recorded');

    const legacy: WorkflowRun = {
      ...paused,
      currentStepAttempts: [
        {
          kind: 'main',
          requestId: 'legacy-first',
          task: 'first retained legacy task',
          startedAt: 3,
        },
        {
          kind: 'main',
          requestId: 'legacy-tail',
          task: 'tail retained legacy task',
          startedAt: 4,
        },
      ],
      currentStepOmittedAttempts: 3,
    };
    const legacyOutput = render({ run: legacy, workflow, now: 5 });
    expect(legacyOutput).toContain('Attempt 1 · main agent');
    expect(legacyOutput).toContain('Attempt 5 · main agent');
    expect(legacyOutput).toContain('3 attempts were compacted');

    const narrow = renderStepDetail(
      plainTheme,
      { run: paused, workflow, now: 3 },
      0,
      new Map(),
      1,
    );
    expect(narrow.length).toBeGreaterThan(2);

    const invalid = render({ run: paused, workflow, now: 3 }, 99);
    expect(invalid).toContain('selected step is no longer available');
  });

  test('renders every child transcript cache state without reading arbitrary paths', () => {
    const workflow = loadedWorkflow();
    const trustedRoot = '/tmp/detail-render-only';
    const references = Array.from({ length: 5 }, (_, index) =>
      transcriptReference(trustedRoot, `child-${index + 1}`),
    );
    const attempts: ReadonlyArray<StepExecutionAttempt> = [
      {
        kind: 'subagent',
        requestId: 'child-no-reference',
        ordinal: 1,
        agent: 'worker',
        task: 'No reference',
        startedAt: 2,
      },
      ...references.map((transcript, index): StepExecutionAttempt => ({
        kind: 'subagent',
        requestId: `child-${index + 1}`,
        ordinal: index + 2,
        agent: 'worker',
        task: `Child task ${index + 1}`,
        startedAt: index + 3,
        transcript,
      })),
    ];
    const run: WorkflowRun = {
      ...createRun(workflow, '', [], 'detail-child-cache', 1),
      currentStepAttempts: attempts,
    };
    const cache: StepTranscriptViewCache = new Map([
      [stepTranscriptCacheKey(run.runId, attempts[2]!), { status: 'loading' }],
      [
        stepTranscriptCacheKey(run.runId, attempts[3]!),
        {
          status: 'unavailable',
          reason: 'The child log failed safe validation.',
        },
      ],
      [
        stepTranscriptCacheKey(run.runId, attempts[4]!),
        { status: 'available', lines: [], truncated: true },
      ],
      [
        stepTranscriptCacheKey(run.runId, attempts[5]!),
        {
          status: 'available',
          lines: ['assistant\nChild finished'],
          truncated: false,
        },
      ],
    ]);

    const output = render({ run, workflow, now: 10 }, 0, cache);
    expect(output).toContain('No trusted child transcript reference');
    expect(output).toContain('Loading trusted child transcript');
    expect(output).toContain('failed safe validation');
    expect(output).toContain('No displayable assistant or tool events');
    expect(output).toContain('Transcript display was bounded');
    expect(output).toContain('Child finished');
  });
});

describe('when reading bounded child transcript evidence', () => {
  test('parses mixed events chronologically and stops at the event ceiling', async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'pi-workflows-transcript-events-'),
    );
    try {
      const trustedRoot = join(temporaryRoot, 'sessions');
      const mixedEntries = [
        '',
        'not json',
        JSON.stringify(42),
        JSON.stringify({
          type: 'custom_message',
          customType: 'progress',
          content: 'Inspecting Authorization: Bearer transcript-secret',
        }),
        JSON.stringify({
          type: 'custom_message',
          details: {
            message: 'structured progress',
            password: 'structured-secret',
          },
        }),
        JSON.stringify({ type: 'custom_message' }),
        JSON.stringify({ type: 'unknown' }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Assistant response' },
              {
                type: 'toolCall',
                name: 'read',
                arguments: { path: 'README.md' },
              },
              { type: 'thinking', thinking: 'private reasoning' },
            ],
            errorMessage: 'Assistant warning',
          },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'toolResult',
            isError: true,
            content: [
              { type: 'image' },
              { type: 'audio' },
              { type: 'text', text: 'Tool error detail' },
            ],
          },
        }),
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: 'private child envelope' },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            content: Array.from(
              { length: MAX_STEP_TRACE_LOG_EVENTS + 5 },
              (_, index) => ({
                type: 'text',
                text: `event-${index}`,
              }),
            ),
          },
        }),
      ];
      const reference = await writeTranscript(
        trustedRoot,
        'mixed-child',
        mixedEntries.join('\n'),
      );

      const log = await readStepTranscript(reference);

      expect(log.status).toBe('available');
      if (log.status !== 'available') return;
      const output = log.lines.join('\n');
      expect(log.lines).toHaveLength(MAX_STEP_TRACE_LOG_EVENTS);
      expect(log.truncated).toBeTrue();
      expect(output).toContain('event progress');
      expect(output).toContain('Authorization=[redacted]');
      expect(output).not.toContain('transcript-secret');
      expect(output).not.toContain('structured-secret');
      expect(output).toContain('Assistant response');
      expect(output).toContain('tool call · read');
      expect(output).toContain('assistant error');
      expect(output).toContain('tool error · unknown tool');
      expect(output).toContain('[image]');
      expect(output).toContain('[audio]');
      expect(output).not.toContain('private reasoning');
      expect(output).not.toContain('private child envelope');
    } finally {
      await rm(temporaryRoot, { recursive: true });
    }
  });

  test('bounds transcripts by aggregate characters and by stable source prefix', async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'pi-workflows-transcript-bounds-'),
    );
    try {
      const trustedRoot = join(temporaryRoot, 'sessions');
      const characterEntries = Array.from({ length: 100 }, (_, index) =>
        JSON.stringify({
          type: 'custom_message',
          customType: `large-${index}`,
          content: 'x'.repeat(MAX_STEP_TRACE_LOG_EVENT_CHARS),
        }),
      );
      const characterReference = await writeTranscript(
        trustedRoot,
        'character-child',
        characterEntries.join('\n'),
      );
      const characterLog = await readStepTranscript(characterReference);
      expect(characterLog.status).toBe('available');
      if (characterLog.status === 'available') {
        expect(characterLog.truncated).toBeTrue();
        expect(characterLog.lines.length).toBeLessThan(100);
        expect(
          characterLog.lines.reduce((total, line) => total + line.length, 0),
        ).toBeLessThanOrEqual(MAX_STEP_TRACE_LOG_CHARS);
      }

      const sourceReference = await writeTranscript(
        trustedRoot,
        'source-child',
        `${JSON.stringify({
          type: 'custom_message',
          content: 'first stable event',
        })}\n${' '.repeat(2 * 1024 * 1024 + 128)}`,
      );
      const sourceLog = await readStepTranscript(sourceReference);
      expect(sourceLog).toMatchObject({
        status: 'available',
        truncated: true,
      });
      if (sourceLog.status === 'available') {
        expect(sourceLog.lines.join('\n')).toContain('first stable event');
      }
    } finally {
      await rm(temporaryRoot, { recursive: true });
    }
  });

  test('fails closed for invalid, missing, redirected, and non-file identities', async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'pi-workflows-transcript-safety-'),
    );
    try {
      const trustedRoot = join(temporaryRoot, 'sessions');
      await mkdir(trustedRoot, { recursive: true });

      const invalid = await readStepTranscript({
        ...transcriptReference(trustedRoot, 'invalid-child'),
        runId: '../invalid-child',
      });
      expect(invalid).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('identity is invalid'),
      });

      const missing = await readStepTranscript(
        transcriptReference(trustedRoot, 'missing-child'),
      );
      expect(missing).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('missing'),
      });

      const realRun = join(trustedRoot, 'real-run');
      await mkdir(join(realRun, 'run-0'), { recursive: true });
      await writeFile(join(realRun, 'run-0', 'session.jsonl'), '', 'utf8');
      await symlink(realRun, join(trustedRoot, 'redirected-run'));
      const redirectedRun = await readStepTranscript(
        transcriptReference(trustedRoot, 'redirected-run'),
      );
      expect(redirectedRun).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('directory identity'),
      });

      const redirectedChildRun = join(trustedRoot, 'redirected-child');
      const realChild = join(temporaryRoot, 'real-child');
      await mkdir(realChild, { recursive: true });
      await writeFile(join(realChild, 'session.jsonl'), '', 'utf8');
      await mkdir(redirectedChildRun, { recursive: true });
      await symlink(realChild, join(redirectedChildRun, 'run-0'));
      const redirectedChild = await readStepTranscript(
        transcriptReference(trustedRoot, 'redirected-child'),
      );
      expect(redirectedChild).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('directory identity'),
      });

      const childFileRun = join(trustedRoot, 'child-file');
      await mkdir(childFileRun, { recursive: true });
      await writeFile(join(childFileRun, 'run-0'), '', 'utf8');
      const childFile = await readStepTranscript(
        transcriptReference(trustedRoot, 'child-file'),
      );
      expect(childFile).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('directory identity'),
      });

      const sessionDirectoryReference = transcriptReference(
        trustedRoot,
        'session-directory',
      );
      await mkdir(sessionDirectoryReference.sessionFile, { recursive: true });
      const sessionDirectory = await readStepTranscript(
        sessionDirectoryReference,
      );
      expect(sessionDirectory).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('not a regular file'),
      });

      const sessionLinkReference = transcriptReference(
        trustedRoot,
        'session-link',
      );
      await mkdir(join(trustedRoot, 'session-link', 'run-0'), {
        recursive: true,
      });
      const linkTarget = join(temporaryRoot, 'session-target.jsonl');
      await writeFile(linkTarget, '', 'utf8');
      await symlink(linkTarget, sessionLinkReference.sessionFile);
      const sessionLink = await readStepTranscript(sessionLinkReference);
      expect(sessionLink).toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('not a regular file'),
      });
    } finally {
      await rm(temporaryRoot, { recursive: true });
    }
  });
});
