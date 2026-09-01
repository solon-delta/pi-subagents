export interface RunQueue {
  /** Take one run. It starts at once when a slot is free, and waits otherwise. */
  add(id: string, start: () => Promise<void>): void;
  /** Drop a run that waits. Returns false when the run is not in the queue. */
  stop(id: string): boolean;
}

interface Waiting {
  id: string;
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
    add(id, start) {
      waiting.push({ id, start });
      pump();
    },
    stop(id) {
      const index = waiting.findIndex((item) => item.id === id);
      if (index === -1) return false;
      waiting.splice(index, 1);
      return true;
    },
  };
}
