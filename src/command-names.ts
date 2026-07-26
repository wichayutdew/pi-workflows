/**
 * Slash commands owned by the workflow harness.
 */
export const HARNESS_COMMAND_NAMES = [
  'workflow-abort',
  'workflow-doctor',
  'workflow-list',
  'workflow-pause',
  'workflow-reload',
  'workflow-resume',
  'workflow-start',
] as const;

/**
 * Interactive commands handled by Pi before extension command dispatch.
 * Hidden diagnostic commands are included because an alias cannot reach them.
 */
export const PI_BUILTIN_COMMAND_NAMES = [
  'arminsayshi',
  'changelog',
  'clone',
  'compact',
  'copy',
  'debug',
  'dementedelves',
  'export',
  'fork',
  'hotkeys',
  'import',
  'login',
  'logout',
  'model',
  'name',
  'new',
  'quit',
  'reload',
  'resume',
  'scoped-models',
  'session',
  'settings',
  'share',
  'tree',
  'trust',
] as const;

/**
 * Command names that workflow aliases may not shadow.
 */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  ...HARNESS_COMMAND_NAMES,
  ...PI_BUILTIN_COMMAND_NAMES,
]);
