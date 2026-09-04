import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { stepLogLinesFromTurn, textOnlyUserMessage } from '../../ui/index.ts';
import {
  modelUsageFromMessage,
  type ModelUsage,
} from '../../function/index.ts';
import type { MainStepRuntimeState } from './main-step-runtime-types.ts';

type UnknownRecord = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

type RegisterMainStepTraceOptions = {
  readonly pi: ExtensionAPI;
  readonly state: MainStepRuntimeState;
};

/** Extracts finalized assistant and nested tool-result usage from one Pi turn. */
export function mainTurnUsage(event: {
  readonly message?: unknown;
  readonly toolResults?: ReadonlyArray<unknown>;
}): ReadonlyArray<ModelUsage> {
  const messageUsage = modelUsageFromMessage(event.message);
  const fallbackProvider =
    messageUsage?.provider ??
    (isRecord(event.message) && typeof event.message.provider === 'string'
      ? event.message.provider
      : undefined);
  const fallbackModel =
    messageUsage?.model ??
    (isRecord(event.message) && typeof event.message.model === 'string'
      ? event.message.model
      : undefined);
  const entries: Array<ModelUsage> = messageUsage ? [messageUsage] : [];
  for (const toolResult of event.toolResults ?? []) {
    const toolUsage = modelUsageFromMessage(
      toolResult,
      fallbackProvider,
      fallbackModel,
    );
    if (toolUsage) entries.push(toolUsage);
  }
  return entries;
}

/** Arms a trace only after Pi finalizes the exact extension-supplied task. */
export function armMainStepTrace(
  state: MainStepRuntimeState,
  message: unknown,
): void {
  if (!state.active || state.traceArmed || state.traceClosed) return;
  if (textOnlyUserMessage(message) === state.active.task) {
    state.traceArmed = true;
  }
}

/**
 * Persists finalized main-agent turns while one exact workflow attempt is armed.
 *
 * Successful completion is closed only after its assistant call and tool result
 * are captured, preventing queued parent-session follow-ups from leaking in.
 */
export function registerMainStepTrace({
  pi,
  state,
}: RegisterMainStepTraceOptions): void {
  pi.on('turn_end', async (event, context) => {
    const active = state.active;
    if (!active || !state.traceArmed || state.traceClosed) return;
    const lines = stepLogLinesFromTurn(event.message, event.toolResults);
    try {
      const usage = mainTurnUsage(event);
      if (lines.length > 0 || usage.length > 0)
        await active.onTrace(lines, context, usage);
    } catch {
      // Status evidence is best-effort and must never interrupt the agent loop.
    } finally {
      if (state.active === active && state.pendingResult) {
        state.traceClosed = true;
      }
    }
  });
}
