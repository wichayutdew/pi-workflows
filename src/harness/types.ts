import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ChildStepPolicy } from '../integrations/subagents/protocol.ts';

export type ActiveDelegation = {
  requestId: string;
  runId: string;
  stepId: string;
  stepDigest: string;
  sessionEpoch: number;
  resultDirectory: string;
  policy: ChildStepPolicy;
  transcriptTask: string;
  agent: string;
  model?: string;
  progress?: string;
  activityLog?: Array<string>;
  cancelling?: boolean;
};

export type MainStepIdentity = {
  requestId: string;
  runId: string;
  stepId: string;
  stepDigest: string;
  sessionEpoch: number;
};

export type ActivePromptReview = {
  requestId: string;
  runId: string;
  stepId: string;
  sessionEpoch: number;
  abortController: AbortController;
};

export type WorkflowStartContext = {
  context: ExtensionContext;
  skills: () => ReadonlyArray<{ name: string }> | undefined;
  waitForIdle: () => Promise<void>;
};
