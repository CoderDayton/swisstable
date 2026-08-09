#!/usr/bin/env bun
/**
 * Builds the modules with UndefinedBehaviorSanitizer in trapping mode and
 * drives them through a workload that reaches every path the shipped build
 * takes: growth, in-place compaction, tombstone reuse, the SIMD group scan,
 * and the u64 bulk API.
 *
 * Trapping mode lowers each UBSan report to an `unreachable` instruction, so
 * it needs no runtime and links under -nostdlib. Undefined behaviour that
 * the optimizer would otherwise be free to assume away — a signed overflow,
 * a shift past the word width, a misaligned load — surfaces here as a
 * WebAssembly trap instead of as a miscompile nobody notices.
 *
 * The workload runs against the raw exports rather than the bindings, and
 * checks every answer against a JavaScript Map, so a trap and a wrong result
 * are both failures. Shipped modules are built without this: a trap aborts
 * the instance, which is a worse production outcome than the arithmetic that
 * provoked it.
 *
 *     bun run check:ubsan
 */

import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BUILD_DIR = join(ROOT, "dist", "wasm-ubsan");

/** Operations per module. Large enough to cross several rehashes. */
const OPERATIONS = 400_000;

/**
 * Key space, chosen well below OPERATIONS so keys repeat: overwrites,
 * deletes of live keys, and re-inserts into tombstoned slots are the paths
 * a purely-increasing key sequence would never reach.
 */
const KEY_SPACE = 120_000;

/** How often the whole table is walked and compared against the Map. */
const SCAN_INTERVAL = 100_000;

/** Keys per bulk batch, clamped to what the module reports it can stage. */
const BATCH = 4_096;

/** Bulk batches issued per module, each staged with fresh random keys. */
const BULK_ROUNDS = 16;

const SET_SHARE = 0.55;
const GET_SHARE = 0.85;

const STATUS_OK = 0;

/**
 * What `delete_many` returns when it rejects its arguments. It reports a
 * removal count otherwise, so it has no room for a negative status.
 */
const DELETE_MANY_FAILED = -1;

/** xorshift32, so a failure reproduces from the seed alone. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>>= 0);
  };
}

function build(): void {
  const result = Bun.spawnSync(
    [process.execPath, "run", join(import.meta.dir, "build-wasm.ts")],
    {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...Bun.env, SWISS_UBSAN: "1" },
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(`checked build failed with exit ${result.exitCode}`);
  }
}

/** The engine both modules share, as the raw module exports it. */
interface TableExports {
  readonly memory: WebAssembly.Memory;
  init(expectedEntries: number): number;
  has_get(key: number): number;
  delete_key(key: number): number;
  shrink_to_fit(): number;
  clear(): void;
  size(): number;
  capacity(): number;
  scan(cursor: number): number;
  scan_window(): number;
  scan_keys_ptr(): number;
  last_value_ptr(): number;
}

interface U32Exports extends TableExports {
  set(key: number, value: number): number;
  get_or_insert(key: number, value: number): number;
  increment(key: number, delta: number): number;
  set_many(keys: number, values: number, count: number): number;
  get_many(
    keys: number,
    values: number,
    found: number,
    count: number,
  ): number;
  delete_many(keys: number, deleted: number, count: number): number;
  bulk_capacity(): number;
  bulk_keys_ptr(): number;
  bulk_values_ptr(): number;
  bulk_flags_ptr(): number;
  scan_values_ptr(): number;
}

interface U64Exports extends TableExports {
  set(key: number, lo: number, hi: number): number;
  set_many(keys: number, lo: number, hi: number, count: number): number;
  get_many(
    keys: number,
    lo: number,
    hi: number,
    found: number,
    count: number,
  ): number;
  delete_many(keys: number, deleted: number, count: number): number;
  bulk_capacity(): number;
  bulk_keys_ptr(): number;
  bulk_vals_lo_ptr(): number;
  bulk_vals_hi_ptr(): number;
  bulk_flags_ptr(): number;
  scan_vals_lo_ptr(): number;
  scan_vals_hi_ptr(): number;
}

async function instantiate<T extends TableExports>(name: string): Promise<T> {
  const path = join(BUILD_DIR, `${name}.wasm`);
  const { instance } = await WebAssembly.instantiate(
    await Bun.file(path).arrayBuffer(),
    {},
  );
  return instance.exports as unknown as T;
}

/** Fails with the module and operation that produced the wrong answer. */
function assert(condition: boolean, module: string, detail: string): void {
  if (!condition) throw new Error(`${module}: ${detail}`);
}

/**
 * Walks every slot and checks the entries staged out against `expected`,
 * which catches a scan that drops, duplicates, or corrupts an entry —
 * none of which a per-key lookup would notice.
 */
function checkScan(
  module: string,
  wasm: TableExports,
  expected: ReadonlyMap<number, number>,
  read: (index: number) => [key: number, value: number],
): void {
  const window = wasm.scan_window();
  const capacity = wasm.capacity();
  const seen = new Set<number>();

  for (let cursor = 0; cursor < capacity; cursor += window) {
    const count = wasm.scan(cursor) as number;
    assert(count >= 0, module, `scan(${cursor}) returned ${count}`);

    for (let i = 0; i < count; i++) {
      const [key, value] = read(i);
      assert(!seen.has(key), module, `scan reported key ${key} twice`);
      seen.add(key);
      assert(
        expected.get(key) === value,
        module,
        `scan gave ${key} => ${value}, expected ${expected.get(key)}`,
      );
    }
  }

  assert(
    seen.size === expected.size,
    module,
    `scan found ${seen.size} entries, expected ${expected.size}`,
  );
}

async function exerciseU32(): Promise<number> {
  const module = "swiss_u32";
  const wasm = await instantiate<U32Exports>(module);
  const memory = new DataView(wasm.memory.buffer);

  assert(wasm.init(0) === STATUS_OK, module, "init failed");

  const lastValue = wasm.last_value_ptr();
  const keysPtr = wasm.scan_keys_ptr();
  const valuesPtr = wasm.scan_values_ptr();
  const readStaged = (i: number): [number, number] => [
    memory.getUint32(keysPtr + i * 4, true),
    memory.getUint32(valuesPtr + i * 4, true),
  ];

  const next = random(0x5f3759df);
  const expected = new Map<number, number>();

  for (let op = 0; op < OPERATIONS; op++) {
    const key = next() % KEY_SPACE;
    const roll = next() / 0x1_0000_0000;

    if (roll < SET_SHARE) {
      const value = next();
      assert(wasm.set(key, value) === STATUS_OK, module, `set(${key}) failed`);
      expected.set(key, value);
    } else if (roll < GET_SHARE) {
      const found = wasm.has_get(key) === 1;
      assert(found === expected.has(key), module, `has_get(${key}) disagreed`);
      if (found) {
        assert(
          memory.getUint32(lastValue, true) === expected.get(key),
          module,
          `has_get(${key}) latched the wrong value`,
        );
      }
    } else {
      const removed = wasm.delete_key(key) === 1;
      assert(removed === expected.has(key), module, `delete(${key}) disagreed`);
      expected.delete(key);
    }

    if (op % SCAN_INTERVAL === SCAN_INTERVAL - 1) {
      checkScan(module, wasm, expected, readStaged);
    }
  }

  // Capacity only ever rises during the loop above, so the compaction path
  // is unreachable there and gets its own call.
  assert(wasm.shrink_to_fit() === STATUS_OK, module, "shrink_to_fit failed");
  checkScan(module, wasm, expected, readStaged);

  exerciseU32Upserts(wasm, memory, next, expected);
  checkScan(module, wasm, expected, readStaged);

  exerciseU32Bulk(wasm, memory, next, expected);
  checkScan(module, wasm, expected, readStaged);

  wasm.clear();
  assert(wasm.size() === 0, module, "clear left entries behind");

  return OPERATIONS;
}

/**
 * Drives get_or_insert and increment.
 *
 * Both take the same probe and growth path as set, but reach it through
 * upsert_slot_tracked and write the latch slot, so neither is covered by the
 * random set/get/delete loop.
 */
function exerciseU32Upserts(
  wasm: U32Exports,
  memory: DataView,
  next: () => number,
  expected: Map<number, number>,
): void {
  const module = "swiss_u32";
  const lastValue = wasm.last_value_ptr();

  for (let op = 0; op < OPERATIONS / 4; op++) {
    const key = next() % KEY_SPACE;

    if (next() % 2 === 0) {
      const seeded = next();
      assert(
        wasm.get_or_insert(key, seeded) === STATUS_OK,
        module,
        `get_or_insert(${key}) failed`,
      );
      const stored = expected.has(key) ? expected.get(key)! : seeded;
      expected.set(key, stored);
      assert(
        memory.getUint32(lastValue, true) === stored,
        module,
        `get_or_insert(${key}) latched the wrong value`,
      );
    } else {
      const delta = next();
      assert(
        wasm.increment(key, delta) === STATUS_OK,
        module,
        `increment(${key}) failed`,
      );
      const stored = ((expected.get(key) ?? 0) + delta) >>> 0;
      expected.set(key, stored);
      assert(
        memory.getUint32(lastValue, true) === stored,
        module,
        `increment(${key}) latched the wrong value`,
      );
    }
  }
}

/**
 * Drives the bulk exports, whose staging-buffer indexing by a
 * caller-supplied count is the arithmetic most worth running under the
 * checks.
 */
function exerciseU32Bulk(
  wasm: U32Exports,
  memory: DataView,
  next: () => number,
  expected: Map<number, number>,
): void {
  const module = "swiss_u32";
  const batch = Math.min(BATCH, wasm.bulk_capacity());
  const bulkKeys = wasm.bulk_keys_ptr();
  const bulkValues = wasm.bulk_values_ptr();
  const bulkFlags = wasm.bulk_flags_ptr();

  for (let round = 0; round < BULK_ROUNDS; round++) {
    const staged = new Map<number, number>();

    for (let i = 0; i < batch; i++) {
      const key = next() % KEY_SPACE;
      const value = next();
      memory.setUint32(bulkKeys + i * 4, key, true);
      memory.setUint32(bulkValues + i * 4, value, true);
      staged.set(key, value);
    }

    assert(
      wasm.set_many(bulkKeys, bulkValues, batch) === STATUS_OK,
      module,
      "set_many failed",
    );
    for (const [key, value] of staged) expected.set(key, value);

    assert(
      wasm.get_many(bulkKeys, bulkValues, bulkFlags, batch) === STATUS_OK,
      module,
      "get_many failed",
    );

    for (let i = 0; i < batch; i++) {
      const key = memory.getUint32(bulkKeys + i * 4, true);
      assert(
        memory.getUint8(bulkFlags + i) === 1,
        module,
        `get_many missed ${key} it had just written`,
      );
      assert(
        memory.getUint32(bulkValues + i * 4, true) === expected.get(key),
        module,
        `get_many gave the wrong value for ${key}`,
      );
    }

    const removed = wasm.delete_many(bulkKeys, bulkFlags, batch);
    assert(
      removed !== DELETE_MANY_FAILED,
      module,
      "delete_many rejected its arguments",
    );
    for (const key of staged.keys()) expected.delete(key);
  }
}

async function exerciseU64(): Promise<number> {
  const module = "swiss_u64";
  const wasm = await instantiate<U64Exports>(module);
  const memory = new DataView(wasm.memory.buffer);

  assert(wasm.init(0) === STATUS_OK, module, "init failed");

  const lastValue = wasm.last_value_ptr();
  const scanKeys = wasm.scan_keys_ptr();
  const scanLo = wasm.scan_vals_lo_ptr();
  const readStaged = (i: number): [number, number] => [
    memory.getUint32(scanKeys + i * 4, true),
    memory.getUint32(scanLo + i * 4, true),
  ];

  const bulkKeys = wasm.bulk_keys_ptr();
  const bulkLo = wasm.bulk_vals_lo_ptr();
  const bulkHi = wasm.bulk_vals_hi_ptr();
  const bulkFlags = wasm.bulk_flags_ptr();
  const batch = Math.min(BATCH, wasm.bulk_capacity());

  const next = random(0x9e3779b9);
  // Only the low lane is compared against; the high lane is derived from it
  // so a batch that crossed the lanes still shows up as a mismatch.
  const expected = new Map<number, number>();
  let operations = 0;

  while (operations < OPERATIONS) {
    const keys = new Uint32Array(batch);
    for (let i = 0; i < batch; i++) keys[i] = next() % KEY_SPACE;

    for (let i = 0; i < batch; i++) {
      memory.setUint32(bulkKeys + i * 4, keys[i]!, true);
      memory.setUint32(bulkLo + i * 4, keys[i]! ^ 0xa5a5a5a5, true);
      memory.setUint32(bulkHi + i * 4, ~keys[i]! >>> 0, true);
    }

    assert(
      wasm.set_many(bulkKeys, bulkLo, bulkHi, batch) === STATUS_OK,
      module,
      "set_many failed",
    );
    for (const key of keys) expected.set(key, (key ^ 0xa5a5a5a5) >>> 0);

    assert(
      wasm.get_many(bulkKeys, bulkLo, bulkHi, bulkFlags, batch) === STATUS_OK,
      module,
      "get_many failed",
    );
    for (let i = 0; i < batch; i++) {
      assert(
        memory.getUint8(bulkFlags + i) === 1 &&
          memory.getUint32(bulkLo + i * 4, true) === expected.get(keys[i]!) &&
          memory.getUint32(bulkHi + i * 4, true) === (~keys[i]! >>> 0),
        module,
        `get_many disagreed on key ${keys[i]}`,
      );
    }

    // A quarter of each batch is removed, so later batches insert into
    // tombstones and eventually provoke an in-place compaction.
    const removals = batch >> 2;
    for (let i = 0; i < removals; i++) {
      memory.setUint32(bulkKeys + i * 4, keys[i]!, true);
    }

    // Every key in the slice was just inserted, so each distinct one is
    // present and removed exactly once — a batch may repeat a key.
    const distinct = new Set(keys.subarray(0, removals)).size;
    const removed = wasm.delete_many(bulkKeys, bulkFlags, removals);
    assert(removed !== DELETE_MANY_FAILED, module, "delete_many was rejected");
    assert(
      removed === distinct,
      module,
      `delete_many removed ${removed}, expected ${distinct}`,
    );
    for (let i = 0; i < removals; i++) expected.delete(keys[i]!);

    // Single-key paths share the engine but not the entry points.
    const key = next() % KEY_SPACE;
    assert(wasm.set(key, key, 0) === STATUS_OK, module, `set(${key}) failed`);
    expected.set(key, key);
    assert(wasm.has_get(key) === 1, module, `has_get(${key}) missed`);
    assert(
      memory.getUint32(lastValue, true) === key,
      module,
      `has_get(${key}) latched the wrong lane`,
    );

    operations += batch * 3;
    checkScan(module, wasm, expected, readStaged);
  }

  assert(wasm.shrink_to_fit() === STATUS_OK, module, "shrink_to_fit failed");
  checkScan(module, wasm, expected, readStaged);

  return operations;
}

build();

for (const exercise of [exerciseU32, exerciseU64]) {
  const started = performance.now();
  const operations = await exercise();
  const elapsed = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `${exercise.name.replace("exercise", "").toLowerCase()}: ` +
      `${operations.toLocaleString()} operations, no trap (${elapsed}s)`,
  );
}

console.log("checked build reported no undefined behaviour");
