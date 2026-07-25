export type ChildRuntimePathInspection = {
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
};

export type ChildRuntimeFileSystem = {
  readonly exists: (path: string) => boolean;
  readonly inspect: (path: string) => ChildRuntimePathInspection;
  readonly readText: (path: string) => string;
  readonly realPath: (path: string) => string;
  readonly rename: (source: string, destination: string) => void;
  readonly stat: (path: string) => ChildRuntimePathInspection;
  readonly unlink: (path: string) => void;
  readonly writeExclusive: (path: string, content: string) => void;
};

export type SubagentChildRuntimeDependencies = {
  readonly fileSystem: ChildRuntimeFileSystem;
  readonly createUniqueId: () => string;
  readonly currentWorkingDirectory: () => string;
  readonly environmentChildAgent: () => string | undefined;
  readonly temporaryDirectory: () => string;
  readonly tokensAreEqual: (actual: string, expected: string) => boolean;
};

export type SubagentChildRuntimeOptions = {
  readonly childAgent?: string;
  readonly dependencies?: SubagentChildRuntimeDependencies;
};
