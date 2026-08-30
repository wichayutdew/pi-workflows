import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadAgentProfile } from '../agents/profile.ts';
import type { LoadedWorkflow, WorkflowStep } from '../config/types.ts';
import type { WorkflowRun } from '../engine/state.ts';
import { allowedOutcomes } from '../engine/transitions.ts';
import { digest } from '../digest.ts';
import {
  encodeChildPolicy,
  type ChildStepPolicy,
  type SubagentDelegationRequest,
} from '../integrations/subagents/protocol.ts';
import { buildDelegatedStepTask } from '../prompt.ts';
import type { WorkflowHarnessDependencies } from './dependencies.ts';
import type { ActiveDelegation } from './types.ts';

const HANDOFF_RESERVE = 2;

type DelegationPlanInput = {
  workflow: LoadedWorkflow;
  run: WorkflowRun;
  step: WorkflowStep;
  sessionEpoch: number;
  latestContext: ExtensionContext | undefined;
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
  const { workflow, run, step, latestContext } = input;
  const agent = step.agent?.name;
  if (!agent) {
    return {
      kind: 'invalid',
      reason: `Step "${run.currentStepId}" has no agent profile`,
    };
  }
  let agentProfile;
  try {
    agentProfile = loadAgentProfile(agent);
  } catch (error) {
    return {
      kind: 'invalid',
      reason: error instanceof Error ? error.message : String(error),
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
  const toolBudget =
    step.maxToolCalls === undefined
      ? {}
      : {
          maxToolCalls: step.maxToolCalls,
          handoffReserve: HANDOFF_RESERVE,
          totalToolCalls: step.maxToolCalls + HANDOFF_RESERVE,
        };
  const policyDigest = digest({
    version: 1,
    requestId,
    agent,
    runId: run.runId,
    stepId: run.currentStepId,
    stepDigest: run.currentStepDigest,
    cwd: delegationCwd,
    capabilityPath: workspace.capabilityPath,
    resultPath: workspace.resultPath,
    permissions: step.permissions,
    outcomes,
    ...toolBudget,
    ...(step.workspace ? { workspace: step.workspace } : {}),
  });
  const policy: ChildStepPolicy = {
    version: 1,
    requestId,
    agent,
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
    ...toolBudget,
    ...(step.gate ? { gateSubmitOutcome: step.gate.submitOutcome } : {}),
    ...(step.workspace ? { workspace: structuredClone(step.workspace) } : {}),
  };
  const task = buildDelegatedStepTask(workflow, run, '');
  const active: ActiveDelegation = {
    requestId,
    runId: run.runId,
    stepId: run.currentStepId,
    stepDigest: run.currentStepDigest,
    sessionEpoch: input.sessionEpoch,
    resultDirectory: workspace.resultDirectory,
    policy,
    transcriptTask: task,
    agent,
    ...(agentProfile.model ? { model: agentProfile.model } : {}),
  };
  const request: SubagentDelegationRequest = {
    version: 1,
    requestId,
    agent,
    task: `${encodeChildPolicy(policy)}\n\n${task}`,
    cwd: delegationCwd,
    timeoutMs: 900_000,
    ...(agentProfile.model ? { model: agentProfile.model } : {}),
    ...(agentProfile.thinking ? { thinking: agentProfile.thinking } : {}),
  };

  return { kind: 'ready', active, request };
}
