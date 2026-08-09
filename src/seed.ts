/**
 * The hash seed every table installs into its module at construction.
 *
 * The keys go through a fixed Murmur3 finalizer, which is a permutation of
 * the key space and therefore invertible: without a seed, the set of keys
 * that pile onto one group is a property of the build, identical in every
 * process, and computable offline by anyone holding a copy of the package.
 * Seeding makes that set a property of the instance instead, so it cannot
 * be computed without first learning the seed.
 *
 * A 32-bit seed is what a 32-bit finalizer can carry. It removes
 * precomputation and cross-process reuse; it is not a keyed MAC, and an
 * attacker who can observe which keys collide can still search the seed
 * space offline. See the API reference for what that does and does not buy.
 *
 * @packageDocumentation
 * @internal
 */

/** Fills a one-element buffer with random bytes. */
type FillRandom = (lane: Uint32Array) => void;

/**
 * The Web Crypto entry point, if this runtime has one.
 *
 * Browsers, Deno, Bun, and Node 19+ expose it as a global. It is spelled
 * through an inline structural type rather than `lib.dom`, which the
 * bindings deliberately do not pull in.
 *
 * @returns A filler bound to the global `crypto`, or `undefined`.
 */
function webRandom(): FillRandom | undefined {
  const source = (globalThis as { crypto?: { getRandomValues?: unknown } })
    .crypto;

  if (source === undefined) return undefined;

  const fill = source.getRandomValues;
  if (typeof fill !== "function") return undefined;

  return (lane) => {
    (fill as FillRandom).call(source, lane);
  };
}

/**
 * Resolved `node:crypto` filler, for the Node versions predating the
 * global.
 *
 * Node exposed Web Crypto as a global in 19; the oldest release this
 * package supports is 16.9, and `randomFillSync` has been there throughout.
 * Probed once and cached, including the failure: a runtime without the
 * module does not acquire it on a retry.
 */
let nodeFill: Promise<FillRandom | undefined> | undefined;

/**
 * The `node:crypto` entry point, if this runtime has one.
 *
 * The specifier is assembled at runtime so a bundler targeting the browser
 * does not try to resolve it. This branch is only reached on a runtime that
 * has no global `crypto` at all, which no browser is.
 *
 * @returns A filler backed by `randomFillSync`, or `undefined`.
 */
async function nodeRandom(): Promise<FillRandom | undefined> {
  nodeFill ??= import(/* @vite-ignore */ `node:${"crypto"}`).then(
    (module: { randomFillSync?: unknown }) => {
      const fill = module.randomFillSync;
      if (typeof fill !== "function") return undefined;

      return (lane: Uint32Array) => {
        (fill as FillRandom)(lane);
      };
    },
    () => undefined,
  );

  return nodeFill;
}

/**
 * Draws a random 32-bit hash seed from the runtime's CSPRNG.
 *
 * Never falls back to `Math.random`: a seed drawn from a generator whose
 * state an attacker can recover from its own output is not a seed, and
 * failing loudly is better than a table that reports itself seeded and is
 * not. A runtime with no CSPRNG can still supply its own seed through
 * `createWithSeed`.
 *
 * @returns A seed in `[0, 2**32)`.
 * @throws {Error} If the runtime exposes neither Web Crypto nor
 *   `node:crypto`.
 * @internal
 */
export async function randomSeed(): Promise<number> {
  const fill = webRandom() ?? (await nodeRandom());

  if (fill === undefined) {
    throw new Error(
      "swisstable needs a cryptographic random source to seed its hash, " +
        "and this runtime exposes neither crypto.getRandomValues nor " +
        "node:crypto. Pass a seed explicitly with createWithSeed or " +
        "loadWithSeed if you have one.",
    );
  }

  const lane = new Uint32Array(1);
  fill(lane);

  return lane[0]!;
}

/**
 * Draws a random 32-bit hash seed without awaiting anything.
 *
 * Web Crypto only. The `node:crypto` fallback that {@link randomSeed} uses
 * is reached through a dynamic `import`, which is asynchronous by
 * specification and cannot be made otherwise — so on a runtime with no
 * global `crypto` this throws rather than silently seeding from something
 * weaker. That is Node 16.9 to 18; every browser, Deno, Bun, and Node 19+
 * has the global.
 *
 * @returns A seed in `[0, 2**32)`.
 * @throws {Error} If the runtime exposes no global `crypto.getRandomValues`.
 * @internal
 */
export function randomSeedSync(): number {
  const fill = webRandom();

  if (fill === undefined) {
    throw new Error(
      "swisstable needs a cryptographic random source to seed its hash, " +
        "and this runtime exposes no global crypto.getRandomValues. Use " +
        "the asynchronous create/load, which can also reach node:crypto, " +
        "or pass a seed explicitly with loadSyncWithSeed.",
    );
  }

  const lane = new Uint32Array(1);
  fill(lane);

  return lane[0]!;
}
