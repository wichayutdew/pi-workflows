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

export type SubagentDelegationResponse = {
  readonly version?: number;
  readonly requestId: string;
  readonly agent?: string;
  readonly status: SubagentDelegationStatus;
  readonly error?: string;
  readonly exitCode?: number;
  readonly warnings?: ReadonlyArray<string>;
};
