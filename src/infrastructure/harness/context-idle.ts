import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { WorkflowHarnessDependencies } from './dependencies.ts';

const CONTEXT_IDLE_TIMEOUT_MS = 30_000;
const CONTEXT_IDLE_POLL_INTERVAL_MS = 10;

/**
 * Waits for an interrupted Pi event context to settle before workflow start.
 */
export async function waitForEventContextIdle(
  context: ExtensionContext,
  dependencies: Pick<WorkflowHarnessDependencies, 'now' | 'waitForDelay'>,
): Promise<void> {
  const deadline = dependencies.now() + CONTEXT_IDLE_TIMEOUT_MS;
  while (!context.isIdle()) {
    if (dependencies.now() >= deadline) {
      throw new Error('Timed out waiting for the interrupted Pi turn to stop');
    }
    await dependencies.waitForDelay(CONTEXT_IDLE_POLL_INTERVAL_MS);
  }
}
