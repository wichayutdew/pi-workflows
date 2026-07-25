import { basename } from 'node:path';
import { tokenizeRestrictedCommand } from './restricted-command.ts';
import {
  parseJsonDocuments,
  verificationCommands,
} from './reviewed-artifact.ts';

const malformedBunInstallReason = (command: string): string | undefined => {
  const parsed = tokenizeRestrictedCommand(command);
  if (!parsed.tokens || basename(parsed.tokens[0] ?? '') !== 'bun') {
    return undefined;
  }

  const installIndex = parsed.tokens.indexOf('install', 1);
  if (installIndex <= 1) return undefined;
  const hasCwdBeforeInstall = parsed.tokens
    .slice(1, installIndex)
    .some((token) => token === '--cwd' || token.startsWith('--cwd='));
  if (!hasCwdBeforeInstall) return undefined;

  return [
    `Invalid Bun install command: ${JSON.stringify(command)}.`,
    '`--cwd` appears before `install`, so Bun interprets `install` as a package script.',
    'Use `bun install --cwd <absolute-cwd> --frozen-lockfile`, preserving the reviewed path and any other intended install flags, then resubmit the plan.',
  ].join(' ');
};

/**
 * Rejects known command-shape mistakes before human approval.
 *
 * Deterministic checks prevent known parser traps from becoming approved
 * capabilities while leaving arbitrary runtime diagnosis to the agent.
 *
 * @param artifact - Reviewed execution contract.
 * @returns A corrective error message, or `undefined` when shapes are valid.
 */
export const reviewedCommandShapeError = (
  artifact: string,
): string | undefined => {
  for (const document of parseJsonDocuments(artifact)) {
    for (const role of ['worker', 'reviewer'] as const) {
      for (const command of verificationCommands(document, role)) {
        const reason = malformedBunInstallReason(command);
        if (reason) return reason;
      }
    }
  }
  return undefined;
};
