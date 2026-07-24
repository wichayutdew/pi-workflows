import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';

const APPROVE = 'Approve';
const REQUEST_CHANGES = 'Request changes';
const PAUSE = 'Pause workflow';

export type PromptGateReviewResult =
  | {
      status: 'resolved';
      approved: boolean;
      feedback: string;
    }
  | {
      status: 'dismissed';
    };

export async function requestPromptGateReview(
  ui: ExtensionUIContext,
  title: string,
  artifact: string,
  signal?: AbortSignal,
): Promise<PromptGateReviewResult> {
  const choice = await ui.select(
    `${title}\n\n${artifact}`,
    [APPROVE, REQUEST_CHANGES, PAUSE],
    ...(signal ? [{ signal }] : []),
  );

  if (choice === APPROVE) {
    return { status: 'resolved', approved: true, feedback: '' };
  }
  if (choice !== REQUEST_CHANGES) {
    return { status: 'dismissed' };
  }

  while (true) {
    const feedback = await ui.input(
      'Workflow review feedback',
      'Describe the required changes',
      ...(signal ? [{ signal }] : []),
    );
    if (feedback === undefined) {
      return { status: 'dismissed' };
    }
    if (feedback.trim()) {
      return {
        status: 'resolved',
        approved: false,
        feedback: feedback.trim(),
      };
    }
    ui.notify('Feedback cannot be empty', 'warning');
  }
}
