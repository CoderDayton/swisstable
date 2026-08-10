#!/usr/bin/env bun
/**
 * Compiles the native SwissTable sources to freestanding wasm32 modules,
 * and emits each one a second time as a base64 TypeScript module so the
 * bindings can instantiate without the caller supplying bytes.
 *
 * The compiler is the pinned Zig toolchain, installed on demand by
 * scripts/toolchain.ts. It carries its own clang, lld, and headers, so the
 * output is identical on Linux, macOS, and Windows.
 *
 * Set SWISS_UBSAN=1 to build the checked variant instead: same sources with
 * UndefinedBehaviorSanitizer in trapping mode, written to dist/wasm-ubsan
 * and never embedded. `bun run check:ubsan` exercises it.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { zigExecutable } from "./toolchain.ts";

const ROOT = resolve(import.meta.dir, "..");
const NATIVE_DIR = join(ROOT, "native");
const GENERATED_DIR = join(ROOT, "src", "generated");

/**
 * Trapping UBSan needs no runtime library, so it links under -nostdlib and
 * costs nothing but code size. It is a verification build, not a shipping
 * one: a trap aborts the instance, which is a worse outcome in production
 * than the arithmetic that would have provoked it.
 */
const UBSAN = Bun.env.SWISS_UBSAN === "1";

const OUTPUT_DIR = join(ROOT, "dist", UBSAN ? "wasm-ubsan" : "wasm");

const MIB = 1024 * 1024;

/** WebAssembly linear memory is reserved in units of this. */
const PAGE = 64 * 1024;

/** Smallest exponent that still leaves room for one group of slots. */
const MIN_MAX_CAPACITY_LOG2 = 4;

/**
 * Largest exponent MAX_LIVE()'s 32-bit product stays exact for. Enforced
 * identically in native/swiss_core.h, which the sources also compile
 * standalone against.
 *
 * What binds first is narrower and per-module: three banks have to address
 * inside wasm32, which depends on the entry width. Each source carries its
 * own ceiling and asserts it at compile time, so an override past what a
 * module can address fails the build rather than this check.
 */
const MAX_MAX_CAPACITY_LOG2 = 29;

/**
 * Exponent override, or `undefined` to let each source keep its own.
 *
 * Lowering it builds modules for a workload holding many small tables. It no
 * longer changes what an instance reserves — the banks are reached by
 * growing memory, so an instance costs what its table costs either way — but
 * it does cap how far one table can grow, and caps the address space the
 * module asks the host to reserve.
 */
function maxCapacityLog2(): number | undefined {
  const raw = Bun.env.SWISS_MAX_CAPACITY_LOG2;
  if (raw === undefined || raw === "") return undefined;

  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_MAX_CAPACITY_LOG2 ||
    parsed > MAX_MAX_CAPACITY_LOG2
  ) {
    throw new Error(
      `SWISS_MAX_CAPACITY_LOG2 must be an integer in ` +
        `[${MIN_MAX_CAPACITY_LOG2}, ${MAX_MAX_CAPACITY_LOG2}]; got ${raw}`,
    );
  }

  return parsed;
}

const MAX_CAPACITY_LOG2 = maxCapacityLog2();

const COMMON_FLAGS = [
  "--target=wasm32-freestanding",
  "-O3",
  "-flto",
  "-msimd128",
  "-mbulk-memory",
  "-nostdlib",
  // The module defines its own memset, and clang lowers bulk stores to a
  // memset call. Without this, the byte loop inside that definition is
  // itself a memset-shaped loop, and only an LLVM heuristic that declines
  // to transform loops in a function of that name keeps it from being
  // rewritten into a call to itself. Naming the builtin removes the
  // recursion risk from the optimiser's discretion; the one call site that
  // wants the `memory.fill` instruction asks for it as __builtin_memset.
  "-fno-builtin-memset",
  // Zig turns UBSan on by default, and its handlers live in a runtime this
  // module does not link, so the default build has to switch it off. The
  // checked build instead keeps the instrumentation and lowers each report
  // to an `unreachable` instruction, which needs no runtime at all.
  ...(UBSAN
    ? ["-fsanitize=undefined", "-fsanitize-trap=undefined"]
    : ["-fno-sanitize=undefined"]),
  "-Wall",
  "-Wextra",
  "-Wl,--no-entry",
  "-Wl,--export-memory",
  // Stack below all data, so an overflow traps as an out-of-bounds access
  // instead of silently corrupting the table banks in .bss. `zig cc` passes
  // --stack-first to wasm-ld itself for freestanding wasm and rejects it as
  // a user linker argument, so it is not repeated here; the layout is
  // asserted by test/memory-layout.test.ts rather than assumed. The size
  // pins the linker default so the budget is explicit.
  "-Wl,-z,stack-size=65536",
  // The module is freestanding and has no debugging use case, so the name,
  // producers, and target-features sections are dead weight — about a tenth
  // of the output. Stripping also removes the compiler version string the
  // producers section embeds, which would otherwise put the toolchain's
  // identity in the committed payload and make src/generated change on a CI
  // image bump with no source change behind it.
  "-Wl,--strip-all",
];

interface WasmTarget {
  /** Output module name, without the .wasm extension. */
  readonly name: string;
  /** Single translation unit, relative to `native/`. */
  readonly source: string;
  /**
   * Bytes one bank spends per slot: one control byte plus one entry. The
   * maximum memory is derived from this and MAX_CAPACITY_LOG2 rather than
   * written out, so lowering the exponent lowers the ceiling with it.
   */
  readonly bankBytesPerSlot: number;
  /**
   * The source's own `MAX_CAPACITY_LOG2`, matching the `#ifndef` in it.
   *
   * Repeated here because `--max-memory` is derived from it, and the linker
   * needs the number before the compiler has read the source. A mismatch is
   * caught by the `_Static_assert` in swiss_core.h, not left to be found at
   * runtime.
   */
  readonly ceilingLog2: number;
  /**
   * Static data below the heap: the fixed-size staging buffers, which are
   * sized by SCAN_WINDOW / BULK_CAPACITY and not by MAX_CAPACITY, plus the
   * module's own sections. This is what the initial memory has to cover.
   */
  readonly staticBytes: number;
  /** Symbols the JavaScript bindings expect to find on the instance. */
  readonly exports: readonly string[];
  /**
   * Whether the module is also emitted as a base64 TypeScript source, which
   * is what makes `create()` work without a loader.
   *
   * False for a module built only for the test suite to load off disk. Such
   * a module also ignores SWISS_MAX_CAPACITY_LOG2: it exists to put a
   * ceiling within reach of a test, and an override would defeat that.
   */
  readonly embed: boolean;
  /**
   * Linear memory the module may grow to, overriding what its ceiling
   * implies. Only set for a test module that has to be refused a grow.
   */
  readonly maxMemoryOverride?: number;
}

const TARGETS: readonly WasmTarget[] = [
  {
    name: "swiss_u32",
    source: "swiss_u32.c",
    embed: true,
    // 1 control byte + an 8-byte Entry per slot.
    bankBytesPerSlot: 1 + 8,
    ceilingLog2: 27,
    // 65536 x (bulk keys, values, flags; scan keys, values) = ~1.1 MiB,
    // plus section headroom.
    staticBytes: 65536 * 17 + 128 * 1024,
    exports: [
      "set_seed",
      "init",
      "reserve",
      "shrink_to_fit",
      "clear",
      "has",
      "has_get",
      "last_value_ptr",
      "set",
      "get_or_insert",
      "increment",
      "delete_key",
      "set_many",
      "get_many",
      "delete_many",
      "bulk_capacity",
      "bulk_keys_ptr",
      "bulk_values_ptr",
      "bulk_flags_ptr",
      "scan",
      "scan_window",
      "scan_keys_ptr",
      "scan_values_ptr",
      "generation",
      "size",
      "capacity",
      "size_ptr",
      "capacity_ptr",
    ],
  },
  {
    name: "swiss_u64",
    source: "swiss_u64.c",
    embed: true,
    // 1 control byte + a 12-byte Entry per slot.
    bankBytesPerSlot: 1 + 12,
    ceilingLog2: 26,
    // 65536 x (bulk keys, lo, hi, flags; scan keys, lo, hi) = ~1.6 MiB,
    // plus section headroom.
    staticBytes: 65536 * 25 + 128 * 1024,
    exports: [
      "set_seed",
      "init",
      "reserve",
      "shrink_to_fit",
      "clear",
      "has",
      "has_get",
      "last_value_ptr",
      "set",
      "get_or_insert",
      "increment",
      "delete_key",
      "set_many",
      "get_many",
      "delete_many",
      "bulk_capacity",
      "bulk_keys_ptr",
      "bulk_values_lo_ptr",
      "bulk_values_hi_ptr",
      "bulk_flags_ptr",
      "scan",
      "scan_window",
      "scan_keys_ptr",
      "scan_values_lo_ptr",
      "scan_values_hi_ptr",
      "generation",
      "size",
      "capacity",
      "size_ptr",
      "capacity_ptr",
    ],
  },
];

/**
 * The u32 module again, capped low enough that a test can fill it.
 *
 * The shipped ceiling is 117,440,512 entries, which no test can reach in
 * bounded time or memory — but the paths that report it are worth covering:
 * a refused insert, an overwrite that must still succeed on a full table,
 * and a table left usable afterwards. This module puts all three within a
 * few tens of thousands of inserts.
 *
 * Never embedded and never published; the test suite loads it from
 * dist/wasm, the same way it loads the real ones.
 */
const CAPPED_U32: WasmTarget = {
  ...TARGETS[0]!,
  name: "swiss_u32_capped",
  ceilingLog2: 16,
  embed: false,
};

/**
 * The u32 module with a ceiling it cannot afford: 2^20 slots would need
 * 28 MiB of banks, and it is allowed 8.
 *
 * This is the only way to exercise the other refusal — the host declining a
 * `memory.grow` — which reports the same status as the slot ceiling but
 * from a different place, and has to leave the table just as usable.
 *
 * Never embedded and never published.
 */
const STARVED_U32: WasmTarget = {
  ...TARGETS[0]!,
  name: "swiss_u32_starved",
  ceilingLog2: 20,
  embed: false,
  maxMemoryOverride: 8 * MIB,
};

/** Linker-placed stack, from -Wl,-z,stack-size in COMMON_FLAGS. */
const STACK_BYTES = 64 * 1024;

/** wasm32 addresses 65536 pages, and no engine accepts a larger maximum. */
const MAX_PAGES = 65536;

/**
 * What an instance reserves at instantiation: static data and stack, and
 * nothing proportional to the capacity ceiling.
 *
 * The banks live on the heap and are reached by growing memory, so this is
 * what a table that stays small actually costs. Undersizing it is caught by
 * the link rather than at runtime: wasm-ld fails outright when static data
 * does not fit below the initial memory, so the arithmetic is checked by
 * every build rather than trusted.
 */
function initialMemoryBytes(target: WasmTarget): number {
  return Math.ceil((target.staticBytes + STACK_BYTES) / PAGE) * PAGE;
}

/**
 * The most an instance may ever grow to: the high-water mark of the bank
 * placement, which is three banks at MAX_CAPACITY — see the placement note
 * in native/swiss_core.h — above the static data.
 *
 * This is address space, not a reservation. Only the pages a bank has
 * actually written are ever committed.
 */
/** The exponent this target is built at: the override, or its own. */
function exponentFor(target: WasmTarget): number {
  if (!target.embed) return target.ceilingLog2;
  return MAX_CAPACITY_LOG2 ?? target.ceilingLog2;
}

function maxMemoryBytes(target: WasmTarget): number {
  if (target.maxMemoryOverride !== undefined) {
    return Math.ceil(target.maxMemoryOverride / PAGE) * PAGE;
  }

  const slots = 2 ** exponentFor(target);
  const peak = 3 * target.bankBytesPerSlot * slots;
  const required = peak + initialMemoryBytes(target);

  return Math.min(Math.ceil(required / PAGE) * PAGE, MAX_PAGES * PAGE);
}

function linkFlags(target: WasmTarget): string[] {
  return [
    `-Wl,--initial-memory=${initialMemoryBytes(target)}`,
    `-Wl,--max-memory=${maxMemoryBytes(target)}`,
    ...target.exports.map((symbol) => `-Wl,--export=${symbol}`),
  ];
}

async function build(zig: string, target: WasmTarget): Promise<void> {
  const outputPath = join(OUTPUT_DIR, `${target.name}.wasm`);
  await mkdir(dirname(outputPath), { recursive: true });

  const argv = [
    zig,
    "cc",
    ...COMMON_FLAGS,
    `-DMAX_CAPACITY_LOG2=${exponentFor(target)}`,
    ...linkFlags(target),
    "-o",
    outputPath,
    join(NATIVE_DIR, target.source),
  ];

  const result = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });

  if (result.exitCode !== 0) {
    throw new Error(`${target.source}: zig cc exited with ${result.exitCode}`);
  }

  const bytes = await Bun.file(outputPath).bytes();
  // The checked build is a throwaway the tests instantiate directly. Writing
  // it into src/generated would ship trapping code and, worse, make the
  // committed payload depend on which variant was built last.
  if (!UBSAN && target.embed) await emitEmbedded(target, bytes);

  console.log(
    `built ${target.name}.wasm (${bytes.length} bytes, ` +
      `${(initialMemoryBytes(target) / MIB).toFixed(2)} MiB initial memory, ` +
      `${(maxMemoryBytes(target) / MIB).toFixed(0)} MiB maximum, ` +
      `max capacity 2^${exponentFor(target)}${UBSAN ? ", ubsan" : ""})`,
  );
}

/**
 * Writes the module out as a base64 string literal in a TypeScript source
 * file, which is what makes `create()` work on every runtime without a
 * loader: no fs, no fetch, no bundler asset handling.
 *
 * base64 costs 33% over the raw bytes, which on modules this small is about
 * 1.3 KiB. Decoding is a few microseconds against a compile that is orders
 * of magnitude more, so the tradeoff is not close.
 */
async function emitEmbedded(
  target: WasmTarget,
  bytes: Uint8Array,
): Promise<void> {
  const constant = `${target.name.toUpperCase()}_WASM_BASE64`;
  const source = [
    `// Generated by scripts/build-wasm.ts from native/${target.source}.`,
    "// Do not edit; rebuild with `bun run build:wasm`.",
    "",
    `/** ${target.name}.wasm, base64 encoded. */`,
    // Annotated rather than inferred: without it the declaration emit
    // widens to the literal type and repeats the whole payload in the
    // .d.ts, which ships a second copy of every module for no one.
    `export const ${constant}: string =`,
    `  "${Buffer.from(bytes).toString("base64")}";`,
    "",
  ].join("\n");

  await Bun.write(join(GENERATED_DIR, `${target.name}.ts`), source);
}

const zig = await zigExecutable();

await mkdir(GENERATED_DIR, { recursive: true });

for (const target of [...TARGETS, CAPPED_U32, STARVED_U32]) {
  await build(zig, target);
}
