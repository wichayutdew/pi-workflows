import type {
  SubagentDelegationRequest as UpstreamDelegationRequest,
  SubagentDelegationResponse as UpstreamDelegationResponse,
  SubagentDelegationStatus as UpstreamDelegationStatus,
  SubagentDelegationUpdate as UpstreamDelegationUpdate,
} from 'pi-subagents/delegation';

// These released v1 transport values are duplicated as literals because
// pi-subagents 0.36.0 exports TypeScript source. Node's native type stripping
// cannot execute TypeScript below node_modules; the public types above remain
// the compile-time compatibility check.
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

export type SubagentDelegationRequest = UpstreamDelegationRequest;
export type SubagentDelegationUpdate = UpstreamDelegationUpdate;
export type SubagentDelegationStatus = UpstreamDelegationStatus;
export type SubagentDelegationResponse = UpstreamDelegationResponse;
