/**
 * Pi may dispatch extension commands while another command is awaiting I/O.
 * Serialize state-changing commands while allowing the queue to recover after
 * an individual command rejects.
 */
export class SerialTaskQueue {
  private tail: Promise<void>;

  constructor() {
    this.tail = Promise.resolve();
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
