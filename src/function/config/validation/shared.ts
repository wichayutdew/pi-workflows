export type ValidationResult<TValue> = {
  readonly value?: TValue;
  readonly errors: ReadonlyArray<string>;
};

export type JsonObject = Record<string, unknown>;
export type ValidationErrors = Array<string>;

export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const OUTCOME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const TOOL_PATTERN = /^[A-Za-z0-9_.:-]+$/;
export const RESOURCE_SELECTOR_PATTERN = /^[A-Za-z0-9_@./:+-]+$/;
export const MCP_SELECTOR_PATTERN = /^[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)?$/;
export const EXECUTABLE_PATTERN = /^[A-Za-z0-9_./+-]+$/;

type StringOptions = {
  readonly pattern?: RegExp;
};

type IntegerLimits = {
  readonly min: number;
  readonly max: number;
};

/** Return whether an unknown value is a plain JSON-style object. */
export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Append diagnostics for object properties outside the supplied allow-list. */
export function rejectUnknownKeys(
  value: JsonObject,
  allowed: ReadonlyArray<string>,
  path: string,
  errors: ValidationErrors,
): void {
  const allowedKeys = new Set(allowed);
  Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .forEach((key) => errors.push(`${path}: unknown property "${key}"`));
}

/** Parse and normalize a string, collecting a diagnostic when it is invalid. */
export function readString(
  value: unknown,
  path: string,
  errors: ValidationErrors,
  options: StringOptions = {},
): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${path}: expected a string`);
    return undefined;
  }

  const result = value.trim();
  if (result.length === 0) {
    errors.push(`${path}: must not be empty`);
    return undefined;
  }
  if (options.pattern && !options.pattern.test(result)) {
    errors.push(`${path}: invalid value "${result}"`);
    return undefined;
  }
  return result;
}

/** Parse a bounded integer, returning the supplied fallback on invalid input. */
export function readInteger(
  value: unknown,
  fallback: number,
  path: string,
  errors: ValidationErrors,
  limits: IntegerLimits,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < limits.min ||
    value > limits.max
  ) {
    errors.push(
      `${path}: expected an integer from ${limits.min} to ${limits.max}`,
    );
    return fallback;
  }
  return value;
}

/** Parse a boolean, returning the supplied fallback on invalid input. */
export function readBoolean(
  value: unknown,
  fallback: boolean,
  path: string,
  errors: ValidationErrors,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    errors.push(`${path}: expected a boolean`);
    return fallback;
  }
  return value;
}

/** Parse a duplicate-free array of patterned strings. */
export function readStringList(
  value: unknown,
  path: string,
  errors: ValidationErrors,
  pattern: RegExp,
): Array<string> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array of strings`);
    return [];
  }

  return value.reduce<Array<string>>((result, item, index) => {
    const parsed = readString(item, `${path}[${index}]`, errors, { pattern });
    if (!parsed) return result;
    if (result.includes(parsed)) {
      errors.push(`${path}[${index}]: duplicate value "${parsed}"`);
      return result;
    }
    return [...result, parsed];
  }, []);
}
