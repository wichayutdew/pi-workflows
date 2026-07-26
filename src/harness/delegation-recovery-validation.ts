import { parseDelegatedStepResult } from '../integrations/subagents/protocol.ts';
import type {
  ChildStepPolicy,
  SubagentDelegationResponse,
} from '../integrations/subagents/protocol.ts';
import type { WorkflowStepResult } from '../runtime/step-result.ts';
import type { ActiveDelegation, DelegationFailureDetails } from './types.ts';

/**
 * Verifies that transcript completion data exactly matches a recovered result.
 *
 * @param diagnostic - Correlated tool-failure diagnostic.
 * @param result - Result recovered from the delegated artifact.
 * @param policy - Child policy used to validate the result.
 * @returns Whether the transcript and recovered artifact agree.
 */
export function completionMatchesResult(
  diagnostic: NonNullable<DelegationFailureDetails['diagnostic']>,
  result: WorkflowStepResult,
  policy: ChildStepPolicy,
): boolean {
  const value = diagnostic.completionValue;
  if (!value) return false;
  const expectedKeys = [
    'outcome',
    'summary',
    ...(result.artifact === undefined ? [] : ['artifact']),
    ...(result.workspace === undefined ? [] : ['workspace']),
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key, index) => key === expectedKeys[index])
  ) {
    return false;
  }
  try {
    const completion = parseDelegatedStepResult(
      {
        ...value,
        version: 1,
        policyDigest: policy.policyDigest,
      },
      policy,
    );
    return (
      completion.outcome === result.outcome &&
      completion.summary === result.summary &&
      completion.artifact === result.artifact &&
      completion.workspace?.cwd === result.workspace?.cwd
    );
  } catch {
    return false;
  }
}

/**
 * Finds contradictory or unsafe fields in a recovered terminal projection.
 *
 * @param active - Active delegation identity.
 * @param response - Terminal response received from the child.
 * @param diagnostic - Transcript evidence correlated to the failure.
 * @returns A rejection reason, or undefined for a valid projection.
 */
export function recoveredProjectionError(
  active: ActiveDelegation,
  response: SubagentDelegationResponse,
  diagnostic: NonNullable<DelegationFailureDetails['diagnostic']>,
): string | undefined {
  if (response.agent !== active.agent) {
    return `terminal agent identity is ${JSON.stringify(response.agent)}; expected ${JSON.stringify(active.agent)}`;
  }
  if (response.childIndex !== 0) {
    return `terminal child index is ${JSON.stringify(response.childIndex)}; expected 0`;
  }
  if (
    typeof response.exitCode !== 'number' ||
    !Number.isSafeInteger(response.exitCode) ||
    response.exitCode <= 0
  ) {
    return `terminal exit code is ${JSON.stringify(response.exitCode)}; expected a positive safe integer`;
  }
  const execution = response.execution;
  if (!execution) return 'terminal response has no execution projection';
  if (execution.status !== 'failed' || execution.success) {
    return `execution projection is ${JSON.stringify({
      status: execution.status,
      success: execution.success,
    })}; expected failed/false`;
  }
  if (execution.exitCode !== response.exitCode) {
    return `execution exit code ${JSON.stringify(execution.exitCode)} does not match terminal exit code ${JSON.stringify(response.exitCode)}`;
  }
  if (
    typeof response.error !== 'string' ||
    !response.error ||
    typeof execution.error !== 'string' ||
    execution.error !== response.error
  ) {
    return 'terminal and execution errors are missing or do not match exactly';
  }
  const warnings = response.warnings as unknown;
  if (
    warnings !== undefined &&
    (!Array.isArray(warnings) ||
      warnings.some(
        (warning) => typeof warning !== 'string' || warning.trim().length > 0,
      ))
  ) {
    return `terminal response contains warning evidence: ${JSON.stringify(warnings)}`;
  }
  if (
    diagnostic.transcriptToolCount !== undefined &&
    response.toolCount !== undefined &&
    response.toolCount !== diagnostic.transcriptToolCount
  ) {
    return `terminal tool count ${response.toolCount} does not match transcript tool count ${diagnostic.transcriptToolCount}`;
  }
  if (
    diagnostic.transcriptTurnCount !== undefined &&
    response.turns !== undefined &&
    response.turns !== diagnostic.transcriptTurnCount
  ) {
    return `terminal turn count ${response.turns} does not match transcript turn count ${diagnostic.transcriptTurnCount}`;
  }
  const toolFailure = response.error.match(
    /^\s*([a-z][\w-]*) failed\s*\(exit\s+(\d+)\)\s*:/i,
  );
  if (!toolFailure) {
    return 'terminal error is not a recognized "<tool> failed (exit N): <detail>" failure';
  }
  const terminalTool = toolFailure[1];
  const terminalExitCodeText = toolFailure[2];
  if (!terminalTool || !terminalExitCodeText) {
    return 'terminal error does not contain a complete tool failure projection';
  }
  const terminalExitCode = Number(terminalExitCodeText);
  if (
    terminalTool.toLowerCase() !== diagnostic.tool.toLowerCase() ||
    terminalExitCode !== response.exitCode
  ) {
    return `terminal tool/exit ${JSON.stringify({
      tool: terminalTool,
      exitCode: terminalExitCode,
    })} does not match the correlated failure ${JSON.stringify({
      tool: diagnostic.tool,
      exitCode: response.exitCode,
    })}`;
  }
  const unsafeFlag = (
    [
      ['interrupted', execution.interrupted],
      ['timedOut', execution.timedOut],
      ['stopped', execution.stopped],
      ['detached', execution.detached],
    ] as const
  ).find(([, isEnabled]) => isEnabled === true)?.[0];
  return unsafeFlag
    ? `execution projection reports ${unsafeFlag}=true`
    : undefined;
}
