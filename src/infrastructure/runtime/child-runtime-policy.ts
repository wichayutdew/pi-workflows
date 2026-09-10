import type { ChildStepPolicy, WorkflowStep } from '../../domain/index.ts';

/**
 * Projects a delegated policy into the workflow step shape used by policy
 * authorization.
 */
export const childPolicyStep = (policy: ChildStepPolicy): WorkflowStep => ({
  title: policy.stepTitle,
  prompt: { file: 'delegated-step.md' },
  agent: { name: policy.agent },
  permissions: policy.permissions,
  transitions: {},
  ...(policy.workspace ? { workspace: policy.workspace } : {}),
});

/**
 * Builds the deterministic system prompt that describes the active child
 * policy.
 */
export const childSystemPrompt = (policy: ChildStepPolicy): string => {
  return [
    '# Pi Workflows delegated step',
    '',
    `Workflow: ${policy.workflowId}`,
    `Run: ${policy.runId}`,
    `Step: ${policy.stepId} (${policy.stepTitle})`,
    '',
    'The parent workflow harness owns orchestration and state transitions.',
    'Perform only this delegated step. Its child-side tool policy is enforced.',
    'Do not launch subagents while executing this declarative workflow step.',
    'Use `blocked` only when progress requires user-provided information, a decision, authority, credentials, or approval.',
    'Use `handoff` when actionable work remains without a user question; use `gaps` when an earlier configured step must refresh requirements.',
    'Do not open a skill unless this step YAML lists that skill.',
    'When finished, call `structured_output` exactly once and as the only tool call in that message.',
    'Pass the workflow result as its `value`: outcome, completed, remaining, plus artifact or workspace only when required below.',
    `Valid outcomes: ${policy.outcomes.join(', ')}`,
    `Pause outcomes: ${policy.pauseOutcomes.join(', ') || '(none)'}`,
    `Summary limit: ${policy.summaryMaxChars} characters`,
    "Evaluate completion and choose an outcome using only this delegated step's instructions.",
    'A later workflow step is not unfinished work in this step and never by itself requires `handoff`.',
    'Limit completed and remaining fields to this delegated step. When it is complete, use `No active-step work remains.` as the remaining item.',
    'For every outcome, provide only plain-text `completed` and `remaining` fields; each completed item must cite a concrete path, command, identifier, or user decision. Do not use Markdown, list markers, placeholders, or extra handoff fields.',
    ...(policy.outcomes.includes('ready')
      ? [
          'For `ready`, remaining must be exactly `No active-step work remains.`.',
        ]
      : []),
    ...(policy.outcomes.includes('blocked')
      ? [
          'For `blocked`, include at least one user question ending in `?` in remaining.',
        ]
      : []),
    ...(policy.outcomes.includes('handoff')
      ? [
          'For `handoff`, remaining must be non-question actionable work for this step.',
        ]
      : []),
    ...(policy.outcomes.includes('gaps')
      ? [
          'For `gaps`, remaining must be non-question actionable requirements for the configured earlier step.',
        ]
      : []),
    ...(policy.maxToolCalls === undefined
      ? []
      : [
          '',
          '## Tool-call budget',
          `Productive tool-call budget: ${policy.maxToolCalls} calls.`,
          `Handoff reserve: ${policy.handoffReserve} calls.`,
          `Total tool-call budget: ${policy.totalToolCalls} calls.`,
          'At 2 productive calls remaining, finish the active delegated step with its applicable configured outcome when possible; otherwise prepare a concise handoff for its incomplete work.',
          'Work tools are locked when the productive budget is exhausted.',
          'If you settle without a result after exhaustion, the parent workflow harness composes a contextual fallback handoff from available active-step context and your prior checkpoints.',
        ]),
    ...(policy.gateSubmitOutcome
      ? [
          `Outcome "${policy.gateSubmitOutcome}" requires the complete gate artifact.`,
        ]
      : []),
    ...(policy.workspace
      ? [
          `For the ready outcome, include workspace.cwd as an absolute directory under one allowed root relative to the run-start directory: ${policy.workspace.allowedRoots.join(', ')}`,
          'For every other outcome, omit workspace.',
        ]
      : ['This step cannot bind a workspace; omit workspace.']),
    'This is a non-interactive workflow child. Never call contact_supervisor, subagent_supervisor, or intercom.',
    'Follow the supplied step instructions when choosing one valid outcome; outcome names have no built-in domain meaning.',
  ].join('\n');
};
