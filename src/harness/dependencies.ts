import { randomBytes, randomUUID } from 'node:crypto';
import { constants, mkdtempSync, writeFileSync } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { loadCatalog } from '../config/load.ts';
import {
  requestPlannotatorReview,
  requestPlannotatorReviewStatus,
} from '../integrations/plannotator.ts';
import { requestPromptGateReview } from '../integrations/prompt-gate.ts';
import {
  createSubagentDelegationClient,
  type SubagentDelegationClientController,
} from '../integrations/subagents/client.ts';
import {
  auditCompletedDelegationTranscript,
  readDelegationReplayAudit,
  readToolFailureDiagnostic,
} from '../integrations/subagents/diagnostics.ts';
import {
  createMainStepRuntime,
  type MainStepRuntimeController,
} from '../runtime/main-step-runtime.ts';
import {
  createSerialTaskQueue,
  type SerialTaskQueueController,
} from '../runtime/serial-task-queue.ts';
import { showWorkflowStatus } from '../workflow-status.ts';
import type { ActiveDelegation } from './types.ts';
import {
  resolveWorkspaceDirectory,
  type ResolveWorkspaceDirectoryOptions,
} from './workspace-directory.ts';
import { flushUnwrittenSession } from './session-persistence.ts';

const MAX_DELEGATED_RESULT_BYTES = 1024 * 1024;

export type DelegationWorkspace = {
  resultDirectory: string;
  capabilityPath: string;
  capabilityToken: string;
  resultPath: string;
};

export type WorkflowHarnessDependencies = {
  readonly now: () => number;
  readonly createRequestId: () => string;
  readonly createAbortController: () => AbortController;
  readonly createDelegationWorkspace: () => DelegationWorkspace;
  readonly readDelegatedResult: (active: ActiveDelegation) => Promise<string>;
  readonly removeDelegationWorkspace: (
    resultDirectory: string,
  ) => Promise<void>;
  readonly waitForDelay: (delayMs: number) => Promise<void>;
  readonly resolveWorkspaceDirectory: (
    options: ResolveWorkspaceDirectoryOptions,
  ) => string;
  readonly loadCatalog: typeof loadCatalog;
  readonly requestPlannotatorReview: typeof requestPlannotatorReview;
  readonly requestPlannotatorReviewStatus: typeof requestPlannotatorReviewStatus;
  readonly requestPromptGateReview: typeof requestPromptGateReview;
  readonly readDelegationReplayAudit: typeof readDelegationReplayAudit;
  readonly readToolFailureDiagnostic: typeof readToolFailureDiagnostic;
  readonly auditCompletedDelegationTranscript: typeof auditCompletedDelegationTranscript;
  readonly showWorkflowStatus: typeof showWorkflowStatus;
  readonly createSubagentClient: (
    pi: ExtensionAPI,
  ) => SubagentDelegationClientController;
  readonly createMainStepRuntime: (
    pi: ExtensionAPI,
  ) => MainStepRuntimeController;
  readonly createMutationQueue: () => SerialTaskQueueController;
  /** Makes a new Pi session durable before its first assistant message. */
  readonly flushUnwrittenSession: typeof flushUnwrittenSession;
  readonly scheduleInterval: (
    operation: () => void,
    intervalMs: number,
  ) => ReturnType<typeof setInterval>;
  readonly cancelInterval: (timer: ReturnType<typeof setInterval>) => void;
};

function createDelegationWorkspace(): DelegationWorkspace {
  const resultDirectory = mkdtempSync(join(tmpdir(), 'pi-workflows-step-'));
  const capabilityPath = join(resultDirectory, 'capability');
  const capabilityToken = randomBytes(32).toString('hex');
  const resultPath = join(resultDirectory, 'result.json');
  writeFileSync(capabilityPath, capabilityToken, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return {
    resultDirectory,
    capabilityPath,
    capabilityToken,
    resultPath,
  };
}

async function readDelegatedResult(active: ActiveDelegation): Promise<string> {
  const expectedPath = join(active.resultDirectory, 'result.json');
  if (active.policy.resultPath !== expectedPath) {
    throw new Error(
      'delegated result path does not match its private directory',
    );
  }
  const inspected = await lstat(expectedPath);
  if (inspected.isSymbolicLink() || !inspected.isFile()) {
    throw new Error('delegated result is not a regular file');
  }
  const handle = await open(
    expectedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const beforeRead = await handle.stat();
    if (!beforeRead.isFile() || beforeRead.size > MAX_DELEGATED_RESULT_BYTES) {
      throw new Error('delegated result is not a bounded regular file');
    }
    const value = await handle.readFile({ encoding: 'utf8' });
    const afterRead = await handle.stat();
    if (
      afterRead.dev !== beforeRead.dev ||
      afterRead.ino !== beforeRead.ino ||
      afterRead.size !== beforeRead.size ||
      afterRead.mtimeMs !== beforeRead.mtimeMs
    ) {
      throw new Error('delegated result changed while it was being read');
    }
    return value;
  } finally {
    await handle.close();
  }
}

const DEFAULT_DEPENDENCIES: WorkflowHarnessDependencies = {
  now: () => Date.now(),
  createRequestId: randomUUID,
  createAbortController: () => new AbortController(),
  createDelegationWorkspace,
  readDelegatedResult,
  removeDelegationWorkspace: async (resultDirectory) =>
    rm(resultDirectory, { recursive: true, force: true }),
  waitForDelay: async (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
  resolveWorkspaceDirectory,
  loadCatalog,
  requestPlannotatorReview,
  requestPlannotatorReviewStatus,
  requestPromptGateReview,
  readDelegationReplayAudit,
  readToolFailureDiagnostic,
  auditCompletedDelegationTranscript,
  showWorkflowStatus,
  createSubagentClient: () => createSubagentDelegationClient(),
  createMainStepRuntime: (pi) => createMainStepRuntime({ pi }),
  createMutationQueue: createSerialTaskQueue,
  flushUnwrittenSession,
  scheduleInterval: (operation, intervalMs) =>
    setInterval(operation, intervalMs),
  cancelInterval: (timer) => {
    clearInterval(timer);
  },
};

/**
 * Builds the effect boundary used by the workflow harness.
 *
 * Callers can replace individual dependencies for deterministic tests or
 * alternate runtime integrations without changing workflow logic.
 */
export function createWorkflowHarnessDependencies(
  overrides: Partial<WorkflowHarnessDependencies> = {},
): WorkflowHarnessDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}
