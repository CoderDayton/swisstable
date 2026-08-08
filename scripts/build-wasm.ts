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

/**
 * Default `MAX_CAPACITY_LOG2`, matching the `#ifndef` in both sources.
 *
 * A table is bounded by this, and so is the memory an instance reserves —
 * the banks are static arrays, so the full reservation exists from
 * instantiation whether the table holds one entry or its maximum. One
 * instance is one table, so a workload holding many small tables pays the
 * whole budget per table.
 *
 * Lower it with SWISS_MAX_CAPACITY_LOG2 to build modules for that case:
 * 2^16 slots costs a little over 1 MiB per u32 instance instead of 20, at
 * the price of a table that cannot exceed 57,344 entries.
 */
const DEFAULT_MAX_CAPACITY_LOG2 = 20;

/** Smallest exponent that still leaves room for one group of slots. */
const MIN_MAX_CAPACITY_LOG2 = 4;

/**
 * Largest exponent whose banks still address inside wasm32's 4 GiB, with
 * room to spare for the staging buffers.
 */
const MAX_MAX_CAPACITY_LOG2 = 26;

function maxCapacityLog2(): number {
  const raw = Bun.env.SWISS_MAX_CAPACITY_LOG2;
  if (raw === undefined || raw === "") return DEFAULT_MAX_CAPACITY_LOG2;

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
   * Bytes of bank storage per slot: one control byte plus one entry, times
   * the two banks a rehash swaps between. Memory is derived from this and
   * MAX_CAPACITY_LOG2 rather than written out, so lowering the exponent
   * shrinks the reservation instead of leaving it stranded at the default.
   */
  readonly bankBytesPerSlot: number;
  /**
   * Everything not proportional to capacity: the fixed-size staging buffers
   * (which are sized by SCAN_WINDOW / BULK_CAPACITY, not by MAX_CAPACITY),
   * the linker-placed stack, and the module's own sections.
   */
  readonly overheadBytes: number;
  /** Symbols the JavaScript bindings expect to find on the instance. */
  readonly exports: readonly string[];
}

const TARGETS: readonly WasmTarget[] = [
  {
    name: "swiss_u32",
    source: "swiss_u32.c",
    // 2 banks x (1 control byte + an 8-byte Entry) per slot: 18 MiB at 2^20.
    bankBytesPerSlot: 2 * (1 + 8),
    // 0.5 MiB of scan staging buffers, plus stack and section headroom.
    overheadBytes: 2 * MIB,
    exports: [
      "init",
      "reserve",
      "shrink_to_fit",
      "clear",
      "has",
      "has_get",
      "last_value_ptr",
      "set",
      "delete_key",
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
    // 2 banks x (1 control byte + a 12-byte Entry): 26 MiB at 2^20.
    bankBytesPerSlot: 2 * (1 + 12),
    // ~1.6 MiB of staging buffers — bulk and scan hold separate arrays —
    // plus stack and section headroom.
    overheadBytes: 3 * MIB,
    exports: [
      "init",
      "reserve",
      "shrink_to_fit",
      "clear",
      "has",
      "has_get",
      "last_value_ptr",
      "set",
      "delete_key",
      "set_many",
      "get_many",
      "delete_many",
      "bulk_capacity",
      "bulk_keys_ptr",
      "bulk_vals_lo_ptr",
      "bulk_vals_hi_ptr",
      "bulk_flags_ptr",
      "scan",
      "scan_window",
      "scan_keys_ptr",
      "scan_vals_lo_ptr",
      "scan_vals_hi_ptr",
      "generation",
      "size",
      "capacity",
      "size_ptr",
      "capacity_ptr",
    ],
  },
];

/**
 * Linear memory for a target, rounded up to a whole page.
 *
 * Undersizing it is caught by the link rather than at runtime: wasm-ld
 * fails outright when .bss does not fit below the initial memory, so this
 * arithmetic is checked by every build rather than trusted.
 */
function memoryBytes(target: WasmTarget): number {
  const slots = 2 ** MAX_CAPACITY_LOG2;
  const required = target.bankBytesPerSlot * slots + target.overheadBytes;
  return Math.ceil(required / PAGE) * PAGE;
}

function linkFlags(target: WasmTarget, memory: number): string[] {
  return [
    `-Wl,--initial-memory=${memory}`,
    `-Wl,--max-memory=${memory}`,
    ...target.exports.map((symbol) => `-Wl,--export=${symbol}`),
  ];
}

async function build(zig: string, target: WasmTarget): Promise<void> {
  const outputPath = join(OUTPUT_DIR, `${target.name}.wasm`);
  await mkdir(dirname(outputPath), { recursive: true });

  const memory = memoryBytes(target);

  const argv = [
    zig,
    "cc",
    ...COMMON_FLAGS,
    `-DMAX_CAPACITY_LOG2=${MAX_CAPACITY_LOG2}`,
    ...linkFlags(target, memory),
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
  if (!UBSAN) await emitEmbedded(target, bytes);

  console.log(
    `built ${target.name}.wasm (${bytes.length} bytes, ` +
      `${(memory / MIB).toFixed(1)} MiB of linear memory, ` +
      `max capacity 2^${MAX_CAPACITY_LOG2}${UBSAN ? ", ubsan" : ""})`,
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

for (const target of TARGETS) {
  await build(zig, target);
}
