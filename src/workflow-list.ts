/**
 * Display fields needed for one workflow-list row.
 */
export type WorkflowListItem = {
  readonly id: string;
  readonly command: string;
  readonly description: string;
};

function escapeMarkdownTableCell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r\n|\r|\n/g, ' ');
}

/**
 * Formats loaded workflows as a Markdown table for the Pi transcript.
 *
 * @param workflows - Workflow identities and descriptions to list.
 * @returns A Markdown workflow table.
 */
export function formatWorkflowList(
  workflows: ReadonlyArray<WorkflowListItem>,
): string {
  return [
    '| Workflow | Command | Description |',
    '| --- | --- | --- |',
    ...workflows.map(
      (workflow) =>
        `| \`${workflow.id}\` | \`/${workflow.command}\` | ${escapeMarkdownTableCell(workflow.description)} |`,
    ),
  ].join('\n');
}
