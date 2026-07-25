export { authorizeMcpProxy } from './mcp-authorization.ts';
export { authorizeToolCall } from './tool-call-authorization.ts';
export {
  matchesExtensionSelector,
  resolveActiveTools,
} from './tool-selection.ts';
export type {
  ToolAuthorization,
  ToolInventoryItem,
  ToolSourceInfo,
} from './tool-types.ts';
