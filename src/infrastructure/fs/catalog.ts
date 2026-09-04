import { join, resolve } from 'node:path';
import type {
  ConfigDiagnostic,
  ConfigLoader,
  ConfigLoaderDependencies,
  LoadCatalogOptions,
  LoadedWorkflow,
  PermissionCeiling,
  WorkflowCatalog,
  WorkflowSettings,
} from '../../domain/index.ts';
import {
  checkWorkflowAgainstCeiling,
  createDiagnostic,
} from '../../function/index.ts';
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

function requiredPermissionCeiling(
  settings: WorkflowSettings,
): PermissionCeiling {
  if (!settings.permissionCeiling) {
    throw new Error(
      'validated settings must define a ceiling when project workflows are enabled',
    );
  }
  return settings.permissionCeiling;
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

  const projectDirectory = join(resolve(options.cwd), '.pi', 'workflows');
  if (settingsResult.settings.allowProjectWorkflows) {
    if (!options.projectTrusted) {
      state.diagnostics.push(
        createDiagnostic(
          projectDirectory,
          'project workflows were skipped because the project is not trusted',
          'warning',
        ),
      );
    } else {
      const permissionCeiling = requiredPermissionCeiling(
        settingsResult.settings,
      );
      const projectResult = await loadWorkflowDirectory(
        dependencies.fileSystem,
        projectDirectory,
        'project',
      );
      state.diagnostics.push(...projectResult.diagnostics);
      projectResult.workflows.forEach((workflow) => {
        const ceilingErrors = checkWorkflowAgainstCeiling(
          workflow.definition,
          permissionCeiling,
        );
        if (ceilingErrors.length > 0) {
          state.diagnostics.push(
            ...ceilingErrors.map((message) =>
              createDiagnostic(workflow.sourcePath, message),
            ),
          );
          return;
        }
        addWorkflow(state, workflow);
      });
    }
  }

  return {
    workflows: state.workflows,
    settings: settingsResult.settings,
    diagnostics: state.diagnostics,
    userDirectory,
    ...(settingsResult.settings.allowProjectWorkflows
      ? { projectDirectory }
      : {}),
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
