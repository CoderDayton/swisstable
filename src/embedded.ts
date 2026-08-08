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
 * Smallest module that uses a SIMD instruction: one function returning the
 * result of `i8x16.splat`.
 *
 * Validated rather than instantiated, so the probe costs a parse of thirty
 * bytes and never allocates a memory. A runtime without SIMD rejects it at
 * the opcode, which is the same reason it rejects the table modules — but
 * this one says so unambiguously, where their failure is just a compile
 * error somewhere in five kilobytes.
 */
const SIMD_PROBE = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic and version
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, // type: () -> v128
  0x03, 0x02, 0x01, 0x00, // one function of that type
  0x0a, 0x08, 0x01, 0x06, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x0b, // i8x16.splat
);

/**
 * Runtimes this package supports, for the message a failure to compile
 * raises. These are the versions that shipped WebAssembly SIMD.
 */
const SIMD_RUNTIMES = "Node 16.9+, Chrome 91+, Firefox 89+, or Safari 16.4+";

/**
 * Reports whether this runtime supports WebAssembly SIMD.
 *
 * Exported so a test can assert it agrees with the table modules: a probe
 * that wrongly answered `false` would report every compile failure — a
 * truncated payload, a corrupt build — as a missing runtime feature, which
 * is worse than the bare error it replaces.
 *
 * @returns `true` if the runtime accepts a v128 instruction.
 * @internal
 */
export function supportsSimd(): boolean {
  return WebAssembly.validate(SIMD_PROBE);
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
 * That case is diagnosed rather than passed through. A runtime without SIMD
 * rejects the module with a bare `CompileError` naming an opcode offset,
 * which tells a caller nothing about what their runtime is missing; the
 * probe distinguishes it from genuinely corrupt bytes, which are reported
 * as they arrive.
 *
 * @param base64 - The embedded module payload.
 * @param probeSimd - How to tell a runtime without SIMD from a bad payload.
 *   Injectable because the diagnostic below is unreachable on any runtime
 *   able to run the test suite, and an untested error path is one that has
 *   never been seen to work.
 * @returns A function returning the shared compiled module.
 * @internal
 */
export function embeddedModule(
  base64: string,
  probeSimd: () => boolean = supportsSimd,
): () => Promise<WebAssembly.Module> {
  let compiled: Promise<WebAssembly.Module> | undefined;

  return () => {
    compiled ??= WebAssembly.compile(decodeBase64(base64)).catch(
      (cause: unknown) => {
        if (probeSimd()) throw cause;

        throw new Error(
          `swisstable requires WebAssembly SIMD (v128), which this runtime ` +
            `does not support. It needs ${SIMD_RUNTIMES}.`,
          { cause },
        );
      },
    );
    return compiled;
  };
}
