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

type ResourceKind = 'extension' | 'skill' | 'tool';

const MISSING_RESOURCE_STATE = {
  extension: 'detectable',
  skill: 'loaded',
  tool: 'installed',
} as const satisfies Record<ResourceKind, string>;

type MissingRequiredResourcesOptions = {
  readonly requiredNames: ReadonlyArray<string>;
  readonly hasResource: (name: string) => boolean;
  readonly resourceKind: ResourceKind;
};

const missingRequiredResources = ({
  requiredNames,
  hasResource,
  resourceKind,
}: MissingRequiredResourcesOptions): ReadonlyArray<string> =>
  requiredNames
    .filter((name) => !hasResource(name))
    .map(
      (name) =>
        `required ${resourceKind} "${name}" is not ${MISSING_RESOURCE_STATE[resourceKind]}`,
    );

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
  const toolNames = new Set(inventory.tools.map((tool) => tool.name));
  const extensionResources = [...inventory.tools, ...inventory.commands];
  const hasExtension = (extension: string): boolean =>
    extensionResources.some((resource) => sourceMatches(resource, extension));
  const isPlannotatorRequired =
    step.gate?.provider === 'plannotator' &&
    !step.requires.extensions.includes('plannotator');

  return [
    ...missingRequiredResources({
      requiredNames: step.requires.tools,
      hasResource: (toolName) => toolNames.has(toolName),
      resourceKind: 'tool',
    }),
    ...(isPlannotatorRequired && !hasExtension('plannotator')
      ? [
          'Plannotator is required by this gate, but its extension is not installed or detectable',
        ]
      : []),
    ...missingRequiredResources({
      requiredNames: step.requires.extensions,
      hasResource: hasExtension,
      resourceKind: 'extension',
    }),
    ...missingRequiredResources({
      requiredNames: step.requires.skills,
      hasResource: (skillName) => inventory.skills.has(skillName),
      resourceKind: 'skill',
    }),
  ];
}
