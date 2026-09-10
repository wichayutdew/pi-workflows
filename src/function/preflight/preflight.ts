import type { WorkflowStep } from '../../domain/index.ts';

type SourceInfoLike = {
  readonly source?: string;
  readonly path?: string;
};

type NamedResource = {
  readonly name: string;
  readonly sourceInfo?: SourceInfoLike;
};

/**
 * Installed resources visible to workflow preflight checks.
 */
export type PreflightInventory = {
  readonly tools: ReadonlyArray<NamedResource>;
  readonly commands: ReadonlyArray<NamedResource>;
  readonly skills: ReadonlySet<string>;
};

const sourceMatches = (resource: NamedResource, selector: string): boolean => {
  const source = [
    resource.sourceInfo?.source ?? '',
    resource.sourceInfo?.path ?? '',
  ].join('\n');
  return source.toLowerCase().includes(selector.toLowerCase());
};

/**
 * Checks that resources required by a workflow step are available before
 * execution begins.
 *
 * @param step - Workflow step to validate.
 * @param inventory - Installed tools, commands, and loaded skills.
 * @returns Human-readable preflight errors, or an empty array when ready.
 */
export function preflightStep(
  step: WorkflowStep,
  inventory: PreflightInventory,
): Array<string> {
  const extensionResources = [...inventory.tools, ...inventory.commands];
  const hasPlannotator = extensionResources.some((resource) =>
    sourceMatches(resource, 'plannotator'),
  );
  return step.gate !== undefined && !hasPlannotator
    ? [
        'Plannotator is required by this gate, but its extension is not installed or detectable',
      ]
    : [];
}
