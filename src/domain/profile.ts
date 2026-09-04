export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type AgentProfile = {
  readonly prompt: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
};
