import {
  DELETE_MANY_FAILED,
  ScanIterator,
  asCallback,
  asWasmI32,
  assertStatus,
  bulkLength,
  materializeU32,
  scanColumns,
  stageU32,
} from "./abi.ts";
import type { BulkU32Source, ColumnScan, ScanExports } from "./abi.ts";
import { embeddedModule } from "./embedded.ts";
import { SWISS_U64_WASM_BASE64 } from "./generated/swiss_u64.ts";
import { instantiate } from "./wasm.ts";
import type { WasmSource } from "./wasm.ts";

/**
 * Raw export surface of `swiss_u64.wasm`.
 *
 * This mirrors the `export_name` attributes in `native/swiss_u64.c` and is
 * not part of the published API — use {@link SwissU32ToU64} instead.
 *
 * @internal
 */
export interface SwissU64WasmExports extends ScanExports {
  /** The module's linear memory. Fixed size; never grown. */
  memory: WebAssembly.Memory;

  /** Sizes the table for `expectedEntries` and empties it. */
  init(expectedEntries: number): number;
  /** Grows the table so `entries` fit without a further rehash. */
  reserve(entries: number): number;
  /** Shrinks to the smallest capacity holding the live entries. */
  shrink_to_fit(): number;
  /** Marks every slot empty, retaining the current capacity. */
  clear(): void;

  /** Returns 1 if `key` is present, else 0. */
  has(key: number): number;
  /** Returns 1 and latches both lanes at `last_value_ptr()`, else 0. */
  has_get(key: number): number;
  /** Address of the latched-result lanes (two consecutive u32). */
  last_value_ptr(): number;
  /** Inserts or overwrites, returning a status code. */
  set(key: number, lo: number, hi: number): number;
  /** Removes `key`, returning 1 if it was present. Named to avoid the C keyword. */
  delete_key(key: number): number;

  /** Inserts `count` staged pairs, returning a status code. */
  set_many(
    keysPtr: number,
    valsLoPtr: number,
    valsHiPtr: number,
    count: number,
  ): number;

  /**
   * Looks up `count` staged keys, writing lanes and presence flags in place.
   *
   * Returns a status code: the module rejects a count past its staging
   * capacity, or a pointer it does not own, rather than writing through it.
   */
  get_many(
    keysPtr: number,
    valsLoPtr: number,
    valsHiPtr: number,
    foundPtr: number,
    count: number,
  ): number;

  /**
   * Removes `count` staged keys, returning how many were present, or -1 if
   * the module rejected the arguments. See {@link SwissU64WasmExports.get_many}.
   */
  delete_many(keysPtr: number, deletedPtr: number, count: number): number;

  /** Maximum keys the module's staging buffers hold in one call. */
  bulk_capacity(): number;
  /** Address of the staging key buffer. */
  bulk_keys_ptr(): number;
  /** Address of the staging low-lane buffer. */
  bulk_vals_lo_ptr(): number;
  /** Address of the staging high-lane buffer. */
  bulk_vals_hi_ptr(): number;
  /** Address of the staging flag buffer. */
  bulk_flags_ptr(): number;

  /**
   * Stages the live entries in the slot window at `cursor`, returning how
   * many, or a negative status if it rejected the cursor.
   *
   * Writes through the same staging buffers as the bulk methods.
   */
  scan(cursor: number): number;
  /** Slots one `scan` visits, never more than `bulk_capacity()`. */
  scan_window(): number;
  /** Counter bumped by every rehash, clear, and init. */
  generation(): number;

  /** Number of live entries. */
  size(): number;
  /** Number of allocated slots. */
  capacity(): number;
  /** Address of the live-entry counter, for reading it as memory. */
  size_ptr(): number;
  /** Address of the slot-count counter, for reading it as memory. */
  capacity_ptr(): number;
}

/**
 * A 64-bit value split into two unsigned 32-bit lanes.
 *
 * The reassembled value is `(hi × 2³²) + lo`. Lanes are used rather than
 * `bigint` because an `i64` crossing the WASM boundary is boxed on every
 * call, which costs more than the whole lookup.
 */
export interface U64Lanes {
  /** Low 32 bits. */
  lo: number;
  /** High 32 bits. */
  hi: number;
}

/**
 * An `{offset, length}` region, the conventional payload for string pools
 * and KV-cache blocks stored in a {@link SwissU32ToU64}.
 */
export interface Span {
  /** Start of the region, in whatever unit the caller's pool uses. */
  offset: number;
  /** Extent of the region, in the same unit. */
  length: number;
}

/** Result of {@link SwissU32ToU64.getMany}, as parallel arrays. */
export interface BulkGetResult {
  /**
   * Low lanes, one per requested key. Written as 0 where `found` is 0, so a
   * miss is indistinguishable from a stored 0 — read `found` to tell them
   * apart.
   */
  valsLo: Uint32Array;
  /** High lanes, one per requested key. Written as 0 where `found` is 0. */
  valsHi: Uint32Array;
  /** 1 where the key was present, 0 where it was absent. */
  found: Uint8Array;
}

/** The parts of the table an iterator reads. */
interface SwissU64Scan {
  readonly wasm: SwissU64WasmExports;
  readonly scanWindow: number;
  readonly scratch: BulkScratch;
}

/*
 * The three kinds are separate classes rather than one class with a mode,
 * so each at() has a single return type and a single call site. See the
 * matching note in swiss-u32.ts.
 *
 * Each lists only the columns it reads, and binds them to its own fields
 * rather than indexing `columns` per entry. Copying out of the module is
 * scanColumns' job, and here that also isolates a walk from the bulk
 * methods: the scan writes through the same staging buffers getMany does,
 * so an iterator that read them lazily would hand back whatever an
 * interleaved call left behind.
 */

/** Yields each key. Never copies the lanes, which it does not read. */
class KeyIterator extends ScanIterator<number> {
  private readonly keys: Uint32Array;

  constructor(source: SwissU64Scan) {
    super(source.wasm, source.scanWindow, [source.scratch.keys]);
    this.keys = this.columns[0]!;
  }

  protected override at(index: number): number {
    return this.keys[index]!;
  }
}

/** Yields each value as fresh lanes. */
class ValueIterator extends ScanIterator<U64Lanes> {
  private readonly valsLo: Uint32Array;
  private readonly valsHi: Uint32Array;

  constructor(source: SwissU64Scan) {
    super(source.wasm, source.scanWindow, [
      source.scratch.valsLo,
      source.scratch.valsHi,
    ]);
    this.valsLo = this.columns[0]!;
    this.valsHi = this.columns[1]!;
  }

  protected override at(index: number): U64Lanes {
    return { lo: this.valsLo[index]!, hi: this.valsHi[index]! };
  }
}

/** Yields each entry as a fresh `[key, lanes]` pair. */
class EntryIterator extends ScanIterator<[number, U64Lanes]> {
  private readonly keys: Uint32Array;
  private readonly valsLo: Uint32Array;
  private readonly valsHi: Uint32Array;

  constructor(source: SwissU64Scan) {
    super(source.wasm, source.scanWindow, [
      source.scratch.keys,
      source.scratch.valsLo,
      source.scratch.valsHi,
    ]);
    this.keys = this.columns[0]!;
    this.valsLo = this.columns[1]!;
    this.valsHi = this.columns[2]!;
  }

  protected override at(index: number): [number, U64Lanes] {
    return [
      this.keys[index]!,
      { lo: this.valsLo[index]!, hi: this.valsHi[index]! },
    ];
  }
}

/** Result of {@link SwissU32ToU64.deleteMany}. */
export interface BulkDeleteResult {
  /** 1 where the key was present and removed, 0 where it was absent. */
  deleted: Uint8Array;
  /** Total number of keys actually removed. */
  removedCount: number;
}

/**
 * Packs a span into value lanes.
 *
 * The fields are carried through unchanged rather than masked with `>>> 0`:
 * masking would turn an out-of-range `offset` or a fractional `length` into
 * a different, silently valid u32, defeating the validation
 * {@link SwissU32ToU64.set} performs at the boundary.
 *
 * This is a pure conversion and validates nothing, by design: the fields are
 * carried through so {@link SwissU32ToU64.set} sees the value the caller
 * actually wrote and can reject it. Validation lives at the boundary, in
 * {@link SwissU32ToU64.setSpan}.
 *
 * @param span - Region to encode.
 * @returns The span as `{lo: offset, hi: length}`.
 */
export function spanToLanes(span: Span): U64Lanes {
  return { lo: span.offset, hi: span.length };
}

/**
 * Unpacks value lanes into a span. Inverse of {@link spanToLanes}.
 *
 * @param lanes - Lanes to decode.
 * @returns The lanes as `{offset: lo, length: hi}`.
 */
export function lanesToSpan(lanes: U64Lanes): Span {
  return { offset: lanes.lo, length: lanes.hi };
}

/**
 * Exports the bindings call. Every one is listed, not a representative
 * few: {@link BulkScratch} and the constructor invoke the pointer and
 * capacity accessors immediately, so a module missing one used to surface
 * as a bare "is not a function" instead of the intended TypeError.
 */
const REQUIRED_U64_EXPORTS = [
  "init",
  "reserve",
  "shrink_to_fit",
  "clear",
  "has",
  "has_get",
  "last_value_ptr",
  "set",
  "delete_key",
  "set_many",
  "get_many",
  "delete_many",
  "bulk_capacity",
  "bulk_keys_ptr",
  "bulk_vals_lo_ptr",
  "bulk_vals_hi_ptr",
  "bulk_flags_ptr",
  "scan",
  "scan_window",
  "generation",
  "size",
  "capacity",
  "size_ptr",
  "capacity_ptr",
] as const satisfies readonly (keyof SwissU64WasmExports)[];

/** Compiles the embedded module once, shared by every {@link SwissU32ToU64.create}. */
const compileEmbedded = embeddedModule(SWISS_U64_WASM_BASE64);

/**
 * Views over the module's own bulk staging buffers.
 *
 * The addresses and the batch size come from the module itself, so the
 * buffers can never overlap the table banks — an earlier revision picked the
 * offsets on the JavaScript side and silently aliased them.
 *
 * The views are built once: the modules are linked with initial memory equal
 * to maximum memory and never call `memory.grow`, so the backing buffer is
 * never detached and never reallocated.
 */
class BulkScratch {
  /** Maximum keys per WASM call; larger batches are chunked. */
  readonly maxBatch: number;

  /** Address of {@link BulkScratch.keys} in linear memory. */
  readonly keysPtr: number;
  /** Address of {@link BulkScratch.valsLo} in linear memory. */
  readonly valsLoPtr: number;
  /** Address of {@link BulkScratch.valsHi} in linear memory. */
  readonly valsHiPtr: number;
  /** Address of {@link BulkScratch.found} in linear memory. */
  readonly foundPtr: number;

  /** Staged keys for the current chunk. */
  readonly keys: Uint32Array;
  /** Staged or returned low lanes for the current chunk. */
  readonly valsLo: Uint32Array;
  /** Staged or returned high lanes for the current chunk. */
  readonly valsHi: Uint32Array;
  /** Returned per-key flags for the current chunk. */
  readonly found: Uint8Array;

  constructor(wasm: SwissU64WasmExports) {
    this.maxBatch = wasm.bulk_capacity() >>> 0;

    // Every bulk method strides by this; a zero would loop forever.
    if (this.maxBatch === 0) {
      throw new TypeError("swiss_u64.wasm reported a zero bulk capacity");
    }

    this.keysPtr = wasm.bulk_keys_ptr() >>> 0;
    this.valsLoPtr = wasm.bulk_vals_lo_ptr() >>> 0;
    this.valsHiPtr = wasm.bulk_vals_hi_ptr() >>> 0;
    this.foundPtr = wasm.bulk_flags_ptr() >>> 0;

    const buffer = wasm.memory.buffer;

    this.keys = new Uint32Array(buffer, this.keysPtr, this.maxBatch);
    this.valsLo = new Uint32Array(buffer, this.valsLoPtr, this.maxBatch);
    this.valsHi = new Uint32Array(buffer, this.valsHiPtr, this.maxBatch);
    this.found = new Uint8Array(buffer, this.foundPtr, this.maxBatch);
  }
}

/**
 * WASM-resident SwissTable mapping `uint32_t` keys to 64-bit values.
 *
 * Values are carried as two u32 lanes ({@link U64Lanes}) rather than as
 * `bigint`, so no boxing happens at the boundary. Alongside the per-key
 * methods it exposes bulk operations that stage a whole batch into the
 * module's memory and process it in one crossing — the widest margin over
 * `Map`, since the boundary cost is paid once per batch instead of per key.
 *
 * Capacity is fixed at build time: the module is freestanding and has no
 * allocator, so operations that would exceed it throw {@link RangeError}
 * rather than growing.
 *
 * @example
 * ```ts
 * const bytes = await Bun.file("dist/wasm/swiss_u64.wasm").arrayBuffer();
 * const table = await SwissU32ToU64.load(bytes, keys.length);
 *
 * table.setMany(keys, valsLo, valsHi);
 * const { valsLo: out, found } = table.getMany(keys);
 * ```
 */
export class SwissU32ToU64 {
  /** The instantiated module. */
  private readonly wasm: SwissU64WasmExports;

  /** Views over the module's staging buffers, used by the bulk methods. */
  private readonly scratch: BulkScratch;

  /**
   * View over the module's latched-result lanes.
   *
   * Reading them through linear memory keeps a lookup at one boundary
   * crossing instead of three. The view is built once because the module's
   * memory is fixed and never grows.
   */
  private readonly lastValue: Uint32Array;

  /** Slots one scan call visits. */
  private readonly scanWindow: number;

  /**
   * Views over the module's live-entry and slot counters.
   *
   * {@link SwissU32ToU64.size} and {@link SwissU32ToU64.capacity} read
   * through these rather than calling the matching exports, so a property
   * costs what a local variable costs. See the note in swiss_u64.c — these
   * are the module's own counters, not a cached copy, so there is nothing to
   * invalidate.
   */
  private readonly sizeView: Uint32Array;
  private readonly capacityView: Uint32Array;

  private constructor(wasm: SwissU64WasmExports) {
    this.wasm = wasm;
    this.scratch = new BulkScratch(wasm);
    this.lastValue = new Uint32Array(
      wasm.memory.buffer,
      wasm.last_value_ptr(),
      2,
    );

    this.scanWindow = wasm.scan_window() >>> 0;

    // The scan borrows the bulk staging buffers, so its window has to fit
    // inside them; and every iterator strides by it, so a zero would never
    // reach capacity.
    if (this.scanWindow === 0 || this.scanWindow > this.scratch.maxBatch) {
      throw new TypeError(
        "swiss_u64.wasm reported a scan window its staging buffers cannot hold",
      );
    }

    const buffer = wasm.memory.buffer;
    this.sizeView = new Uint32Array(buffer, wasm.size_ptr(), 1);
    this.capacityView = new Uint32Array(buffer, wasm.capacity_ptr(), 1);
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
  static async create(expectedEntries = 0): Promise<SwissU32ToU64> {
    return SwissU32ToU64.load(await compileEmbedded(), expectedEntries);
  }

  /**
   * Instantiates a caller-supplied `swiss_u64.wasm` and returns a table
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
  ): Promise<SwissU32ToU64> {
    const instance = await instantiate(wasmBytes);
    const wasm = instance.exports as unknown as SwissU64WasmExports;

    if (
      !(wasm.memory instanceof WebAssembly.Memory) ||
      !REQUIRED_U64_EXPORTS.every(
        (name) => typeof wasm[name] === "function",
      )
    ) {
      throw new TypeError("Invalid swiss_u64.wasm exports");
    }

    const table = new SwissU32ToU64(wasm);

    assertStatus(
      wasm.init(asWasmI32(expectedEntries, "expectedEntries")),
      "expectedEntries",
      "SwissU32ToU64",
    );

    return table;
  }

  /**
   * Number of live entries.
   *
   * Read straight out of linear memory, so this costs what reading a local
   * variable costs and is safe to put in a loop condition.
   */
  get size(): number {
    return this.sizeView[0]!;
  }

  /**
   * Number of allocated slots, always a power of two.
   *
   * The table rehashes once live entries reach 7/8 of this. As cheap to read
   * as {@link SwissU32ToU64.size}.
   */
  get capacity(): number {
    return this.capacityView[0]!;
  }

  /**
   * Maximum keys processed per WASM call by the bulk methods.
   *
   * Larger batches are chunked automatically; this only matters when sizing
   * batches to avoid the copy that chunking implies.
   */
  get maxBatch(): number {
    return this.scratch.maxBatch;
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
      "SwissU32ToU64",
    );
  }

  /**
   * Shrinks the table to the smallest capacity that holds its live entries.
   *
   * Capacity otherwise only ever rises — {@link SwissU32ToU64.reserve} and
   * the growth path raise it, {@link SwissU32ToU64.clear} retains it, and a
   * delete leaves a tombstone rather than a freed slot. Lookups do not care,
   * but iteration visits every slot, so a table that once peaked large keeps
   * paying peak walk cost until this is called.
   *
   * A no-op when the table is already at that capacity, so calling it after
   * a bulk removal costs a comparison rather than a rehash.
   *
   * This rehashes, which invalidates any open iterator exactly as a growth
   * rehash would.
   *
   * @throws {Error} If the module reports a failure.
   */
  shrinkToFit(): void {
    assertStatus(this.wasm.shrink_to_fit(), "shrinkToFit", "SwissU32ToU64");
  }

  /**
   * Removes every entry, retaining the current capacity.
   *
   * The retained capacity is never released by this call; follow it with
   * {@link SwissU32ToU64.shrinkToFit} to hand it back, which matters most
   * when the instance is reused for a much smaller workload than the one it
   * grew for.
   */
  clear(): void {
    this.wasm.clear();
  }

  /**
   * Reports whether `key` is present.
   *
   * @param key - Unsigned 32-bit key.
   * @throws {RangeError} If `key` is not an unsigned 32-bit integer.
   */
  has(key: number): boolean {
    return this.wasm.has(asWasmI32(key, "key")) !== 0;
  }

  /**
   * Returns the lanes stored for `key`, or `undefined` if absent.
   *
   * Allocates one object per hit. Prefer {@link SwissU32ToU64.getMany} when
   * looking up more than a handful of keys.
   *
   * @param key - Unsigned 32-bit key.
   * @throws {RangeError} If `key` is not an unsigned 32-bit integer.
   */
  get(key: number): U64Lanes | undefined {
    if (this.wasm.has_get(asWasmI32(key, "key")) === 0) return undefined;
    return { lo: this.lastValue[0]!, hi: this.lastValue[1]! };
  }

  /**
   * Returns the value stored for `key` decoded as a span.
   *
   * @param key - Unsigned 32-bit key.
   * @returns The span, or `undefined` if the key is absent.
   * @throws {RangeError} If `key` is not an unsigned 32-bit integer.
   */
  getSpan(key: number): Span | undefined {
    const lanes = this.get(key);
    return lanes === undefined ? undefined : lanesToSpan(lanes);
  }

  /**
   * Inserts `key`, or overwrites the value if it is already present.
   *
   * @param key - Unsigned 32-bit key.
   * @param lo - Low 32 bits of the value.
   * @param hi - High 32 bits of the value.
   * @returns This table, for chaining.
   * @throws {RangeError} If any argument is not an unsigned 32-bit integer,
   *   or if the insert would exceed the compiled capacity.
   */
  set(key: number, lo: number, hi: number): this {
    assertStatus(
      this.wasm.set(
        asWasmI32(key, "key"),
        asWasmI32(lo, "lo"),
        asWasmI32(hi, "hi"),
      ),
      "set",
      "SwissU32ToU64",
    );
    return this;
  }

  /**
   * Stores `span` under `key`, encoded with {@link spanToLanes}.
   *
   * @param key - Unsigned 32-bit key.
   * @param span - Region to store.
   * @returns This table, for chaining.
   * @throws {RangeError} If `key` or either span field is not an unsigned
   *   32-bit integer, or if the insert would exceed the compiled capacity.
   */
  setSpan(key: number, span: Span): this {
    // Reported against the field the caller wrote: letting a bad span reach
    // set() would complain about `lo` or `hi`, names that appear nowhere in
    // the span API.
    if (span === null || typeof span !== "object") {
      throw new TypeError("span must be an object with offset and length");
    }

    asWasmI32(span.offset, "span.offset");
    asWasmI32(span.length, "span.length");

    const lanes = spanToLanes(span);
    return this.set(key, lanes.lo, lanes.hi);
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

  /**
   * Inserts or overwrites a whole batch of pairs.
   *
   * Batches longer than {@link SwissU32ToU64.maxBatch} are chunked; each
   * chunk is still a single WASM call, and capacity is checked once per
   * chunk rather than once per key.
   *
   * @param keys - Unsigned 32-bit keys.
   * @param valsLo - Low lanes, parallel to `keys`.
   * @param valsHi - High lanes, parallel to `keys`.
   * @throws {RangeError} If the three arrays differ in length, if an element
   *   is not a 32-bit integer, or if the inserts would exceed the compiled
   *   capacity. A rejected element applies nothing, whatever its position;
   *   a capacity ceiling is not atomic across chunks, the same way the module
   *   reports one hit partway through a single chunk.
   */
  setMany(
    keys: BulkU32Source,
    valsLo: BulkU32Source,
    valsHi: BulkU32Source,
  ): void {
    const total = bulkLength(keys, "keys");

    if (
      bulkLength(valsLo, "valsLo") !== total ||
      bulkLength(valsHi, "valsHi") !== total
    ) {
      throw new RangeError("setMany: key/value array length mismatch");
    }

    const { maxBatch } = this.scratch;

    // One chunk stages every element before the single WASM call, so a bad
    // element already rejects the whole batch. Past that, the batch has to
    // be checked up front — otherwise element 69_999 of a 70_000-pair batch
    // would throw with the first 65_536 pairs already inserted. The check
    // keeps what it converts, so a non-integer source pays the per-element
    // cost once here rather than again per chunk.
    if (total > maxBatch) {
      keys = materializeU32(keys, total, "keys");
      valsLo = materializeU32(valsLo, total, "valsLo");
      valsHi = materializeU32(valsHi, total, "valsHi");
    }

    for (let offset = 0; offset < total; offset += maxBatch) {
      const chunk = Math.min(maxBatch, total - offset);

      stageU32(keys, this.scratch.keys, offset, chunk, "keys");
      stageU32(valsLo, this.scratch.valsLo, offset, chunk, "valsLo");
      stageU32(valsHi, this.scratch.valsHi, offset, chunk, "valsHi");

      assertStatus(
        this.wasm.set_many(
          this.scratch.keysPtr,
          this.scratch.valsLoPtr,
          this.scratch.valsHiPtr,
          chunk,
        ),
        "setMany",
        "SwissU32ToU64",
      );
    }
  }

  /**
   * Looks up a whole batch of keys.
   *
   * Batches longer than {@link SwissU32ToU64.maxBatch} are chunked; each
   * chunk is still a single WASM call.
   *
   * @param keys - Unsigned 32-bit keys.
   * @param out - Result arrays to write into instead of allocating, each at
   *   least `keys.length` long; only the first `keys.length` elements are
   *   written. A caller issuing same-sized batches in a loop passes the
   *   previous result back to make the steady state allocation-free.
   * @returns Parallel result arrays, each covering `keys.length` keys —
   *   `out` when given, else freshly allocated.
   * @throws {RangeError} If an element is not a 32-bit integer, or an `out`
   *   array is shorter than `keys`. A rejected element writes nothing,
   *   whatever its position, so a reused `out` never comes back holding a
   *   mixture of this batch's results and the last one's.
   */
  getMany(keys: BulkU32Source, out?: BulkGetResult): BulkGetResult {
    const total = bulkLength(keys, "keys");

    const valsLo = out?.valsLo ?? new Uint32Array(total);
    const valsHi = out?.valsHi ?? new Uint32Array(total);
    const found = out?.found ?? new Uint8Array(total);

    // Checked before the first chunk lands, so a short buffer rejects the
    // whole call rather than failing after some lookups were copied out.
    if (
      valsLo.length < total ||
      valsHi.length < total ||
      found.length < total
    ) {
      throw new RangeError("getMany: out arrays are shorter than keys");
    }

    const { maxBatch } = this.scratch;

    // Results land chunk by chunk, so a bad element in a later chunk would
    // otherwise throw with the earlier chunks already copied into `out` —
    // and a caller reusing `out` cannot tell those apart from the previous
    // batch's results. See setMany.
    if (total > maxBatch) keys = materializeU32(keys, total, "keys");

    for (let offset = 0; offset < total; offset += maxBatch) {
      const chunk = Math.min(maxBatch, total - offset);

      stageU32(keys, this.scratch.keys, offset, chunk, "keys");

      assertStatus(
        this.wasm.get_many(
          this.scratch.keysPtr,
          this.scratch.valsLoPtr,
          this.scratch.valsHiPtr,
          this.scratch.foundPtr,
          chunk,
        ),
        "getMany",
        "SwissU32ToU64",
      );

      valsLo.set(this.scratch.valsLo.subarray(0, chunk), offset);
      valsHi.set(this.scratch.valsHi.subarray(0, chunk), offset);
      found.set(this.scratch.found.subarray(0, chunk), offset);
    }

    return out ?? { valsLo, valsHi, found };
  }

  /**
   * Removes a whole batch of keys.
   *
   * Batches longer than {@link SwissU32ToU64.maxBatch} are chunked; each
   * chunk is still a single WASM call.
   *
   * @param keys - Unsigned 32-bit keys.
   * @returns Per-key removal flags and the total removed.
   * @throws {RangeError} If an element is not a 32-bit integer. Nothing is
   *   removed, whatever the element's position.
   */
  deleteMany(keys: BulkU32Source): BulkDeleteResult {
    const total = bulkLength(keys, "keys");
    const deleted = new Uint8Array(total);
    let removedCount = 0;

    const { maxBatch } = this.scratch;

    // Removals land chunk by chunk, so a bad element in a later chunk would
    // otherwise throw with the earlier chunks already gone. See setMany.
    if (total > maxBatch) keys = materializeU32(keys, total, "keys");

    for (let offset = 0; offset < total; offset += maxBatch) {
      const chunk = Math.min(maxBatch, total - offset);

      stageU32(keys, this.scratch.keys, offset, chunk, "keys");

      // The flag buffer carries removal flags here; nothing else reads it
      // between staging the keys and copying the flags out.
      const removed = this.wasm.delete_many(
        this.scratch.keysPtr,
        this.scratch.foundPtr,
        chunk,
      );

      if (removed === DELETE_MANY_FAILED) {
        throw new Error("delete_many rejected its arguments");
      }

      removedCount += removed;

      deleted.set(this.scratch.found.subarray(0, chunk), offset);
    }

    return { deleted, removedCount };
  }

  /** The scan state an iterator needs, bundled without exposing it. */
  private scanSource(): SwissU64Scan {
    return {
      wasm: this.wasm,
      scanWindow: this.scanWindow,
      scratch: this.scratch,
    };
  }

  /**
   * Builds a walk staging keys and both lane columns, for the two whole-
   * table callback methods.
   */
  private entryScan(): ColumnScan {
    return scanColumns(this.wasm, this.scanWindow, [
      this.scratch.keys,
      this.scratch.valsLo,
      this.scratch.valsHi,
    ]);
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
   * rehash — including the one {@link SwissU32ToU64.clear} or
   * {@link SwissU32ToU64.shrinkToFit} performs — is detected rather than
   * allowed to silently skip or repeat entries.
   *
   * The check runs before each slot window, so a rehash is reported only if
   * a window remains to be read. One that happens after the last window has
   * been handed over ends the walk normally: every entry was already
   * reported exactly once from the pre-rehash slot layout, so there is
   * nothing left to get wrong. Treat the error as "may throw", not "always
   * throws".
   *
   * @throws {Error} If the table rehashes while the iterator is open and
   *   windows remain unread.
   */
  keys(): IterableIterator<number> {
    return new KeyIterator(this.scanSource());
  }

  /**
   * Yields every value as lanes, in the same unspecified order as
   * {@link SwissU32ToU64.keys}.
   *
   * Allocates one object per entry. Prefer
   * {@link SwissU32ToU64.forEachLanes} on a hot path — it hands the two
   * lanes over as separate arguments and allocates nothing.
   *
   * @throws {Error} If the table rehashes while the iterator is open.
   */
  values(): IterableIterator<U64Lanes> {
    return new ValueIterator(this.scanSource());
  }

  /**
   * Yields every entry as a `[key, lanes]` pair, in the same unspecified
   * order as {@link SwissU32ToU64.keys}.
   *
   * Each pair is a fresh array holding a fresh {@link U64Lanes}, matching
   * `Map`. Prefer {@link SwissU32ToU64.forEachLanes} on a hot path — it
   * allocates nothing at all.
   *
   * @throws {Error} If the table rehashes while the iterator is open.
   */
  entries(): IterableIterator<[number, U64Lanes]> {
    return new EntryIterator(this.scanSource());
  }

  /**
   * Yields every entry as a `[key, lanes]` pair, so the table works in
   * `for…of` and spreads. Same as {@link SwissU32ToU64.entries}.
   */
  [Symbol.iterator](): IterableIterator<[number, U64Lanes]> {
    return this.entries();
  }

  /**
   * Calls `callback` once per entry, in the same unspecified order as
   * {@link SwissU32ToU64.keys}.
   *
   * A value here is a pair of lanes, and `Map`'s callback shape has one
   * value argument, so this has to build a {@link U64Lanes} per entry. That
   * is the price of matching `Map`; {@link SwissU32ToU64.forEachLanes} is
   * the same walk without it.
   *
   * @param callback - Receives the lanes, the key, and this table — the
   *   argument order `Map.prototype.forEach` uses.
   * @param thisArg - Bound as `this` inside `callback`.
   * @throws {TypeError} If `callback` is not a function.
   * @throws {Error} If the table rehashes while the walk is in progress.
   */
  forEach(
    callback: (value: U64Lanes, key: number, table: this) => void,
    thisArg?: unknown,
  ): void {
    asCallback(callback, "forEach");

    const { windows, columns } = this.entryScan();
    const keys = columns[0]!;
    const valsLo = columns[1]!;
    const valsHi = columns[2]!;

    for (const count of windows) {
      for (let i = 0; i < count; i += 1) {
        callback.call(
          thisArg,
          { lo: valsLo[i]!, hi: valsHi[i]! },
          keys[i]!,
          this,
        );
      }
    }
  }

  /**
   * Calls `callback` once per entry with the two lanes as separate
   * arguments, in the same unspecified order as {@link SwissU32ToU64.keys}.
   *
   * This is the zero-allocation walk, and the one to reach for on a hot
   * path. {@link SwissU32ToU64.forEach} matches `Map`'s callback shape and
   * so must box the lanes into an object per entry; passing them
   * separately is the same choice the rest of this API already makes to
   * keep a 64-bit value off the boxing path.
   *
   * @param callback - Receives the low lane, the high lane, the key, and
   *   this table.
   * @param thisArg - Bound as `this` inside `callback`.
   * @throws {TypeError} If `callback` is not a function.
   * @throws {Error} If the table rehashes while the walk is in progress.
   */
  forEachLanes(
    callback: (lo: number, hi: number, key: number, table: this) => void,
    thisArg?: unknown,
  ): void {
    asCallback(callback, "forEachLanes");

    const { windows, columns } = this.entryScan();
    const keys = columns[0]!;
    const valsLo = columns[1]!;
    const valsHi = columns[2]!;

    for (const count of windows) {
      for (let i = 0; i < count; i += 1) {
        callback.call(thisArg, valsLo[i]!, valsHi[i]!, keys[i]!, this);
      }
    }
  }
}
