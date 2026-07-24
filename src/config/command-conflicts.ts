interface CommandLike {
  name: string;
}

function isSuffixedInvocation(name: string, command: string): boolean {
  if (!name.startsWith(`${command}:`)) return false;
  return /^\d+$/.test(name.slice(command.length + 1));
}

/**
 * Pi adds numeric suffixes when extensions register the same command. Existing
 * aliases owned by this harness are safe to replace on reload; a suffixed name
 * proves at least one other command owns the same base invocation.
 */
export function hasRuntimeCommandConflict(
  command: string,
  availableCommands: readonly CommandLike[],
  ownedAliases: ReadonlySet<string>,
): boolean {
  if (
    availableCommands.some((candidate) =>
      isSuffixedInvocation(candidate.name, command),
    )
  ) {
    return true;
  }
  return (
    !ownedAliases.has(command) &&
    availableCommands.some((candidate) => candidate.name === command)
  );
}
