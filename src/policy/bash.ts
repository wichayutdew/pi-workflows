import { basename } from "node:path";
import type { BashPermission, BashRule } from "../config/types.ts";

const SHELL_META = /[;&|<>\n\r`$(){}#\0]/;
const PATHNAME_EXPANSION = new Set(["*", "?", "[", "]", "~"]);
const WRAPPER_COMMANDS = new Set([
  "bash",
  "builtin",
  "command",
  "env",
  "exec",
  "fish",
  "sh",
  "time",
  "xargs",
  "zsh",
]);
const READ_ONLY_EXECUTABLES = new Set([
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "stat",
  "tail",
  "wc",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);
const DANGEROUS_GIT_OPTIONS = [
  "--config-env",
  "--exec",
  "--ext-diff",
  "--open-files-in-pager",
  "--output",
  "--textconv",
];
const DANGEROUS_GIT_SHORT_OPTIONS: ReadonlyArray<{
  subcommand: string;
  option: string;
}> = [
  // `git grep -O<pager>` executes the supplied pager command.
  { subcommand: "grep", option: "-O" },
];

export interface BashAuthorization {
  allowed: boolean;
  reason?: string;
  tokens?: string[];
}

function reject(reason: string): BashAuthorization {
  return { allowed: false, reason };
}

/**
 * Tokenize the deliberately small shell subset accepted by restricted modes.
 * Shell operators, substitutions, expansions, and comments are rejected first.
 */
export function tokenizeRestrictedCommand(command: string): ValidationTokens {
  if (!command.trim()) return { error: "empty Bash command" };
  if (SHELL_META.test(command)) {
    return {
      error: "shell operators, substitutions, expansions, and comments are not allowed",
    };
  }

  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let tokenStarted = false;

  for (const character of command) {
    if (escaping) {
      token += character;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (PATHNAME_EXPANSION.has(character)) {
      return {
        error: "unquoted pathname and tilde expansion are not allowed",
      };
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (escaping) return { error: "trailing Bash escape is not allowed" };
  if (quote) return { error: "unterminated Bash quote" };
  if (tokenStarted) tokens.push(token);
  if (tokens.length === 0) return { error: "empty Bash command" };
  return { tokens };
}

interface ValidationTokens {
  tokens?: string[];
  error?: string;
}

function matchesRule(tokens: readonly string[], rule: BashRule): boolean {
  if (tokens[0] !== rule.executable) return false;
  return rule.argsPrefix.every((expected, index) => tokens[index + 1] === expected);
}

function hasOption(tokens: readonly string[], option: string): boolean {
  return tokens.some((token) => token === option || token.startsWith(`${option}=`));
}

function authorizeReadOnly(tokens: readonly string[]): BashAuthorization {
  const executable = tokens[0] ?? "";
  if (READ_ONLY_EXECUTABLES.has(executable)) {
    if (
      executable === "rg" &&
      (hasOption(tokens, "--pre") || hasOption(tokens, "--pre-glob"))
    ) {
      return reject("rg preprocessors are not allowed in read-only mode");
    }
    return { allowed: true, tokens: [...tokens] };
  }

  if (executable !== "git") {
    return reject(`"${executable}" is not in the read-only Bash preset`);
  }
  const subcommand = tokens[1];
  if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return reject(`git subcommand "${subcommand ?? ""}" is not read-only`);
  }
  const dangerousOption = DANGEROUS_GIT_OPTIONS.find((option) =>
    hasOption(tokens, option),
  );
  if (dangerousOption) {
    return reject(`git option "${dangerousOption}" is not allowed in read-only mode`);
  }
  const dangerousShortOption = DANGEROUS_GIT_SHORT_OPTIONS.find(
    ({ subcommand: matchedSubcommand, option }) =>
      subcommand === matchedSubcommand &&
      tokens.slice(2).some((token) => token === option || token.startsWith(option)),
  );
  if (dangerousShortOption) {
    return reject(
      `git option "${dangerousShortOption.option}" is not allowed in read-only mode`,
    );
  }
  return { allowed: true, tokens: [...tokens] };
}

export function authorizeBash(
  command: string,
  permission: BashPermission,
): BashAuthorization {
  if (permission.mode === "unrestricted") {
    return { allowed: true };
  }
  if (permission.mode === "deny") {
    return reject("Bash is disabled for this workflow step");
  }

  const parsed = tokenizeRestrictedCommand(command);
  if (!parsed.tokens) return reject(parsed.error ?? "invalid Bash command");
  const executable = parsed.tokens[0] ?? "";
  if (WRAPPER_COMMANDS.has(basename(executable))) {
    return reject(`shell wrapper "${executable}" is not allowed in restricted mode`);
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(executable)) {
    return reject("environment assignments are not allowed in restricted mode");
  }

  if (permission.mode === "read-only") {
    return authorizeReadOnly(parsed.tokens);
  }
  const rule = permission.allow.find((candidate) =>
    matchesRule(parsed.tokens ?? [], candidate),
  );
  if (!rule) {
    return reject(`command does not match this step's Bash allow-list`);
  }
  return { allowed: true, tokens: parsed.tokens };
}
