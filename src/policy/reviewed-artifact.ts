export type ParsedJsonDocuments = {
  readonly documents: ReadonlyArray<unknown>;
  readonly hasMalformedCandidate: boolean;
};

/**
 * Narrows an unknown value to a non-array record.
 *
 * @param value - Value to inspect.
 * @returns `true` when the value is a record.
 */
export const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Parses a complete JSON artifact and JSON fenced blocks while retaining
 * whether any JSON-looking candidate was malformed.
 *
 * @param text - Reviewed artifact text.
 * @returns Parsed documents and malformed-candidate state.
 */
export const parseJsonDocumentsWithValidity = (
  text: string,
): ParsedJsonDocuments => {
  const documents: Array<unknown> = [];
  let hasMalformedCandidate = false;
  const addDocument = (candidate: string): void => {
    try {
      documents.push(JSON.parse(candidate));
    } catch {
      hasMalformedCandidate = true;
    }
  };

  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    addDocument(trimmed);
  }

  const fences = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/giu;
  for (const match of text.matchAll(fences)) {
    const candidate = match[1]?.trim();
    if (candidate) addDocument(candidate);
  }
  return { documents, hasMalformedCandidate };
};

/**
 * Parses all valid JSON documents from a reviewed artifact.
 *
 * @param text - Reviewed artifact text.
 * @returns Valid JSON documents in source order.
 */
export const parseJsonDocuments = (text: string): ReadonlyArray<unknown> =>
  parseJsonDocumentsWithValidity(text).documents;

/**
 * Extracts verification commands for one role from a parsed artifact.
 *
 * @param value - Parsed artifact document.
 * @param role - Verification role whose commands should be returned.
 * @returns Command strings in artifact order.
 */
export const verificationCommands = (
  value: unknown,
  role: 'worker' | 'reviewer',
): Array<string> => {
  if (!isRecord(value) || !Array.isArray(value.repositories)) return [];
  return value.repositories.flatMap((repository) => {
    if (!isRecord(repository) || !Array.isArray(repository[role])) return [];
    return repository[role].flatMap((check) =>
      isRecord(check) && typeof check.command === 'string'
        ? [check.command]
        : [],
    );
  });
};

/**
 * Extracts Bash command actions from a parsed remote-action artifact.
 *
 * @param value - Parsed artifact document.
 * @returns Bash commands in artifact order.
 */
export const remoteActionCommands = (value: unknown): Array<string> => {
  if (!isRecord(value) || !Array.isArray(value.actions)) return [];
  return value.actions.flatMap((action) =>
    isRecord(action) &&
    action.toolName === 'bash' &&
    isRecord(action.input) &&
    typeof action.input.command === 'string'
      ? [action.input.command]
      : [],
  );
};
