export const WORKFLOW_SCHEMA_VERSION = 1 as const;
export const SUBAGENT_RUNTIME_NAME_PATTERN =
  /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

export const TERMINAL_TARGETS = ['$done', '$pause'] as const;
export type TerminalTarget = (typeof TERMINAL_TARGETS)[number];
export type StepTarget = string | TerminalTarget;

export type BashMode = 'deny' | 'read-only' | 'allow-list' | 'unrestricted';
export type BashApprovalSource =
  'verification-worker' | 'verification-reviewer' | 'remote-actions';

export interface BashRule {
  executable: string;
  argsPrefix: string[];
}

export interface BashPermission {
  mode: BashMode;
  allow: BashRule[];
  /**
   * Exact commands extracted from the most recent human-approved artifact.
   * They supplement `allow` only inside the correlated step execution.
   */
  approvedSources?: BashApprovalSource[];
}

export interface StepPermissions {
  /** Exact Pi tool names, including direct MCP tools. */
  tools: string[];
  /** MCP proxy selectors in `server` or `server/tool` form. */
  mcp: string[];
  /** Source-name/path fragments whose registered tools may be used. */
  extensions: string[];
  /** Skills the step prompt is allowed to use. */
  skills: string[];
  bash: BashPermission;
}

export interface StepRequirements {
  tools: string[];
  extensions: string[];
  skills: string[];
}

export type SubagentContext = 'fresh';

export interface SubagentTurnBudget {
  maxTurns: number;
  graceTurns?: number;
}

export interface SubagentToolBudget {
  hard: number;
  soft?: number;
  block?: string[] | '*';
}

export interface StepSubagent {
  /** Step specialty label embedded in the isolated child task. */
  agent: string;
  /** Workflow steps always use a fresh context. */
  context: SubagentContext;
  model?: string;
  timeoutMs: number;
  turnBudget?: SubagentTurnBudget;
  toolBudget?: SubagentToolBudget;
  artifacts: boolean;
}

export type PromptSpec = { inline: string } | { file: string };

interface GateDefinition {
  submitOutcome: string;
  approvedOutcome: string;
  rejectedOutcome: string;
}

export interface PromptGate extends GateDefinition {
  provider: 'prompt';
}

export interface PlannotatorGate extends GateDefinition {
  provider: 'plannotator';
  timeoutMs: number;
}

export type WorkflowGate = PromptGate | PlannotatorGate;

export interface WorkflowStep {
  title: string;
  prompt: PromptSpec;
  /** Omit to execute this step in the main Pi agent. */
  subagent?: StepSubagent;
  permissions: StepPermissions;
  requires: StepRequirements;
  transitions: Record<string, StepTarget>;
  gate?: WorkflowGate;
}

export interface WorkflowDefinition {
  version: typeof WORKFLOW_SCHEMA_VERSION;
  id: string;
  command: string;
  description: string;
  start: string;
  maxStepVisits: number;
  summaryMaxChars: number;
  steps: Record<string, WorkflowStep>;
}

export type WorkflowSourceKind = 'user' | 'project';

export interface LoadedWorkflow {
  definition: WorkflowDefinition;
  prompts: Record<string, string>;
  digest: string;
  stepDigests: Record<string, string>;
  sourcePath: string;
  sourceKind: WorkflowSourceKind;
}

export interface PermissionCeiling {
  tools: string[];
  mcp: string[];
  extensions: string[];
  skills: string[];
  bash: BashPermission;
  subagent?: SubagentPermissionCeiling;
}

export interface SubagentPermissionCeiling {
  agents: string[];
  contexts: SubagentContext[];
  models: string[];
  maxTimeoutMs: number;
  maxTurns: number;
  maxGraceTurns: number;
  maxToolCalls: number;
  artifacts: boolean;
}

export interface WorkflowSettings {
  version: typeof WORKFLOW_SCHEMA_VERSION;
  allowProjectWorkflows: boolean;
  permissionCeiling?: PermissionCeiling;
}

export interface ConfigDiagnostic {
  level: 'warning' | 'error';
  path: string;
  message: string;
}

export interface WorkflowCatalog {
  workflows: Map<string, LoadedWorkflow>;
  settings: WorkflowSettings;
  diagnostics: ConfigDiagnostic[];
  userDirectory: string;
  projectDirectory?: string;
}

export const EMPTY_PERMISSIONS: StepPermissions = {
  tools: [],
  mcp: [],
  extensions: [],
  skills: [],
  bash: { mode: 'deny', allow: [] },
};

export const EMPTY_REQUIREMENTS: StepRequirements = {
  tools: [],
  extensions: [],
  skills: [],
};

export const DEFAULT_STEP_SUBAGENT: StepSubagent = {
  agent: 'pi-workflows.step',
  context: 'fresh',
  timeoutMs: 900_000,
  artifacts: false,
};

export const DEFAULT_SETTINGS: WorkflowSettings = {
  version: WORKFLOW_SCHEMA_VERSION,
  allowProjectWorkflows: false,
};
