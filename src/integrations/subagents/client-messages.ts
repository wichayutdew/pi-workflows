import { SUBAGENT_DELEGATION_PROTOCOL_VERSION } from './protocol-events.ts';
import type {
  SubagentDelegationResponse,
  SubagentDelegationStatus,
  SubagentDelegationUpdate,
} from './protocol-events.ts';

const DELEGATION_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'interrupted',
  'turn_budget_exhausted',
  'tool_budget_exhausted',
  'structured_output_failed',
  'acceptance_failed',
  'invalid_request',
  'unavailable_context',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isDelegationStatus = (value: string): value is SubagentDelegationStatus =>
  DELEGATION_STATUSES.has(value);

const isDelegationResponse = (
  value: unknown,
): value is SubagentDelegationResponse =>
  isRecord(value) &&
  value.version === SUBAGENT_DELEGATION_PROTOCOL_VERSION &&
  typeof value.requestId === 'string' &&
  typeof value.status === 'string' &&
  isDelegationStatus(value.status);

const isDelegationUpdate = (
  value: unknown,
): value is SubagentDelegationUpdate =>
  isRecord(value) &&
  value.version === SUBAGENT_DELEGATION_PROTOCOL_VERSION &&
  typeof value.requestId === 'string';

/**
 * Reads a request identifier from an untrusted event payload.
 */
export const requestIdOf = (value: unknown): string | undefined =>
  isRecord(value) && typeof value.requestId === 'string'
    ? value.requestId
    : undefined;

/**
 * Validates an untrusted terminal delegation response.
 */
export const parseDelegationResponse = (
  value: unknown,
): SubagentDelegationResponse | undefined =>
  isDelegationResponse(value) ? value : undefined;

/**
 * Validates an untrusted delegation progress update.
 */
export const parseDelegationUpdate = (
  value: unknown,
): SubagentDelegationUpdate | undefined =>
  isDelegationUpdate(value) ? value : undefined;
