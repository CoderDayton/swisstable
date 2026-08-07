/**
 * Prefix caching for a paged-attention inference server.
 *
 * An LLM server that serves multi-turn chat re-reads the same tokens over
 * and over: every turn of a conversation resends the system prompt and the
 * whole history before the new user message. Prefill is quadratic in that
 * history, so servers cache the attention KV state in fixed-size blocks and
 * skip prefill for any block whose *prefix* has been seen before.
 *
 * That needs an index from "hash of the token prefix ending at this block"
 * to "which physical block holds it", consulted for every block of every
 * request, on the critical path before a single token is generated. It is a
 * u32 -> (u32, u32) map with hundreds of thousands of entries and constant
 * eviction churn — the shape these tables are built for.
 *
 * The index here maps a block's rolling prefix hash to two lanes:
 *
 *   lo = the physical block that holds its KV state
 *   hi = the tick it was last touched, which is what LRU eviction reads
 *
 * Continuous batching is what makes that cheap. A scheduler step admits
 * every request in flight, so one `getMany` resolves ~2,000 blocks and one
 * `setMany` commits them, and eviction retires a whole generation with a
 * second pair of calls. The WASM boundary is crossed a handful of times per
 * step rather than twice per block. The same workload runs against
 * `Map<number, {slot, tick}>` for comparison, and both are made to reach
 * identical cache decisions so that only their cost differs.
 *
 * Read the two timings it prints together: the index is about twice as fast
 * here, and the step loop around it barely moves, because batching has
 * already made the lookup small against the server's own bookkeeping.
 *
 * The timings are single-shot and include JIT warmup, so they run slower
 * than the steady-state figures in docs/performance.md. Use `bun run bench`
 * for numbers worth comparing.
 *
 * Run with `bun run examples/05-prefix-cache.ts`.
 */

import { SwissU32ToU64 } from "../src/index.ts";

// ── The server's cache ─────────────────────────────────────────────────

const BLOCK_TOKENS = 16;
const PHYSICAL_BLOCKS = 32_768;

// A 7B-class model: 32 layers, 8 KV heads, head dim 128, fp16, K and V.
const KV_BYTES_PER_TOKEN = 2 * 32 * 8 * 128 * 2;
const KV_BYTES_PER_BLOCK = KV_BYTES_PER_TOKEN * BLOCK_TOKENS;

// ── The workload ───────────────────────────────────────────────────────

const SYSTEM_PROMPTS = 8;
const SYSTEM_TOKENS = 208;
const TURNS = 4;
const TURN_TOKENS = 96;
const CONVERSATIONS = 2_000;

// A server has bounded concurrency, so turns interleave across the
// conversations currently in flight rather than across all of them.
const CONCURRENCY = 64;

const SYSTEM_BLOCKS = SYSTEM_TOKENS / BLOCK_TOKENS;
const TURN_BLOCKS = TURN_TOKENS / BLOCK_TOKENS;
const MAX_BLOCKS = SYSTEM_BLOCKS + TURNS * TURN_BLOCKS;

// Continuous batching admits every in-flight request in one scheduler
// step, so a step resolves this many blocks at once.
const STEP_BLOCKS = CONCURRENCY * MAX_BLOCKS;

const VOCAB = 32_000;

// ── Prefix hashing ─────────────────────────────────────────────────────

/**
 * Chains each block's hash into the next, so a hash identifies the whole
 * token prefix ending at that block and not just its own 16 tokens. Two
 * requests agree on a hash only when every token before it agreed too,
 * which is what makes sharing safe.
 *
 * Distinct prefixes can still collide in 32 bits. Servers accept that the
 * same way they accept it for content-addressed storage: the birthday odds
 * at 48,000 live blocks are under 1 in 3,000, and a collision costs a wrong
 * cache hit, not a crash. Verify the tokens alongside the hash if that is
 * not acceptable.
 */
function hashBlock(parent: number, tokens: Uint32Array, start: number): number {
  let h = (parent ^ 0x811c_9dc5) >>> 0;

  for (let i = start; i < start + BLOCK_TOKENS; i++) {
    h = Math.imul(h ^ tokens[i]!, 0x0100_0193) >>> 0;
  }

  // Murmur3's finalizer, so adjacent prefixes land far apart.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85eb_ca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2_ae35) >>> 0;
  h ^= h >>> 16;

  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function fillTokens(
  seed: number,
  count: number,
  into: Uint32Array,
  at: number,
): void {
  const random = mulberry32(seed);
  for (let i = 0; i < count; i++) into[at + i] = (random() * VOCAB) >>> 0;
}

// Tokenizing and hashing is the client's work, not the index's, so it
// happens once up front and outside every timed region below.
const blockHashes = new Uint32Array(CONVERSATIONS * MAX_BLOCKS);

{
  const tokens = new Uint32Array(SYSTEM_TOKENS + TURNS * TURN_TOKENS);

  for (let c = 0; c < CONVERSATIONS; c++) {
    // Conversations sharing a system prompt share its exact tokens, so
    // their first SYSTEM_BLOCKS hashes come out identical.
    fillTokens(1_000 + (c % SYSTEM_PROMPTS), SYSTEM_TOKENS, tokens, 0);
    fillTokens(500_000 + c, TURNS * TURN_TOKENS, tokens, SYSTEM_TOKENS);

    let parent = 0;
    for (let b = 0; b < MAX_BLOCKS; b++) {
      parent = hashBlock(parent, tokens, b * BLOCK_TOKENS);
      blockHashes[c * MAX_BLOCKS + b] = parent;
    }
  }
}

// ── The index, twice ───────────────────────────────────────────────────

/** Where a cached block lives, and when it was last read. */
interface Residency {
  slot: number;
  tick: number;
}

interface Lookup {
  slots: Uint32Array;
  ticks: Uint32Array;
  found: Uint8Array;
}

/**
 * The three things the server asks of its block index. Both implementations
 * answer out of buffers they own, so neither allocates per step and the
 * comparison is of the index, not of the garbage around it.
 */
interface PrefixIndex {
  readonly name: string;
  readonly size: number;
  /** Resolves a whole step's blocks; results are valid until the next call. */
  lookup(hashes: Uint32Array): Lookup;
  /** Inserts missing blocks and refreshes the tick on the ones that hit. */
  commit(hashes: Uint32Array, slots: Uint32Array, ticks: Uint32Array): void;
  /** Retires blocks, by hash; the first `count` entries are read. */
  evict(hashes: Uint32Array, count: number): void;
}

class SwissPrefixIndex implements PrefixIndex {
  readonly name = "SwissU32ToU64";

  // getMany writes into these instead of allocating three arrays per call.
  private readonly out = {
    valsLo: new Uint32Array(STEP_BLOCKS),
    valsHi: new Uint32Array(STEP_BLOCKS),
    found: new Uint8Array(STEP_BLOCKS),
  };

  constructor(private readonly table: SwissU32ToU64) {}

  get size(): number {
    return this.table.size;
  }

  lookup(hashes: Uint32Array): Lookup {
    const result = this.table.getMany(hashes, this.out);
    return { slots: result.valsLo, ticks: result.valsHi, found: result.found };
  }

  commit(hashes: Uint32Array, slots: Uint32Array, ticks: Uint32Array): void {
    // Inserts and tick refreshes are the same call: setMany overwrites an
    // existing key rather than rejecting it, so a request's hits and misses
    // commit together in one crossing.
    this.table.setMany(hashes, slots, ticks);
  }

  evict(hashes: Uint32Array, count: number): void {
    this.table.deleteMany(hashes.subarray(0, count));
  }
}

class MapPrefixIndex implements PrefixIndex {
  readonly name = "Map<number, {slot, tick}>";

  private readonly map = new Map<number, Residency>();
  private readonly slots = new Uint32Array(STEP_BLOCKS);
  private readonly ticks = new Uint32Array(STEP_BLOCKS);
  private readonly found = new Uint8Array(STEP_BLOCKS);

  get size(): number {
    return this.map.size;
  }

  lookup(hashes: Uint32Array): Lookup {
    for (let i = 0; i < hashes.length; i++) {
      const resident = this.map.get(hashes[i]!);

      this.found[i] = resident === undefined ? 0 : 1;
      this.slots[i] = resident?.slot ?? 0;
      this.ticks[i] = resident?.tick ?? 0;
    }

    return { slots: this.slots, ticks: this.ticks, found: this.found };
  }

  commit(hashes: Uint32Array, slots: Uint32Array, ticks: Uint32Array): void {
    for (let i = 0; i < hashes.length; i++) {
      const resident = this.map.get(hashes[i]!);

      // Mutating in place keeps the tick refresh allocation-free, which is
      // the fastest shape a Map can take here.
      if (resident === undefined) {
        this.map.set(hashes[i]!, { slot: slots[i]!, tick: ticks[i]! });
      } else {
        resident.slot = slots[i]!;
        resident.tick = ticks[i]!;
      }
    }
  }

  evict(hashes: Uint32Array, count: number): void {
    for (let i = 0; i < count; i++) this.map.delete(hashes[i]!);
  }
}

// ── Serving ────────────────────────────────────────────────────────────

interface Stats {
  promptTokens: number;
  cachedTokens: number;
  evicted: number;
  resident: number;
  elapsedMs: number;
  indexMs: number;
}

/**
 * Builds a server loop.
 *
 * Each contender gets its own copy rather than sharing one, because a
 * shared loop would see two shapes of `PrefixIndex` at every call site and
 * specialize for neither — the same reason `bun run bench` gives each
 * contender an isolate of its own. Sharing one here costs the faster index
 * most of its margin.
 */
function createServer(): (index: PrefixIndex) => Stats {
  return function serveAll(index: PrefixIndex): Stats {
    // Physical blocks are handed out from a free list and returned by
    // eviction; the index never holds more entries than there are blocks.
    const freeSlots = new Uint32Array(PHYSICAL_BLOCKS);
    for (let i = 0; i < PHYSICAL_BLOCKS; i++) freeSlots[i] = i;
    let freeCount = PHYSICAL_BLOCKS;

    const victims = new Uint32Array(STEP_BLOCKS);
    const victimSlots = new Uint32Array(STEP_BLOCKS);

    const stepHashes = new Uint32Array(STEP_BLOCKS);
    const stepSlots = new Uint32Array(STEP_BLOCKS);
    const stepFound = new Uint8Array(STEP_BLOCKS);
    const slots = new Uint32Array(STEP_BLOCKS);
    const ticks = new Uint32Array(STEP_BLOCKS);

    // What each step committed, oldest first. Eviction retires a whole
    // generation rather than walking the index for the coldest entries: a
    // scan is O(capacity) on the request path, and this is two bulk calls
    // whatever the cache holds.
    const generations: { tick: number; hashes: Uint32Array }[] = [];
    let retiring = 0;

    // The blocks the running batch needs, which eviction must leave alone.
    // A real server refcounts per request; pinning the step is the same rule
    // at the granularity this loop schedules at. Doubling as the step's
    // distinct hashes is what keeps a generation free of duplicates.
    const pinned = new Set<number>();

    // Requests in one step share their system prompt, so the same missing
    // hash arrives several times. Assigning it a block once keeps the free
    // list honest — otherwise every duplicate but the last would own a block
    // nothing could ever reach again.
    const assigned = new Map<number, number>();

    let promptTokens = 0;
    let cachedTokens = 0;
    let evicted = 0;
    let tick = 1;

    // The index is consulted a few times per step rather than per block, so
    // a clock around each call is far too coarse to perturb what it times.
    let indexNs = 0;

    /**
     * Retires the oldest generation still holding blocks, returning how
     * many it freed.
     *
     * A block that was touched after its generation carries a newer tick
     * and belongs to that newer generation instead, so the lookup filters
     * it out here and it is retired on its own turn. Nothing leaks: every
     * skipped block is either already gone or listed in a later generation.
     */
    function retireOldest(): number {
      while (retiring < generations.length) {
        const generation = generations[retiring++]!;
        const { hashes } = generation;
        const startedLookup = Bun.nanoseconds();
        const resident = index.lookup(hashes);
        indexNs += Bun.nanoseconds() - startedLookup;

        let freed = 0;

        for (let i = 0; i < hashes.length; i++) {
          if (resident.found[i] !== 1) continue;
          if (resident.ticks[i] !== generation.tick) continue;
          if (pinned.has(hashes[i]!)) continue;

          victims[freed] = hashes[i]!;
          victimSlots[freed] = resident.slots[i]!;
          freed++;
        }

        if (freed === 0) continue;

        const startedEvict = Bun.nanoseconds();
        index.evict(victims, freed);
        indexNs += Bun.nanoseconds() - startedEvict;

        for (let i = 0; i < freed; i++) freeSlots[freeCount++] = victimSlots[i]!;
        evicted += freed;

        return freed;
      }

      return 0;
    }

    function allocate(): number {
      while (freeCount === 0) {
        if (retireOldest() === 0) {
          throw new Error("every resident block is in the running batch");
        }
      }

      return freeSlots[--freeCount]!;
    }

    const started = Bun.nanoseconds();

    for (let first = 0; first < CONVERSATIONS; first += CONCURRENCY) {
      const last = Math.min(first + CONCURRENCY, CONVERSATIONS);

      for (let turn = 1; turn <= TURNS; turn++) {
        const requests = last - first;
        const blocks = SYSTEM_BLOCKS + turn * TURN_BLOCKS;
        const total = requests * blocks;

        // Stage the running batch's prompts back to back. Batching is what
        // makes the crossing disappear: a step of 64 requests resolves ~2,000
        // blocks in one call, well past the point where the fixed cost of a
        // call still shows up in the per-block figure.
        pinned.clear();

        for (let r = 0; r < requests; r++) {
          const base = (first + r) * MAX_BLOCKS;

          for (let b = 0; b < blocks; b++) {
            const hash = blockHashes[base + b]!;
            stepHashes[r * blocks + b] = hash;
            pinned.add(hash);
          }
        }

        const step = stepHashes.subarray(0, total);

        const startedLookup = Bun.nanoseconds();
        const resident = index.lookup(step);
        indexNs += Bun.nanoseconds() - startedLookup;

        // Copy the answer out before allocating: eviction consults the index
        // too, and both implementations answer from a buffer they reuse.
        stepSlots.set(resident.slots.subarray(0, total));
        stepFound.set(resident.found.subarray(0, total));

        // Attention needs a contiguous prefix, so a block that hits after a
        // gap is still resident but cannot shorten that request's prefill.
        // Counting only the unbroken run is what the server can really skip.
        for (let r = 0; r < requests; r++) {
          const at = r * blocks;
          let prefix = 0;
          while (prefix < blocks && stepFound[at + prefix] === 1) prefix++;

          promptTokens += blocks * BLOCK_TOKENS;
          cachedTokens += prefix * BLOCK_TOKENS;
        }

        assigned.clear();

        for (let i = 0; i < total; i++) {
          if (stepFound[i] === 1) {
            slots[i] = stepSlots[i]!;
            continue;
          }

          const hash = step[i]!;
          let slot = assigned.get(hash);

          if (slot === undefined) {
            slot = allocate();
            assigned.set(hash, slot);
          }

          slots[i] = slot;
        }

        ticks.fill(tick, 0, total);

        const startedCommit = Bun.nanoseconds();
        index.commit(step, slots.subarray(0, total), ticks.subarray(0, total));
        indexNs += Bun.nanoseconds() - startedCommit;

        // Every block the step touched now carries this tick, so this is
        // exactly the set the generation owns.
        generations.push({ tick, hashes: Uint32Array.from(pinned) });
        tick++;
      }
    }

    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

    return {
      promptTokens,
      cachedTokens,
      evicted,
      resident: index.size,
      elapsedMs,
      indexMs: indexNs / 1e6,
    };
  };
}

// ── Run it ─────────────────────────────────────────────────────────────

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const pct = (part: number, whole: number) =>
  `${((part / whole) * 100).toFixed(1)}%`;

console.log("KV cache:");
console.log(`  block            ${BLOCK_TOKENS} tokens, ${KV_BYTES_PER_BLOCK / 1024 ** 2} MiB`);
console.log(`  capacity         ${PHYSICAL_BLOCKS.toLocaleString()} blocks`);
console.log(`                   ${gib(PHYSICAL_BLOCKS * KV_BYTES_PER_BLOCK)} of device memory`);
console.log(`                   ${(PHYSICAL_BLOCKS * BLOCK_TOKENS).toLocaleString()} tokens resident`);
console.log(`  workload         ${(CONVERSATIONS * TURNS).toLocaleString()} requests over ${CONVERSATIONS.toLocaleString()} conversations`);
console.log(`                   ${SYSTEM_PROMPTS} shared system prompts, ${CONCURRENCY} in flight`);
console.log();

const table = await SwissU32ToU64.create(PHYSICAL_BLOCKS);

// Each index is run twice and the second pass reported, so neither is
// charged for the JIT warming up on it.
let swiss!: Stats;
let map!: Stats;

const serveSwiss = createServer();
const serveMap = createServer();

for (let pass = 0; pass < 2; pass++) {
  table.clear();

  // Collect before each run rather than between passes. The Map index
  // allocates a residency object per block and the table allocates none,
  // so without this the table's run is charged for collecting the Map's
  // garbage — the same reason `bun run bench` collects between rounds.
  Bun.gc(true);
  swiss = serveSwiss(new SwissPrefixIndex(table));

  Bun.gc(true);
  map = serveMap(new MapPrefixIndex());
}

for (const [stats, index] of [[swiss, "SwissU32ToU64"], [map, "Map"]] as const) {
  console.log(`${index}:`);
  console.log(`  in the index     ${stats.indexMs.toFixed(1)} ms`);
  console.log(`  whole step loop  ${stats.elapsedMs.toFixed(1)} ms`);
  console.log(`  prefill skipped  ${stats.cachedTokens.toLocaleString()} of ${stats.promptTokens.toLocaleString()} tokens (${pct(stats.cachedTokens, stats.promptTokens)})`);
  console.log(`  evicted          ${stats.evicted.toLocaleString()} blocks`);
  console.log(`  resident         ${stats.resident.toLocaleString()} blocks`);
  console.log();
}

// Both runs make identical decisions, so the only thing that differs is
// what the index cost to consult.
console.log(
  "same cache decisions:",
  swiss.cachedTokens === map.cachedTokens && swiss.evicted === map.evicted,
);
console.log(`index speedup:  ${(map.indexMs / swiss.indexMs).toFixed(2)}x`);
console.log();

// Worth reading the two lines above together. The step loop stages hashes,
// pins the running batch and hands out blocks, and that work is identical
// under both indexes — so batching has already made the index small enough
// against it that the whole loop barely moves. Speeding up the lookup is
// only worth doing while the lookup is what a request waits on.
console.log("The rest of each step is the server's own bookkeeping, and is");
console.log("the same work under either index.");
console.log();

// Worth being clear about which advantage is doing the work. The index is
// a rounding error against the cache it manages — 14.9 B per live entry
// against a measured 77.4 B for Map<number, {lo, hi}> on V8 saves under a
// megabyte here, next to tens of gigabytes of KV state. What it buys is
// latency on a lookup that every request waits on, and that comes from
// batching: two crossings per request instead of two per block.
console.log(`index footprint:  ~${((PHYSICAL_BLOCKS * 14.9) / 1024 ** 2).toFixed(2)} MiB`);
console.log(`KV cache:         ${gib(PHYSICAL_BLOCKS * KV_BYTES_PER_BLOCK)}`);
console.log();
console.log("A cache small enough to hold under ~2,000 blocks should use a Map");
console.log("instead — see docs/performance.md for where the crossover sits.");
