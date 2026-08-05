/**
 * Shared helpers for the JavaScript ↔ WebAssembly boundary.
 *
 * Nothing here is part of the published surface; it is the contract the two
 * table bindings share with the native modules in `native/`.
 *
 * @packageDocumentation
 * @internal
 */

/**
 * Status returned by a fallible export that completed successfully.
 *
 * @internal
 */
export const STATUS_OK = 0;

/**
 * Status returned when a request would exceed the capacity the module was
 * compiled with (`MAX_CAPACITY` in the native sources).
 *
 * The modules are freestanding and have no allocator, so this ceiling is
 * fixed at build time and cannot be raised at runtime.
 *
 * @internal
 */
export const STATUS_CAPACITY_EXCEEDED = -2;

/**
 * Status returned when an export is called with arguments it cannot honour —
 * a bulk count past the staging capacity, or a pointer the module does not
 * own. Nothing is applied, so the table is left exactly as it was.
 *
 * @internal
 */
export const STATUS_INVALID_ARGUMENT = -3;

/**
 * Sentinel `delete_many` returns instead of a removal count when it rejects
 * its arguments.
 *
 * The module returns `UINT32_MAX`; a WebAssembly `i32` result is signed at
 * the JavaScript boundary, so it arrives as `-1`. Every genuine removal count
 * is non-negative, which keeps the sentinel unambiguous.
 *
 * @internal
 */
export const DELETE_MANY_FAILED = -1;

/**
 * The exports {@link scanWindows} drives. Both modules provide them.
 *
 * @internal
 */
export interface ScanExports {
  /** Stages the live entries in the slot window at `cursor`, returning how
   *  many, or a negative status if it rejected the cursor. */
  scan(cursor: number): number;
  /** Slots one {@link ScanExports.scan} call visits. */
  scan_window(): number;
  /** Counter bumped by every rehash, clear, and init. */
  generation(): number;
  /** Number of allocated slots. */
  capacity(): number;
}

/**
 * Thrown when the table is rehashed while an iterator is open.
 *
 * @internal
 */
export const REHASHED_DURING_ITERATION =
  "the table was rehashed during iteration, so the cursor no longer refers " +
  "to the entries it did when the walk started";

/**
 * A walk over a table's slot space, with the walk's private copy of every
 * column it was asked to stage.
 *
 * @internal
 */
export interface ColumnScan {
  /**
   * Per-window entry counts, in cursor order. Advancing this refills
   * {@link ColumnScan.columns} before it yields.
   */
  readonly windows: Generator<number>;
  /**
   * One buffer per requested source, parallel to it and valid up to the
   * count the walk last yielded. These belong to this walk alone.
   */
  readonly columns: readonly Uint32Array[];
}

/**
 * Builds a walk over the whole slot space that copies `sources` out one
 * window at a time.
 *
 * The windows `[0, W)`, `[W, 2W)`, … partition the slot space, so every live
 * slot falls in exactly one and is reported exactly once. Nothing is carried
 * across a call but the cursor, which is why two iterators over the same
 * table can be advanced alternately without either observing the other.
 *
 * `sources` are views into the module's staging buffers, which every scan
 * and every bulk call writes through. They are copied into this walk's own
 * `columns` before each yield, while the staged chunk is still intact —
 * that copy is what makes a walk safe against a bulk call issued between
 * two `next()`s, and what keeps two open walks from seeing each other's
 * scan.
 *
 * Capacity is read exactly once here, and the column buffers are sized from
 * that same read rather than a second one. A window stages at most as many
 * entries as it spans slots, so `min(window, capacity)` is an upper bound
 * no scan of this walk can exceed — and because one read establishes both
 * the walk's extent and its buffer length, there is no window in which a
 * rehash could make the two disagree. It is also why iterating ten entries
 * does not allocate for 65536.
 *
 * A rehash renumbers the slots, so a cursor held across one names different
 * entries than it did — some skipped, some repeated, with nothing in the
 * data to show it. The generation counter is checked before each window and
 * the walk is abandoned rather than allowed to report a mixture. Mutations
 * that leave the slots in place (an insert with room, a delete) are not
 * errors; whether the walk observes them is unspecified.
 *
 * The check is per window, which means a rehash after the last window was
 * handed over is not reported at all. That is deliberate rather than a hole:
 * by then every entry has been reported exactly once from the layout the
 * walk pinned, so there is no mixture left to guard against. Callers should
 * read the error as "may throw".
 *
 * `sources` are views over the module's linear memory, built once and held
 * for the table's lifetime. That is only sound because the modules are
 * linked with initial memory equal to maximum memory and never call
 * `memory.grow`, so the backing buffer is never detached or reallocated —
 * any future change to grow memory would have to rebuild these views.
 *
 * @param wasm - The module being iterated.
 * @param window - Slots per call, from `scan_window()`.
 * @param sources - Views over the module's staging buffers to copy out.
 *   Only the columns a caller actually reads should be listed; a `keys()`
 *   walk that never looks at values should not pay to copy them.
 * @returns The walk and its private column buffers.
 * @internal
 */
export function scanColumns(
  wasm: ScanExports,
  window: number,
  sources: readonly Uint32Array[],
): ColumnScan {
  // Both reads happen here rather than inside the generator, which would
  // not run until the first next(). A rehash between building the walk and
  // advancing it would otherwise go unnoticed and stage a chunk larger than
  // the buffers sized for it.
  const capacity = wasm.capacity() >>> 0;
  const generation = wasm.generation() >>> 0;

  const staged = Math.min(window, capacity);
  const columns = sources.map(() => new Uint32Array(staged));

  // Runs once per window, not once per entry, so the loop over columns and
  // the subarray views it builds cost nothing measurable per entry.
  const receive = (count: number): void => {
    for (let i = 0; i < columns.length; i += 1) {
      columns[i]!.set(sources[i]!.subarray(0, count));
    }
  };

  return {
    windows: walkWindows(wasm, window, receive, capacity, generation),
    columns,
  };
}

/** The walk itself, over the capacity and generation {@link scanColumns}
 *  pinned when it was called. */
function* walkWindows(
  wasm: ScanExports,
  window: number,
  receive: (count: number) => void,
  capacity: number,
  generation: number,
): Generator<number> {
  for (let cursor = 0; cursor < capacity; cursor += window) {
    if ((wasm.generation() >>> 0) !== generation) {
      throw new Error(REHASHED_DURING_ITERATION);
    }

    const count = wasm.scan(cursor);

    // Only an unaligned cursor is rejected, and every cursor here is a
    // multiple of the window, itself a multiple of the group width. A
    // module that reports one anyway is not the one this was written for.
    if (count < 0) {
      throw new Error(`scan rejected cursor ${cursor} with status ${count}`);
    }

    receive(count);
    yield count;
  }
}

/**
 * The single exhausted result, shared by every iterator.
 *
 * Reusing it is safe where reusing a `{value, done: false}` record would not
 * be: it carries no value, and consumers stop at the first `done`.
 */
const EXHAUSTED: IteratorReturnResult<undefined> = Object.freeze({
  value: undefined,
  done: true,
});

/**
 * Iterator protocol over a table, refilled one slot window at a time.
 *
 * Written as an explicit `next()` rather than a generator, which is not
 * stylistic: a generator resumes its frame once per entry, and measured
 * against an iterator object over the same data that costs about 2x. The
 * window walk underneath is still {@link scanColumns} — its own frame
 * resumes once per window, roughly once per 57000 entries at the load
 * factor, so it costs nothing per entry.
 *
 * Copying the staged columns out is handled by the walk, so a subclass
 * supplies only {@link ScanIterator.at}, which projects one element. Each
 * should bind the columns it reads to its own fields in its constructor
 * rather than indexing {@link ScanIterator.columns} per entry, which keeps
 * the per-entry access a monomorphic field load.
 *
 * @internal
 */
export abstract class ScanIterator<T> implements IterableIterator<T> {
  /** Walk over the slot windows; yields the entry count staged for each. */
  private readonly walk: Generator<number>;

  /** This walk's private copies of the columns it was built with. */
  protected readonly columns: readonly Uint32Array[];

  /** Next element of the current chunk to project. */
  private index = 0;

  /** Live elements in the current chunk. */
  private count = 0;

  protected constructor(
    wasm: ScanExports,
    window: number,
    sources: readonly Uint32Array[],
  ) {
    const scan = scanColumns(wasm, window, sources);
    this.walk = scan.windows;
    this.columns = scan.columns;
  }

  /** Projects element `index` of the chunk last staged. */
  protected abstract at(index: number): T;

  next(): IteratorResult<T> {
    // A window can be entirely empty, so this loops rather than branches:
    // a sparse table has stretches of slots that stage nothing at all.
    while (this.index >= this.count) {
      const step = this.walk.next();
      if (step.done === true) return EXHAUSTED;
      this.count = step.value;
      this.index = 0;
    }

    // A fresh record per entry, as the built-in iterators produce. Reusing
    // one measured about 1.6x faster, and is what a library willing to
    // deviate here would do — but it breaks holding two results from
    // consecutive next() calls, and even reused this path does not overtake
    // Map. forEach is the answer for a hot loop; it allocates nothing.
    return { value: this.at(this.index++), done: false };
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this;
  }
}

/**
 * Asserts an iteration callback is callable before the walk begins.
 *
 * `Map.prototype.forEach` rejects a non-function up front rather than at the
 * first entry, so an empty table reports the mistake the same way a full one
 * does. This keeps that.
 *
 * @param value - The caller-supplied argument.
 * @param name - Method name, for the message.
 * @throws {TypeError} If `value` is not a function.
 * @internal
 */
export function asCallback<T>(value: T, name: string): T {
  if (typeof value !== "function") {
    throw new TypeError(`${name} expects a function`);
  }
  return value;
}

/**
 * Validates an unsigned 32-bit integer and hands back its int32 bit pattern.
 *
 * `x >>> 0` is the identity exactly on the u32 range, so the single
 * comparison rejects negatives, non-integers, `NaN`, and anything past
 * 2³² − 1 at once.
 *
 * The `| 0` is not cosmetic. A JavaScript number above 2³¹ − 1 cannot be
 * tagged as a machine int32, so it reaches a WASM `i32` parameter as a boxed
 * double and is converted at the boundary — measured at ~14 ns per call,
 * several times the cost of the lookup itself. The signed form carries the
 * same 32 bits, WASM `i32` parameters are untyped bit patterns, and the C
 * side reads them back as `uint32_t`.
 *
 * @param value - Candidate value, expected in `[0, 2³² − 1]`.
 * @param name - Parameter name, used only to build the error message.
 * @returns The same 32 bits, as a value in `[-2³¹, 2³¹ − 1]`.
 * @throws {RangeError} If `value` is not an unsigned 32-bit integer.
 * @internal
 */
export function asWasmI32(value: number, name: string): number {
  if ((value >>> 0) !== value) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
  return value | 0;
}

/**
 * Any numeric sequence the bulk methods accept.
 *
 * Every element must be an integer representable in 32 bits, signed or
 * unsigned — that is, in `[-2**31, 2**32 - 1]`. Negative values are taken as
 * their unsigned bit pattern, so `-1` and `4294967295` are the same key.
 *
 * `Float32Array` is the one source that cannot carry the whole range: it has
 * 24 bits of mantissa, so a value past 2**24 was already rounded before this
 * code saw it (`16777217` is stored as `16777216`). The rounded value is
 * still a 32-bit integer, so it would pass validation and address the wrong
 * key — its elements are therefore held to `[-2**24, 2**24]`, and anything
 * beyond that is rejected rather than used. Use `Float64Array` — or better,
 * `Uint32Array` — for large keys.
 */
export type BulkU32Source =
  | Uint32Array
  | Int32Array
  | Uint16Array
  | Int16Array
  | Uint8Array
  | Uint8ClampedArray
  | Int8Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array
  | readonly number[]
  | readonly bigint[];

/** Lowest value accepted by {@link stageU32}, as an int32. */
const MIN_I32 = -0x8000_0000;
/** Highest value accepted by {@link stageU32}, as a u32. */
const MAX_U32 = 0xffff_ffff;

/**
 * Largest magnitude a `Float32Array` element can hold exactly.
 *
 * A float32 has 24 mantissa bits, so consecutive integers stop being
 * representable past 2**24: an element beyond it may already be a rounded
 * stand-in for the value the caller wrote.
 */
const MAX_EXACT_F32 = 0x100_0000;

/**
 * The same bounds as BigInts, hoisted out of the per-element loops.
 *
 * `BigInt(MIN_I32)` inside the loop allocates a fresh BigInt per element,
 * which is pure overhead on the slowest source type there is.
 */
const MIN_I32_BIG = BigInt(MIN_I32);
const MAX_U32_BIG = BigInt(MAX_U32);

/**
 * Integer typed arrays copy straight into the staging buffer.
 *
 * `TypedArray.prototype.set` converts element by element through `ToUint32`,
 * which is exact for every integer array: widening is lossless and narrowing
 * never happens, since the destination is the widest of them. Signed values
 * arrive as their unsigned bit pattern, matching the documented contract.
 */
function isIntegerView(value: unknown): value is
  | Uint32Array
  | Int32Array
  | Uint16Array
  | Int16Array
  | Uint8Array
  | Uint8ClampedArray
  | Int8Array {
  return (
    value instanceof Uint32Array ||
    value instanceof Int32Array ||
    value instanceof Uint16Array ||
    value instanceof Int16Array ||
    value instanceof Uint8Array ||
    value instanceof Uint8ClampedArray ||
    value instanceof Int8Array
  );
}

/**
 * Narrows one element to a u32, or explains which element was wrong.
 *
 * @throws {RangeError} If the value is not a 32-bit integer.
 */
function elementToU32(value: number, name: string, index: number): number {
  if (!Number.isInteger(value) || value < MIN_I32 || value > MAX_U32) {
    throw new RangeError(`${name}[${index}] must be a 32-bit integer`);
  }
  return value >>> 0;
}

/**
 * Narrows one `Float32Array` element, refusing anything already rounded.
 *
 * Past {@link MAX_EXACT_F32} the stored value need not be the one the caller
 * wrote, and the rounded stand-in is itself a valid 32-bit integer — so it
 * would address a different key without complaint. Rejecting is the only
 * honest answer: what was lost happened before this code ran.
 *
 * `2**24 + 1` is the one value this cannot catch, since it rounds *into* the
 * accepted range and arrives indistinguishable from a genuine `2**24`.
 *
 * @throws {RangeError} If the value is not a 32-bit integer, or is past the
 *   range a float32 represents exactly.
 */
function float32ElementToU32(
  value: number,
  name: string,
  index: number,
): number {
  if (value < -MAX_EXACT_F32 || value > MAX_EXACT_F32) {
    throw new RangeError(
      `${name}[${index}] is past the range Float32Array represents exactly ` +
        `(±2**24), so it may already have been rounded; ` +
        `use Float64Array or Uint32Array`,
    );
  }
  return elementToU32(value, name, index);
}

/**
 * Narrows one BigInt element to a u32.
 *
 * @throws {RangeError} If the value is outside the 32-bit range.
 */
function bigintToU32(value: bigint, name: string, index: number): number {
  if (value < MIN_I32_BIG || value > MAX_U32_BIG) {
    throw new RangeError(`${name}[${index}] must be a 32-bit integer`);
  }
  return Number(BigInt.asUintN(32, value));
}

/**
 * Copies `count` elements of `source`, starting at `from`, into `dest`,
 * validating each element.
 *
 * Integer typed arrays take a bulk `set` and are never inspected per element
 * — the case the bulk API exists for. Everything else is converted one
 * element at a time *with* validation, because those conversions can lose
 * information silently: a float array truncates (`1.5` becomes `1`, `2**32`
 * becomes `0`), and a BigInt array cannot convert at all. You pay the
 * per-element cost only for a source that needs it.
 *
 * @param source - Caller-supplied sequence.
 * @param dest - Staging buffer to fill.
 * @param from - First index of `source` to copy.
 * @param count - Number of elements to copy.
 * @param name - Parameter name, for messages.
 * @throws {TypeError} If `source` is not a supported sequence.
 * @throws {RangeError} If an element is not a 32-bit integer.
 * @internal
 */
export function stageU32(
  source: BulkU32Source,
  dest: Uint32Array,
  from: number,
  count: number,
  name: string,
): void {
  if (isIntegerView(source)) {
    // Nothing in an integer view can fail, so this is a single bulk copy.
    dest.set(source.subarray(from, from + count));
    return;
  }

  if (source instanceof Float32Array) {
    for (let i = 0; i < count; i += 1) {
      dest[i] = float32ElementToU32(source[from + i]!, name, from + i);
    }
    return;
  }

  if (source instanceof Float64Array) {
    for (let i = 0; i < count; i += 1) {
      dest[i] = elementToU32(source[from + i]!, name, from + i);
    }
    return;
  }

  if (source instanceof BigInt64Array || source instanceof BigUint64Array) {
    for (let i = 0; i < count; i += 1) {
      dest[i] = bigintToU32(source[from + i]!, name, from + i);
    }
    return;
  }

  if (!Array.isArray(source)) {
    throw new TypeError(`${name} must be an array or typed array of numbers`);
  }

  for (let i = 0; i < count; i += 1) {
    const element = source[from + i];
    if (typeof element === "bigint") {
      dest[i] = bigintToU32(element, name, from + i);
    } else if (typeof element === "number") {
      dest[i] = elementToU32(element, name, from + i);
    } else {
      throw new TypeError(`${name}[${from + i}] must be a number`);
    }
  }
}

/**
 * Converts a source into a form that stages with a bulk copy, validating
 * every element.
 *
 * Integer typed arrays return unchanged: nothing in them can fail, and they
 * already stage with a single `set`. Every other source comes back as a
 * fresh Uint32Array of its converted elements.
 *
 * This is how the chunked bulk methods keep their rejection all-or-nothing —
 * a batch longer than the staging buffer is applied in several WASM calls,
 * so an element rejected in a later chunk would otherwise throw with the
 * earlier chunks already applied. Handing back the converted copy also
 * means each element is converted exactly once: a separate validation pass
 * would pay the per-element cost a second time when staging.
 *
 * @param source - Caller-supplied sequence.
 * @param count - Number of elements to convert, from index 0.
 * @param name - Parameter name, for messages.
 * @returns `source` itself, or its elements converted to a Uint32Array.
 * @throws {TypeError} If `source` is not a supported sequence.
 * @throws {RangeError} If an element is not a 32-bit integer.
 * @internal
 */
export function materializeU32(
  source: BulkU32Source,
  count: number,
  name: string,
): BulkU32Source {
  if (isIntegerView(source)) return source;

  const copy = new Uint32Array(count);
  stageU32(source, copy, 0, count, name);
  return copy;
}

/**
 * Asserts a bulk argument is a sequence, and reports its length.
 *
 * Checked once per call, never per key.
 *
 * @param value - The caller-supplied argument.
 * @param name - Parameter name, for the message.
 * @returns The sequence length.
 * @throws {TypeError} If `value` is not a supported sequence.
 * @internal
 */
export function bulkLength(value: unknown, name: string): number {
  const isSupported =
    isIntegerView(value) ||
    value instanceof Float32Array ||
    value instanceof Float64Array ||
    value instanceof BigInt64Array ||
    value instanceof BigUint64Array ||
    Array.isArray(value);

  if (!isSupported) {
    throw new TypeError(`${name} must be an array or typed array of numbers`);
  }

  return (value as { length: number }).length;
}

/**
 * Asserts a value is a string before it is used as an interning key.
 *
 * A `Map` accepts any key, so an accidental number or `null` would be
 * interned and later handed back by `resolve`, breaking its declared
 * `string | undefined` return.
 *
 * @param value - The caller-supplied argument.
 * @param name - Parameter name, for the message.
 * @returns `value`, narrowed.
 * @throws {TypeError} If `value` is not a string.
 * @internal
 */
export function asString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

/**
 * Translates a native status code into a thrown error, or returns silently.
 *
 * @param status - Value returned by a fallible export.
 * @param operation - Export name, used to build the error message.
 * @param table - Class name of the binding that issued the call.
 * @throws {RangeError} If the module reported that its compiled capacity
 *   would be exceeded.
 * @throws {Error} If the module reported any other non-zero status.
 * @internal
 */
export function assertStatus(
  status: number,
  operation: string,
  table: string,
): void {
  if (status === STATUS_OK) return;

  if (status === STATUS_CAPACITY_EXCEEDED) {
    throw new RangeError(`${operation} exceeded the compiled ${table} capacity`);
  }

  throw new Error(`${operation} failed with status ${status}`);
}
