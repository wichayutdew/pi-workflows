import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digest } from '../digest.ts';
import { createDiagnostic, errorCode, errorMessage } from './diagnostics.ts';
import type { ConfigFileSystem, LoadedDirectory } from './load-types.ts';
import type {
  LoadedWorkflow,
  WorkflowDefinition,
  WorkflowSourceKind,
} from './types.ts';
import { validatePromptText, validateWorkflow } from './validate.ts';
import { parseYaml } from './yaml.ts';

async function readYamlFile(
  fileSystem: ConfigFileSystem,
  path: string,
): Promise<unknown> {
  return parseYaml(await fileSystem.readTextFile(path), 'workflow');
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
  fileSystem: ConfigFileSystem,
  sourcePath: string,
  definition: WorkflowDefinition,
  stepId: string,
): Promise<string> {
  const prompt = definition.steps[stepId]?.prompt;
  if (!prompt) throw new Error(`unknown step "${stepId}"`);
  if ('inline' in prompt) return prompt.inline;

  const sourceDirectory = await fileSystem.realPath(dirname(sourcePath));
  const requestedPath = resolve(sourceDirectory, prompt.file);
  if (!isInside(sourceDirectory, requestedPath)) {
    throw new Error(`prompt file escapes workflow directory: ${prompt.file}`);
  }

  const actualPath = await fileSystem.realPath(requestedPath);
  if (!isInside(sourceDirectory, actualPath)) {
    throw new Error(
      `prompt file symlink escapes workflow directory: ${prompt.file}`,
    );
  }
  return fileSystem.readTextFile(actualPath);
}

async function loadWorkflowFile(
  fileSystem: ConfigFileSystem,
  sourcePath: string,
  sourceKind: WorkflowSourceKind,
): Promise<LoadedWorkflow> {
  const validation = validateWorkflow(
    await readYamlFile(fileSystem, sourcePath),
  );
  if (!validation.value) {
    throw new Error(validation.errors.join('\n'));
  }

  const definition = validation.value;
  const prompts: Record<string, string> = {};
  for (const stepId of Object.keys(definition.steps)) {
    const text = await loadPrompt(fileSystem, sourcePath, definition, stepId);
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

/** Load and validate every workflow file in one source directory. */
export async function loadWorkflowDirectory(
  fileSystem: ConfigFileSystem,
  directory: string,
  sourceKind: WorkflowSourceKind,
): Promise<LoadedDirectory> {
  let entries: Awaited<ReturnType<ConfigFileSystem['readDirectory']>>;
  try {
    entries = await fileSystem.readDirectory(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { workflows: [], diagnostics: [] };
    }
    return {
      workflows: [],
      diagnostics: [
        createDiagnostic(
          directory,
          `cannot read workflow directory: ${String(error)}`,
        ),
      ],
    };
  }

  const files = entries
    .filter((entry) => entry.isFile() && /\.workflow\.ya?ml$/i.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();
  const workflows: Array<LoadedWorkflow> = [];
  const diagnostics = [];
  for (const path of files) {
    try {
      workflows.push(await loadWorkflowFile(fileSystem, path, sourceKind));
    } catch (error) {
      diagnostics.push(createDiagnostic(path, errorMessage(error)));
    }
  }
  return { workflows, diagnostics };
}
