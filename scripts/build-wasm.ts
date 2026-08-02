#!/usr/bin/env bun
/**
 * Compiles the native SwissTable sources to freestanding wasm32 modules.
 *
 * Requires clang with the WebAssembly target and `wasm-ld` (LLVM lld) on
 * PATH. Override the compiler with the CLANG environment variable.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const NATIVE_DIR = join(ROOT, "native");
const OUTPUT_DIR = join(ROOT, "dist", "wasm");

const CLANG = Bun.env.CLANG ?? "clang";
const MIB = 1024 * 1024;

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
   * Linear memory reserved up front; also the hard ceiling. The modules
   * never call memory.grow, so this must cover every static array plus the
   * linker-placed stack, and it is all the memory the module will ever have.
   */
  readonly memoryBytes: number;
  /** Symbols the JavaScript bindings expect to find on the instance. */
  readonly exports: readonly string[];
}

const TARGETS: readonly WasmTarget[] = [
  {
    name: "swiss_u32",
    source: "swiss_u32.c",
    memoryBytes: 20 * MIB,
    exports: [
      "init",
      "reserve",
      "clear",
      "has",
      "has_get",
      "last_value_ptr",
      "set",
      "delete_key",
      "size",
      "capacity",
    ],
  },
  {
    name: "swiss_u64",
    source: "swiss_u64.c",
    // 26 MiB of table banks (2 MiB control + 24 MiB of 12-byte entries)
    // plus ~0.8 MiB of bulk staging buffers.
    memoryBytes: 32 * MIB,
    exports: [
      "init",
      "reserve",
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
      "size",
      "capacity",
    ],
  },
];

function linkFlags(target: WasmTarget): string[] {
  return [
    `-Wl,--initial-memory=${target.memoryBytes}`,
    `-Wl,--max-memory=${target.memoryBytes}`,
    ...target.exports.map((symbol) => `-Wl,--export=${symbol}`),
  ];
}

async function build(target: WasmTarget): Promise<void> {
  const outputPath = join(OUTPUT_DIR, `${target.name}.wasm`);
  await mkdir(dirname(outputPath), { recursive: true });

  const argv = [
    CLANG,
    ...COMMON_FLAGS,
    ...linkFlags(target),
    "-o",
    outputPath,
    join(NATIVE_DIR, target.source),
  ];

  const result = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });

  if (result.exitCode !== 0) {
    throw new Error(`${target.source}: clang exited with ${result.exitCode}`);
  }

  const bytes = (await Bun.file(outputPath).arrayBuffer()).byteLength;
  console.log(`built ${target.name}.wasm (${bytes} bytes)`);
}

for (const target of TARGETS) {
  await build(target);
}
