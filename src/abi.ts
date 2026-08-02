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
