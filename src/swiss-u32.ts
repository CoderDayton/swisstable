import { asWasmI32, assertStatus } from "./abi.ts";
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
export interface SwissU32WasmExports {
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

  /** Number of live entries. */
  size(): number;
  /** Number of allocated slots. */
  capacity(): number;
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
  "size",
  "capacity",
] as const satisfies readonly (keyof SwissU32WasmExports)[];

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

  private constructor(wasm: SwissU32WasmExports) {
    this.wasm = wasm;
    this.lastValue = new Uint32Array(
      wasm.memory.buffer,
      wasm.last_value_ptr(),
      1,
    );
  }

  /**
   * Instantiates `swiss_u32.wasm` and returns a table ready for use.
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
}
