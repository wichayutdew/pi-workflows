import { DEFAULT_SETTINGS, type WorkflowCatalog } from '../../domain/index.ts';

/**
 * Creates the initial empty catalog value used before configuration is loaded.
 */
export function createEmptyCatalog(): WorkflowCatalog {
  return {
    workflows: new Map(),
    settings: DEFAULT_SETTINGS,
    diagnostics: [],
    userDirectory: '',
  };
}

/**
 * Formats a bounded diagnostic summary suitable for a Pi notification.
 */
export function formatCatalogDiagnostics(catalog: WorkflowCatalog): string {
  const shownDiagnostics = catalog.diagnostics
    .slice(0, 3)
    .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`);
  const remainingCount = catalog.diagnostics.length - shownDiagnostics.length;
  return [
    ...shownDiagnostics,
    ...(remainingCount > 0 ? [`${remainingCount} more diagnostic(s)`] : []),
  ].join('\n');
}

/**
 * Extracts the latest advertised skill names from a Pi system prompt.
 */
export function parseAvailableSkills(
  systemPrompt: string,
): Array<{ name: string }> {
  const sections = [
    ...systemPrompt.matchAll(
      /<available_skills>([\s\S]*?)<\/available_skills>/g,
    ),
  ];
  const section = sections.at(-1)?.[1] ?? '';
  return [...section.matchAll(/<name>([^<]+)<\/name>/g)].flatMap((match) => {
    const name = match[1]?.trim();
    return name ? [{ name }] : [];
  });
}
