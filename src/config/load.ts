import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { digest } from '../digest.ts';
import { checkWorkflowAgainstCeiling } from './ceiling.ts';
import {
  DEFAULT_SETTINGS,
  type ConfigDiagnostic,
  type LoadedWorkflow,
  type WorkflowCatalog,
  type WorkflowDefinition,
  type WorkflowSettings,
  type WorkflowSourceKind,
} from './types.ts';
import {
  validatePromptText,
  validateSettings,
  validateWorkflow,
} from './validate.ts';

export interface LoadCatalogOptions {
  cwd: string;
  projectTrusted: boolean;
  userDirectory?: string;
}

interface LoadedDirectory {
  workflows: LoadedWorkflow[];
  diagnostics: ConfigDiagnostic[];
}

function diagnostic(
  path: string,
  message: string,
  level: ConfigDiagnostic['level'] = 'error',
): ConfigDiagnostic {
  return { path, message, level };
}

async function readYaml(
  path: string,
  kind: 'settings' | 'workflow',
): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  const document = parseDocument(text, {
    customTags: [],
    merge: false,
    prettyErrors: true,
    resolveKnownTags: false,
    schema: 'core',
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: '1.2',
  });
  const issues = [...document.errors, ...document.warnings];
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => issue.message).join('\n'));
  }
  if (
    document.directives.yaml.explicit &&
    document.directives.yaml.version !== '1.2'
  ) {
    throw new Error(`${kind} YAML must use version 1.2`);
  }
  return document.toJS({ maxAliasCount: 100 }) as unknown;
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

async function loadPrompt(
  sourcePath: string,
  definition: WorkflowDefinition,
  stepId: string,
): Promise<string> {
  const prompt = definition.steps[stepId]?.prompt;
  if (!prompt) throw new Error(`unknown step "${stepId}"`);
  if ('inline' in prompt) return prompt.inline;

  const sourceDirectory = await realpath(dirname(sourcePath));
  const requestedPath = resolve(sourceDirectory, prompt.file);
  if (!isInside(sourceDirectory, requestedPath)) {
    throw new Error(`prompt file escapes workflow directory: ${prompt.file}`);
  }

  const actualPath = await realpath(requestedPath);
  if (!isInside(sourceDirectory, actualPath)) {
    throw new Error(
      `prompt file symlink escapes workflow directory: ${prompt.file}`,
    );
  }
  return readFile(actualPath, 'utf8');
}

async function loadWorkflowFile(
  sourcePath: string,
  sourceKind: WorkflowSourceKind,
): Promise<LoadedWorkflow> {
  const raw = await readYaml(sourcePath, 'workflow');
  const validation = validateWorkflow(raw);
  if (!validation.value) {
    throw new Error(validation.errors.join('\n'));
  }

  const definition = validation.value;
  const prompts: Record<string, string> = {};
  for (const stepId of Object.keys(definition.steps)) {
    const text = await loadPrompt(sourcePath, definition, stepId);
    const promptErrors = validatePromptText(
      text,
      `workflow.steps.${stepId}.prompt`,
    );
    if (promptErrors.length > 0) {
      throw new Error(promptErrors.join('\n'));
    }
    prompts[stepId] = text;
  }

  const stepDigests = Object.fromEntries(
    Object.entries(definition.steps).map(([stepId, step]) => [
      stepId,
      digest({ step, prompt: prompts[stepId] }),
    ]),
  );
  return {
    definition,
    prompts,
    digest: digest({ definition, prompts }),
    stepDigests,
    sourcePath,
    sourceKind,
  };
}

async function loadWorkflowDirectory(
  directory: string,
  sourceKind: WorkflowSourceKind,
): Promise<LoadedDirectory> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { workflows: [], diagnostics: [] };
    return {
      workflows: [],
      diagnostics: [
        diagnostic(
          directory,
          `cannot read workflow directory: ${String(error)}`,
        ),
      ],
    };
  }

  const workflows: LoadedWorkflow[] = [];
  const diagnostics: ConfigDiagnostic[] = [];
  const files = entries
    .filter((entry) => entry.isFile() && /\.workflow\.ya?ml$/i.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();

  for (const path of files) {
    try {
      workflows.push(await loadWorkflowFile(path, sourceKind));
    } catch (error) {
      diagnostics.push(
        diagnostic(
          path,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  return { workflows, diagnostics };
}

async function loadSettings(userDirectory: string): Promise<{
  settings: WorkflowSettings;
  diagnostics: ConfigDiagnostic[];
}> {
  const path = join(userDirectory, 'settings.yaml');
  try {
    const validation = validateSettings(await readYaml(path, 'settings'));
    if (!validation.value) {
      return {
        settings: DEFAULT_SETTINGS,
        diagnostics: validation.errors.map((message) =>
          diagnostic(path, message),
        ),
      };
    }
    return { settings: validation.value, diagnostics: [] };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      return { settings: DEFAULT_SETTINGS, diagnostics: [] };
    return {
      settings: DEFAULT_SETTINGS,
      diagnostics: [
        diagnostic(
          path,
          `cannot read settings: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
}

function addWorkflow(
  catalog: Map<string, LoadedWorkflow>,
  commands: Map<string, string>,
  workflow: LoadedWorkflow,
  diagnostics: ConfigDiagnostic[],
): void {
  const id = workflow.definition.id;
  const command = workflow.definition.command;
  const existing = catalog.get(id);
  if (existing) {
    diagnostics.push(
      diagnostic(
        workflow.sourcePath,
        `workflow id "${id}" already belongs to ${existing.sourcePath}; overrides are not allowed`,
      ),
    );
    return;
  }
  const existingCommand = commands.get(command);
  if (existingCommand) {
    diagnostics.push(
      diagnostic(
        workflow.sourcePath,
        `command "/${command}" already belongs to workflow "${existingCommand}"`,
      ),
    );
    return;
  }
  catalog.set(id, workflow);
  commands.set(command, id);
}

export function defaultUserWorkflowDirectory(): string {
  const explicit = process.env.PI_WORKFLOWS_DIR?.trim();
  if (explicit) return resolve(explicit);
  const agentDirectory =
    process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
  return join(agentDirectory, 'workflows');
}

export async function loadCatalog(
  options: LoadCatalogOptions,
): Promise<WorkflowCatalog> {
  const userDirectory = resolve(
    options.userDirectory ?? defaultUserWorkflowDirectory(),
  );
  const diagnostics: ConfigDiagnostic[] = [];
  const settingsResult = await loadSettings(userDirectory);
  diagnostics.push(...settingsResult.diagnostics);

  const catalog = new Map<string, LoadedWorkflow>();
  const commands = new Map<string, string>();
  const userResult = await loadWorkflowDirectory(userDirectory, 'user');
  diagnostics.push(...userResult.diagnostics);
  for (const workflow of userResult.workflows) {
    addWorkflow(catalog, commands, workflow, diagnostics);
  }

  const projectDirectory = join(resolve(options.cwd), '.pi', 'workflows');
  if (settingsResult.settings.allowProjectWorkflows) {
    if (!options.projectTrusted) {
      diagnostics.push(
        diagnostic(
          projectDirectory,
          'project workflows were skipped because the project is not trusted',
          'warning',
        ),
      );
    } else if (!settingsResult.settings.permissionCeiling) {
      diagnostics.push(
        diagnostic(
          projectDirectory,
          'project workflows were skipped because no user permission ceiling is configured',
        ),
      );
    } else {
      const projectResult = await loadWorkflowDirectory(
        projectDirectory,
        'project',
      );
      diagnostics.push(...projectResult.diagnostics);
      for (const workflow of projectResult.workflows) {
        const ceilingErrors = checkWorkflowAgainstCeiling(
          workflow.definition,
          settingsResult.settings.permissionCeiling,
        );
        if (ceilingErrors.length > 0) {
          diagnostics.push(
            ...ceilingErrors.map((message) =>
              diagnostic(workflow.sourcePath, message),
            ),
          );
          continue;
        }
        addWorkflow(catalog, commands, workflow, diagnostics);
      }
    }
  }

  return {
    workflows: catalog,
    settings: settingsResult.settings,
    diagnostics,
    userDirectory,
    ...(settingsResult.settings.allowProjectWorkflows
      ? { projectDirectory }
      : {}),
  };
}
