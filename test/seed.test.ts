import { describe, expect, test } from "bun:test";

import { SwissU32ToU32, SwissU32ToU64 } from "../src/index.ts";

const WASM_PATH = new URL("../dist/wasm/swiss_u32.wasm", import.meta.url);
const wasmFile = Bun.file(WASM_PATH);
const wasmBuilt = await wasmFile.exists();

/** Status the module returns for an argument it will not act on. */
const STATUS_INVALID_ARGUMENT = -3;

/** Keys wide enough that two permutations of them are all but certain to differ. */
const KEYS = Array.from({ length: 512 }, (_, index) => index * 7 + 1);

/**
 * Slot order of a table holding {@link KEYS}.
 *
 * Iteration is slot order, so this is the layout the hash produced —
 * the only externally visible consequence of the seed.
 */
async function layout(seed?: number): Promise<number[]> {
  const table =
    seed === undefined
      ? await SwissU32ToU32.create(1024)
      : await SwissU32ToU32.createWithSeed(1024, seed);

  for (const key of KEYS) table.set(key, key);

  const order = [...table.keys()];
  table.dispose();

  return order;
}

describe("hash seeding", () => {
  test("two tables built with the same seed agree on slot order", async () => {
    expect(await layout(0x5eed_1234)).toEqual(await layout(0x5eed_1234));
  });

  test("two tables built with different seeds do not", async () => {
    expect(await layout(1)).not.toEqual(await layout(2));
  });

  /**
   * The point of the whole change: a key set that collides in one process
   * must not collide in the next.
   *
   * Two random 32-bit seeds coincide once in 2^32, and equal seeds produce
   * equal layouts, so a single pair would be a one-in-four-billion flake.
   * Three independent pairs put that at 2^-96, which is never.
   */
  test("tables built without a seed disagree across instances", async () => {
    const pairs = await Promise.all(
      [0, 1, 2].map(async () => {
        const [first, second] = await Promise.all([layout(), layout()]);
        return first.join() !== second.join();
      }),
    );

    expect(pairs).toContain(true);
  });

  test("a random seed does not disturb the contents", async () => {
    using table = await SwissU32ToU32.create(1024);

    for (const key of KEYS) table.set(key, key * 3);

    expect(table.size).toBe(KEYS.length);
    for (const key of KEYS) expect(table.get(key)).toBe(key * 3);
    expect(table.get(KEYS[0]! + 1)).toBeUndefined();
  });

  test("the seed survives clear(), which re-fills to the same layout", async () => {
    using table = await SwissU32ToU32.createWithSeed(1024, 0xabcd);

    for (const key of KEYS) table.set(key, key);
    const before = [...table.keys()];

    table.clear();
    for (const key of KEYS) table.set(key, key);

    expect([...table.keys()]).toEqual(before);
  });

  test("the seed survives a rehash, which preserves the contents", async () => {
    using table = await SwissU32ToU32.createWithSeed(16, 0x1234_5678);

    for (const key of KEYS) table.set(key, key);
    table.reserve(100_000);

    expect(table.size).toBe(KEYS.length);
    for (const key of KEYS) expect(table.get(key)).toBe(key);
  });

  test("SwissU32ToU64 seeds the same way", async () => {
    const order = async (seed: number) => {
      using table = await SwissU32ToU64.createWithSeed(1024, seed);
      for (const key of KEYS) table.set(key, key, 0);
      return [...table.keys()];
    };

    expect(await order(7)).toEqual(await order(7));
    expect(await order(7)).not.toEqual(await order(8));
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["past u32", 2 ** 32],
    ["not a number", Number.NaN],
  ])("a %s seed is rejected", async (_label, seed) => {
    await expect(SwissU32ToU32.createWithSeed(16, seed)).rejects.toThrow(
      RangeError,
    );
    await expect(SwissU32ToU64.createWithSeed(16, seed)).rejects.toThrow(
      RangeError,
    );
  });
});

// Requires `bun run build`; skipped when the module has not been compiled.
describe.skipIf(!wasmBuilt)("the module's own seeding guard", () => {
  /**
   * Reseeding a table that holds entries would leave every one of them
   * unfindable: their slots were chosen under the old permutation and
   * nothing here rehashes them. The bindings only ever seed before `init`,
   * so this is the module refusing on its own account.
   */
  test("set_seed is refused once the table holds an entry", async () => {
    const bytes = await wasmFile.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes);
    const wasm = instance.exports as unknown as {
      set_seed(seed: number): number;
      init(expectedEntries: number): number;
      set(key: number, value: number): number;
      has(key: number): number;
      clear(): void;
    };

    expect(wasm.set_seed(0x1111)).toBe(0);
    wasm.init(64);
    wasm.set(42, 1);

    expect(wasm.set_seed(0x2222)).toBe(STATUS_INVALID_ARGUMENT);
    expect(wasm.has(42)).toBe(1);

    // Emptied, the table has no placed entry left to invalidate.
    wasm.clear();
    expect(wasm.set_seed(0x2222)).toBe(0);
  });
});
