import { describe, expect, test } from "bun:test";

import {
  InternedSwissMap,
  StringInterner,
  SwissU32ToU32,
} from "../src/index.ts";
import type { NumericKeyTable } from "../src/index.ts";

/**
 * Distinct keys rotated through a map that never holds more than a handful.
 *
 * The leak this covers is in the JavaScript heap, not the table, so it does
 * not need the table's ceiling to show up — it needs far more keys than the
 * map ever holds at once.
 */
const ROTATIONS = 300_000;

/** How many keys are live at any moment during a rotation. */
const WINDOW = 1000;

/** A table that stores nothing and refuses every write. */
function rejectingTable(): NumericKeyTable<number> {
  return {
    size: 0,
    set() {
      throw new RangeError("set exceeded the compiled capacity");
    },
    get: () => undefined,
    has: () => false,
    delete: () => false,
  };
}

describe("StringInterner without recycling", () => {
  test("release is refused, so IDs cannot silently stop being stable", () => {
    const interner = new StringInterner();
    const id = interner.intern("a");

    // Matched on the message: calling a method that does not exist also
    // throws a TypeError, which would satisfy a bare constructor check.
    expect(() => interner.release(id)).toThrow(/recycl/i);
    expect(interner.resolve(id)).toBe("a");
    expect(interner.size).toBe(1);
  });

  test("recyclesIds reports the mode", () => {
    expect(new StringInterner().recyclesIds).toBe(false);
    expect(new StringInterner({ recycleIds: true }).recyclesIds).toBe(true);
  });
});

describe("StringInterner with recycling", () => {
  test("release frees the ID and forgets the string", () => {
    const interner = new StringInterner({ recycleIds: true });
    const id = interner.intern("a");

    expect(interner.release(id)).toBe(true);
    expect(interner.resolve(id)).toBeUndefined();
    expect(interner.lookup("a")).toBeUndefined();
    expect(interner.size).toBe(0);
  });

  test("a released ID is handed to the next new string", () => {
    const interner = new StringInterner({ recycleIds: true });
    interner.intern("a");
    const second = interner.intern("b");

    interner.release(second);

    expect(interner.intern("c")).toBe(second);
    expect(interner.resolve(second)).toBe("c");
    expect(interner.size).toBe(2);
  });

  test("releasing an ID that is not assigned changes nothing", () => {
    const interner = new StringInterner({ recycleIds: true });
    const id = interner.intern("a");

    expect(interner.release(id)).toBe(true);
    expect(interner.release(id)).toBe(false);
    expect(interner.release(999)).toBe(false);
    expect(interner.release(-1)).toBe(false);
    expect(interner.size).toBe(0);

    // The pool must not have gained a duplicate from the refused releases.
    expect(interner.intern("b")).toBe(id);
    expect(interner.intern("c")).not.toBe(id);
  });

  test("the ID space stops growing once IDs come back", () => {
    const interner = new StringInterner({ recycleIds: true });

    for (let i = 0; i < 10_000; i += 1) {
      const id = interner.intern(`key-${i}`);
      interner.release(id);
    }

    expect(interner.size).toBe(0);
    // One ID has served all 10000 strings.
    expect(interner.intern("last")).toBe(0);
  });

  test("interning an existing string still returns its ID, not a pooled one", () => {
    const interner = new StringInterner({ recycleIds: true });
    const kept = interner.intern("kept");
    interner.release(interner.intern("gone"));

    expect(interner.intern("kept")).toBe(kept);
  });

  test("forgetLast rolls back an assignment that came from the pool", () => {
    const interner = new StringInterner({ recycleIds: true });
    interner.intern("a");
    const recycled = interner.intern("b");
    interner.release(recycled);

    // Not the tail ID, so the old tail-only rule would refuse it.
    expect(interner.intern("c")).toBe(recycled);
    expect(interner.forgetLast(recycled)).toBe(true);
    expect(interner.lookup("c")).toBeUndefined();
    expect(interner.size).toBe(1);

    // It went back to the pool rather than being lost.
    expect(interner.intern("d")).toBe(recycled);
  });
});

describe("InternedSwissMap with a recycling interner", () => {
  test("delete returns the ID to the pool", async () => {
    const map = new InternedSwissMap(
      await SwissU32ToU32.create(1000),
      new StringInterner({ recycleIds: true }),
    );

    map.set("x", 1).set("y", 2);
    expect(map.interner.size).toBe(2);

    expect(map.delete("x")).toBe(true);

    expect(map.size).toBe(1);
    expect(map.interner.size).toBe(1);
    expect(map.get("x")).toBeUndefined();
    expect(map.get("y")).toBe(2);
  });

  test("deleteParts returns its ID too", async () => {
    const map = new InternedSwissMap(
      await SwissU32ToU32.create(1000),
      new StringInterner({ recycleIds: true }),
    );

    map.setParts(["a", "b"], 1);
    expect(map.interner.size).toBe(1);

    expect(map.deleteParts(["a", "b"])).toBe(true);
    expect(map.interner.size).toBe(0);
    expect(map.getParts(["a", "b"])).toBeUndefined();
  });

  test("deleting a key that is absent releases nothing", async () => {
    const map = new InternedSwissMap(
      await SwissU32ToU32.create(1000),
      new StringInterner({ recycleIds: true }),
    );

    map.set("x", 1);
    // Interned but never stored, so the table has no entry to remove.
    map.interner.intern("y");

    expect(map.delete("y")).toBe(false);
    expect(map.interner.resolve(map.interner.lookup("y")!)).toBe("y");
    expect(map.interner.size).toBe(2);
  });

  // The ID lifecycle is the map's to run: an ID released behind its back
  // strands the table entry that ID named. The guard is the declared type,
  // so `tsc --noEmit` is what proves this one -- each @ts-expect-error below
  // fails the build if the method becomes reachable through the map again.
  // The map hands back the interner itself rather than a wrapper, so the
  // methods are still there at runtime, and this records that boundary.
  test("does not expose the ID lifecycle through the map", async () => {
    const map = new InternedSwissMap(
      await SwissU32ToU32.create(16),
      new StringInterner({ recycleIds: true }),
    );

    map.set("x", 1);

    // @ts-expect-error release would strand the table entry it named
    const release = map.interner.release;
    // @ts-expect-error forgetLast would strand the table entry it named
    const forgetLast = map.interner.forgetLast;
    // @ts-expect-error claim is the constructor's to call
    const claim = map.interner.claim;

    expect([release, forgetLast, claim].map((m) => typeof m)).toEqual([
      "function",
      "function",
      "function",
    ]);
  });

  test("a rotating key set leaves the interner bounded", async () => {
    const map = new InternedSwissMap(
      await SwissU32ToU32.create(WINDOW * 2),
      new StringInterner({ recycleIds: true }),
    );

    for (let i = 0; i < ROTATIONS; i += 1) {
      map.set(`key-${i}`, i);
      if (i >= WINDOW) map.delete(`key-${i - WINDOW}`);
    }

    expect(map.size).toBe(WINDOW);
    expect(map.interner.size).toBe(WINDOW);
  });

  // Without this the previous test proves nothing: it has to be the
  // recycling that bounds the interner, not the workload.
  test("the same rotation without recycling grows without bound", async () => {
    const map = new InternedSwissMap(await SwissU32ToU32.create(WINDOW * 2));

    for (let i = 0; i < ROTATIONS; i += 1) {
      map.set(`key-${i}`, i);
      if (i >= WINDOW) map.delete(`key-${i - WINDOW}`);
    }

    expect(map.size).toBe(WINDOW);
    expect(map.interner.size).toBe(ROTATIONS);
  });

  test("a rejected write releases the ID it just assigned", async () => {
    const interner = new StringInterner({ recycleIds: true });
    const map = new InternedSwissMap(rejectingTable(), interner);

    expect(() => map.set("x", 1)).toThrow(RangeError);

    expect(interner.size).toBe(0);
    expect(interner.lookup("x")).toBeUndefined();
  });

  // Two maps over one recycling interner would corrupt each other: a delete
  // in the first hands its ID to a new string, and the second map's entry
  // under that ID then answers for a key it never held.
  test("a recycling interner cannot be shared between maps", async () => {
    const interner = new StringInterner({ recycleIds: true });
    const first = new InternedSwissMap(await SwissU32ToU32.create(100), interner);
    const other = await SwissU32ToU32.create(100);

    expect(first.size).toBe(0);
    expect(() => new InternedSwissMap(other, interner)).toThrow(/shared|owner/i);
  });

  test("a non-recycling interner is still shareable", async () => {
    const interner = new StringInterner();
    const first = new InternedSwissMap(await SwissU32ToU32.create(100), interner);
    const second = new InternedSwissMap(await SwissU32ToU32.create(100), interner);

    first.set("a", 1);
    second.set("a", 2);

    expect(first.get("a")).toBe(1);
    expect(second.get("a")).toBe(2);
    expect(interner.size).toBe(1);
  });
});
