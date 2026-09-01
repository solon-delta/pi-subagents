export interface RunQueue {
  /**
   * Take one run. It starts at once when a slot is free, and waits otherwise.
   * Returns true when the run started at once.
   */
  add(start: () => Promise<void>): boolean;
}

interface Waiting {
  start: () => Promise<void>;
}

/** Run at most `limit` children at the same time. The rest wait in arrival order. */
export function createRunQueue(limit: number): RunQueue {
  const waiting: Waiting[] = [];
  let running = 0;

  const pump = (): void => {
    while (running < limit) {
      const next = waiting.shift();
      if (next === undefined) return;

      running += 1;
      const free = (): void => {
        running -= 1;
        pump();
      };
      // A start that throws must free its slot too. The executor turns that
      // throw into a rejection, and it still calls start right now.
      void new Promise<void>((resolve) => resolve(next.start())).then(free, free);
    }
  };

  return {
    add(start) {
      const item: Waiting = { start };
      waiting.push(item);
      pump();
      // pump takes the run out of the list when it starts it.
      return !waiting.includes(item);
    },
  };
}
