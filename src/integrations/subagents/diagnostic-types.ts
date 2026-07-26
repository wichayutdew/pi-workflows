import type { BashPermission } from '../../config/types.ts';

export type ToolFailureDiagnostic = {
  readonly tool: string;
  readonly call?: string;
  readonly output?: string;
  readonly postCompletionWarning?: string;
  readonly replaySafe?: true;
  readonly completionAfterFailure?: true;
  readonly completionValue?: Readonly<Record<string, unknown>>;
  readonly transcriptToolCount?: number;
  readonly transcriptTurnCount?: number;
  readonly correlation?:
    'latest-before-completion' | 'successful-output-before-completion';
};

export type DelegationReplayAudit = {
  readonly replaySafe: boolean;
  readonly toolCount: number;
};

export type DelegationReplayExpectation = {
  readonly task: string;
  readonly bashPermission: BashPermission;
};

export type SubagentSessionIdentity = {
  readonly runId: string;
  readonly childIndex: number;
};

export type RecordedToolCall = {
  readonly id: string;
  readonly order: number;
  readonly tool: string;
  readonly call?: string;
  readonly completionValue?: Readonly<Record<string, unknown>>;
};

export type RecordedToolFailure = ToolFailureDiagnostic & {
  readonly callId?: string;
  readonly order: number;
};

export type RecordedToolSuccess = {
  readonly order: number;
  readonly tool: string;
  readonly call?: string;
  readonly output?: string;
  readonly detectorOutput?: string;
};

export type RecordedCompletion = {
  readonly order: number;
  readonly value: Readonly<Record<string, unknown>>;
};

export type RecordedTranscriptWarning = {
  readonly order: number;
  readonly content: string;
};

export type RecordedMessage = {
  readonly order: number;
  readonly value: Readonly<Record<string, unknown>>;
};

export type ParsedFailureTranscript = {
  readonly recordedCalls: ReadonlyArray<RecordedToolCall>;
  readonly diagnostics: ReadonlyArray<RecordedToolFailure>;
  readonly successfulResults: ReadonlyArray<RecordedToolSuccess>;
  readonly successfulCompletions: ReadonlyArray<RecordedCompletion>;
  readonly transcriptWarnings: ReadonlyArray<RecordedTranscriptWarning>;
  readonly recordedMessages: ReadonlyArray<RecordedMessage>;
  readonly resultCallIds: ReadonlySet<string>;
  readonly hasValidFalsePositiveProof: boolean;
  readonly lastInteractionOrder: number;
};

export type SessionTail = {
  readonly content: string;
  readonly truncated: boolean;
};
