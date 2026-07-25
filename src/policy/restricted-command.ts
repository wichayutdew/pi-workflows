import type { RestrictedCommandTokens } from './bash-types.ts';

const UNQUOTED_SHELL_METACHARACTERS: ReadonlySet<string> = new Set([
  ';',
  '&',
  '|',
  '<',
  '>',
  '\n',
  '\r',
  '`',
  '$',
  '(',
  ')',
  '{',
  '}',
  '#',
  '\0',
]);
const PATHNAME_EXPANSION_CHARACTERS: ReadonlySet<string> = new Set([
  '*',
  '?',
  '[',
  ']',
  '~',
]);

type Quote = "'" | '"';

const invalidCharacter = (character: string): string | undefined => {
  if (character === '\n' || character === '\r' || character === '\0') {
    return 'multiline and null characters are not allowed';
  }
  return undefined;
};

/**
 * Tokenizes the deliberately small shell subset accepted by restricted modes.
 *
 * Shell operators, substitutions, expansions, and comments are rejected
 * before authorization rules are evaluated.
 *
 * @param command - Command text to tokenize.
 * @returns Parsed tokens or a validation error.
 */
export const tokenizeRestrictedCommand = (
  command: string,
): RestrictedCommandTokens => {
  if (!command.trim()) return { error: 'empty Bash command' };

  const tokens: Array<string> = [];
  let token = '';
  let quote: Quote | undefined;
  let isEscaping = false;
  let isTokenStarted = false;

  for (const character of command) {
    if (quote === "'") {
      const error = invalidCharacter(character);
      if (error) return { error };

      if (character === "'") {
        quote = undefined;
      } else {
        token += character;
      }
      isTokenStarted = true;
      continue;
    }

    if (quote === '"') {
      const error = invalidCharacter(character);
      if (error) return { error };

      if (character === '"') {
        quote = undefined;
      } else if (character === '$' || character === '`' || character === '\\') {
        return {
          error:
            'substitutions and escapes are not allowed inside double quotes',
        };
      } else {
        token += character;
      }
      isTokenStarted = true;
      continue;
    }

    if (isEscaping) {
      const error = invalidCharacter(character);
      if (error) return { error };

      token += character;
      isEscaping = false;
      isTokenStarted = true;
      continue;
    }

    if (character === '\\') {
      isEscaping = true;
      isTokenStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      isTokenStarted = true;
      continue;
    }

    if (UNQUOTED_SHELL_METACHARACTERS.has(character)) {
      return {
        error:
          'shell operators, substitutions, expansions, and comments are not allowed',
      };
    }

    if (PATHNAME_EXPANSION_CHARACTERS.has(character)) {
      return {
        error: 'unquoted pathname and tilde expansion are not allowed',
      };
    }

    if (/\s/u.test(character)) {
      if (isTokenStarted) {
        tokens.push(token);
        token = '';
        isTokenStarted = false;
      }
      continue;
    }

    token += character;
    isTokenStarted = true;
  }

  if (isEscaping) return { error: 'trailing Bash escape is not allowed' };
  if (quote) return { error: 'unterminated Bash quote' };
  if (isTokenStarted) tokens.push(token);
  return tokens.length > 0 ? { tokens } : { error: 'empty Bash command' };
};
