import type { ConfigDiagnostic } from '../../domain/index.ts';

/** Create one normalized configuration diagnostic. */
export function createDiagnostic(
  path: string,
  message: string,
  level: ConfigDiagnostic['level'] = 'error',
): ConfigDiagnostic {
  return { path, message, level };
}

/** Convert any caught value to a stable diagnostic message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read a Node-style string error code without asserting the caught value. */
export function errorCode(error: unknown): string | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    typeof error.code !== 'string'
  ) {
    return undefined;
  }
  return error.code;
}
