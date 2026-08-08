import { describe, expect, test } from "bun:test";

import { embeddedModule, supportsSimd } from "../src/embedded.ts";
import { SWISS_U32_WASM_BASE64 } from "../src/generated/swiss_u32.ts";

/** A payload that cannot compile anywhere, standing in for any failure. */
const CORRUPT = btoa("not a WebAssembly module");

describe("embeddedModule without SIMD", () => {
  test("names the missing feature and the runtimes that have it", async () => {
    const compile = embeddedModule(SWISS_U32_WASM_BASE64, () => false);

    // The payload is the real one, so only the probe decides the message.
    // On this runtime it compiles, which is why the probe has to be injected
    // to reach the branch at all.
    const corrupt = embeddedModule(CORRUPT, () => false);

    await expect(corrupt()).rejects.toThrow(/requires WebAssembly SIMD/);
    await expect(corrupt()).rejects.toThrow(/Node 16\.9\+/);
    await expect(compile()).resolves.toBeInstanceOf(WebAssembly.Module);
  });

  test("keeps the underlying failure as the cause", async () => {
    const compile = embeddedModule(CORRUPT, () => false);

    const error = (await compile().catch((e: unknown) => e)) as Error;

    expect(error.message).toMatch(/requires WebAssembly SIMD/);
    expect(error.cause).toBeDefined();
  });

  test("passes a compile failure through when SIMD is present", async () => {
    const compile = embeddedModule(CORRUPT, () => true);

    const error = (await compile().catch((e: unknown) => e)) as Error;

    // A corrupt build must not be reported as a missing runtime feature.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toMatch(/requires WebAssembly SIMD/);
  });

  test("caches the rejection instead of recompiling", async () => {
    let probes = 0;
    const compile = embeddedModule(CORRUPT, () => {
      probes += 1;
      return false;
    });

    await expect(compile()).rejects.toThrow();
    await expect(compile()).rejects.toThrow();

    expect(probes).toBe(1);
  });

  test("the real probe agrees with this runtime", () => {
    // If these disagreed, every corrupt build would be misreported.
    expect(supportsSimd()).toBe(true);
  });
});
