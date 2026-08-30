import type { WorkflowStep } from '../../config/types.ts';
import type { ChildStepPolicy } from './child-policy-types.ts';

/**
 * Projects a delegated policy into the workflow step shape used by policy
 * authorization.
 */
export const childPolicyStep = (policy: ChildStepPolicy): WorkflowStep => ({
  title: policy.stepTitle,
  prompt: { inline: 'Delegated workflow step' },
  agent: { name: policy.agent },
  permissions: policy.permissions,
  requires: { tools: [], extensions: [], skills: [] },
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
    'Use `retry` only for a transient failure that can be retried without new user input.',
    'Do not open a skill unless this step YAML lists that skill.',
    'When finished, call `structured_output` exactly once and as the only tool call in that message.',
    'Pass the workflow result as its `value`: outcome, summary, optional artifact, and workspace only when required below.',
    `Valid outcomes: ${policy.outcomes.join(', ')}`,
    `Pause outcomes: ${policy.pauseOutcomes.join(', ') || '(none)'}`,
    `Summary limit: ${policy.summaryMaxChars} characters`,
    ...(policy.maxToolCalls === undefined
      ? []
      : [
          '',
          '## Tool-call budget',
          `Productive tool-call budget: ${policy.maxToolCalls} calls.`,
          `Handoff reserve: ${policy.handoffReserve} calls.`,
          `Total tool-call budget: ${policy.totalToolCalls} calls.`,
          'At 2 productive calls remaining, prepare a concise handoff with completed work, current state, remaining work, and any blocker.',
          'Work tools are locked when the productive budget is exhausted.',
          'If the child settles without a result after exhaustion, the extension writes the configured `handoff` structured result.',
        ]),
    ...(policy.gateSubmitOutcome
      ? [
          `Outcome "${policy.gateSubmitOutcome}" requires the complete gate artifact.`,
        ]
      : []),
    ...(policy.workspace
      ? [
          `Workspace-binding outcomes: ${policy.workspace.bindOn.join(', ')}`,
          `For those outcomes, include workspace.cwd as an absolute directory under one allowed root relative to the run-start directory: ${policy.workspace.allowedRoots.join(', ')}`,
          'For every other outcome, omit workspace.',
        ]
      : ['This step cannot bind a workspace; omit workspace.']),
    'This is a non-interactive workflow child. Never call contact_supervisor, subagent_supervisor, or intercom.',
    'Follow the supplied step instructions when choosing one valid outcome; outcome names have no built-in domain meaning.',
  ].join('\n');
};
