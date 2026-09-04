import type { StepPermissions, StepWorkspaceBinding } from './config.ts';
import type { UsageTotals } from './state.ts';

export const SUBAGENT_DELEGATION_PROTOCOL_VERSION = 1 as const;
export const SUBAGENT_DELEGATION_REQUEST_EVENT =
  'prompt-template:subagent:request';
export const SUBAGENT_DELEGATION_STARTED_EVENT =
  'prompt-template:subagent:started';
export const SUBAGENT_DELEGATION_UPDATE_EVENT =
  'prompt-template:subagent:update';
export const SUBAGENT_DELEGATION_RESPONSE_EVENT =
  'prompt-template:subagent:response';
export const SUBAGENT_DELEGATION_CANCEL_EVENT =
  'prompt-template:subagent:cancel';

export type ChildStepPolicy = {
  readonly version: 1;
  readonly requestId: string;
  readonly agent: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly stepTitle: string;
  /** Effective run directory: the captured start cwd or accepted binding. */
  readonly cwd: string;
  readonly policyDigest: string;
  readonly capabilityPath: string;
  readonly capabilityToken: string;
  readonly resultPath: string;
  readonly permissions: StepPermissions;
  readonly outcomes: ReadonlyArray<string>;
  /** Outcomes that pause instead of advancing to another workflow step. */
  readonly pauseOutcomes: ReadonlyArray<string>;
  readonly summaryMaxChars: number;
  /** Productive calls available before the mandatory handoff reserve. */
  readonly maxToolCalls?: number;
  /** Calls reserved for the child to hand off after productive work. */
  readonly handoffReserve?: number;
  /** Productive calls plus the mandatory handoff reserve. */
  readonly totalToolCalls?: number;
  /** Extension-owned outcome persisted when an exhausted child settles without a result. */
  readonly handoffOutcome?: string;
  readonly gateSubmitOutcome?: string;
  readonly workspace?: StepWorkspaceBinding;
};

export type ExtractedChildPolicy = {
  readonly policy: ChildStepPolicy;
  readonly task: string;
};

export type ChildPolicyEnvironment = {
  readonly platform: NodeJS.Platform;
  readonly tempDir: () => string;
};

export type DiagnosticCallState = 'completed' | 'failed' | 'started';

export type DelegationDiagnosticCall = {
  readonly id: string;
  readonly name: string;
  readonly state: DiagnosticCallState;
};

export type DelegationDiagnostic = {
  readonly settled: boolean;
  readonly truncated: boolean;
  readonly calls: ReadonlyArray<DelegationDiagnosticCall>;
};

export type RecoverySafety = 'read-only' | 'unsafe' | 'incomplete';

export type SubagentDelegationRequest = {
  readonly version: 1;
  readonly requestId: string;
  readonly agent: string;
  readonly task: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly thinking?:
    'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly [key: string]: unknown;
};

export type SubagentDelegationUpdate = {
  readonly requestId: string;
  readonly activity?: string;
  /** Operator-visible detail; never used as workflow instruction or input. */
  readonly detail?: string;
  readonly currentTool?: string;
  readonly toolCount?: number;
  readonly tokens?: number;
};

export type SubagentDelegationStatus = 'completed' | 'failed' | 'cancelled';

export type SubagentModelUsage = {
  readonly provider: string;
  readonly model: string;
  readonly usage: UsageTotals;
};

export type SubagentDelegationResponse = {
  readonly version?: number;
  readonly requestId: string;
  readonly agent?: string;
  readonly status: SubagentDelegationStatus;
  readonly error?: string;
  readonly exitCode?: number;
  readonly warnings?: ReadonlyArray<string>;
  readonly diagnostic?: DelegationDiagnostic;
  /** Usage captured from terminal worker messages only. */
  readonly usage?: ReadonlyArray<SubagentModelUsage>;
};

export type DelegatedStepResult = {
  readonly outcome: string;
  readonly summary: string;
  readonly artifact?: string;
  readonly workspace?: {
    readonly cwd: string;
  };
};

export {
  extractChildPolicy,
  encodeChildPolicy,
} from '../function/subagent/child-policy-envelope.ts';
export { parseDelegatedStepResult } from '../function/subagent/delegated-result.ts';
