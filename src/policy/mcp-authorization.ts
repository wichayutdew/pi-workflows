import type { ToolAuthorization } from './tool-types.ts';

const UNSUPPORTED_MCP_PROXY_FIELDS = [
  'action',
  'connect',
  'describe',
  'search',
  'regex',
  'includeSchemas',
] as const;

const reject = (reason: string): ToolAuthorization => ({
  allowed: false,
  reason,
});

const selectorAllows = (
  selectors: ReadonlyArray<string>,
  server: string,
  tool: string,
): boolean =>
  selectors.some((selector) => {
    const separator = selector.indexOf('/');
    if (separator === -1) return selector === server;
    return (
      selector.slice(0, separator) === server &&
      selector.slice(separator + 1) === tool
    );
  });

/**
 * Authorizes an explicit MCP proxy server and tool selection.
 *
 * Discovery and other broad proxy modes are disabled so selectors cannot be
 * widened at runtime.
 *
 * @param input - MCP proxy input.
 * @param selectors - Allowed `server` or `server/tool` selectors.
 * @returns The authorization decision.
 */
export const authorizeMcpProxy = (
  input: Readonly<Record<string, unknown>>,
  selectors: ReadonlyArray<string>,
): ToolAuthorization => {
  if (selectors.length === 0) {
    return reject('MCP access is disabled for this workflow step');
  }

  const unsupportedMode = UNSUPPORTED_MCP_PROXY_FIELDS.find(
    (field) => input[field] !== undefined,
  );
  if (unsupportedMode) {
    return reject(
      `MCP proxy mode "${unsupportedMode}" is disabled; use an explicit server and tool`,
    );
  }
  if (typeof input.server !== 'string' || !input.server.trim()) {
    return reject('MCP proxy calls must name an explicit server');
  }
  if (typeof input.tool !== 'string' || !input.tool.trim()) {
    return reject('MCP proxy calls must name an explicit tool');
  }

  const server = input.server.trim();
  const tool = input.tool.trim();
  return selectorAllows(selectors, server, tool)
    ? { allowed: true }
    : reject(
        `MCP tool "${server}/${tool}" is not allowed for this workflow step`,
      );
};
