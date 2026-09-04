export { authorizeMcpProxy } from './mcp-authorization.ts';
export { authorizeToolCall } from './tool-auth.ts';
export {
  matchesExtensionSelector,
  resolveActiveTools,
} from './tool-selection.ts';
export type {
  ToolAuthorization,
  ToolInventoryItem,
  ToolSourceInfo,
} from '../../domain/index.ts';
