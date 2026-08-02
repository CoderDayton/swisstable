import { asWasmI32, assertStatus } from "./abi.ts";
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
export interface SwissU64WasmExports {
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

  /** Looks up `count` staged keys, writing lanes and presence flags in place. */
  get_many(
    keysPtr: number,
    valsLoPtr: number,
    valsHiPtr: number,
    foundPtr: number,
    count: number,
  ): void;

  /** Removes `count` staged keys, returning how many were present. */
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

  /** Number of live entries. */
  size(): number;
  /** Number of allocated slots. */
  capacity(): number;
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
  /** Low lanes, one per requested key. Undefined where `found` is 0. */
  valsLo: Uint32Array;
  /** High lanes, one per requested key. Undefined where `found` is 0. */
  valsHi: Uint32Array;
  /** 1 where the key was present, 0 where it was absent. */
  found: Uint8Array;
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
/**
 * Exports the bindings call. Every one is listed, not a representative
 * few: {@link BulkScratch} and the constructor invoke the pointer and
 * capacity accessors immediately, so a module missing one used to surface
 * as a bare "is not a function" instead of the intended TypeError.
 */
const REQUIRED_U64_EXPORTS = [
  "init",
  "reserve",
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
  "size",
  "capacity",
] as const satisfies readonly (keyof SwissU64WasmExports)[];

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

  private constructor(wasm: SwissU64WasmExports) {
    this.wasm = wasm;
    this.scratch = new BulkScratch(wasm);
    this.lastValue = new Uint32Array(
      wasm.memory.buffer,
      wasm.last_value_ptr(),
      2,
    );
  }

  /**
   * Instantiates `swiss_u64.wasm` and returns a table ready for use.
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
      "init",
      "SwissU32ToU64",
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
   * @throws {RangeError} If the three arrays differ in length, or if the
   *   inserts would exceed the compiled capacity.
   */
  setMany(keys: Uint32Array, valsLo: Uint32Array, valsHi: Uint32Array): void {
    const total = keys.length;

    if (valsLo.length !== total || valsHi.length !== total) {
      throw new RangeError("setMany: key/value array length mismatch");
    }

    const { maxBatch } = this.scratch;

    for (let offset = 0; offset < total; offset += maxBatch) {
      const chunk = Math.min(maxBatch, total - offset);

      this.scratch.keys.set(keys.subarray(offset, offset + chunk));
      this.scratch.valsLo.set(valsLo.subarray(offset, offset + chunk));
      this.scratch.valsHi.set(valsHi.subarray(offset, offset + chunk));

      assertStatus(
        this.wasm.set_many(
          this.scratch.keysPtr,
          this.scratch.valsLoPtr,
          this.scratch.valsHiPtr,
          chunk,
        ),
        "set_many",
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
   * @returns Parallel result arrays, each of `keys.length`, freshly
   *   allocated once per call.
   */
  getMany(keys: Uint32Array): BulkGetResult {
    const total = keys.length;

    const valsLo = new Uint32Array(total);
    const valsHi = new Uint32Array(total);
    const found = new Uint8Array(total);

    const { maxBatch } = this.scratch;

    for (let offset = 0; offset < total; offset += maxBatch) {
      const chunk = Math.min(maxBatch, total - offset);

      this.scratch.keys.set(keys.subarray(offset, offset + chunk));

      this.wasm.get_many(
        this.scratch.keysPtr,
        this.scratch.valsLoPtr,
        this.scratch.valsHiPtr,
        this.scratch.foundPtr,
        chunk,
      );

      valsLo.set(this.scratch.valsLo.subarray(0, chunk), offset);
      valsHi.set(this.scratch.valsHi.subarray(0, chunk), offset);
      found.set(this.scratch.found.subarray(0, chunk), offset);
    }

    return { valsLo, valsHi, found };
  }

  /**
   * Removes a whole batch of keys.
   *
   * Batches longer than {@link SwissU32ToU64.maxBatch} are chunked; each
   * chunk is still a single WASM call.
   *
   * @param keys - Unsigned 32-bit keys.
   * @returns Per-key removal flags and the total removed.
   */
  deleteMany(keys: Uint32Array): BulkDeleteResult {
    const total = keys.length;
    const deleted = new Uint8Array(total);
    let removedCount = 0;

    const { maxBatch } = this.scratch;

    for (let offset = 0; offset < total; offset += maxBatch) {
      const chunk = Math.min(maxBatch, total - offset);

      this.scratch.keys.set(keys.subarray(offset, offset + chunk));

      // The flag buffer carries removal flags here; nothing else reads it
      // between staging the keys and copying the flags out.
      removedCount += this.wasm.delete_many(
        this.scratch.keysPtr,
        this.scratch.foundPtr,
        chunk,
      );

      deleted.set(this.scratch.found.subarray(0, chunk), offset);
    }

    return { deleted, removedCount };
  }
}
