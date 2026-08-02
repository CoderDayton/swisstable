/**
 * Bytes accepted as a WebAssembly module: a raw buffer or a byte view.
 *
 * Spelled out rather than reusing the DOM `BufferSource`, so the bindings
 * typecheck without `lib.dom`. `ArrayBuffer` rather than `ArrayBufferLike`,
 * because the latter admits `SharedArrayBuffer`, which is not a valid
 * source for `WebAssembly.instantiate` — allowing it here would silently
 * resolve to the compiled-module overload instead.
 */
export type WasmSource = ArrayBuffer | Uint8Array<ArrayBufferLike>;

/**
 * Instantiates a module from bytes or from an already-compiled module.
 *
 * The SwissTable modules are freestanding and declare no imports, so no
 * import object is ever needed.
 *
 * @param source - Module bytes, or a compiled {@link WebAssembly.Module}.
 * @returns The instantiated module.
 * @internal
 */
export async function instantiate(
  source: WasmSource | WebAssembly.Module,
): Promise<WebAssembly.Instance> {
  if (source instanceof WebAssembly.Module) {
    return WebAssembly.instantiate(source);
  }
  return instantiateBytes(source);
}

/**
 * Instantiates from bytes only.
 *
 * Split out so the argument has a single, unambiguous type at the call to
 * `WebAssembly.instantiate`. `lib.dom` declares `WebAssembly.Module` as an
 * empty interface, so an `instanceof` check does not narrow a byte source
 * away from it and overload resolution picks the compiled-module signature,
 * whose result has no `instance` property.
 *
 * @param bytes - Module bytes.
 * @returns The instantiated module.
 */
async function instantiateBytes(
  bytes: WasmSource,
): Promise<WebAssembly.Instance> {
  // The cast selects the byte-source overload; it is not a runtime claim.
  // `BufferSource` is `ArrayBufferView<ArrayBuffer> | ArrayBuffer`, so a
  // view backed by `ArrayBufferLike` — which is what `node:fs` hands back —
  // does not match it, and resolution would otherwise fall through to the
  // compiled-module signature. Every host accepts both shapes at runtime.
  const { instance } = await WebAssembly.instantiate(bytes as ArrayBuffer);
  return instance;
}
