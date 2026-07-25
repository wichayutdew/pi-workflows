import type { WorkflowStep } from '../../config/types.ts';
import type { ChildStepPolicy } from './child-policy-types.ts';

/**
 * Projects a delegated policy into the workflow step shape used by policy
 * authorization.
 */
export const childPolicyStep = (policy: ChildStepPolicy): WorkflowStep => ({
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
});

/**
 * Builds the deterministic system prompt that describes the active child
 * policy.
 */
export const childSystemPrompt = (policy: ChildStepPolicy): string => {
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
};
