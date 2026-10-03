import assert from "node:assert/strict";
import { test } from "node:test";
import { SpendCapError } from "../dist/index.js";

export function checkpointTests(rail, setup) {
  for (const asynchronous of [false, true]) {
    test(`${rail} checkpoint ${asynchronous ? "rejection" : "throw"} restores capacity for the next purchase`, async t => {
      let fail = true;
      const onPrepared = () => {
        if (!fail) return;
        if (asynchronous) return Promise.reject(new Error("disk full"));
        throw new Error("disk full");
      };
      const f = await setup(t, { maxTotal: "0.001", onPrepared });
      for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(f.buyer.buy(f.topic), /disk full/);
      assert.equal(f.payments(), 0);
      fail = false;
      assert.equal((await f.buyer.buy(f.topic)).amount, "1000");
      await assert.rejects(f.buyer.buy(f.topic), SpendCapError);
      assert.equal(f.payments(), 1);
    });
  }

  for (const restart of [false, true]) {
    test(`${rail} saved checkpoint after failure reserves once on ${restart ? "a new" : "the same"} buyer`, async t => {
      let saved;
      const f = await setup(t, { maxTotal: "0.001", onPrepared: value => { saved = value; throw new Error("disk full"); } });
      await assert.rejects(f.buyer.buy(f.topic), /disk full/);
      assert.equal(f.payments(), 0);
      const buyer = restart ? await f.create({ maxTotal: "0.001" }) : f.buyer;
      if (restart) await f.buyer.close();
      assert.equal((await buyer.resume(saved)).amount, "1000");
      await assert.rejects(buyer.buy(f.topic), SpendCapError);
      assert.equal(f.payments(), 1);
    });
  }

  test(`${rail} failed checkpoint cannot be resumed after another purchase consumes the cap`, async t => {
    let saved;
    let fail = true;
    const f = await setup(t, { maxTotal: "0.001", onPrepared: value => {
      if (fail) { saved = value; throw new Error("disk full"); }
    } });
    await assert.rejects(f.buyer.buy(f.topic), /disk full/);
    fail = false;
    await f.buyer.buy(f.topic);
    await assert.rejects(f.buyer.resume(saved), SpendCapError);
    assert.equal(f.payments(), 1);
  });

  test(`${rail} checkpoint callback cannot resume its payment before saving completes`, async t => {
    let buyer;
    let fail = true;
    const f = await setup(t, { maxTotal: "0.001", onPrepared: async value => {
      if (!fail) return;
      for (const request of [value, { ...value, id: "different-request" }]) {
        await assert.rejects(buyer.resume(request), /checkpoint in progress/);
      }
      throw new Error("disk full");
    } });
    buyer = f.buyer;
    await assert.rejects(buyer.buy(f.topic), /disk full/);
    assert.equal(f.payments(), 0);
    fail = false;
    await buyer.buy(f.topic);
    await assert.rejects(buyer.buy(f.topic), SpendCapError);
    assert.equal(f.payments(), 1);
  });

  test(`${rail} pending checkpoint keeps its reservation until rejection`, async t => {
    let entered;
    let reject;
    let saved;
    let fail = true;
    const ready = new Promise(resolve => { entered = resolve; });
    const f = await setup(t, { maxTotal: "0.001", onPrepared: value => {
      if (!fail) return;
      saved = value;
      entered();
      return new Promise((_, refusal) => { reject = refusal; });
    } });
    const pending = assert.rejects(f.buyer.buy(f.topic), /disk full/);
    await ready;
    try {
      await assert.rejects(f.buyer.buy(f.topic), SpendCapError);
      await assert.rejects(f.buyer.resume(saved), /checkpoint in progress/);
      assert.equal(f.payments(), 0);
    } finally { reject(new Error("disk full")); await pending; }
    fail = false;
    await f.buyer.buy(f.topic);
    await assert.rejects(f.buyer.buy(f.topic), SpendCapError);
    assert.equal(f.payments(), 1);
  });

  test(`${rail} concurrent checkpoint failures restore only their own reservations`, async t => {
    let fail = true;
    const f = await setup(t, { maxTotal: "0.003", onPrepared: async () => {
      if (!fail) return;
      await new Promise(resolve => setTimeout(resolve, 20));
      throw new Error("disk full");
    } });
    await Promise.all(Array.from({ length: 3 }, () => assert.rejects(f.buyer.buy(f.topic), /disk full/)));
    assert.equal(f.payments(), 0);
    fail = false;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => f.buyer.buy(f.topic)));
    assert.equal(results.filter(value => value.status === "fulfilled").length, 3);
    const failures = results.filter(value => value.status === "rejected");
    assert.equal(failures.length, 2);
    assert.ok(failures.every(value => value.reason instanceof SpendCapError));
    assert.equal(f.payments(), 3);
  });
}
