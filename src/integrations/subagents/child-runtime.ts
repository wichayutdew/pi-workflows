import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { WorkflowStep } from '../../config/types.ts';
import { invalidCompletionCallIds } from '../../policy/completion-batch.ts';
import { freezeToolInput } from '../../policy/immutable-input.ts';
import { authorizeToolCall, resolveActiveTools } from '../../policy/tools.ts';
import {
  extractChildPolicy,
  isSubagentRuntimeName,
  parseDelegatedStepResult,
  type ChildStepPolicy,
} from './protocol.ts';

export const CHILD_COMPLETION_TOOL = 'structured_output';
const CHILD_COORDINATION_TOOLS = new Set([
  'contact_supervisor',
  'subagent_supervisor',
  'intercom',
]);
const STRUCTURED_RESULT_KEYS = new Set(['outcome', 'summary', 'artifact']);
const FILE_MUTATION_TOOLS = new Set(['edit', 'write']);

function policyStep(policy: ChildStepPolicy): WorkflowStep {
  return {
    title: policy.stepTitle,
    prompt: { inline: 'Delegated workflow step' },
    subagent: {
      agent: policy.agent,
      context: 'fresh',
      timeoutMs: 900_000,
      artifacts: false,
      retryToolFailures: false,
    },
    permissions: policy.permissions,
    requires: { tools: [], extensions: [], skills: [] },
    transitions: {},
  };
}

function childSystemPrompt(policy: ChildStepPolicy): string {
  const hasPauseOutcome = policy.pauseOutcomes.length > 0;
  return [
    '# Pi Workflows delegated step',
    '',
    `Workflow: ${policy.workflowId}`,
    `Run: ${policy.runId}`,
    `Step: ${policy.stepId} (${policy.stepTitle})`,
    '',
    'The parent workflow harness owns orchestration and state transitions.',
    'Perform only this delegated step. Its child-side tool policy is enforced.',
    'When finished, call `structured_output` exactly once and as the only tool call in that message.',
    'Pass the workflow result as its `value`: outcome, summary, and optional artifact.',
    `Valid outcomes: ${policy.outcomes.join(', ')}`,
    `Pause outcomes: ${policy.pauseOutcomes.join(', ') || '(none)'}`,
    `Summary limit: ${policy.summaryMaxChars} characters`,
    ...(policy.gateSubmitOutcome
      ? [
          `Outcome "${policy.gateSubmitOutcome}" requires the complete gate artifact.`,
        ]
      : []),
    ...(hasPauseOutcome
      ? [
          `If the workflow definition or environment is wrong, choose a pause outcome (${policy.pauseOutcomes.join(', ')}).`,
        ]
      : [
          'If the workflow definition or environment is wrong, do not fabricate success or call the completion tool; end with a concise declarative error so the parent pauses the step.',
        ]),
    'This is a non-interactive workflow child. Never call contact_supervisor, subagent_supervisor, or intercom.',
    ...(policy.gateSubmitOutcome
      ? [
          'Put every unresolved decision in the gate artifact with evidence, options, a recommendation, and an adopted default; do not ask a terminal question.',
        ]
      : hasPauseOutcome
        ? [
            'Treat the step instructions and incoming handoff as the final execution contract.',
            'If that contract is missing, stale, or contradictory, finish with a pause outcome and describe the unresolved contract and evidence declaratively in the summary; do not ask a terminal question.',
          ]
        : [
            'Treat the step instructions and incoming handoff as the final execution contract.',
            'If that contract is missing, stale, or contradictory, do not fabricate success or call the completion tool; end with a concise declarative error so the parent pauses the step. Do not ask a terminal question.',
          ]),
    ...(policy.repositoryCwd
      ? [
          `Reviewed repository root: ${policy.repositoryCwd}`,
          ...(policy.bootstrapCwd
            ? [
                `Bootstrap directory: ${policy.bootstrapCwd}`,
                'The reviewed repository root does not exist yet. Run only its exact approved setup command first, then use absolute paths under the reviewed repository root for every edit and write. Never mutate the bootstrap directory.',
              ]
            : [
                'Keep every edit and write inside the reviewed repository root.',
              ]),
        ]
      : []),
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

function structuredResult(
  input: unknown,
  policy: ChildStepPolicy,
): ReturnType<typeof parseDelegatedStepResult> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('structured_output input must be an object');
  }
  const wrapper = input as Record<string, unknown>;
  if (Object.keys(wrapper).length !== 1 || !Object.hasOwn(wrapper, 'value')) {
    throw new Error('structured_output input must contain only value');
  }
  if (
    wrapper.value === null ||
    typeof wrapper.value !== 'object' ||
    Array.isArray(wrapper.value)
  ) {
    throw new Error('structured_output value must be an object');
  }
  const value = wrapper.value as Record<string, unknown>;
  const unknownKey = Object.keys(value).find(
    (key) => !STRUCTURED_RESULT_KEYS.has(key),
  );
  if (unknownKey) {
    throw new Error(
      `structured_output value has unknown property "${unknownKey}"`,
    );
  }
  return parseDelegatedStepResult(
    {
      version: 1,
      policyDigest: policy.policyDigest,
      ...value,
    },
    policy,
  );
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

function authorizeRepositoryMutation(
  toolName: string,
  input: Record<string, unknown>,
  policy: ChildStepPolicy,
): string | undefined {
  if (!policy.repositoryCwd || !FILE_MUTATION_TOOLS.has(toolName)) return;
  if (typeof input.path !== 'string' || !input.path.trim()) {
    return `${toolName} must name a path inside the reviewed repository root`;
  }
  const candidate = resolve(process.cwd(), input.path);
  const root = resolve(policy.repositoryCwd);
  if (!pathIsInside(root, candidate)) {
    return `${toolName} path is outside the reviewed repository root "${policy.repositoryCwd}"`;
  }
  let canonicalRoot: string;
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
    canonicalRoot = realpathSync(root);
  } catch {
    return `reviewed repository root is not an existing directory: ${policy.repositoryCwd}`;
  }
  const canonicalAncestor = nearestCanonicalAncestor(candidate);
  if (
    canonicalAncestor === undefined ||
    !pathIsInside(canonicalRoot, canonicalAncestor)
  ) {
    return `${toolName} path is outside the reviewed repository root "${policy.repositoryCwd}"`;
  }
  return;
}

function pathIsInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function nearestCanonicalAncestor(path: string): string | undefined {
  let candidate = path;
  while (true) {
    try {
      lstatSync(candidate);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 'ENOENT') return undefined;
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
      continue;
    }
    try {
      return realpathSync(candidate);
    } catch {
      return undefined;
    }
  }
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
  const childAgent =
    options.childAgent ?? process.env.PI_SUBAGENT_CHILD_AGENT?.trim();

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
      if (!profileTools.has(CHILD_COMPLETION_TOOL)) {
        throw new Error(
          'pi-subagents structured_output completion is unavailable',
        );
      }
      activePolicy = extracted.policy;
      policyError = undefined;
      effectiveTools = new Set(
        resolveActiveTools(
          pi.getAllTools(),
          policyStep(activePolicy),
          CHILD_COMPLETION_TOOL,
        ).filter((toolName) => !CHILD_COORDINATION_TOOLS.has(toolName)),
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
      try {
        const result = structuredResult(event.input, activePolicy);
        writeResult(activePolicy, result);
        freezeToolInput(event.input);
        return;
      } catch (error) {
        return {
          block: true,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (CHILD_COORDINATION_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason:
          'workflow children are non-interactive; use structured_output with a pause outcome and describe the unresolved contract in summary',
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
    if (!effectiveTools.has(event.toolName)) {
      return {
        block: true,
        reason: `tool "${event.toolName}" is allowed by the workflow but unavailable in this child runtime`,
      };
    }

    const mutationError = authorizeRepositoryMutation(
      event.toolName,
      event.input as unknown as Record<string, unknown>,
      activePolicy,
    );
    if (mutationError) {
      return {
        block: true,
        reason: mutationError,
      };
    }
    freezeToolInput(event.input);
  });
}
