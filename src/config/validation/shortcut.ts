import type { WorkflowSettings } from '../types.ts';
import { DEFAULT_STATUS_SHORTCUT } from '../types.ts';
import { readString, type ValidationErrors } from './shared.ts';

const SHORTCUT_MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'super']);
const SHORTCUT_NAMED_KEYS = new Map<string, string>([
  ['escape', 'escape'],
  ['esc', 'esc'],
  ['enter', 'enter'],
  ['return', 'return'],
  ['tab', 'tab'],
  ['space', 'space'],
  ['backspace', 'backspace'],
  ['delete', 'delete'],
  ['insert', 'insert'],
  ['clear', 'clear'],
  ['home', 'home'],
  ['end', 'end'],
  ['pageup', 'pageUp'],
  ['pagedown', 'pageDown'],
  ['up', 'up'],
  ['down', 'down'],
  ['left', 'left'],
  ['right', 'right'],
]);
const SHORTCUT_SYMBOL_KEYS = new Set([
  '`',
  '-',
  '=',
  '[',
  ']',
  '\\',
  ';',
  "'",
  ',',
  '.',
  '/',
  '!',
  '@',
  '#',
  '$',
  '%',
  '^',
  '&',
  '*',
  '(',
  ')',
  '_',
  '|',
  '~',
  '{',
  '}',
  ':',
  '<',
  '>',
  '?',
]);
const MAX_SHORTCUT_CHARS = 64;

function canonicalShortcutKey(value: string): string | undefined {
  if (/^[a-z0-9]$/.test(value) || SHORTCUT_SYMBOL_KEYS.has(value)) {
    return value;
  }
  if (/^f(?:[1-9]|1[0-2])$/.test(value)) return value;
  return SHORTCUT_NAMED_KEYS.get(value);
}

function isStatusShortcut(
  value: string,
): value is WorkflowSettings['statusShortcut'] {
  const parts = value.split('+');
  const key = parts.pop() ?? '';
  return (
    canonicalShortcutKey(key.toLowerCase()) === key &&
    parts.every((modifier) => SHORTCUT_MODIFIERS.has(modifier))
  );
}

/** Parse and normalize the configured workflow status shortcut. */
export function readStatusShortcut(
  value: unknown,
  path: string,
  errors: ValidationErrors,
): WorkflowSettings['statusShortcut'] {
  if (value === undefined) return DEFAULT_STATUS_SHORTCUT;
  const shortcut = readString(value, path, errors);
  if (!shortcut) return DEFAULT_STATUS_SHORTCUT;
  if (shortcut.length > MAX_SHORTCUT_CHARS) {
    errors.push(`${path}: must be at most ${MAX_SHORTCUT_CHARS} characters`);
    return DEFAULT_STATUS_SHORTCUT;
  }

  const parts = shortcut.toLowerCase().split('+');
  const key = parts.pop() ?? '';
  const modifiers = parts;
  const uniqueModifiers = new Set(modifiers);
  const canonicalKey = canonicalShortcutKey(key);
  const isPlainTypingKey =
    modifiers.length === 0 && (key.length === 1 || key === 'space');
  const isUnmatchableModifiedKey =
    modifiers.length > 0 &&
    (key === 'escape' || key === 'esc' || /^f(?:[1-9]|1[0-2])$/.test(key));
  const isInvalid =
    !canonicalKey ||
    modifiers.length > SHORTCUT_MODIFIERS.size ||
    uniqueModifiers.size !== modifiers.length ||
    modifiers.some((modifier) => !SHORTCUT_MODIFIERS.has(modifier)) ||
    isPlainTypingKey ||
    isUnmatchableModifiedKey;

  if (isInvalid) {
    errors.push(`${path}: expected a supported Pi key id such as "ctrl+alt+w"`);
    return DEFAULT_STATUS_SHORTCUT;
  }

  const normalized = [...modifiers, canonicalKey].join('+');
  return isStatusShortcut(normalized) ? normalized : DEFAULT_STATUS_SHORTCUT;
}
