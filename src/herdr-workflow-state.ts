import net from 'node:net';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const source = 'herdr:pi-workflows';

type WorkflowState = {
  state: 'working' | 'blocked' | 'completed' | 'interrupted';
  workflowId?: string;
  stepId?: string;
  message?: string;
};

export default function herdrWorkflowState(pi: ExtensionAPI): void {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== '1' || !socketPath || !paneId) return;

  let seq = Date.now() * 1000;
  let last = '';
  pi.events.on('pi-workflows:state', (data: unknown) => {
    if (!data || typeof data !== 'object') return;
    const event = data as WorkflowState;
    if (
      !['working', 'blocked', 'completed', 'interrupted'].includes(event.state)
    )
      return;
    const state =
      event.state === 'working'
        ? 'working'
        : event.state === 'blocked'
          ? 'blocked'
          : 'idle';
    const message =
      event.message ??
      (event.workflowId
        ? `Workflow "${event.workflowId}" ${event.state}`
        : undefined);
    const fingerprint = `${state}:${message ?? ''}`;
    if (fingerprint === last) return;
    last = fingerprint;
    const request = {
      id: `${source}:${Date.now()}:${++seq}`,
      method: 'pane.report_agent',
      params: {
        pane_id: paneId,
        source,
        agent: 'pi-workflows',
        state,
        message,
        seq,
      },
    };
    const socket = net.createConnection(socketPath);
    const timeout = setTimeout(() => socket.destroy(), 1500);
    timeout.unref();
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', () => socket.destroy());
    socket.on('close', () => { clearTimeout(timeout); });
    socket.on('error', () => { clearTimeout(timeout); });
  });
}
