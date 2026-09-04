import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import type {
  ConfigLoaderDependencies,
  LoadCatalogOptions,
  LoadedSettings,
  WorkflowCatalog,
} from '../../domain/index.ts';
import { createConfigLoader } from './catalog.ts';

export type {
  ConfigEnvironment,
  ConfigFileSystem,
  ConfigLoader,
  ConfigLoaderDependencies,
  LoadCatalogOptions,
  LoadedSettings,
  WorkflowDirectoryEntry,
} from '../../domain/index.ts';
export { createConfigLoader } from './catalog.ts';

const NODE_CONFIG_DEPENDENCIES = {
  fileSystem: {
    readDirectory: (path) => readdir(path, { withFileTypes: true }),
    readTextFile: (path) => readFile(path, 'utf8'),
    realPath: realpath,
  },
  environment: {
    getVariable: (name) => process.env[name],
    homeDirectory: homedir,
  },
} as const satisfies ConfigLoaderDependencies;

const NODE_CONFIG_LOADER = createConfigLoader(NODE_CONFIG_DEPENDENCIES);

/** Resolve the default user workflow directory from the process environment. */
export function defaultUserWorkflowDirectory(): string {
  return NODE_CONFIG_LOADER.defaultUserWorkflowDirectory();
}

/** Load workflow settings from the given user directory. */
export async function loadSettings(
  userDirectory: string,
): Promise<LoadedSettings> {
  return NODE_CONFIG_LOADER.loadSettings(userDirectory);
}

/** Load the complete workflow catalog using the default Node.js adapters. */
export async function loadCatalog(
  options: LoadCatalogOptions,
): Promise<WorkflowCatalog> {
  return NODE_CONFIG_LOADER.loadCatalog(options);
}
