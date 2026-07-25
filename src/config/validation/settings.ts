import {
  DEFAULT_SETTINGS,
  WORKFLOW_SCHEMA_VERSION,
  type PermissionCeiling,
  type WorkflowSettings,
} from '../types.ts';
import { parsePermissions } from './permissions.ts';
import {
  isJsonObject,
  rejectUnknownKeys,
  type ValidationErrors,
  type ValidationResult,
} from './shared.ts';
import { readStatusShortcut } from './shortcut.ts';
import { parseSubagentPermissionCeiling } from './subagent.ts';

function parsePermissionCeiling(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): PermissionCeiling | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    errors.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(
    value,
    ['tools', 'mcp', 'extensions', 'skills', 'bash', 'subagent'],
    path,
    errors,
  );
  const permissions = parsePermissions(
    {
      ...(value.tools !== undefined ? { tools: value.tools } : {}),
      ...(value.mcp !== undefined ? { mcp: value.mcp } : {}),
      ...(value.extensions !== undefined
        ? { extensions: value.extensions }
        : {}),
      ...(value.skills !== undefined ? { skills: value.skills } : {}),
      ...(value.bash !== undefined ? { bash: value.bash } : {}),
    },
    path,
    errors,
  );
  const subagent =
    value.subagent === undefined
      ? undefined
      : parseSubagentPermissionCeiling(
          value.subagent,
          `${path}.subagent`,
          errors,
        );
  return {
    ...permissions,
    ...(subagent ? { subagent } : {}),
  };
}

/** Validate and normalize untrusted user workflow settings. */
export function validateSettings(
  value: unknown,
): ValidationResult<WorkflowSettings> {
  const errors: ValidationErrors = [];
  if (!isJsonObject(value)) {
    return { errors: ['settings: expected an object'] };
  }
  rejectUnknownKeys(
    value,
    [
      '$schema',
      'version',
      'allowProjectWorkflows',
      'statusShortcut',
      'permissionCeiling',
    ],
    'settings',
    errors,
  );
  if (value.$schema !== undefined && typeof value.$schema !== 'string') {
    errors.push('settings.$schema: expected a string');
  }
  if (value.version !== WORKFLOW_SCHEMA_VERSION) {
    errors.push(`settings.version: expected ${WORKFLOW_SCHEMA_VERSION}`);
  }
  const allowProjectWorkflows =
    typeof value.allowProjectWorkflows === 'boolean'
      ? value.allowProjectWorkflows
      : false;
  if (
    value.allowProjectWorkflows !== undefined &&
    typeof value.allowProjectWorkflows !== 'boolean'
  ) {
    errors.push('settings.allowProjectWorkflows: expected a boolean');
  }
  const statusShortcut = readStatusShortcut(
    value.statusShortcut,
    'settings.statusShortcut',
    errors,
  );
  const permissionCeiling = parsePermissionCeiling(
    value.permissionCeiling,
    'settings.permissionCeiling',
    errors,
  );
  if (allowProjectWorkflows && !permissionCeiling) {
    errors.push(
      'settings.permissionCeiling: required when project workflows are enabled',
    );
  }
  if (errors.length > 0) return { errors };

  return {
    value: {
      ...DEFAULT_SETTINGS,
      allowProjectWorkflows,
      statusShortcut,
      ...(permissionCeiling ? { permissionCeiling } : {}),
    },
    errors,
  };
}
