export interface WorkflowListItem {
  id: string;
  command: string;
  description: string;
}

function escapeMarkdownTableCell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r\n|\r|\n/g, ' ');
}

export function formatWorkflowList(
  workflows: readonly WorkflowListItem[],
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
