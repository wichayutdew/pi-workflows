import { isWorkflowRun, type WorkflowRun } from './state.ts';

export type CheckpointResult =
  | { status: 'none' }
  | { status: 'invalid' }
  | { status: 'valid'; run: WorkflowRun };

interface SessionEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

/**
 * Only the newest entry for this checkpoint type is authoritative. Falling
 * back past corrupt or newer-version state could repeat already-finished work.
 */
export function readLatestCheckpoint(
  entries: readonly SessionEntryLike[],
  customType: string,
): CheckpointResult {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'custom' || entry.customType !== customType) continue;
    return isWorkflowRun(entry.data)
      ? { status: 'valid', run: structuredClone(entry.data) }
      : { status: 'invalid' };
  }
  return { status: 'none' };
}
