import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const target = process.env.HERDR_PI_EXTENSION_PATH ?? join(homedir(), '.pi', 'agent', 'extensions', 'herdr-agent-state.ts');
const source = await readFile(target, 'utf8');
if (source.includes('pi-workflows-herdr-lifecycle-patch:start')) {
  console.log(`Herdr workflow patch already present: ${target}`);
  process.exit(0);
}
const state = '  // pi-workflows-herdr-lifecycle-patch:start\n  let workflowActive = false;\n  let workflowMessage: string | undefined;\n  // pi-workflows-herdr-lifecycle-patch:end\n';
const listener = '  // pi-workflows-herdr-lifecycle-patch:start\n  pi.events.on("pi-workflows:state", (data) => {\n    if (!rootSession || !data || typeof data !== "object") return;\n    const event = data as { state?: string; message?: string };\n    workflowActive = event.state === "working";\n    workflowMessage = event.message;\n    publishState();\n  });\n  // pi-workflows-herdr-lifecycle-patch:end\n\n';
let patched = source.replace('  let blockedCount = 0;', `${state}  let blockedCount = 0;`);
patched = patched.replace('    if (agentActive) {\n      return { state: "working" as const, message: undefined };', '    if (agentActive || workflowActive) {\n      return { state: "working" as const, message: workflowMessage };');
patched = patched.replace('    return { state: "idle" as const, message: undefined };', '    return { state: "idle" as const, message: workflowMessage };');
patched = patched.replace('  pi.events.on("herdr:blocked",', `${listener}  pi.events.on("herdr:blocked",`);
if (patched === source) throw new Error(`Unsupported Herdr integration layout: ${target}`);
await writeFile(target, patched);
console.log(`Patched Herdr workflow lifecycle reporting: ${target}`);
