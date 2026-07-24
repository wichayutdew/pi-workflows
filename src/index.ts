import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { WorkflowHarness } from './harness.ts';
import { registerSubagentChildRuntime } from './integrations/subagents/child-runtime.ts';
import { isSubagentRuntimeName } from './integrations/subagents/protocol.ts';

export default function piWorkflowsExtension(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === '1') {
    const childAgent = process.env.PI_SUBAGENT_CHILD_AGENT?.trim();
    if (isSubagentRuntimeName(childAgent)) {
      registerSubagentChildRuntime(pi, { childAgent });
    }
    return;
  }
  new WorkflowHarness(pi);
}
