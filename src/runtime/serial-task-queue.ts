/**
 * Minimal functional surface for serial task execution.
 */
export type SerialTaskQueueController = {
  /** Enqueues a task and returns its eventual result. */
  readonly run: <TResult>(task: () => Promise<TResult>) => Promise<TResult>;
};

const settleTask = async (taskResult: Promise<unknown>): Promise<void> => {
  try {
    await taskResult;
  } catch {
    // The original promise is returned to the caller; only the queue tail recovers.
  }
};

/**
 * Creates a closure-based queue that serializes asynchronous state changes.
 *
 * A rejected task does not poison the queue; later tasks still execute.
 *
 * @returns A serial task queue controller.
 */
export function createSerialTaskQueue(): SerialTaskQueueController {
  let tail = Promise.resolve();

  const run = <TResult>(task: () => Promise<TResult>): Promise<TResult> => {
    const result = tail.then(task, task);
    tail = settleTask(result);
    return result;
  };

  return { run };
}

/**
 * Compatibility facade for callers that construct a serial queue with `new`.
 */
export class SerialTaskQueue implements SerialTaskQueueController {
  private readonly controller: SerialTaskQueueController;

  /** Creates an isolated serial task queue. */
  constructor() {
    this.controller = createSerialTaskQueue();
  }

  /**
   * Enqueues one asynchronous task after all previously submitted tasks.
   *
   * @param task - State-changing operation to serialize.
   * @returns The task result or rejection.
   */
  run<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    return this.controller.run(task);
  }
}
