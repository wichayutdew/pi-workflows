/**
 * Pi intentionally lets later extensions mutate tool inputs. Once this harness
 * authorizes a workflow call, freeze the validated argument graph so a later
 * handler cannot change what the tool will execute.
 *
 * @param input - Validated tool input to freeze recursively.
 * @returns The same input after it has been frozen.
 */
export function freezeToolInput<TInput extends object>(input: TInput): TInput {
  const seen = new WeakSet();

  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };

  freeze(input);
  return input;
}
