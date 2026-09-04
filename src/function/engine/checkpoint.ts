import type { WorkflowRun } from '../../domain/index.ts';
import { isWorkflowRun } from './run-validation.ts';

export type CheckpointResult =
  | { readonly status: 'none' }
  | { readonly status: 'invalid' }
  | { readonly status: 'valid'; readonly run: WorkflowRun };

type SessionEntryLike = {
  readonly type?: unknown;
  readonly customType?: unknown;
  readonly data?: unknown;
};

/**
 * Only the newest entry for this checkpoint type is authoritative. Falling
 * back past corrupt or newer-version state could repeat already-finished work.
 *
 * @param entries - Session entries in chronological order.
 * @param customType - Workflow checkpoint entry type.
 * @returns The newest checkpoint state.
 */
export function readLatestCheckpoint(
  entries: ReadonlyArray<SessionEntryLike>,
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
