import { join, resolve } from 'node:path';
import type {
  ConfigDiagnostic,
  ConfigLoader,
  ConfigLoaderDependencies,
  LoadCatalogOptions,
  LoadedWorkflow,
  WorkflowCatalog,
} from '../../domain/index.ts';
import { createDiagnostic } from '../../function/index.ts';
import { loadSettings } from './load-settings.ts';
import { loadWorkflowDirectory } from './load-workflows.ts';

type MutableCatalog = {
  readonly workflows: Map<string, LoadedWorkflow>;
  readonly commands: Map<string, string>;
  readonly diagnostics: Array<ConfigDiagnostic>;
};

function addWorkflow(catalog: MutableCatalog, workflow: LoadedWorkflow): void {
  const { id, command } = workflow.definition;
  const existing = catalog.workflows.get(id);
  if (existing) {
    catalog.diagnostics.push(
      createDiagnostic(
        workflow.sourcePath,
        `workflow id "${id}" already belongs to ${existing.sourcePath}; overrides are not allowed`,
      ),
    );
    return;
  }
  const existingCommand = catalog.commands.get(command);
  if (existingCommand) {
    catalog.diagnostics.push(
      createDiagnostic(
        workflow.sourcePath,
        `command "/${command}" already belongs to workflow "${existingCommand}"`,
      ),
    );
    return;
  }
  catalog.workflows.set(id, workflow);
  catalog.commands.set(command, id);
}

function defaultUserWorkflowDirectory(
  dependencies: ConfigLoaderDependencies,
): string {
  const explicit = dependencies.environment
    .getVariable('PI_WORKFLOWS_DIR')
    ?.trim();
  if (explicit) return resolve(explicit);
  const agentDirectory =
    dependencies.environment.getVariable('PI_CODING_AGENT_DIR')?.trim() ||
    join(dependencies.environment.homeDirectory(), '.pi', 'agent');
  return join(agentDirectory, 'workflows');
}

async function loadCatalog(
  dependencies: ConfigLoaderDependencies,
  options: LoadCatalogOptions,
): Promise<WorkflowCatalog> {
  const userDirectory = resolve(
    options.userDirectory ?? defaultUserWorkflowDirectory(dependencies),
  );
  const settingsResult = await loadSettings(
    dependencies.fileSystem,
    userDirectory,
  );
  const state: MutableCatalog = {
    workflows: new Map(),
    commands: new Map(),
    diagnostics: [...settingsResult.diagnostics],
  };
  const userResult = await loadWorkflowDirectory(
    dependencies.fileSystem,
    userDirectory,
    'user',
  );
  state.diagnostics.push(...userResult.diagnostics);
  userResult.workflows.forEach((workflow) => {
    addWorkflow(state, workflow);
  });
  return {
    workflows: state.workflows,
    settings: settingsResult.settings,
    diagnostics: state.diagnostics,
    userDirectory,
  };
}

/** Bind configuration loading to explicit filesystem and environment ports. */
export function createConfigLoader(
  dependencies: ConfigLoaderDependencies,
): ConfigLoader {
  return {
    defaultUserWorkflowDirectory: () =>
      defaultUserWorkflowDirectory(dependencies),
    loadSettings: (userDirectory) =>
      loadSettings(dependencies.fileSystem, userDirectory),
    loadCatalog: (options) => loadCatalog(dependencies, options),
  };
}
