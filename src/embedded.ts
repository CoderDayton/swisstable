/**
 * Support for instantiating the SwissTable modules from bytes compiled into
 * the bindings, so callers do not have to load a `.wasm` file themselves.
 *
 * @internal
 */

/**
 * Decodes a base64 module payload.
 *
 * Uses `atob` rather than `Buffer` or `Uint8Array.fromBase64`: it is the one
 * spelling available in every runtime this package targets, and the payloads
 * are a few kilobytes, so the per-character loop is not worth optimizing.
 *
 * @param text - Base64 text emitted by `scripts/build-wasm.ts`.
 * @returns The decoded module bytes.
 * @internal
 */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/**
 * Returns a compiler for an embedded module that compiles at most once.
 *
 * Validation and code generation are the expensive part of creating a table,
 * and the bytes never change, so every table after the first reuses the
 * compiled {@link WebAssembly.Module}.
 *
 * A rejection is cached along with the success. The only way compilation
 * fails here is a runtime that cannot compile these modules at all — no SIMD
 * support, most likely — and that does not become true on a retry.
 *
 * @param base64 - The embedded module payload.
 * @returns A function returning the shared compiled module.
 * @internal
 */
export function embeddedModule(
  base64: string,
): () => Promise<WebAssembly.Module> {
  let compiled: Promise<WebAssembly.Module> | undefined;

  return () => {
    compiled ??= WebAssembly.compile(decodeBase64(base64));
    return compiled;
  };
}
