import {
  ScanIterator,
  asCallback,
  asWasmI32,
  assertStatus,
  scanWindows,
} from "./abi.ts";
import type { ScanExports } from "./abi.ts";
import { embeddedModule } from "./embedded.ts";
import { SWISS_U32_WASM_BASE64 } from "./generated/swiss_u32.ts";
import { instantiate } from "./wasm.ts";
import type { WasmSource } from "./wasm.ts";

/**
 * Raw export surface of `swiss_u32.wasm`.
 *
 * This mirrors the `export_name` attributes in `native/swiss_u32.c` and is
 * not part of the published API — use {@link SwissU32ToU32} instead.
 *
 * @internal
 */
export interface SwissU32WasmExports extends ScanExports {
  /** The module's linear memory. Fixed size; never grown. */
  memory: WebAssembly.Memory;

  /** Sizes the table for `expectedEntries` and empties it. */
  init(expectedEntries: number): number;
  /** Grows the table so `entries` fit without a further rehash. */
  reserve(entries: number): number;
  /** Marks every slot empty, retaining the current capacity. */
  clear(): void;

  /** Returns 1 if `key` is present, else 0. */
  has(key: number): number;
  /** Returns 1 and latches the value at `last_value_ptr()`, else 0. */
  has_get(key: number): number;
  /** Address of the latched-result slot, in linear memory. */
  last_value_ptr(): number;
  /** Inserts or overwrites, returning a status code. */
  set(key: number, value: number): number;
  /** Removes `key`, returning 1 if it was present. Named to avoid the C keyword. */
  delete_key(key: number): number;

  /** Stages the live entries in the slot window at `cursor`. */
  scan(cursor: number): number;
  /** Slots one `scan` visits; also the staging length, in entries. */
  scan_window(): number;
  /** Address of the staging key buffer. */
  scan_keys_ptr(): number;
  /** Address of the staging value buffer. */
  scan_values_ptr(): number;
  /** Counter bumped by every rehash, clear, and init. */
  generation(): number;

  /** Number of live entries. */
  size(): number;
  /** Number of allocated slots. */
  capacity(): number;
}

/** One window's worth of staged entries, copied out of the module. */
interface EntryChunk {
  /** Keys, valid up to {@link EntryChunk.count}. */
  readonly keys: Uint32Array;
  /** Values, parallel to {@link EntryChunk.keys}. */
  readonly values: Uint32Array;
  /** How many of the buffers' leading elements are live. */
  count: number;
}

/** The parts of the table an iterator reads. */
interface SwissU32Scan {
  readonly wasm: SwissU32WasmExports;
  readonly scanWindow: number;
  readonly scanKeys: Uint32Array;
  readonly scanValues: Uint32Array;
}

/**
 * Chunk-buffer length for one iterator over `source`.
 *
 * A window is the most a scan can stage, and a table smaller than one is
 * the most it ever will — so iterating ten entries does not allocate for
 * 65536.
 */
function stagedLength(source: SwissU32Scan): number {
  return Math.min(source.scanWindow, source.wasm.capacity() >>> 0);
}

/*
 * The three kinds are separate classes rather than one class with a mode,
 * which is a performance decision and a measured one. A single at() with a
 * branch per kind returns a number down two paths and a pair down the
 * third, and the union costs about 10ns per entry — five times the whole
 * rest of the protocol — because the result record it feeds can no longer
 * be specialised. Split, each at() has one return type and one call site.
 *
 * Each holds its own chunk buffers, filled before any next() that crosses a
 * window boundary returns. That is what lets two iterators over one table
 * be advanced alternately: neither reads the module's staging buffers after
 * its own copy has been taken.
 */

/** Yields each key. */
class KeyIterator extends ScanIterator<number> {
  private readonly keys: Uint32Array;

  constructor(private readonly source: SwissU32Scan) {
    super(source.wasm, source.scanWindow);
    this.keys = new Uint32Array(stagedLength(source));
  }

  protected override receive(count: number): void {
    this.keys.set(this.source.scanKeys.subarray(0, count));
  }

  protected override at(index: number): number {
    return this.keys[index]!;
  }
}

/** Yields each value. Never copies the keys, which it does not read. */
class ValueIterator extends ScanIterator<number> {
  private readonly values: Uint32Array;

  constructor(private readonly source: SwissU32Scan) {
    super(source.wasm, source.scanWindow);
    this.values = new Uint32Array(stagedLength(source));
  }

  protected override receive(count: number): void {
    this.values.set(this.source.scanValues.subarray(0, count));
  }

  protected override at(index: number): number {
    return this.values[index]!;
  }
}

/** Yields each entry as a fresh `[key, value]` pair. */
class EntryIterator extends ScanIterator<[number, number]> {
  private readonly keys: Uint32Array;
  private readonly values: Uint32Array;

  constructor(private readonly source: SwissU32Scan) {
    super(source.wasm, source.scanWindow);
    const staged = stagedLength(source);
    this.keys = new Uint32Array(staged);
    this.values = new Uint32Array(staged);
  }

  protected override receive(count: number): void {
    this.keys.set(this.source.scanKeys.subarray(0, count));
    this.values.set(this.source.scanValues.subarray(0, count));
  }

  protected override at(index: number): [number, number] {
    return [this.keys[index]!, this.values[index]!];
  }
}

/**
 * Exports the binding calls. Every one is listed, not a representative few,
 * so a module missing any of them fails with this TypeError rather than a
 * bare "is not a function" at the first call site that reaches it.
 */
const REQUIRED_U32_EXPORTS = [
  "init",
  "reserve",
  "clear",
  "has",
  "has_get",
  "last_value_ptr",
  "set",
  "delete_key",
  "scan",
  "scan_window",
  "scan_keys_ptr",
  "scan_values_ptr",
  "generation",
  "size",
  "capacity",
] as const satisfies readonly (keyof SwissU32WasmExports)[];

/** Compiles the embedded module once, shared by every {@link SwissU32ToU32.create}. */
const compileEmbedded = embeddedModule(SWISS_U32_WASM_BASE64);

/**
 * WASM-resident SwissTable mapping `uint32_t` keys to `uint32_t` values.
 *
 * Keys, values, control bytes, and probing all live in the module's linear
 * memory. Every method issues exactly one call into WASM and there are no
 * JavaScript callbacks on the hot path.
 *
 * Capacity is fixed at build time: the module is freestanding and has no
 * allocator, so operations that would exceed it throw {@link RangeError}
 * rather than growing.
 *
 * @example
 * ```ts
 * const bytes = await Bun.file("dist/wasm/swiss_u32.wasm").arrayBuffer();
 * const table = await SwissU32ToU32.load(bytes, 100_000);
 *
 * table.set(0xdead_beef, 42);
 * table.get(0xdead_beef); // 42
 * ```
 *
 * @see {@link https://abseil.io/about/design/swisstables} for the design this
 *   implements.
 */
export class SwissU32ToU32 {
  /** The instantiated module. */
  private readonly wasm: SwissU32WasmExports;

  /**
   * View over the module's latched-result slot.
   *
   * Reading the value through linear memory keeps a lookup at one boundary
   * crossing instead of two. The view is built once because the module's
   * memory is fixed and never grows, so the backing buffer is never detached.
   */
  private readonly lastValue: Uint32Array;

  /** Slots one scan call visits, and the length of the staging views. */
  private readonly scanWindow: number;

  /** View over the module's staging key buffer, filled by `scan`. */
  private readonly scanKeys: Uint32Array;

  /** View over the module's staging value buffer, filled by `scan`. */
  private readonly scanValues: Uint32Array;

  private constructor(wasm: SwissU32WasmExports) {
    this.wasm = wasm;
    this.lastValue = new Uint32Array(
      wasm.memory.buffer,
      wasm.last_value_ptr(),
      1,
    );

    this.scanWindow = wasm.scan_window() >>> 0;

    // Every iterator strides by this; a zero would never reach capacity.
    if (this.scanWindow === 0) {
      throw new TypeError("swiss_u32.wasm reported a zero scan window");
    }

    const buffer = wasm.memory.buffer;
    this.scanKeys = new Uint32Array(
      buffer,
      wasm.scan_keys_ptr(),
      this.scanWindow,
    );
    this.scanValues = new Uint32Array(
      buffer,
      wasm.scan_values_ptr(),
      this.scanWindow,
    );
  }

  /**
   * Creates a table from the module compiled into this package.
   *
   * Prefer this over {@link load} unless you need to control how the module
   * is fetched or cached. It needs no `.wasm` file, so it behaves the same
   * on every runtime, and the module is compiled once and shared by every
   * table created this way.
   *
   * @param expectedEntries - Entry count to size the table for up front,
   *   avoiding rehashes during the initial fill.
   * @returns The new table.
   * @throws {RangeError} If `expectedEntries` exceeds the compiled capacity.
   */
  static async create(expectedEntries = 0): Promise<SwissU32ToU32> {
    return SwissU32ToU32.load(await compileEmbedded(), expectedEntries);
  }

  /**
   * Instantiates a caller-supplied `swiss_u32.wasm` and returns a table
   * ready for use.
   *
   * Use this to control loading — streaming compilation, a shared module
   * across workers, a custom asset path. {@link create} covers the common
   * case without a loader.
   *
   * @param wasmBytes - Module bytes, or a module already compiled with
   *   {@link WebAssembly.compile}. Compile once and pass the module when
   *   creating several tables.
   * @param expectedEntries - Entry count to size the table for up front,
   *   avoiding rehashes during the initial fill.
   * @returns The loaded table.
   * @throws {TypeError} If the instance does not export the expected symbols.
   * @throws {RangeError} If `expectedEntries` exceeds the compiled capacity.
   */
  static async load(
    wasmBytes: WasmSource | WebAssembly.Module,
    expectedEntries = 0,
  ): Promise<SwissU32ToU32> {
    const instance = await instantiate(wasmBytes);
    const wasm = instance.exports as unknown as SwissU32WasmExports;

    if (
      !(wasm.memory instanceof WebAssembly.Memory) ||
      !REQUIRED_U32_EXPORTS.every(
        (name) => typeof wasm[name] === "function",
      )
    ) {
      throw new TypeError("Invalid swiss_u32.wasm exports");
    }

    const table = new SwissU32ToU32(wasm);

    assertStatus(
      wasm.init(asWasmI32(expectedEntries, "expectedEntries")),
      "init",
      "SwissU32ToU32",
    );

    return table;
  }

  /** Number of live entries. */
  get size(): number {
    return this.wasm.size() >>> 0;
  }

  /**
   * Number of allocated slots, always a power of two.
   *
   * The table rehashes once live entries reach 7/8 of this.
   */
  get capacity(): number {
    return this.wasm.capacity() >>> 0;
  }

  /**
   * Grows the table so `entries` fit without a further rehash.
   *
   * A no-op when the current capacity already suffices.
   *
   * @param entries - Target live-entry count.
   * @throws {RangeError} If `entries` is not a u32, or exceeds the compiled
   *   capacity.
   */
  reserve(entries: number): void {
    assertStatus(
      this.wasm.reserve(asWasmI32(entries, "entries")),
      "reserve",
      "SwissU32ToU32",
    );
  }

  /**
   * Removes every entry, retaining the current capacity.
   *
   * Reuse the instance across workloads only when the next one is of similar
   * size; the retained capacity is never released.
   */
  clear(): void {
    this.wasm.clear();
  }

  /**
   * Reports whether `key` is present.
   *
   * Prefer {@link SwissU32ToU32.get} when the value is needed too — it costs
   * the same single crossing.
   *
   * @param key - Unsigned 32-bit key.
   * @throws {RangeError} If `key` is not an unsigned 32-bit integer.
   */
  has(key: number): boolean {
    return this.wasm.has(asWasmI32(key, "key")) !== 0;
  }

  /**
   * Returns the value stored for `key`, or `undefined` if absent.
   *
   * @param key - Unsigned 32-bit key.
   * @throws {RangeError} If `key` is not an unsigned 32-bit integer.
   */
  get(key: number): number | undefined {
    if (this.wasm.has_get(asWasmI32(key, "key")) === 0) return undefined;
    return this.lastValue[0]!;
  }

  /**
   * Inserts `key`, or overwrites the value if it is already present.
   *
   * @param key - Unsigned 32-bit key.
   * @param value - Unsigned 32-bit value.
   * @returns This table, for chaining.
   * @throws {RangeError} If either argument is not an unsigned 32-bit
   *   integer, or if the insert would exceed the compiled capacity.
   */
  set(key: number, value: number): this {
    assertStatus(
      this.wasm.set(asWasmI32(key, "key"), asWasmI32(value, "value")),
      "set",
      "SwissU32ToU32",
    );
    return this;
  }

  /**
   * Removes `key`.
   *
   * @param key - Unsigned 32-bit key.
   * @returns `true` if the key was present.
   * @throws {RangeError} If `key` is not an unsigned 32-bit integer.
   */
  delete(key: number): boolean {
    return this.wasm.delete_key(asWasmI32(key, "key")) !== 0;
  }

  /** The scan state an iterator needs, bundled without exposing it. */
  private scanSource(): SwissU32Scan {
    return {
      wasm: this.wasm,
      scanWindow: this.scanWindow,
      scanKeys: this.scanKeys,
      scanValues: this.scanValues,
    };
  }

  /**
   * Walks the table one slot window at a time, yielding the chunk each scan
   * staged.
   *
   * The yielded object is reused across chunks — every public iterator
   * consumes one fully before asking for the next — but its buffers belong
   * to this generator alone. That is what keeps two open iterators from
   * seeing each other's scan, and what makes a bulk call issued between two
   * `next()`s harmless.
   *
   * They are sized to the smaller of the window and the capacity, so
   * iterating a table of ten entries does not allocate for 65536.
   */
  private *chunks(): Generator<EntryChunk> {
    const staged = Math.min(this.scanWindow, this.capacity);
    const chunk: EntryChunk = {
      keys: new Uint32Array(staged),
      values: new Uint32Array(staged),
      count: 0,
    };

    const receive = (count: number): void => {
      chunk.keys.set(this.scanKeys.subarray(0, count));
      chunk.values.set(this.scanValues.subarray(0, count));
    };

    for (const count of scanWindows(this.wasm, this.scanWindow, receive)) {
      chunk.count = count;
      yield chunk;
    }
  }

  /**
   * Yields every key.
   *
   * Order is unspecified: it is slot order, which depends on the hash and
   * changes whenever the table rehashes. Do not rely on it, and do not rely
   * on two tables holding the same entries agreeing on it.
   *
   * Entries are read out one window of slots per WASM call rather than one
   * per key, so a full walk costs a handful of crossings whatever the size.
   *
   * Deleting or inserting during the walk is allowed as long as the table
   * does not rehash; whether the walk observes the change is unspecified. A
   * rehash — including the one {@link SwissU32ToU32.clear} performs — throws
   * rather than silently skipping or repeating entries.
   *
   * @throws {Error} If the table rehashes while the iterator is open.
   */
  keys(): IterableIterator<number> {
    return new KeyIterator(this.scanSource());
  }

  /**
   * Yields every value, in the same unspecified order as
   * {@link SwissU32ToU32.keys}.
   *
   * @throws {Error} If the table rehashes while the iterator is open.
   */
  values(): IterableIterator<number> {
    return new ValueIterator(this.scanSource());
  }

  /**
   * Yields every entry as a `[key, value]` pair, in the same unspecified
   * order as {@link SwissU32ToU32.keys}.
   *
   * Each pair is a fresh array, matching `Map`. Prefer
   * {@link SwissU32ToU32.forEach} on a hot path — it allocates nothing.
   *
   * @throws {Error} If the table rehashes while the iterator is open.
   */
  entries(): IterableIterator<[number, number]> {
    return new EntryIterator(this.scanSource());
  }

  /**
   * Yields every entry as a `[key, value]` pair, so the table works in
   * `for…of` and spreads. Same as {@link SwissU32ToU32.entries}.
   */
  [Symbol.iterator](): IterableIterator<[number, number]> {
    return this.entries();
  }

  /**
   * Calls `callback` once per entry, in the same unspecified order as
   * {@link SwissU32ToU32.keys}.
   *
   * Allocates nothing per entry, unlike {@link SwissU32ToU32.entries}, which
   * has to build a pair.
   *
   * @param callback - Receives the value, the key, and this table — the
   *   argument order `Map.prototype.forEach` uses.
   * @param thisArg - Bound as `this` inside `callback`.
   * @throws {TypeError} If `callback` is not a function.
   * @throws {Error} If the table rehashes while the walk is in progress.
   */
  forEach(
    callback: (value: number, key: number, table: this) => void,
    thisArg?: unknown,
  ): void {
    asCallback(callback, "forEach");

    for (const { keys, values, count } of this.chunks()) {
      for (let i = 0; i < count; i += 1) {
        callback.call(thisArg, values[i]!, keys[i]!, this);
      }
    }
  }
}
