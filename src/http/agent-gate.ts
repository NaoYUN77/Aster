/**
 * One in-process serialization point for everything that writes through the durable harness.
 *
 * The harness and the SQLite storage behind it are not written concurrently: a user reply, a
 * routine run and a host notification all take this gate. A reminder arriving during a long model
 * reply therefore waits for that reply instead of opening a second writer; the delay is bounded by
 * the request timeout.
 */
export class AgentGate {
  #tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
