import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defaultUserWorkflowDirectory, loadSettings } from './config/load.ts';
import { WorkflowHarness } from './harness.ts';
import { registerSubagentChildRuntime } from './integrations/subagents/child-runtime.ts';
import { isSubagentRuntimeName } from './integrations/subagents/protocol.ts';

export default async function piWorkflowsExtension(
  pi: ExtensionAPI,
): Promise<void> {
  if (process.env.PI_SUBAGENT_CHILD === '1') {
    const childAgent = process.env.PI_SUBAGENT_CHILD_AGENT?.trim();
    if (isSubagentRuntimeName(childAgent)) {
      registerSubagentChildRuntime(pi, { childAgent });
    }
    return;
  }
  const { settings } = await loadSettings(defaultUserWorkflowDirectory());
  new WorkflowHarness(pi, settings.statusShortcut);
}
