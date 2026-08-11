import type { KeyId } from '@earendil-works/pi-tui';

export const WORKFLOW_SCHEMA_VERSION = 1 as const;
export const DEFAULT_STATUS_SHORTCUT = 'ctrl+alt+w' as const satisfies KeyId;
export const AGENT_PROFILE_NAME_PATTERN =
  /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
export const MAX_WORKSPACE_PATH_CHARS = 4_096;
export const MAX_WORKSPACE_ALLOWED_ROOTS = 32;

export const TERMINAL_TARGETS = ['$done', '$pause'] as const;
export type TerminalTarget = (typeof TERMINAL_TARGETS)[number];
export type StepTarget = string;

export type BashMode = 'deny' | 'allow-list' | 'unrestricted';

export type BashRule = {
  readonly executable: string;
  readonly argsPrefix: ReadonlyArray<string>;
};

export type BashPermission = {
  readonly mode: BashMode;
  readonly allow: ReadonlyArray<BashRule>;
};

export type StepPermissions = {
  /** Exact Pi tool names, including direct MCP tools. */
  readonly tools: ReadonlyArray<string>;
  /** MCP proxy selectors in `server` or `server/tool` form. */
  readonly mcp: ReadonlyArray<string>;
  /** Source-name/path fragments whose registered tools may be used. */
  readonly extensions: ReadonlyArray<string>;
  /** Skills the step prompt is allowed to use. */
  readonly skills: ReadonlyArray<string>;
  readonly bash: BashPermission;
};

export type StepRequirements = {
  readonly tools: ReadonlyArray<string>;
  readonly extensions: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
};

export type StepAgent = {
  /** Workflow-owned role prompt applied to this main-agent step. */
  readonly name: string;
};

export type PromptSpec =
  { readonly inline: string } | { readonly file: string };

type GateDefinition = {
  readonly submitOutcome: string;
  readonly approvedOutcome: string;
  readonly rejectedOutcome: string;
};

export type PromptGate = GateDefinition & {
  readonly provider: 'prompt';
};

export type PlannotatorGate = GateDefinition & {
  readonly provider: 'plannotator';
  readonly timeoutMs: number;
};

export type WorkflowGate = PromptGate | PlannotatorGate;

export type StepWorkspaceBinding = {
  /** Outcomes whose result establishes the workspace for later steps. */
  readonly bindOn: ReadonlyArray<string>;
  /** Relative, absolute, or ~/ home-relative paths that may contain the workspace. */
  readonly allowedRoots: ReadonlyArray<string>;
};

export type WorkflowStep = {
  readonly title: string;
  readonly prompt: PromptSpec;
  /** Optional workflow-owned role prompt for this main-agent step. */
  readonly agent?: StepAgent;
  readonly permissions: StepPermissions;
  readonly requires: StepRequirements;
  readonly transitions: Readonly<Record<string, StepTarget>>;
  readonly gate?: WorkflowGate;
  /** Optional immutable workspace binding produced by this delegated step. */
  readonly workspace?: StepWorkspaceBinding;
};

export type WorkflowDefinition = {
  readonly version: typeof WORKFLOW_SCHEMA_VERSION;
  readonly id: string;
  readonly command: string;
  readonly description: string;
  readonly start: string;
  readonly maxStepVisits: number;
  readonly summaryMaxChars: number;
  readonly steps: Readonly<Record<string, WorkflowStep>>;
};

export type WorkflowSourceKind = 'user' | 'project';

export type LoadedWorkflow = {
  readonly definition: WorkflowDefinition;
  readonly prompts: Readonly<Record<string, string>>;
  readonly digest: string;
  readonly stepDigests: Readonly<Record<string, string>>;
  /** Per-step digest excluding only the prompt specification and resolved text. */
  readonly stepStructuralDigests: Readonly<Record<string, string>>;
  readonly sourcePath: string;
  readonly sourceKind: WorkflowSourceKind;
};

export type PermissionCeiling = {
  readonly tools: ReadonlyArray<string>;
  readonly mcp: ReadonlyArray<string>;
  readonly extensions: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly bash: BashPermission;
};

export type WorkflowSettings = {
  readonly version: typeof WORKFLOW_SCHEMA_VERSION;
  readonly allowProjectWorkflows: boolean;
  readonly statusShortcut: KeyId;
  readonly permissionCeiling?: PermissionCeiling;
};

export type ConfigDiagnostic = {
  readonly level: 'warning' | 'error';
  readonly path: string;
  readonly message: string;
};

export type WorkflowCatalog = {
  readonly workflows: ReadonlyMap<string, LoadedWorkflow>;
  readonly settings: WorkflowSettings;
  readonly diagnostics: ReadonlyArray<ConfigDiagnostic>;
  readonly userDirectory: string;
  readonly projectDirectory?: string;
};

export const EMPTY_PERMISSIONS = {
  tools: [],
  mcp: [],
  extensions: [],
  skills: [],
  bash: { mode: 'deny', allow: [] },
} as const satisfies StepPermissions;

export const EMPTY_REQUIREMENTS = {
  tools: [],
  extensions: [],
  skills: [],
} as const satisfies StepRequirements;

export const DEFAULT_SETTINGS = {
  version: WORKFLOW_SCHEMA_VERSION,
  allowProjectWorkflows: false,
  statusShortcut: DEFAULT_STATUS_SHORTCUT,
} as const satisfies WorkflowSettings;
