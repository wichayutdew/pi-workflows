import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { LoadedWorkflow, WorkflowStep } from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';
import { allowedOutcomes } from '../engine/transitions.ts';
import { digest } from '../digest.ts';
import { deriveSubagentSessionRoot } from '../integrations/subagents/diagnostics.ts';
import {
  encodeChildPolicy,
  type ChildStepPolicy,
  type SubagentDelegationRequest,
} from '../integrations/subagents/protocol.ts';
import { automaticRecoveryTask, buildDelegatedStepTask } from '../prompt.ts';
import { WORKFLOW_COMPLETION_PARAMETERS } from '../runtime/completion-tool.ts';
import { MAX_DELEGATION_RECOVERY_ATTEMPTS } from './delegation-retry-policy.ts';
import type { WorkflowHarnessDependencies } from './dependencies.ts';
import type { ActiveDelegation, DelegationRecovery } from './types.ts';

type DelegationPlanInput = {
  workflow: LoadedWorkflow;
  run: WorkflowRun;
  step: WorkflowStep;
  sessionEpoch: number;
  latestContext: ExtensionContext | undefined;
  recovery: DelegationRecovery | undefined;
};

export type DelegationPlan =
  | {
      kind: 'invalid';
      reason: string;
    }
  | {
      kind: 'ready';
      active: ActiveDelegation;
      request: SubagentDelegationRequest;
    };

function delegationTranscriptBinding(
  requestId: string,
  policyDigest: string,
): string {
  return `<pi-workflows-delegation-binding-v1>${requestId}:${policyDigest}</pi-workflows-delegation-binding-v1>`;
}

/**
 * Creates one immutable subagent request from workflow state and injected
 * identity/workspace effects.
 */
export function createDelegationPlan(
  input: DelegationPlanInput,
  dependencies: Pick<
    WorkflowHarnessDependencies,
    | 'createDelegationWorkspace'
    | 'createRequestId'
    | 'resolveWorkspaceDirectory'
  >,
): DelegationPlan {
  const { workflow, run, step, latestContext, recovery } = input;
  const subagent = step.subagent;
  if (!subagent) {
    return {
      kind: 'invalid',
      reason: `Step "${run.currentStepId}" has no subagent configuration`,
    };
  }
  if (!run.cwd) {
    return {
      kind: 'invalid',
      reason:
        'Workflow run has no captured working directory; abort it and start a new run',
    };
  }
  if (!run.startCwd || !latestContext?.cwd) {
    return {
      kind: 'invalid',
      reason:
        'Workflow start directory or current session directory is unavailable; abort it and start a new run',
    };
  }

  let canonicalStartCwd: string;
  let canonicalSessionCwd: string;
  try {
    canonicalStartCwd = dependencies.resolveWorkspaceDirectory({
      candidateCwd: run.startCwd,
      startCwd: run.startCwd,
      allowedRoots: ['.'],
    });
    canonicalSessionCwd = dependencies.resolveWorkspaceDirectory({
      candidateCwd: latestContext.cwd,
      startCwd: latestContext.cwd,
      allowedRoots: ['.'],
    });
  } catch (error) {
    return {
      kind: 'invalid',
      reason: `Workflow start directory is no longer valid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (
    canonicalStartCwd !== run.startCwd ||
    canonicalSessionCwd !== canonicalStartCwd
  ) {
    return {
      kind: 'invalid',
      reason:
        'Current session cwd does not match the captured workflow start directory',
    };
  }

  let delegationCwd = run.cwd;
  const bindingEntry = [...run.history]
    .reverse()
    .find((entry) => entry.workspaceCwd !== undefined);
  if (!bindingEntry && run.cwd !== run.startCwd) {
    return {
      kind: 'invalid',
      reason:
        'Workflow cwd differs from its start directory without a workspace binding',
    };
  }
  if (bindingEntry) {
    const binding = workflow.definition.steps[bindingEntry.stepId]?.workspace;
    if (!binding || !run.startCwd || bindingEntry.workspaceCwd !== run.cwd) {
      return {
        kind: 'invalid',
        reason:
          'Workflow workspace binding no longer matches its persisted configuration',
      };
    }
    try {
      delegationCwd = dependencies.resolveWorkspaceDirectory({
        candidateCwd: run.cwd,
        startCwd: run.startCwd,
        allowedRoots: binding.allowedRoots,
      });
    } catch (error) {
      return {
        kind: 'invalid',
        reason: `Workflow workspace is no longer valid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (delegationCwd !== run.cwd) {
      return {
        kind: 'invalid',
        reason:
          'Workflow workspace no longer resolves to the bound canonical directory',
      };
    }
  }
  const requestId =
    `${run.runId}:${run.currentStepId}:` + dependencies.createRequestId();
  const workspace = dependencies.createDelegationWorkspace();
  const outcomes = allowedOutcomes(workflow, run);
  const outcomeSet = new Set(outcomes);
  const policyDigest = digest({
    version: 1,
    requestId,
    agent: subagent.agent,
    runId: run.runId,
    stepId: run.currentStepId,
    stepDigest: run.currentStepDigest,
    cwd: delegationCwd,
    capabilityPath: workspace.capabilityPath,
    resultPath: workspace.resultPath,
    permissions: step.permissions,
    outcomes,
    ...(step.workspace ? { workspace: step.workspace } : {}),
  });
  const policy: ChildStepPolicy = {
    version: 1,
    requestId,
    agent: subagent.agent,
    workflowId: workflow.definition.id,
    runId: run.runId,
    stepId: run.currentStepId,
    stepTitle: step.title,
    cwd: delegationCwd,
    policyDigest,
    capabilityPath: workspace.capabilityPath,
    capabilityToken: workspace.capabilityToken,
    resultPath: workspace.resultPath,
    permissions: structuredClone(step.permissions),
    outcomes,
    pauseOutcomes: Object.entries(step.transitions)
      .filter(
        ([outcome, target]) => target === '$pause' && outcomeSet.has(outcome),
      )
      .map(([outcome]) => outcome),
    summaryMaxChars: workflow.definition.summaryMaxChars,
    ...(step.gate ? { gateSubmitOutcome: step.gate.submitOutcome } : {}),
    ...(step.workspace ? { workspace: structuredClone(step.workspace) } : {}),
  };
  const trustedSessionRoot = deriveSubagentSessionRoot(
    latestContext.sessionManager.getSessionFile(),
  );
  const transcriptTask = [
    buildDelegatedStepTask(workflow, run, ''),
    delegationTranscriptBinding(requestId, policyDigest),
    ...(recovery
      ? [
          automaticRecoveryTask(
            recovery.failures.map(({ reason }) => reason),
            recovery.attempt,
            MAX_DELEGATION_RECOVERY_ATTEMPTS,
          ),
        ]
      : []),
  ].join('\n\n');
  const active: ActiveDelegation = {
    requestId,
    runId: run.runId,
    stepId: run.currentStepId,
    stepDigest: run.currentStepDigest,
    sessionEpoch: input.sessionEpoch,
    resultDirectory: workspace.resultDirectory,
    policy,
    transcriptTask,
    agent: subagent.agent,
    ...(trustedSessionRoot ? { trustedSessionRoot } : {}),
    broadRecoveryAuthorized: subagent.retryToolFailures,
    recoveryAttemptCount: recovery?.attempt ?? 0,
    recoveryFailures: recovery?.failures ?? [],
  };
  const request: SubagentDelegationRequest = {
    version: 1,
    requestId,
    agent: subagent.agent,
    task: `${encodeChildPolicy(policy)}\n\n${transcriptTask}`,
    // Workflow steps are isolation boundaries. Parent/sibling transcripts are
    // replaced by the explicit workflow handoff.
    context: 'fresh',
    cwd: delegationCwd,
    timeoutMs: subagent.timeoutMs,
    skill:
      step.permissions.skills.length > 0 ? [...step.permissions.skills] : false,
    output: false,
    // TypeBox schemas are structurally JSON objects, but the upstream contract
    // exposes a generic record.
    outputSchema: WORKFLOW_COMPLETION_PARAMETERS as unknown as Record<
      string,
      unknown
    >,
    agentContract: { version: 1 },
    artifacts: subagent.artifacts,
    ...(subagent.model ? { model: subagent.model } : {}),
    ...(subagent.turnBudget
      ? { turnBudget: structuredClone(subagent.turnBudget) }
      : {}),
    ...(subagent.toolBudget
      ? {
          toolBudget: {
            hard: subagent.toolBudget.hard,
            ...(subagent.toolBudget.soft === undefined
              ? {}
              : { soft: subagent.toolBudget.soft }),
            ...(subagent.toolBudget.block === undefined
              ? {}
              : {
                  block:
                    subagent.toolBudget.block === '*'
                      ? '*'
                      : [...subagent.toolBudget.block],
                }),
          },
        }
      : {}),
  };

  return { kind: 'ready', active, request };
}
