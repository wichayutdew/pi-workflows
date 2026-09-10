import type { ArtifactContract, RequiredHeading } from '../../domain/index.ts';

function headingLine(heading: RequiredHeading): string {
  return `${'#'.repeat(heading.level)} ${heading.title}`;
}

function artifactHeadings(artifact: string): ReadonlySet<string> {
  const headings = new Set<string>();
  let fence:
    { readonly character: '`' | '~'; readonly length: number } | undefined;

  for (const line of artifact.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!marker) continue;
      const character = marker[0] as '`' | '~';
      if (!fence) {
        fence = { character, length: marker.length };
      } else if (
        fence.character === character &&
        marker.length >= fence.length
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;

    const headingMatch = /^(#{1,3})[ \t]+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      headings.add(`${headingMatch[1]} ${headingMatch[2]}`);
    }
  }

  return headings;
}

export function validateArtifactContract(
  artifact: string,
  contract: ArtifactContract | undefined,
): string | undefined {
  if (!contract) return undefined;
  if (artifact.length > contract.maxChars) {
    return `gate artifact exceeds ${contract.maxChars} characters`;
  }
  const headings = artifactHeadings(artifact);
  const required = contract.requiredHeadings.find(
    (heading) => !headings.has(headingLine(heading)),
  );
  return required
    ? `gate artifact is missing required heading: ${JSON.stringify(headingLine(required))}`
    : undefined;
}
