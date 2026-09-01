import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { createRunQueue } from "../src/queue.ts";

interface Gate {
  /** True once the queue has started this run. */
  started: boolean;
  /** Ends the run. */
  finish: () => void;
  start: () => Promise<void>;
}

/** A run that the test starts and ends by hand. */
function gate(): Gate {
  const item: Gate = {
    started: false,
    finish: () => {},
    start: () =>
      new Promise<void>((resolve) => {
        item.started = true;
        item.finish = resolve;
      }),
  };
  return item;
}

test("a run below the limit starts at once", () => {
  const queue = createRunQueue(2);
  const first = gate();

  queue.add("a", first.start);

  assert.equal(first.started, true);
});

test("a run above the limit waits for a free slot", async () => {
  const queue = createRunQueue(2);
  const [first, second, third] = [gate(), gate(), gate()];

  queue.add("a", first.start);
  queue.add("b", second.start);
  queue.add("c", third.start);
  assert.equal(third.started, false);

  first.finish();
  await setImmediate();

  assert.equal(third.started, true);
});

test("queued runs start in the order they arrive", async () => {
  const queue = createRunQueue(1);
  const order: string[] = [];
  const gates = new Map(["a", "b", "c", "d"].map((id) => [id, gate()]));

  for (const [id, item] of gates) {
    queue.add(id, async () => {
      order.push(id);
      await item.start();
    });
  }

  for (let step = 0; step < gates.size; step += 1) {
    for (const item of gates.values()) if (item.started) item.finish();
    await setImmediate();
  }

  assert.deepEqual(order, ["a", "b", "c", "d"]);
});

test("a stopped run never starts and leaves the queue", async () => {
  const queue = createRunQueue(1);
  const [first, second, third] = [gate(), gate(), gate()];

  queue.add("a", first.start);
  queue.add("b", second.start);
  queue.add("c", third.start);

  assert.equal(queue.stop("b"), true);
  assert.equal(queue.stop("b"), false, "a run leaves the queue once");
  assert.equal(queue.stop("a"), false, "a running run is not in the queue");

  first.finish();
  await setImmediate();

  assert.equal(second.started, false);
  assert.equal(third.started, true);
});

test("a start that fails frees its slot", async () => {
  const queue = createRunQueue(1);
  const next = gate();

  queue.add("a", () => {
    throw new Error("the child did not start");
  });
  queue.add("b", next.start);
  await setImmediate();

  assert.equal(next.started, true);
});
