#!/usr/bin/env bun
/**
 * Compiles the native SwissTable sources to freestanding wasm32 modules,
 * and emits each one a second time as a base64 TypeScript module so the
 * bindings can instantiate without the caller supplying bytes.
 *
 * Requires clang with the WebAssembly target and `wasm-ld` (LLVM lld) on
 * PATH. Override the compiler with the CLANG environment variable.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const NATIVE_DIR = join(ROOT, "native");
const OUTPUT_DIR = join(ROOT, "dist", "wasm");
const GENERATED_DIR = join(ROOT, "src", "generated");

const CLANG = Bun.env.CLANG ?? "clang";
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
  "--target=wasm32",
  "-O3",
  "-flto",
  "-msimd128",
  "-mbulk-memory",
  "-nostdlib",
  "-Wall",
  "-Wextra",
  "-Wl,--no-entry",
  "-Wl,--export-memory",
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
    // ~0.81 MiB of bulk staging buffers, plus stack and section headroom.
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

async function build(target: WasmTarget): Promise<void> {
  const outputPath = join(OUTPUT_DIR, `${target.name}.wasm`);
  await mkdir(dirname(outputPath), { recursive: true });

  const memory = memoryBytes(target);

  const argv = [
    CLANG,
    ...COMMON_FLAGS,
    `-DMAX_CAPACITY_LOG2=${MAX_CAPACITY_LOG2}`,
    ...linkFlags(target, memory),
    "-o",
    outputPath,
    join(NATIVE_DIR, target.source),
  ];

  const result = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });

  if (result.exitCode !== 0) {
    throw new Error(`${target.source}: clang exited with ${result.exitCode}`);
  }

  const bytes = await Bun.file(outputPath).bytes();
  await emitEmbedded(target, bytes);

  console.log(
    `built ${target.name}.wasm (${bytes.length} bytes, ` +
      `${(memory / MIB).toFixed(1)} MiB of linear memory, ` +
      `max capacity 2^${MAX_CAPACITY_LOG2})`,
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
    `export const ${constant} =`,
    `  "${Buffer.from(bytes).toString("base64")}";`,
    "",
  ].join("\n");

  await Bun.write(join(GENERATED_DIR, `${target.name}.ts`), source);
}

await mkdir(GENERATED_DIR, { recursive: true });

for (const target of TARGETS) {
  await build(target);
}
