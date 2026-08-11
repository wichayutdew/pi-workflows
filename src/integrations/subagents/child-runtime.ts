import type {
  ExtensionAPI,
  InputEvent,
  InputEventResult,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { invalidCompletionCallIds } from '../../policy/completion-batch.ts';
import { freezeToolInput } from '../../policy/immutable-input.ts';
import { authorizeToolCall, resolveActiveTools } from '../../policy/tools.ts';
import {
  CHILD_COMPLETION_TOOL,
  CHILD_COORDINATION_TOOLS,
  parseChildStructuredResult,
} from './child-runtime-completion.ts';
import { DEFAULT_CHILD_RUNTIME_DEPENDENCIES } from './child-runtime-dependencies.ts';
import {
  verifyChildCapability,
  verifyChildWorkingDirectory,
  writeChildResult,
} from './child-runtime-files.ts';
import { childPolicyStep, childSystemPrompt } from './child-runtime-policy.ts';
import type {
  SubagentChildRuntimeDependencies,
  SubagentChildRuntimeOptions,
} from './child-runtime-types.ts';
import { extractChildPolicy } from './child-policy-envelope.ts';
import type { ChildStepPolicy } from './child-policy-types.ts';

export { CHILD_COMPLETION_TOOL } from './child-runtime-completion.ts';
export type {
  ChildRuntimeFileSystem,
  ChildRuntimePathInspection,
  SubagentChildRuntimeDependencies,
  SubagentChildRuntimeOptions,
} from './child-runtime-types.ts';

type ChildRuntimeState = {
  readonly activePolicy: ChildStepPolicy | undefined;
  readonly policyError: string | undefined;
  readonly invalidCompletionCalls: ReadonlySet<string>;
  readonly effectiveTools: ReadonlySet<string>;
};

const INITIAL_STATE: ChildRuntimeState = {
  activePolicy: undefined,
  policyError: undefined,
  invalidCompletionCalls: new Set(),
  effectiveTools: new Set(),
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const invalidPolicyInput = (
  pi: ExtensionAPI,
  policyError: string,
  images: InputEvent['images'],
): InputEventResult => {
  pi.setActiveTools([]);
  return {
    action: 'transform' as const,
    text: `Delegated workflow policy is invalid: ${policyError}`,
    ...(images ? { images } : {}),
  };
};

const resolveChildAgent = (
  options: SubagentChildRuntimeOptions,
  dependencies: SubagentChildRuntimeDependencies,
): string | undefined =>
  options.childAgent ?? dependencies.environmentChildAgent();

/**
 * Registers the policy-enforcing runtime used inside a delegated subagent.
 *
 * All file-system, identity, process, and capability-comparison boundaries can
 * be supplied through `options.dependencies`.
 */
export const registerSubagentChildRuntime = (
  pi: ExtensionAPI,
  options: SubagentChildRuntimeOptions = {},
): void => {
  const dependencies =
    options.dependencies ?? DEFAULT_CHILD_RUNTIME_DEPENDENCIES;
  const childAgent = resolveChildAgent(options, dependencies);
  let state = INITIAL_STATE;

  pi.registerTool({
    name: CHILD_COMPLETION_TOOL,
    label: 'Complete Workflow Step',
    description: 'Return the one structured result for this workflow step',
    parameters: Type.Object({ value: Type.Any() }),
    executionMode: 'sequential',
    execute: async () => ({
      content: [
        { type: 'text' as const, text: 'Captured workflow step result.' },
      ],
      details: {},
      terminate: true,
    }),
  });

  pi.on('input', (event) => {
    let extracted;
    try {
      extracted = extractChildPolicy(event.text, {
        temporaryDirectory: dependencies.temporaryDirectory,
      });
    } catch (error) {
      const policyError = errorMessage(error);
      state = { ...state, policyError };
      return invalidPolicyInput(pi, policyError, event.images);
    }
    if (!extracted) return;
    if (state.activePolicy) {
      const policyError = 'child received more than one workflow policy';
      state = { ...state, policyError };
      return invalidPolicyInput(pi, policyError, event.images);
    }

    try {
      if (!childAgent) throw new Error('workflow worker agent is unavailable');
      verifyChildWorkingDirectory(extracted.policy, dependencies);
      verifyChildCapability({
        policy: extracted.policy,
        childAgent,
        dependencies,
      });
      const profileTools = new Set(pi.getActiveTools());
      if (!profileTools.has(CHILD_COMPLETION_TOOL)) {
        throw new Error('workflow worker completion tool is unavailable');
      }
      const effectiveTools = new Set(
        resolveActiveTools(
          pi.getAllTools(),
          childPolicyStep(extracted.policy),
          CHILD_COMPLETION_TOOL,
        ).filter((toolName) => !CHILD_COORDINATION_TOOLS.has(toolName)),
      );
      state = {
        ...state,
        activePolicy: extracted.policy,
        policyError: undefined,
        effectiveTools,
      };
    } catch (error) {
      const policyError = errorMessage(error);
      state = {
        ...state,
        policyError,
        effectiveTools: new Set(),
      };
      return invalidPolicyInput(pi, policyError, event.images);
    }

    pi.setActiveTools([...state.effectiveTools]);
    return {
      action: 'transform' as const,
      text: extracted.task,
      ...(event.images ? { images: event.images } : {}),
    };
  });

  pi.on('before_agent_start', (event) => {
    if (!state.activePolicy) {
      if (state.policyError) pi.setActiveTools([]);
      return;
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${childSystemPrompt(state.activePolicy)}`,
    };
  });

  pi.on('turn_start', () => {
    state = { ...state, invalidCompletionCalls: new Set() };
  });

  pi.on('message_end', (event) => {
    if (!state.activePolicy) return;
    const invalid = invalidCompletionCallIds(
      event.message,
      CHILD_COMPLETION_TOOL,
    );
    if (invalid.size > 0 || event.message.role === 'assistant') {
      state = { ...state, invalidCompletionCalls: invalid };
    }
  });

  pi.on('tool_call', (event) => {
    const { activePolicy, policyError } = state;
    if (!activePolicy) {
      if (!policyError) return;
      return {
        block: true,
        reason: policyError,
      };
    }
    if (state.invalidCompletionCalls.has(event.toolCallId)) {
      return {
        block: true,
        reason: `${CHILD_COMPLETION_TOOL} must be the only tool call in its message`,
      };
    }
    if (event.toolName === CHILD_COMPLETION_TOOL) {
      if (policyError) {
        return {
          block: true,
          reason: policyError,
        };
      }
      try {
        const result = parseChildStructuredResult({
          input: event.input,
          policy: activePolicy,
        });
        writeChildResult({
          policy: activePolicy,
          result,
          dependencies,
        });
        freezeToolInput(event.input);
        return;
      } catch (error) {
        return {
          block: true,
          reason: errorMessage(error),
        };
      }
    }
    if (CHILD_COORDINATION_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason:
          'workflow children are non-interactive; follow the step prompt and use structured_output with one configured valid outcome',
      };
    }

    const input: Record<string, unknown> = { ...event.input };
    const authorization = authorizeToolCall(
      event.toolName,
      input,
      childPolicyStep(activePolicy),
      pi.getAllTools(),
    );
    if (!authorization.allowed) {
      return {
        block: true,
        reason: authorization.reason ?? 'Tool blocked by workflow child policy',
      };
    }
    if (!state.effectiveTools.has(event.toolName)) {
      return {
        block: true,
        reason: `tool "${event.toolName}" is allowed by the workflow but unavailable in this child runtime`,
      };
    }

    freezeToolInput(event.input);
  });
};
