/**
 * Pi intentionally lets later extensions mutate tool inputs. Once this harness
 * authorizes a workflow call, freeze the validated argument graph so a later
 * handler cannot change what the tool will execute.
 */
export function freezeToolInput<T extends object>(input: T): T {
  const seen = new WeakSet<object>();

  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };

  freeze(input);
  return input;
}
