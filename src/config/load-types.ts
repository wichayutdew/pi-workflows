import type {
  ConfigDiagnostic,
  LoadedWorkflow,
  WorkflowCatalog,
  WorkflowSettings,
} from './types.ts';

export type LoadCatalogOptions = {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly userDirectory?: string;
};

export type WorkflowDirectoryEntry = {
  readonly name: string;
  readonly isFile: () => boolean;
};

export type ConfigFileSystem = {
  readonly readDirectory: (
    path: string,
  ) => Promise<ReadonlyArray<WorkflowDirectoryEntry>>;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly realPath: (path: string) => Promise<string>;
};

export type ConfigEnvironment = {
  readonly getVariable: (name: string) => string | undefined;
  readonly homeDirectory: () => string;
};

export type ConfigLoaderDependencies = {
  readonly fileSystem: ConfigFileSystem;
  readonly environment: ConfigEnvironment;
};

export type LoadedDirectory = {
  readonly workflows: ReadonlyArray<LoadedWorkflow>;
  readonly diagnostics: ReadonlyArray<ConfigDiagnostic>;
};

export type LoadedSettings = {
  readonly settings: WorkflowSettings;
  readonly diagnostics: ReadonlyArray<ConfigDiagnostic>;
};

export type ConfigLoader = {
  readonly defaultUserWorkflowDirectory: () => string;
  readonly loadSettings: (userDirectory: string) => Promise<LoadedSettings>;
  readonly loadCatalog: (
    options: LoadCatalogOptions,
  ) => Promise<WorkflowCatalog>;
};
