import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  StepAttemptResult,
  StepExecutionAttempt,
  StepGateDecision,
  SubagentTranscriptReference,
  UsageAggregate,
  WorkflowRun,
  WorkflowStepResult,
} from '../../domain/index.ts';
import {
  MAX_STEP_TRACE_ARTIFACT_CHARS,
  MAX_STEP_TRACE_ATTEMPTS,
  MAX_STEP_TRACE_LOG_CHARS,
  MAX_STEP_TRACE_LOG_EVENTS,
  MAX_STEP_TRACE_SUMMARY_CHARS,
  MAX_STEP_TRACE_TASK_CHARS,
  MAX_WORKFLOW_TRACE_CHARS,
} from '../../domain/index.ts';
import { redactStepLogText } from '../../ui/step-log.ts';
import { emptyUsageAggregate, mergeUsage } from './usage.ts';

type CompactedTask = {
  readonly task: string;
  readonly taskTruncated?: true;
  readonly omittedTaskChars?: number;
};

const COMPACTED_FIELD_CHARS = 512;
const COMPACTED_LOG_CHARS = 4_096;

type CompactedLog = {
  readonly log?: ReadonlyArray<string>;
  readonly logTruncated?: true;
  readonly omittedLogEvents?: number;
};

function logChars(lines: ReadonlyArray<string> | undefined): number {
  return lines?.reduce((total, line) => total + line.length, 0) ?? 0;
}

function attemptSize(attempt: StepExecutionAttempt): number {
  return (
    attempt.requestId.length +
    attempt.task.length +
    (attempt.kind === 'subagent' ? attempt.agent.length : 0) +
    (attempt.kind === 'main' ? logChars(attempt.log) : 0) +
    (attempt.result?.outcome.length ?? 0) +
    (attempt.result?.summary.length ?? 0) +
    (attempt.result?.artifact?.length ?? 0) +
    (attempt.result?.workspaceCwd?.length ?? 0) +
    (attempt.kind === 'subagent'
      ? (attempt.transcript?.trustedRoot.length ?? 0) +
        (attempt.transcript?.sessionFile.length ?? 0) +
        (attempt.transcript?.runId.length ?? 0)
      : 0) +
    (attempt.gateDecision?.requestId.length ?? 0) +
    (attempt.gateDecision?.feedback.length ?? 0) +
    (attempt.gateDecision?.reviewId?.length ?? 0) +
    (attempt.usage ? JSON.stringify(attempt.usage).length : 0)
  );
}

function compactMainLog(attempt: StepExecutionAttempt): CompactedLog {
  if (attempt.kind !== 'main' || !attempt.log) return {};
  const retained: Array<string> = [];
  let chars = 0;
  for (const line of attempt.log) {
    if (chars + line.length > COMPACTED_LOG_CHARS) break;
    retained.push(line);
    chars += line.length;
  }
  const newlyOmitted = attempt.log.length - retained.length;
  const omittedLogEvents = (attempt.omittedLogEvents ?? 0) + newlyOmitted;
  return {
    log: retained,
    ...(attempt.logTruncated || omittedLogEvents > 0
      ? { logTruncated: true, omittedLogEvents }
      : {}),
  };
}

function compactAttempt(attempt: StepExecutionAttempt): StepExecutionAttempt {
  const task = attempt.task.slice(0, COMPACTED_FIELD_CHARS);
  const removedTaskChars = attempt.task.length - task.length;
  const result = attempt.result
    ? {
        ...attempt.result,
        summary: attempt.result.summary.slice(0, COMPACTED_FIELD_CHARS),
        ...(attempt.result.summary.length > COMPACTED_FIELD_CHARS
          ? { summaryTruncated: true as const }
          : {}),
        ...(attempt.result.artifact !== undefined
          ? {
              artifact: attempt.result.artifact.slice(0, COMPACTED_FIELD_CHARS),
              ...(attempt.result.artifact.length > COMPACTED_FIELD_CHARS
                ? { artifactTruncated: true as const }
                : {}),
            }
          : {}),
      }
    : undefined;
  const gateDecision = attempt.gateDecision
    ? {
        ...attempt.gateDecision,
        feedback: attempt.gateDecision.feedback.slice(0, COMPACTED_FIELD_CHARS),
        ...(attempt.gateDecision.feedback.length > COMPACTED_FIELD_CHARS
          ? { feedbackTruncated: true as const }
          : {}),
      }
    : undefined;
  const compactedLog = compactMainLog(attempt);
  return {
    ...attempt,
    task,
    ...(attempt.taskTruncated || removedTaskChars > 0
      ? {
          taskTruncated: true as const,
          omittedTaskChars: (attempt.omittedTaskChars ?? 0) + removedTaskChars,
        }
      : {}),
    ...(result ? { result } : {}),
    ...(gateDecision ? { gateDecision } : {}),
    ...(attempt.kind === 'main' && attempt.log ? compactedLog : {}),
  };
}

/** Returns the bounded checkpoint payload attributable to step traces. */
export function workflowTraceChars(run: WorkflowRun): number {
  const attempts = [
    ...run.history.flatMap((entry) => entry.attempts ?? []),
    ...(run.currentStepAttempts ?? []),
  ].reduce((total, attempt) => total + attemptSize(attempt), 0);
  const aggregates = [
    ...run.history.map((entry) => entry.usage),
    run.currentStepUsage,
  ].reduce(
    (total, usage) => total + (usage ? JSON.stringify(usage).length : 0),
    0,
  );
  return attempts + aggregates;
}

function compactRunTraceBudget(run: WorkflowRun): WorkflowRun {
  let remaining = workflowTraceChars(run);
  if (remaining <= MAX_WORKFLOW_TRACE_CHARS) return run;

  const compactAttempts = (
    values: ReadonlyArray<StepExecutionAttempt>,
  ): Array<StepExecutionAttempt> => {
    const attempts = [...values];
    for (let index = 0; index < attempts.length; index += 1) {
      if (remaining <= MAX_WORKFLOW_TRACE_CHARS) break;
      const attempt = attempts[index];
      if (!attempt) continue;
      const compacted = compactAttempt(attempt);
      remaining -= attemptSize(attempt) - attemptSize(compacted);
      attempts[index] = compacted;
    }
    return attempts;
  };
  const history = run.history.map((entry) =>
    entry.attempts
      ? { ...entry, attempts: compactAttempts(entry.attempts) }
      : entry,
  );
  const currentStepAttempts = [...(run.currentStepAttempts ?? [])];
  const compactedCurrent = compactAttempts(currentStepAttempts);
  for (let index = 0; index < history.length; index += 1) {
    if (remaining <= MAX_WORKFLOW_TRACE_CHARS) break;
    const entry = history[index];
    if (!entry?.attempts || entry.attempts.length <= 1) continue;
    const attempts = [...entry.attempts];
    let omittedAttempts = entry.omittedAttempts ?? 0;
    while (remaining > MAX_WORKFLOW_TRACE_CHARS && attempts.length > 2) {
      const removed = attempts.splice(1, 1)[0];
      if (removed) remaining -= attemptSize(removed);
      omittedAttempts += 1;
    }
    history[index] = { ...entry, attempts, omittedAttempts };
  }
  let currentOmittedAttempts = run.currentStepOmittedAttempts ?? 0;
  while (remaining > MAX_WORKFLOW_TRACE_CHARS && compactedCurrent.length > 2) {
    const removed = compactedCurrent.splice(1, 1)[0];
    if (removed) remaining -= attemptSize(removed);
    currentOmittedAttempts += 1;
  }
  for (let index = 0; index < history.length; index += 1) {
    if (remaining <= MAX_WORKFLOW_TRACE_CHARS) break;
    const entry = history[index];
    if (!entry?.attempts || entry.attempts.length === 0) continue;
    const attempts = [...entry.attempts];
    let omittedAttempts = entry.omittedAttempts ?? 0;
    while (remaining > MAX_WORKFLOW_TRACE_CHARS && attempts.length > 0) {
      const removed = attempts.shift();
      if (removed) remaining -= attemptSize(removed);
      omittedAttempts += 1;
    }
    history[index] = { ...entry, attempts, omittedAttempts };
  }
  while (remaining > MAX_WORKFLOW_TRACE_CHARS && compactedCurrent.length > 0) {
    const removed = compactedCurrent.shift();
    if (removed) remaining -= attemptSize(removed);
    currentOmittedAttempts += 1;
  }

  return {
    ...run,
    history,
    ...(run.currentStepAttempts
      ? { currentStepAttempts: compactedCurrent }
      : {}),
    ...(currentOmittedAttempts > 0
      ? { currentStepOmittedAttempts: currentOmittedAttempts }
      : {}),
  };
}

function compactTask(task: string): CompactedTask {
  if (task.length <= MAX_STEP_TRACE_TASK_CHARS) return { task };
  return {
    task: task.slice(0, MAX_STEP_TRACE_TASK_CHARS),
    taskTruncated: true,
    omittedTaskChars: task.length - MAX_STEP_TRACE_TASK_CHARS,
  };
}

function appendAttempt(
  run: WorkflowRun,
  attempt: StepExecutionAttempt,
  now: number,
): WorkflowRun {
  if (
    run.currentStepAttempts?.some(
      (candidate) => candidate.requestId === attempt.requestId,
    )
  ) {
    return run;
  }
  const existing = run.currentStepAttempts ?? [];
  const isFull = existing.length >= MAX_STEP_TRACE_ATTEMPTS;
  const retained = isFull
    ? [existing[0], ...existing.slice(-(MAX_STEP_TRACE_ATTEMPTS - 2))].filter(
        (candidate): candidate is StepExecutionAttempt =>
          candidate !== undefined,
      )
    : existing;
  const omittedAttempts =
    (run.currentStepOmittedAttempts ?? 0) + (isFull ? 1 : 0);
  return compactRunTraceBudget({
    ...run,
    currentStepAttempts: [...retained, attempt],
    ...(omittedAttempts > 0
      ? { currentStepOmittedAttempts: omittedAttempts }
      : {}),
    updatedAt: now,
  });
}

function nextAttemptOrdinal(run: WorkflowRun): number {
  const attempts = run.currentStepAttempts ?? [];
  const largestRecordedOrdinal = attempts.reduce(
    (largest, attempt) => Math.max(largest, attempt.ordinal ?? 0),
    0,
  );
  const attemptedCount =
    attempts.length + (run.currentStepOmittedAttempts ?? 0);
  return Math.max(largestRecordedOrdinal, attemptedCount) + 1;
}

/** Records the exact task supplied for one main-agent attempt. */
export function beginMainStepAttempt(
  run: WorkflowRun,
  requestId: string,
  task: string,
  now: number,
): WorkflowRun {
  if (!requestId || requestId.includes('\0') || !task.trim()) return run;
  const compacted = compactTask(task);
  return appendAttempt(
    run,
    {
      kind: 'main',
      requestId,
      ordinal: nextAttemptOrdinal(run),
      ...compacted,
      startedAt: now,
    },
    now,
  );
}

/** Records the exact task body supplied for one child attempt. */
export function beginSubagentStepAttempt(
  run: WorkflowRun,
  requestId: string,
  agent: string,
  task: string,
  now: number,
): WorkflowRun {
  if (!requestId || requestId.includes('\0') || !agent || !task.trim()) {
    return run;
  }
  const compacted = compactTask(task);
  return appendAttempt(
    run,
    {
      kind: 'subagent',
      requestId,
      ordinal: nextAttemptOrdinal(run),
      agent,
      ...compacted,
      startedAt: now,
    },
    now,
  );
}

/** Appends a redacted, bounded prefix of main-agent events to one exact attempt. */
export function appendMainStepLog(
  run: WorkflowRun,
  requestId: string,
  lines: ReadonlyArray<string>,
  now: number,
): WorkflowRun {
  if (!requestId || requestId.includes('\0') || lines.length === 0) return run;
  const attempts = run.currentStepAttempts;
  if (!attempts || attempts.length === 0) return run;
  const index = attempts.length - 1;
  const attempt = attempts[index];
  if (!attempt || attempt.kind !== 'main' || attempt.requestId !== requestId) {
    return run;
  }

  const safeLines = lines
    .map(redactStepLogText)
    .filter((line) => line.length > 0);
  if (safeLines.length === 0) return run;

  const existing = [...(attempt.log ?? [])];
  let chars = logChars(existing);
  let accepted = 0;
  if (!attempt.logTruncated) {
    for (const line of safeLines) {
      if (
        existing.length >= MAX_STEP_TRACE_LOG_EVENTS ||
        chars + line.length > MAX_STEP_TRACE_LOG_CHARS
      ) {
        break;
      }
      existing.push(line);
      chars += line.length;
      accepted += 1;
    }
  }
  const newlyOmitted = safeLines.length - accepted;
  const omittedLogEvents = (attempt.omittedLogEvents ?? 0) + newlyOmitted;
  const currentStepAttempts = [...attempts];
  currentStepAttempts[index] = {
    ...attempt,
    log: existing,
    ...(attempt.logTruncated || omittedLogEvents > 0
      ? { logTruncated: true, omittedLogEvents }
      : {}),
  };
  return compactRunTraceBudget({
    ...run,
    currentStepAttempts,
    updatedAt: now,
  });
}

function isSafeTranscriptReference(
  reference: SubagentTranscriptReference,
): boolean {
  if (
    !isAbsolute(reference.trustedRoot) ||
    !isAbsolute(reference.sessionFile) ||
    reference.trustedRoot.includes('\0') ||
    reference.sessionFile.includes('\0') ||
    !reference.runId ||
    reference.runId.includes('\0') ||
    reference.runId.includes('/') ||
    reference.runId.includes('\\') ||
    reference.runId === '.' ||
    reference.runId === '..' ||
    !Number.isSafeInteger(reference.childIndex) ||
    reference.childIndex < 0
  ) {
    return false;
  }
  const expected = resolve(
    reference.trustedRoot,
    reference.runId,
    `run-${reference.childIndex}`,
    'session.jsonl',
  );
  const relativePath = relative(
    resolve(reference.trustedRoot),
    resolve(reference.sessionFile),
  );
  const isWithinTrustedRoot =
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
  return isWithinTrustedRoot && resolve(reference.sessionFile) === expected;
}

/**
 * Attaches a lexically confined child transcript reference to its attempt.
 *
 * The status reader repeats this check and then verifies real paths, file type,
 * no-follow opening, and a stable bounded read before displaying anything.
 */
export function attachSubagentTranscript(
  run: WorkflowRun,
  requestId: string,
  reference: SubagentTranscriptReference,
  now: number,
): WorkflowRun {
  if (!isSafeTranscriptReference(reference)) return run;
  const attempts = run.currentStepAttempts;
  const index = attempts?.findIndex(
    (attempt) => attempt.requestId === requestId && attempt.kind === 'subagent',
  );
  if (index === undefined || index < 0 || !attempts) return run;
  const currentStepAttempts = [...attempts];
  const attempt = currentStepAttempts[index];
  if (!attempt || attempt.kind !== 'subagent') return run;
  currentStepAttempts[index] = { ...attempt, transcript: reference };
  return compactRunTraceBudget({ ...run, currentStepAttempts, updatedAt: now });
}

function attemptResult(
  result: WorkflowStepResult,
  workspaceCwd?: string,
): StepAttemptResult {
  const summary = result.summary.slice(0, MAX_STEP_TRACE_SUMMARY_CHARS);
  const artifact = result.artifact?.slice(0, MAX_STEP_TRACE_ARTIFACT_CHARS);
  return {
    outcome: result.outcome,
    summary,
    ...(summary.length < result.summary.length
      ? { summaryTruncated: true as const }
      : {}),
    ...(artifact !== undefined ? { artifact } : {}),
    ...(artifact !== undefined &&
    artifact.length < (result.artifact?.length ?? 0)
      ? { artifactTruncated: true as const }
      : {}),
    ...(workspaceCwd ? { workspaceCwd } : {}),
  };
}

/**
 * Attaches finalized usage to its exact attempt. The separate current
 * aggregate deliberately survives trace eviction and is copied to history.
 */
export function recordCurrentStepUsage(
  run: WorkflowRun,
  requestId: string,
  usage: UsageAggregate,
  now: number,
): WorkflowRun {
  const attempts = run.currentStepAttempts;
  const index = attempts?.findIndex(
    (attempt) => attempt.requestId === requestId,
  );
  if (index === undefined || index < 0 || !attempts) return run;
  const attempt = attempts[index];
  if (!attempt) return run;
  const currentStepAttempts = [...attempts];
  currentStepAttempts[index] = {
    ...attempt,
    usage: mergeUsage(attempt.usage ?? emptyUsageAggregate(), usage.models),
  };
  return compactRunTraceBudget({
    ...run,
    currentStepAttempts,
    currentStepUsage: mergeUsage(
      run.currentStepUsage ?? emptyUsageAggregate(),
      usage.models,
    ),
    updatedAt: now,
  });
}

export function usageAggregateFromModels(
  entries: UsageAggregate['models'],
): UsageAggregate {
  return mergeUsage(emptyUsageAggregate(), entries);
}

export function recordCurrentStepResult(
  run: WorkflowRun,
  result: WorkflowStepResult,
  now: number,
  workspaceCwd?: string,
): WorkflowRun {
  const attempts = run.currentStepAttempts;
  if (!attempts || attempts.length === 0) return run;
  const index = attempts.length - 1;
  const latest = attempts[index];
  if (!latest) return run;
  const currentStepAttempts = [...attempts];
  currentStepAttempts[index] = {
    ...latest,
    result: attemptResult(result, workspaceCwd),
  };
  return compactRunTraceBudget({
    ...run,
    currentStepAttempts,
    updatedAt: now,
  });
}

/** Durably pairs a human gate decision with the attempt it reviewed. */
export function recordCurrentGateDecision(
  run: WorkflowRun,
  decision: StepGateDecision,
  now: number,
): WorkflowRun {
  const attempts = run.currentStepAttempts;
  if (!attempts || attempts.length === 0) return run;
  const index = attempts.length - 1;
  const latest = attempts[index];
  if (!latest) return run;
  const feedback = decision.feedback.slice(0, MAX_STEP_TRACE_SUMMARY_CHARS);
  const currentStepAttempts = [...attempts];
  currentStepAttempts[index] = {
    ...latest,
    gateDecision: {
      ...decision,
      feedback,
      ...(feedback.length < decision.feedback.length
        ? { feedbackTruncated: true }
        : {}),
    },
  };
  return compactRunTraceBudget({
    ...run,
    currentStepAttempts,
    updatedAt: now,
  });
}
