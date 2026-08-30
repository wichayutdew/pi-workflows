import { describe, expect, test } from 'bun:test';
import type { LoadedWorkflow } from '../src/config/types.ts';
import { advanceRun } from '../src/engine/transitions.ts';
import { createRun, type WorkflowRun } from '../src/engine/state.ts';
import type { HarnessActionContext } from '../src/harness/action-context.ts';
import { createDelegationResponseActions } from '../src/harness/delegation-response-actions.ts';
import type { ActiveDelegation } from '../src/harness/types.ts';
import type { ChildStepPolicy } from '../src/integrations/subagents/protocol.ts';
import type { SubagentDelegationResponse } from '../src/integrations/subagents/protocol.ts';
import { baseWorkflow, loadedWorkflow } from './helpers.ts';

const APPROVED_PLAN =
  '## Approved plan\n1. Implement feature X\n2. Implement feature Y\n3. Implement feature Z';
const ORIGINAL_REQUEST =
  'Original user request: implement the plan-driven worker handoffs feature.';
const PREVIOUS_CHECKPOINT =
  'Checkpoint: feature X is complete and verified; remaining work is feature Y and feature Z.';
const REPOSITORY_STATE_SNAPSHOT = 'HEAD: abc123\nDirty state: M src/index.ts';

function handoffCapableWorkflow(): LoadedWorkflow {
  const raw = baseWorkflow();
  const steps = raw.steps as Record<string, Record<string, unknown>>;
  const implement = steps.implement!;
  implement.transitions = {
    ...(implement.transitions as Record<string, string>),
    handoff: 'implement',
  };
  return loadedWorkflow(raw);
}

function runAtImplementStep(workflow: LoadedWorkflow): WorkflowRun {
  const created = createRun(
    workflow,
    ORIGINAL_REQUEST,
    ['read', 'edit'],
    'run-1',
    1,
    '/workspace/run',
  );
  const advanced = advanceRun(
    workflow,
    created,
    'ready',
    PREVIOUS_CHECKPOINT,
    2,
  );
  return { ...advanced, reviewedArtifact: APPROVED_PLAN };
}

function buildActiveDelegation(run: WorkflowRun): ActiveDelegation {
  const policy: ChildStepPolicy = {
    version: 1,
    requestId: `${run.runId}:${run.currentStepId}:child-1`,
    agent: 'worker',
    workflowId: run.workflowId,
    runId: run.runId,
    stepId: run.currentStepId,
    stepTitle: 'Implement approved plan with TDD',
    cwd: '/workspace/run',
    policyDigest: 'policy-digest-1',
    capabilityPath: '/tmp/pi-workflows-test-enoent/capability',
    capabilityToken: 'a'.repeat(64),
    resultPath: '/tmp/pi-workflows-test-enoent/result.json',
    permissions: {
      tools: ['read', 'edit'],
      mcp: [],
      extensions: [],
      skills: [],
      bash: { mode: 'deny', allow: [] },
    },
    outcomes: ['done', 'handoff'],
    pauseOutcomes: [],
    summaryMaxChars: 4000,
  };
  return {
    requestId: policy.requestId,
    runId: run.runId,
    stepId: run.currentStepId,
    stepDigest: run.currentStepDigest,
    sessionEpoch: 5,
    resultDirectory: '/tmp/pi-workflows-test-enoent',
    policy,
    transcriptTask: 'Implement the approved plan.',
    agent: 'worker',
  };
}

describe('when a delegated child settles without a correlated result', () => {
  test('records a durable handoff with the approved plan, request, prior checkpoint, diagnostic, and repository state', async () => {
    const workflow = handoffCapableWorkflow();
    const run = runAtImplementStep(workflow);
    const active = buildActiveDelegation(run);
    const response: SubagentDelegationResponse = {
      requestId: active.requestId,
      agent: 'worker',
      status: 'completed',
      diagnostic: {
        settled: true,
        truncated: false,
        calls: [{ id: 'edit-1', name: 'edit', state: 'completed' }],
      },
    };

    const calls = {
      cleanupCount: 0,
      paused: [] as Array<string>,
      persisted: 0,
      settled: [] as Array<{
        stepId: string;
        outcome: string;
        summary: string;
      }>,
      updates: 0,
      inspectedCwd: [] as Array<string>,
    };

    const fixture = {
      activeDelegation: active,
      catalog: {
        workflows: new Map([[workflow.definition.id, workflow]]),
      },
      cleanupDelegation: async () => {
        calls.cleanupCount += 1;
      },
      dependencies: {
        now: () => 100,
        readDelegatedResult: async () => {
          throw Object.assign(new Error('result file is missing'), {
            code: 'ENOENT',
          });
        },
        inspectRepositoryState: (cwd: string) => {
          calls.inspectedCwd.push(cwd);
          return REPOSITORY_STATE_SNAPSHOT;
        },
      },
      finishDelegation: async () => undefined,
      isSessionActive: true,
      latestContext: undefined,
      launchCurrentStep: () => {
        throw new Error('must not retry an unsafe diagnostic');
      },
      mutationQueue: {
        run: async <T>(operation: () => Promise<T> | T) => operation(),
      },
      pauseForDelegationFailure: (reason: string) => {
        calls.paused.push(reason);
      },
      persist: () => {
        calls.persisted += 1;
      },
      releaseMainAfterCancellation: () => undefined,
      retainUnconfirmedDelegation: () => undefined,
      run,
      sessionEpoch: 5,
      settleAfterTransition: (
        _workflow: LoadedWorkflow,
        report: { stepId: string; outcome: string; summary: string },
      ) => {
        calls.settled.push(report);
      },
      subagents: { activeRequestId: undefined },
      submitGate: async () => undefined,
      updateStatus: () => {
        calls.updates += 1;
      },
    };

    const actions = createDelegationResponseActions();
    await actions.finishDelegation.call(
      fixture as unknown as HarnessActionContext,
      active,
      response,
    );

    expect(calls.paused).toEqual([]);
    expect(calls.cleanupCount).toBe(1);
    expect(calls.inspectedCwd).toEqual(['/workspace/run']);
    expect(calls.settled).toHaveLength(1);
    expect(calls.settled[0]).toMatchObject({
      stepId: 'implement',
      outcome: 'handoff',
    });

    const summary = calls.settled[0]!.summary;
    expect(summary).toContain(
      '# Handoff: Delegated child ended without a confirmed result.',
    );
    expect(summary).toContain('No new feature is confirmed complete.');
    expect(summary).toContain(APPROVED_PLAN);
    expect(summary).toContain(ORIGINAL_REQUEST);
    expect(summary).toContain(PREVIOUS_CHECKPOINT);
    expect(summary).toContain('settled=true, truncated=false, calls=1');
    expect(summary).toContain(REPOSITORY_STATE_SNAPSHOT);
    expect(summary).toContain(
      'worker did not produce its required structured result.',
    );
    expect(summary).toContain(
      '**Next:** Reconcile the worktree, then implement the next unconfirmed plan-backed feature.',
    );

    expect(fixture.run.status).toBe('running');
    expect(fixture.run.currentStepId).toBe('implement');
    expect(fixture.run.stepHandoff).toContain(PREVIOUS_CHECKPOINT);
    expect(fixture.run.stepHandoff).toContain('Latest handoff:');
    expect(fixture.run.stepHandoff).toContain(
      'No new feature is confirmed complete.',
    );
  });
});
