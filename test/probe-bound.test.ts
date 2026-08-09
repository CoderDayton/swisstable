import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

/**
 * The probe loop must visit a bounded number of groups.
 *
 * The quadratic sequence enumerates every group exactly once before
 * repeating, but enumerating them is not the same as leaving the loop: the
 * only exits are a key match and an EMPTY byte. A control array with neither
 * spins forever, and WebAssembly has no interrupt, so the calling thread is
 * wedged for good.
 *
 * `g_growth_left` keeps at least capacity/8 slots EMPTY, so no supported call
 * sequence reaches that state — this is the backstop for when an invariant
 * that holds today stops holding, which is exactly when a hang is hardest to
 * diagnose.
 */
describe("probe termination", () => {
  // fileURLToPath, not `.pathname`: on Windows the latter keeps the URL's
  // leading slash, and `/D:/...` is not a path any process can open.
  const fixture = fileURLToPath(
    new URL("./fixtures/probe-bound.ts", import.meta.url),
  );

  /**
   * Runs the probe in a subprocess.
   *
   * A test-runner timeout cannot interrupt an unbounded loop inside
   * WebAssembly; only killing the process can. So the failure mode under test
   * is a subprocess that has to be killed, not an assertion.
   */
  function probe(variant: "u32" | "u64", operation: "lookup" | "insert") {
    return Bun.spawnSync({
      cmd: ["bun", "run", fixture, variant, operation],
      timeout: 20_000,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  for (const variant of ["u32", "u64"] as const) {
    // `lookup` probes find_slot and must report the key absent; `insert`
    // probes find_insert_slot and must reuse a tombstone, reporting STATUS_OK.
    for (const [operation, expected] of [
      ["lookup", "0"],
      ["insert", "0"],
    ] as const) {
      test(`swiss_${variant} ${operation} returns over an all-DELETED control array`, () => {
        const result = probe(variant, operation);
        const stderr = result.stderr.toString().trim();

        // A killed process reports a null exit code, which is the hang. Any
        // other failure is the fixture giving up, and its diagnostic says
        // which check failed.
        expect(stderr).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString().trim()).toBe(expected);
      }, 30_000);
    }
  }
});
