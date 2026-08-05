import { describe, expect, test } from "bun:test";

import {
  InternedSwissMap,
  StringInterner,
  SwissU32ToU32,
  SwissU32ToU64,
} from "../src/index.ts";
import type { NumericKeyTable } from "../src/index.ts";

/** Enough keys to span more than one scan window of the underlying table. */
const MANY_KEYS = 100_000;

async function stringMap(): Promise<InternedSwissMap<number>> {
  return new InternedSwissMap(await SwissU32ToU32.create(1000));
}

describe("InternedSwissMap iteration", () => {
  test("forEach reports every key as the string it was interned from", async () => {
    const map = await stringMap();
    map.set("alpha", 1).set("beta", 2).set("gamma", 3);

    const seen = new Map<string, number>();
    map.forEach((value, key) => {
      seen.set(key, value);
    });

    expect(seen).toEqual(
      new Map([
        ["alpha", 1],
        ["beta", 2],
        ["gamma", 3],
      ]),
    );
  });

  test("forEach passes the map itself and honours thisArg", async () => {
    const map = await stringMap();
    map.set("only", 9);

    const context = { tag: "bound" };
    let boundTo: unknown;
    let passed: unknown;

    map.forEach(function (this: unknown, _value, _key, self) {
      boundTo = this;
      passed = self;
    }, context);

    expect(boundTo).toBe(context);
    expect(passed).toBe(map);
  });

  test("forEach rejects a non-function before walking", async () => {
    const map = await stringMap();

    expect(() =>
      (map as unknown as { forEach: (value: unknown) => void }).forEach(42),
    ).toThrow(TypeError);
  });

  test("keys, values, and entries agree with each other", async () => {
    const map = await stringMap();
    map.set("one", 1).set("two", 2).set("three", 3);

    const keys = [...map.keys()].sort();
    const values = [...map.values()].sort((a, b) => a - b);
    const entries = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));

    expect(keys).toEqual(["one", "three", "two"]);
    expect(values).toEqual([1, 2, 3]);
    expect(entries).toEqual([
      ["one", 1],
      ["three", 3],
      ["two", 2],
    ]);
  });

  test("the map is iterable, yielding the same pairs as entries()", async () => {
    const map = await stringMap();
    map.set("x", 10).set("y", 20);

    expect(new Map([...map])).toEqual(new Map([...map.entries()]));
    expect(new Map([...map])).toEqual(
      new Map([
        ["x", 10],
        ["y", 20],
      ]),
    );
  });

  test("an empty map yields nothing", async () => {
    const map = await stringMap();

    expect([...map]).toEqual([]);
    expect([...map.keys()]).toEqual([]);

    let calls = 0;
    map.forEach(() => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  test("a deleted key stops appearing", async () => {
    const map = await stringMap();
    map.set("keep", 1).set("drop", 2);

    map.delete("drop");

    expect([...map.keys()]).toEqual(["keep"]);
  });

  test("covers a map spanning several scan windows", async () => {
    const map = new InternedSwissMap(await SwissU32ToU32.create(MANY_KEYS));

    for (let i = 0; i < MANY_KEYS; i += 1) map.set(`key:${i}`, i);

    const seen = new Set<string>();
    map.forEach((value, key) => {
      seen.add(key);
      expect(key).toBe(`key:${value}`);
    });

    expect(seen.size).toBe(MANY_KEYS);
    expect([...map.keys()].length).toBe(MANY_KEYS);
  });

  test("a composite key comes back in its encoded form", async () => {
    const map = await stringMap();
    map.setParts(["user", "42"], 7);

    // The parts are length-prefixed on the way in, and that encoded string
    // is what was interned — so it is what an ID resolves back to.
    expect([...map.keys()]).toEqual(["4:user2:42"]);
  });

  test("a recycled ID resolves to whichever key currently owns it", async () => {
    const map = new InternedSwissMap(
      await SwissU32ToU32.create(16),
      new StringInterner({ recycleIds: true }),
    );

    map.set("first", 1);
    map.delete("first");
    map.set("second", 2);

    expect([...map.entries()]).toEqual([["second", 2]]);
  });

  test("an ID written behind the map's back is an error, not a silent skip", async () => {
    const table = await SwissU32ToU32.create(16);
    const map = new InternedSwissMap(table);

    map.set("interned", 1);
    // Bypasses interning entirely, so this ID has no string to report.
    table.set(9999, 2);

    expect(() => [...map.keys()]).toThrow(/cannot resolve to a string/);
    expect(() =>
      map.forEach(() => {
        /* the walk should throw before finishing */
      }),
    ).toThrow(/cannot resolve to a string/);
  });

  test("a table without iteration support says so", async () => {
    const inner = await SwissU32ToU32.create(16);

    // A table meeting only the four required methods, which is all an
    // external implementor was ever asked for.
    const minimal: NumericKeyTable<number> = {
      get size() {
        return inner.size;
      },
      set: (key, value) => {
        inner.set(key, value);
      },
      get: (key) => inner.get(key),
      has: (key) => inner.has(key),
      delete: (key) => inner.delete(key),
    };

    const map = new InternedSwissMap(minimal);
    map.set("still", 1);

    expect(map.get("still")).toBe(1);
    expect(() => map.forEach(() => {})).toThrow(/does not support forEach/);
    expect(() => [...map.keys()]).toThrow(/does not support entries/);
  });

  test("works over a u64 table adapted to lanes", async () => {
    const table = await SwissU32ToU64.create(1000);

    const adapted: NumericKeyTable<number> = {
      get size() {
        return table.size;
      },
      set: (key, value) => {
        table.set(key, value, 0);
      },
      get: (key) => table.get(key)?.lo,
      has: (key) => table.has(key),
      delete: (key) => table.delete(key),
      forEach: (callback) => {
        table.forEachLanes((lo, _hi, key) => {
          callback(lo, key);
        });
      },
      entries: function* () {
        for (const [key, lanes] of table.entries()) yield [key, lanes.lo];
      },
    };

    const map = new InternedSwissMap(adapted);
    map.set("a", 1).set("b", 2);

    expect(new Map([...map])).toEqual(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );

    const seen: string[] = [];
    map.forEach((_value, key) => seen.push(key));
    expect(seen.sort()).toEqual(["a", "b"]);
  });
});

describe("SwissU32ToU64.forEachLanes", () => {
  test("passes both lanes, the key, and the table", async () => {
    const table = await SwissU32ToU64.create(100);
    table.set(5, 11, 22);

    const seen: [number, number, number][] = [];
    let passed: unknown;

    table.forEachLanes((lo, hi, key, self) => {
      seen.push([lo, hi, key]);
      passed = self;
    });

    expect(seen).toEqual([[11, 22, 5]]);
    expect(passed).toBe(table);
  });

  test("honours thisArg", async () => {
    const table = await SwissU32ToU64.create(100);
    table.set(1, 1, 1);

    const context = { tag: "bound" };
    let boundTo: unknown;

    table.forEachLanes(function (this: unknown) {
      boundTo = this;
    }, context);

    expect(boundTo).toBe(context);
  });

  test("rejects a non-function before walking", async () => {
    const table = await SwissU32ToU64.create();

    expect(() =>
      (table as unknown as { forEachLanes: (v: unknown) => void }).forEachLanes(
        null,
      ),
    ).toThrow(TypeError);
  });

  test("agrees with forEach over a table spanning several windows", async () => {
    const table = await SwissU32ToU64.create(MANY_KEYS);

    for (let key = 0; key < MANY_KEYS; key += 1) {
      table.set(key, key * 2, key * 3);
    }

    const viaLanes = new Map<number, string>();
    table.forEachLanes((lo, hi, key) => {
      viaLanes.set(key, `${lo}/${hi}`);
    });

    const viaForEach = new Map<number, string>();
    table.forEach((value, key) => {
      viaForEach.set(key, `${value.lo}/${value.hi}`);
    });

    expect(viaLanes.size).toBe(MANY_KEYS);
    expect(viaLanes).toEqual(viaForEach);
  });

  test("a rehash mid-walk is reported", async () => {
    const table = await SwissU32ToU64.create(MANY_KEYS);

    for (let key = 0; key < MANY_KEYS; key += 1) table.set(key, key, key);

    expect(() =>
      table.forEachLanes(() => {
        table.clear();
      }),
    ).toThrow(/rehashed during iteration/);
  });
});
