import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';

const APPROVE = 'Approve';
const REQUEST_CHANGES = 'Request changes';
const PAUSE = 'Pause workflow';

export type PromptGateReviewResult =
  | {
      readonly status: 'resolved';
      readonly approved: boolean;
      readonly feedback: string;
    }
  | {
      readonly status: 'dismissed';
    };

const selectionOptions = (
  signal: AbortSignal | undefined,
): Array<{ signal: AbortSignal }> => (signal ? [{ signal }] : []);

/**
 * Presents a local workflow gate and returns the reviewer's normalized choice.
 */
export const requestPromptGateReview = async (
  ui: ExtensionUIContext,
  title: string,
  artifact: string,
  signal?: AbortSignal,
): Promise<PromptGateReviewResult> => {
  const choice = await ui.select(
    `${title}\n\n${artifact}`,
    [APPROVE, REQUEST_CHANGES, PAUSE],
    ...selectionOptions(signal),
  );

  if (choice === APPROVE) {
    return { status: 'resolved', approved: true, feedback: '' };
  }
  if (choice !== REQUEST_CHANGES) {
    return { status: 'dismissed' };
  }

  let feedback = await ui.input(
    'Workflow review feedback',
    'Describe the required changes',
    ...selectionOptions(signal),
  );
  while (feedback !== undefined && !feedback.trim()) {
    ui.notify('Feedback cannot be empty', 'warning');
    feedback = await ui.input(
      'Workflow review feedback',
      'Describe the required changes',
      ...selectionOptions(signal),
    );
  }
  if (feedback === undefined) return { status: 'dismissed' };
  return {
    status: 'resolved',
    approved: false,
    feedback: feedback.trim(),
  };
};
