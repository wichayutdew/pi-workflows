import { wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type {
  StepExecutionAttempt,
  StepHistoryEntry,
} from '../engine/state.ts';
import { redactStepDetailText } from '../step-log.ts';
import { boxed, keyValueLines } from './layout.ts';
import { buildPathEntries } from './render-path.ts';
import type { StepTranscriptLog } from './transcript-reader.ts';
import type { WorkflowStatusSnapshot, WorkflowStatusTheme } from './types.ts';

const MAX_DETAIL_ARTIFACT_CHARS = 20_000;

export type StepTranscriptViewState =
  { readonly status: 'loading' } | StepTranscriptLog;

export type StepTranscriptViewCache = ReadonlyMap<
  string,
  StepTranscriptViewState
>;

export type SelectedStepDetail = {
  readonly entryIndex: number;
  readonly historyEntry?: StepHistoryEntry;
  readonly attempts: ReadonlyArray<StepExecutionAttempt>;
  readonly omittedAttempts: number;
};

export function stepTranscriptCacheKey(
  runId: string,
  attempt: StepExecutionAttempt,
): string {
  return `${runId}\0${attempt.requestId}`;
}

/** Resolves one displayed path row back to its durable checkpoint evidence. */
export function selectedStepDetail(
  snapshot: WorkflowStatusSnapshot,
  selectedIndex: number,
): SelectedStepDetail | undefined {
  const entries = buildPathEntries(snapshot);
  const entry = entries[selectedIndex];
  if (!entry) return undefined;
  if (entry.historyIndex !== undefined) {
    const historyEntry = snapshot.run.history[entry.historyIndex];
    if (!historyEntry) return undefined;
    return {
      entryIndex: entry.index,
      historyEntry,
      attempts: historyEntry.attempts ?? [],
      omittedAttempts: historyEntry.omittedAttempts ?? 0,
    };
  }
  return {
    entryIndex: entry.index,
    attempts: snapshot.run.currentStepAttempts ?? [],
    omittedAttempts: snapshot.run.currentStepOmittedAttempts ?? 0,
  };
}

function wrapPlain(
  value: string,
  width: number,
  theme: WorkflowStatusTheme,
  color: 'text' | 'muted' | 'dim' | 'warning' = 'text',
): Array<string> {
  const sanitized = redactStepDetailText(value);
  const logicalLines = sanitized.split('\n');
  const wrapped = logicalLines.flatMap((line) => {
    const themed = theme.fg(color, line || ' ');
    return wrapTextWithAnsi(themed, Math.max(1, width));
  });
  return wrapped.length > 0 ? wrapped : [theme.fg(color, ' ')];
}

function boundedArtifact(value: string): {
  readonly value: string;
  readonly truncated: boolean;
} {
  return value.length <= MAX_DETAIL_ARTIFACT_CHARS
    ? { value, truncated: false }
    : {
        value: value.slice(0, MAX_DETAIL_ARTIFACT_CHARS),
        truncated: true,
      };
}

function renderResult(
  theme: WorkflowStatusTheme,
  attempt: StepExecutionAttempt,
  width: number,
): Array<string> {
  const result = attempt.result;
  if (!result) return [];
  const artifact =
    result.artifact === undefined
      ? undefined
      : boundedArtifact(result.artifact);
  return [
    '',
    theme.bold(theme.fg('accent', 'Submitted result')),
    ...keyValueLines(theme, 'outcome', result.outcome, width, 'success'),
    ...keyValueLines(
      theme,
      'summary',
      `${result.summary}${result.summaryTruncated ? ' … [trace truncated]' : ''}`,
      width,
    ),
    ...(result.workspaceCwd
      ? keyValueLines(theme, 'workspace', result.workspaceCwd, width)
      : []),
    ...(artifact
      ? [
          theme.fg('muted', 'artifact'),
          ...wrapPlain(
            `${artifact.value}${
              artifact.truncated || result.artifactTruncated
                ? '\n… [artifact truncated in status trace]'
                : ''
            }`,
            width,
            theme,
          ),
        ]
      : []),
  ];
}

function renderGateDecision(
  theme: WorkflowStatusTheme,
  attempt: StepExecutionAttempt,
  width: number,
): Array<string> {
  const decision = attempt.gateDecision;
  if (!decision) return [];
  return [
    '',
    theme.bold(theme.fg('accent', 'Human gate decision')),
    ...keyValueLines(theme, 'provider', decision.provider, width),
    ...keyValueLines(
      theme,
      'decision',
      decision.approved ? 'approved' : 'rejected',
      width,
      decision.approved ? 'success' : 'warning',
    ),
    ...(decision.reviewId
      ? keyValueLines(theme, 'review', decision.reviewId, width, 'muted')
      : []),
    ...(decision.feedback
      ? keyValueLines(
          theme,
          'feedback',
          `${decision.feedback}${
            decision.feedbackTruncated ? ' … [trace truncated]' : ''
          }`,
          width,
        )
      : []),
  ];
}

function renderTranscript(
  theme: WorkflowStatusTheme,
  snapshot: WorkflowStatusSnapshot,
  attempt: StepExecutionAttempt,
  cache: StepTranscriptViewCache,
  width: number,
): Array<string> {
  if (attempt.kind === 'main') {
    const events = (attempt.log ?? []).flatMap((event, index) => [
      theme.fg('muted', `#${index + 1}`),
      ...wrapPlain(event, width, theme),
    ]);
    return [
      ...(events.length > 0
        ? events
        : [
            theme.fg(
              'muted',
              'No main-agent reaction log was recorded for this attempt. Legacy checkpoints still show the exact task and result.',
            ),
          ]),
      ...(attempt.logTruncated
        ? [
            theme.fg(
              'warning',
              `… Main-agent log was bounded; ${attempt.omittedLogEvents ?? 0} later event${attempt.omittedLogEvents === 1 ? '' : 's'} omitted.`,
            ),
          ]
        : []),
    ];
  }
  if (!attempt.transcript) {
    return wrapPlain(
      'No trusted child transcript reference was recorded for this attempt.',
      width,
      theme,
      'muted',
    );
  }
  const state = cache.get(stepTranscriptCacheKey(snapshot.run.runId, attempt));
  if (!state || state.status === 'loading') {
    return [theme.fg('muted', 'Loading trusted child transcript…')];
  }
  if (state.status === 'unavailable') {
    return wrapPlain(state.reason, width, theme, 'warning');
  }
  const events = state.lines.flatMap((event, index) => [
    theme.fg('muted', `#${index + 1}`),
    ...wrapPlain(event, width, theme),
  ]);
  return [
    ...(events.length > 0
      ? events
      : [theme.fg('muted', 'No displayable assistant or tool events found.')]),
    ...(state.truncated
      ? [
          theme.fg(
            'warning',
            '… Transcript display was bounded; additional events were omitted.',
          ),
        ]
      : []),
  ];
}

function renderAttempt(
  theme: WorkflowStatusTheme,
  snapshot: WorkflowStatusSnapshot,
  attempt: StepExecutionAttempt,
  attemptNumber: number,
  cache: StepTranscriptViewCache,
  width: number,
): Array<string> {
  const actor =
    attempt.kind === 'subagent' ? `subagent · ${attempt.agent}` : 'main agent';
  const truncation = attempt.taskTruncated
    ? `\n… [${attempt.omittedTaskChars ?? 0} task characters omitted from the bounded checkpoint trace]`
    : '';
  return [
    theme.bold(theme.fg('accent', `Attempt ${attemptNumber} · ${actor}`)),
    ...keyValueLines(theme, 'request', attempt.requestId, width, 'muted'),
    '',
    theme.bold('Requirement fed to the agent'),
    ...wrapPlain(`${attempt.task}${truncation}`, width, theme),
    '',
    theme.bold('Chronological reaction and tool log'),
    ...renderTranscript(theme, snapshot, attempt, cache, width),
    ...renderResult(theme, attempt, width),
    ...renderGateDecision(theme, attempt, width),
  ];
}

function attemptDisplayOrdinal(
  attempt: StepExecutionAttempt,
  index: number,
  omittedAttempts: number,
): number {
  if (attempt.ordinal !== undefined) return attempt.ordinal;
  if (omittedAttempts === 0 || index === 0) return index + 1;
  return omittedAttempts + index + 1;
}

/** Renders one selected execution-path row and its persisted evidence. */
export function renderStepDetail(
  theme: WorkflowStatusTheme,
  snapshot: WorkflowStatusSnapshot,
  selectedIndex: number,
  cache: StepTranscriptViewCache,
  width: number,
): Array<string> {
  const entries = buildPathEntries(snapshot);
  const entry = entries[selectedIndex];
  const detail = selectedStepDetail(snapshot, selectedIndex);
  if (!entry || !detail) {
    return boxed(
      theme,
      'Step Explorer',
      width,
      [theme.fg('muted', 'The selected step is no longer available.')],
      'borderAccent',
    );
  }

  const history = detail.historyEntry;
  const finalArtifact =
    history?.artifact ??
    (entry.isCurrent ? snapshot.run.pendingGate?.artifact : undefined);
  const artifact =
    finalArtifact === undefined ? undefined : boundedArtifact(finalArtifact);
  const attempts = detail.attempts.flatMap((attempt, index) => [
    ...(index > 0 ? ['', theme.fg('dim', '─'.repeat(Math.max(1, width)))] : []),
    ...renderAttempt(
      theme,
      snapshot,
      attempt,
      attemptDisplayOrdinal(attempt, index, detail.omittedAttempts),
      cache,
      width,
    ),
  ]);
  const currentReason =
    entry.isCurrent && snapshot.run.pauseReason
      ? snapshot.run.pauseReason
      : undefined;
  const body = [
    ...keyValueLines(theme, 'workflow', snapshot.run.workflowId, width),
    ...keyValueLines(theme, 'run', snapshot.run.runId, width, 'muted'),
    ...keyValueLines(theme, 'step', entry.stepId, width),
    ...keyValueLines(theme, 'visit', String(entry.visit), width),
    ...keyValueLines(theme, 'status', entry.status, width),
    ...(history
      ? [
          ...keyValueLines(theme, 'outcome', history.outcome, width, 'success'),
          ...keyValueLines(theme, 'summary', history.summary, width),
        ]
      : []),
    ...(currentReason
      ? keyValueLines(theme, 'reason', currentReason, width, 'warning')
      : []),
    ...(entry.isCurrent && snapshot.run.gateFeedback
      ? keyValueLines(
          theme,
          'feedback',
          snapshot.run.gateFeedback,
          width,
          'warning',
        )
      : []),
    ...(history?.workspaceCwd
      ? keyValueLines(theme, 'workspace', history.workspaceCwd, width)
      : entry.isCurrent && snapshot.run.cwd
        ? keyValueLines(theme, 'workspace', snapshot.run.cwd, width)
        : []),
    ...(artifact
      ? [
          '',
          theme.bold('Final/review artifact'),
          ...wrapPlain(
            `${artifact.value}${
              artifact.truncated
                ? '\n… [artifact truncated in status display]'
                : ''
            }`,
            width,
            theme,
          ),
        ]
      : []),
    '',
    ...(detail.omittedAttempts > 0
      ? [
          theme.fg(
            'warning',
            `${detail.omittedAttempts} attempt${
              detail.omittedAttempts === 1 ? ' was' : 's were'
            } compacted from the bounded checkpoint trace; retained attempt numbers preserve the chronological gap.`,
          ),
          '',
        ]
      : []),
    ...(attempts.length > 0
      ? attempts
      : [
          theme.fg(
            'muted',
            'No execution trace was recorded. This step may predate the step-explorer feature.',
          ),
        ]),
  ];
  return boxed(
    theme,
    `Step Explorer · ${entry.title} · visit ${entry.visit}`,
    width,
    body,
    'borderAccent',
  );
}
