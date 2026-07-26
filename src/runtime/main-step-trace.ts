import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { stepLogLinesFromTurn, textOnlyUserMessage } from '../step-log.ts';
import type { MainStepRuntimeState } from './main-step-runtime-types.ts';

type RegisterMainStepTraceOptions = {
  readonly pi: ExtensionAPI;
  readonly state: MainStepRuntimeState;
};

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
      if (lines.length > 0) await active.onTrace(lines, context);
    } catch {
      // Status evidence is best-effort and must never interrupt the agent loop.
    } finally {
      if (state.active === active && state.pendingResult) {
        state.traceClosed = true;
      }
    }
  });
}
