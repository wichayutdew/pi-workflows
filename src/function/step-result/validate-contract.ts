import type { ArtifactContract } from '../../domain/index.ts';

function countOccurrences(value: string, substring: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const match = value.indexOf(substring, offset);
    if (match === -1) return count;
    count += 1;
    offset = match + substring.length;
  }
}

export function validateArtifactContract(
  artifact: string,
  contract: ArtifactContract | undefined,
): string | undefined {
  if (!contract) return undefined;
  if (artifact.length > contract.maxChars) {
    return `gate artifact exceeds ${contract.maxChars} characters`;
  }
  const required = contract.requiredSubstrings.find(
    (substring) => !artifact.includes(substring),
  );
  if (required) {
    return `gate artifact is missing required text: ${JSON.stringify(required)}`;
  }
  const forbidden = contract.forbiddenSubstrings.find((substring) =>
    artifact.includes(substring),
  );
  if (forbidden) {
    return `gate artifact contains forbidden text: ${JSON.stringify(forbidden)}`;
  }
  for (const group of contract.equalOccurrenceGroups) {
    const counts = group.map((substring) =>
      countOccurrences(artifact, substring),
    );
    if (counts.some((count) => count === 0)) {
      return `gate artifact is missing required repeated text: ${JSON.stringify(group)}`;
    }
    if (!counts.every((count) => count === counts[0])) {
      return `gate artifact has unequal repeated text counts: ${JSON.stringify(group)}`;
    }
  }
  return undefined;
}
