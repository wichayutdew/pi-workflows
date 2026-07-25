import type { BashApprovalSource } from '../config/types.ts';
import {
  parseJsonDocuments,
  remoteActionCommands,
  verificationCommands,
} from './reviewed-artifact.ts';
import {
  isSafeRemoteActionCommand,
  isSafeVerificationCommand,
} from './reviewed-command-safety.ts';

const commandsFromSource = (
  document: unknown,
  source: BashApprovalSource,
): Array<string> => {
  if (source === 'verification-worker') {
    return verificationCommands(document, 'worker').filter(
      isSafeVerificationCommand,
    );
  }
  if (source === 'verification-reviewer') {
    return verificationCommands(document, 'reviewer').filter(
      isSafeVerificationCommand,
    );
  }
  return remoteActionCommands(document).filter(isSafeRemoteActionCommand);
};

/**
 * Extracts exact Bash capabilities from human-approved, machine-readable JSON.
 *
 * @param artifact - Artifact displayed by the review gate.
 * @param sources - Approved artifact sections to inspect.
 * @returns Unique safe commands in source order.
 */
export const extractApprovedBashCommands = (
  artifact: string,
  sources: ReadonlyArray<BashApprovalSource>,
): Array<string> => {
  if (!artifact.trim() || sources.length === 0) return [];

  const commands = parseJsonDocuments(artifact).flatMap((document) =>
    sources.flatMap((source) => commandsFromSource(document, source)),
  );
  return [...new Set(commands)];
};

/**
 * Narrows reviewed commands to those retained by the latest step handoff.
 *
 * A child can remove reviewed authority, but its unreviewed output can never
 * introduce a new Bash capability.
 *
 * @param artifact - Original human-approved artifact.
 * @param handoff - Latest completed-step handoff.
 * @param sources - Approved artifact sections to inspect.
 * @returns Commands present in both artifacts.
 */
export const narrowApprovedBashCommands = (
  artifact: string,
  handoff: string,
  sources: ReadonlyArray<BashApprovalSource>,
): Array<string> => {
  const approvedCommands = extractApprovedBashCommands(artifact, sources);
  if (approvedCommands.length === 0) return [];

  const retainedCommands = new Set(
    extractApprovedBashCommands(handoff, sources),
  );
  return approvedCommands.filter((command) => retainedCommands.has(command));
};
