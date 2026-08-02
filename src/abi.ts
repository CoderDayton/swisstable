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
 * Walks `count` elements of `source`, storing them in `dest` when given one.
 *
 * Integer typed arrays take a bulk `set` and are never inspected per element
 * — the case the bulk API exists for. Everything else is converted one
 * element at a time *with* validation, because those conversions can lose
 * information silently: a float array truncates (`1.5` becomes `1`, `2**32`
 * becomes `0`), and a BigInt array cannot convert at all. You pay the
 * per-element cost only for a source that needs it.
 *
 * A `null` `dest` runs the same walk and discards the results, which is how
 * {@link validateU32} checks a batch without staging it. Sharing one walk is
 * what keeps a validation pass from ever accepting an element the staging
 * copy would reject.
 *
 * @param source - Caller-supplied sequence.
 * @param dest - Staging buffer to fill, or `null` to validate only.
 * @param from - First index of `source` to read.
 * @param count - Number of elements to read.
 * @param name - Parameter name, for messages.
 * @throws {TypeError} If `source` is not a supported sequence.
 * @throws {RangeError} If an element is not a 32-bit integer.
 */
function convertU32(
  source: BulkU32Source,
  dest: Uint32Array | null,
  from: number,
  count: number,
  name: string,
): void {
  if (isIntegerView(source)) {
    // Nothing in an integer view can fail, so a validation pass has no work.
    dest?.set(source.subarray(from, from + count));
    return;
  }

  if (source instanceof Float32Array) {
    for (let i = 0; i < count; i += 1) {
      const value = float32ElementToU32(source[from + i]!, name, from + i);
      if (dest) dest[i] = value;
    }
    return;
  }

  if (source instanceof Float64Array) {
    for (let i = 0; i < count; i += 1) {
      const value = elementToU32(source[from + i]!, name, from + i);
      if (dest) dest[i] = value;
    }
    return;
  }

  if (source instanceof BigInt64Array || source instanceof BigUint64Array) {
    for (let i = 0; i < count; i += 1) {
      const value = bigintToU32(source[from + i]!, name, from + i);
      if (dest) dest[i] = value;
    }
    return;
  }

  if (!Array.isArray(source)) {
    throw new TypeError(`${name} must be an array or typed array of numbers`);
  }

  for (let i = 0; i < count; i += 1) {
    const element = source[from + i];
    let value: number;
    if (typeof element === "bigint") {
      value = bigintToU32(element, name, from + i);
    } else if (typeof element === "number") {
      value = elementToU32(element, name, from + i);
    } else {
      throw new TypeError(`${name}[${from + i}] must be a number`);
    }
    if (dest) dest[i] = value;
  }
}

/**
 * Copies `count` elements of `source`, starting at `from`, into `dest`.
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
  convertU32(source, dest, from, count, name);
}

/**
 * Checks `count` elements of `source` without copying any of them.
 *
 * A batch longer than the staging buffer is applied in several WASM calls, so
 * an element rejected in a later chunk would otherwise throw with the earlier
 * chunks already written to the table. Running the checks over the whole
 * batch first keeps the rejection all-or-nothing.
 *
 * Integer typed arrays cannot fail, so the pre-pass costs nothing for the
 * source type the bulk API exists for.
 *
 * @param source - Caller-supplied sequence.
 * @param from - First index of `source` to check.
 * @param count - Number of elements to check.
 * @param name - Parameter name, for messages.
 * @throws {TypeError} If `source` is not a supported sequence.
 * @throws {RangeError} If an element is not a 32-bit integer.
 * @internal
 */
export function validateU32(
  source: BulkU32Source,
  from: number,
  count: number,
  name: string,
): void {
  convertU32(source, null, from, count, name);
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
