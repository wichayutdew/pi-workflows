import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { WorkflowStep } from '../../config/types.ts';
import { invalidCompletionCallIds } from '../../policy/completion-batch.ts';
import { freezeToolInput } from '../../policy/immutable-input.ts';
import { authorizeToolCall, resolveActiveTools } from '../../policy/tools.ts';
import {
  WORKFLOW_COMPLETION_PARAMETERS,
  WORKFLOW_COMPLETION_TOOL,
} from '../../runtime/completion-tool.ts';
import {
  extractChildPolicy,
  isSubagentRuntimeName,
  parseDelegatedStepResult,
  type ChildStepPolicy,
} from './protocol.ts';

export const CHILD_COMPLETION_TOOL = WORKFLOW_COMPLETION_TOOL;

function policyStep(policy: ChildStepPolicy): WorkflowStep {
  return {
    title: policy.stepTitle,
    prompt: { inline: 'Delegated workflow step' },
    subagent: {
      agent: policy.agent,
      context: 'fresh',
      timeoutMs: 900_000,
      artifacts: false,
    },
    permissions: policy.permissions,
    requires: { tools: [], extensions: [], skills: [] },
    transitions: {},
  };
}

function childSystemPrompt(policy: ChildStepPolicy): string {
  return [
    '# Pi Workflows delegated step',
    '',
    `Workflow: ${policy.workflowId}`,
    `Run: ${policy.runId}`,
    `Step: ${policy.stepId} (${policy.stepTitle})`,
    '',
    'The parent workflow harness owns orchestration and state transitions.',
    'Perform only this delegated step. Its child-side tool policy is enforced.',
    'When finished, call `workflow_complete_step` exactly once and as the only tool call in that message.',
    `Valid outcomes: ${policy.outcomes.join(', ')}`,
    `Summary limit: ${policy.summaryMaxChars} characters`,
    ...(policy.gateSubmitOutcome
      ? [
          `Outcome "${policy.gateSubmitOutcome}" requires the complete gate artifact.`,
        ]
      : []),
    'If the workflow definition or environment is wrong, choose an outcome that transitions to $pause.',
  ].join('\n');
}

function writeResult(policy: ChildStepPolicy, result: unknown): void {
  if (existsSync(policy.resultPath)) {
    throw new Error('Delegated workflow step already produced a result');
  }
  const temporaryPath = `${policy.resultPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(result), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporaryPath, policy.resultPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function verifyCapability(
  policy: ChildStepPolicy,
  childAgent: string | undefined,
): void {
  if (!isSubagentRuntimeName(childAgent) || childAgent !== policy.agent) {
    throw new Error('child agent does not match the delegated workflow policy');
  }
  let actual: Buffer;
  try {
    actual = Buffer.from(readFileSync(policy.capabilityPath, 'utf8'), 'utf8');
  } catch {
    throw new Error('delegated workflow capability is missing');
  }
  const expected = Buffer.from(policy.capabilityToken, 'utf8');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('delegated workflow capability is invalid');
  }
  unlinkSync(policy.capabilityPath);
}

export interface SubagentChildRuntimeOptions {
  childAgent?: string;
}

export function registerSubagentChildRuntime(
  pi: ExtensionAPI,
  options: SubagentChildRuntimeOptions = {},
): void {
  let activePolicy: ChildStepPolicy | undefined;
  let policyError: string | undefined;
  let invalidCompletionCalls = new Set<string>();
  let effectiveTools = new Set<string>();
  let completionRegistered = false;
  const childAgent =
    options.childAgent ?? process.env.PI_SUBAGENT_CHILD_AGENT?.trim();

  const registerCompletionTool = (policy: ChildStepPolicy): void => {
    if (completionRegistered) return;
    completionRegistered = true;
    pi.registerTool({
      name: CHILD_COMPLETION_TOOL,
      label: 'Complete Delegated Workflow Step',
      description:
        'Return one validated result from a pi-workflows delegated child step',
      promptSnippet: 'Complete the delegated workflow step',
      promptGuidelines: [
        'Call workflow_complete_step alone after all delegated work is complete.',
      ],
      parameters: WORKFLOW_COMPLETION_PARAMETERS,
      executionMode: 'sequential',
      execute: async (_toolCallId, params) => {
        if (policyError) throw new Error(policyError);
        const result = parseDelegatedStepResult(
          {
            version: 1,
            policyDigest: policy.policyDigest,
            outcome: params.outcome,
            summary: params.summary,
            ...(params.artifact !== undefined
              ? { artifact: params.artifact }
              : {}),
          },
          policy,
        );
        writeResult(policy, result);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Captured workflow step outcome "${result.outcome}".`,
            },
          ],
          details: {
            workflowId: policy.workflowId,
            runId: policy.runId,
            stepId: policy.stepId,
            outcome: result.outcome,
          },
          terminate: true,
        };
      },
    });
  };

  pi.on('input', (event) => {
    let extracted;
    try {
      extracted = extractChildPolicy(event.text);
    } catch (error) {
      policyError = error instanceof Error ? error.message : String(error);
      pi.setActiveTools([]);
      return {
        action: 'transform' as const,
        text: `Delegated workflow policy is invalid: ${policyError}`,
        ...(event.images ? { images: event.images } : {}),
      };
    }
    if (!extracted) return;
    if (activePolicy) {
      policyError = 'child received more than one workflow policy';
      pi.setActiveTools([]);
      return {
        action: 'transform' as const,
        text: `Delegated workflow policy is invalid: ${policyError}`,
        ...(event.images ? { images: event.images } : {}),
      };
    }

    try {
      verifyCapability(extracted.policy, childAgent);
      const profileTools = new Set(pi.getActiveTools());
      activePolicy = extracted.policy;
      policyError = undefined;
      registerCompletionTool(activePolicy);
      effectiveTools = new Set(
        resolveActiveTools(
          pi.getAllTools(),
          policyStep(activePolicy),
          CHILD_COMPLETION_TOOL,
        ).filter(
          (toolName) =>
            toolName === CHILD_COMPLETION_TOOL || profileTools.has(toolName),
        ),
      );
    } catch (error) {
      policyError = error instanceof Error ? error.message : String(error);
      effectiveTools.clear();
      pi.setActiveTools([]);
      return {
        action: 'transform' as const,
        text: `Delegated workflow policy is invalid: ${policyError}`,
        ...(event.images ? { images: event.images } : {}),
      };
    }
    pi.setActiveTools([...effectiveTools]);
    return {
      action: 'transform' as const,
      text: extracted.task,
      ...(event.images ? { images: event.images } : {}),
    };
  });

  pi.on('before_agent_start', (event) => {
    if (!activePolicy) {
      if (policyError) pi.setActiveTools([]);
      return;
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${childSystemPrompt(activePolicy)}`,
    };
  });

  pi.on('turn_start', () => {
    invalidCompletionCalls.clear();
  });

  pi.on('message_end', (event) => {
    if (!activePolicy) return;
    const invalid = invalidCompletionCallIds(
      event.message,
      CHILD_COMPLETION_TOOL,
    );
    if (
      invalid.size > 0 ||
      (event.message as { role?: unknown }).role === 'assistant'
    ) {
      invalidCompletionCalls = invalid;
    }
  });

  pi.on('tool_call', (event) => {
    if (!activePolicy) {
      if (!policyError) return;
      return {
        block: true,
        reason: policyError,
      };
    }
    if (invalidCompletionCalls.has(event.toolCallId)) {
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
      freezeToolInput(event.input);
      return;
    }
    if (!effectiveTools.has(event.toolName)) {
      return {
        block: true,
        reason: `tool "${event.toolName}" is not enabled by subagent "${childAgent ?? 'unknown'}"`,
      };
    }

    const authorization = authorizeToolCall(
      event.toolName,
      event.input as unknown as Record<string, unknown>,
      policyStep(activePolicy),
      pi.getAllTools(),
      activePolicy.approvedBashCommands ?? [],
    );
    if (!authorization.allowed) {
      return {
        block: true,
        reason: authorization.reason ?? 'Tool blocked by workflow child policy',
      };
    }
    freezeToolInput(event.input);
  });
}
