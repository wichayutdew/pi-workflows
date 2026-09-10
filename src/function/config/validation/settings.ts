import {
  DEFAULT_SETTINGS,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowSettings,
} from '../../../domain/index.ts';
import {
  isJsonObject,
  rejectUnknownKeys,
  type ValidationErrors,
  type ValidationResult,
} from './shared.ts';
import { readStatusShortcut } from './shortcut.ts';

/** Validate and normalize user-owned workflow settings. */
export function validateSettings(
  value: unknown,
): ValidationResult<WorkflowSettings> {
  const errors: ValidationErrors = [];
  if (!isJsonObject(value)) {
    return { errors: ['settings: expected an object'] };
  }
  rejectUnknownKeys(value, ['$schema', 'version', 'statusShortcut'], 'settings', errors);
  if (value.$schema !== undefined && typeof value.$schema !== 'string') {
    errors.push('settings.$schema: expected a string');
  }
  if (value.version !== WORKFLOW_SCHEMA_VERSION) {
    errors.push(`settings.version: expected ${WORKFLOW_SCHEMA_VERSION}`);
  }
  const statusShortcut = readStatusShortcut(
    value.statusShortcut,
    'settings.statusShortcut',
    errors,
  );
  if (errors.length > 0) return { errors };
  return { value: { ...DEFAULT_SETTINGS, statusShortcut }, errors };
}
