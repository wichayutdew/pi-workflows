import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parses the optional YAML frontmatter and role prompt in one agent profile. */
export function parseAgentProfile(source: string, name: string): AgentProfile {
  if (!source.startsWith('---\n')) return { prompt: source.trim() };
  const end = source.indexOf('\n---\n', 4);
  if (end === -1) {
    throw new Error(`workflow agent profile is invalid: ${name}`);
  }
  const metadata: unknown = parse(source.slice(4, end));
  if (!isRecord(metadata)) {
    throw new Error(
      `workflow agent profile metadata must be an object: ${name}`,
    );
  }
  const unknownKey = Object.keys(metadata).find(
    (key) => key !== 'model' && key !== 'thinking',
  );
  if (unknownKey) {
    throw new Error(
      `workflow agent profile has unknown metadata "${unknownKey}": ${name}`,
    );
  }
  const model = metadata.model;
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
    throw new Error(
      `workflow agent profile model must be a non-empty string: ${name}`,
    );
  }
  const thinking = metadata.thinking;
  if (
    thinking !== undefined &&
    (typeof thinking !== 'string' ||
      !THINKING_LEVELS.includes(thinking as ThinkingLevel))
  ) {
    throw new Error(
      `workflow agent profile thinking must be one of ${THINKING_LEVELS.join(', ')}: ${name}`,
    );
  }
  const prompt = source.slice(end + 5).trim();
  if (!prompt)
    throw new Error(`workflow agent profile prompt is empty: ${name}`);
  return {
    prompt,
    ...(typeof model === 'string' ? { model: model.trim() } : {}),
    ...(typeof thinking === 'string'
      ? { thinking: thinking as ThinkingLevel }
      : {}),
  };
}

const DEFAULT_AGENT_PROFILE_DIRECTORY = join(homedir(), '.agents', 'agents');

/** Loads a user-owned agent profile, with a bundled prompt-only fallback. */
export function loadAgentProfile(
  name: string,
  agentProfileDirectory = DEFAULT_AGENT_PROFILE_DIRECTORY,
): AgentProfile {
  const userPath = join(agentProfileDirectory, `${name}.md`);
  const bundledUrl = new URL(
    `../../../examples/starter-kit/agents/${name}.md`,
    import.meta.url,
  );
  const path = existsSync(userPath) ? userPath : fileURLToPath(bundledUrl);
  try {
    return parseAgentProfile(readFileSync(path, 'utf8'), name);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('workflow agent')) {
      throw error;
    }
    throw new Error(`workflow agent profile is unavailable: ${name}`, {
      cause: error,
    });
  }
}
