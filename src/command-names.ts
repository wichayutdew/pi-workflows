export const HARNESS_COMMAND_NAMES = [
  'workflow-abort',
  'workflow-list',
  'workflow-pause',
  'workflow-reload',
  'workflow-resume',
  'workflow-start',
  'workflow-status',
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

export const RESERVED_COMMAND_NAMES = new Set<string>([
  ...HARNESS_COMMAND_NAMES,
  ...PI_BUILTIN_COMMAND_NAMES,
]);
