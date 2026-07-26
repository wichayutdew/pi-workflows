import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { DelegationReplayAudit } from '../integrations/subagents/diagnostics.ts';
import type {
  ChildStepPolicy,
  SubagentDelegationStatus,
} from '../integrations/subagents/protocol.ts';
import type { WorkflowHarnessDependencies } from './dependencies.ts';

export type ActiveDelegation = {
  requestId: string;
  runId: string;
  stepId: string;
  stepDigest: string;
  sessionEpoch: number;
  resultDirectory: string;
  policy: ChildStepPolicy;
  transcriptTask: string;
  agent: string;
  trustedSessionRoot?: string;
  broadRecoveryAuthorized: boolean;
  recoveryAttemptCount: number;
  recoveryFailures: ReadonlyArray<DelegationRecoveryFailure>;
  progress?: string;
  cancelling?: boolean;
};

export type DelegationRecoveryBlocker =
  | 'cancelled'
  | 'detached'
  | 'inconsistent-timeout'
  | 'interrupted'
  | 'reported-mutation'
  | 'stopped';

export type DelegationFailureDetails = {
  reason: string;
  status: SubagentDelegationStatus;
  error?: string;
  exitCode?: number;
  recoveryBlocker?: DelegationRecoveryBlocker;
  diagnostic?: Awaited<
    ReturnType<WorkflowHarnessDependencies['readToolFailureDiagnostic']>
  >;
  replayAudit?: DelegationReplayAudit;
};

export type MainStepIdentity = {
  requestId: string;
  runId: string;
  stepId: string;
  stepDigest: string;
  sessionEpoch: number;
};

export type ActivePromptReview = {
  requestId: string;
  runId: string;
  stepId: string;
  sessionEpoch: number;
  abortController: AbortController;
};

export type WorkflowStartContext = {
  context: ExtensionContext;
  skills: () => ReadonlyArray<{ name: string }> | undefined;
  waitForIdle: () => Promise<void>;
};

export type DelegationRecoveryFailure = {
  readonly fingerprint: string;
  readonly reason: string;
};

export type DelegationRecovery = {
  readonly attempt: number;
  readonly failures: ReadonlyArray<DelegationRecoveryFailure>;
};
