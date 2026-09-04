import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { WORKFLOW_COMPLETION_TOOL } from './completion-tool.ts';
import { armMainStepTrace } from './main-step-trace.ts';
import type {
  MainStepRuntimeDependencies,
  MainStepRuntimeState,
} from './main-step-runtime-types.ts';

type RegisterMainStepPolicyOptions = {
  readonly pi: ExtensionAPI;
  readonly state: MainStepRuntimeState;
  readonly dependencies: MainStepRuntimeDependencies;
};

/**
 * Registers policy handlers that isolate and freeze active-step tool calls.
 *
 * @param options - Pi API, runtime state, and injected policy operations.
 */
export function registerMainStepPolicy({
  pi,
  state,
  dependencies,
}: RegisterMainStepPolicyOptions): void {
  pi.on('turn_start', () => {
    state.invalidCompletionCalls = new Set();
  });

  pi.on('message_end', (event) => {
    armMainStepTrace(state, event.message);
    if (!state.active) {
      return;
    }

    const invalidCalls = dependencies.invalidCompletionCallIds(
      event.message,
      WORKFLOW_COMPLETION_TOOL,
    );
    if (invalidCalls.size > 0 || event.message.role === 'assistant') {
      state.invalidCompletionCalls = invalidCalls;
    }
  });

  pi.on('tool_call', (event) => {
    if (state.isSuspended) {
      return {
        block: true,
        reason: 'Main-agent workflow step is suspended',
      };
    }
    if (!state.active) {
      return event.toolName === WORKFLOW_COMPLETION_TOOL
        ? {
            block: true,
            reason: 'No main-agent workflow step is active',
          }
        : undefined;
    }
    if (state.invalidCompletionCalls.has(event.toolCallId)) {
      return {
        block: true,
        reason: `${WORKFLOW_COMPLETION_TOOL} must be the only tool call in its message`,
      };
    }
    if (event.toolName === WORKFLOW_COMPLETION_TOOL) {
      dependencies.freezeToolInput(event.input);
      return;
    }

    const authorization = dependencies.authorizeToolCall(
      event.toolName,
      Object.fromEntries(Object.entries(event.input)),
      state.active.step,
      pi.getAllTools(),
    );
    if (!authorization.allowed) {
      return {
        block: true,
        reason: authorization.reason ?? 'Tool blocked by main workflow policy',
      };
    }

    dependencies.freezeToolInput(event.input);
  });
}
