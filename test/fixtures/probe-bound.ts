/**
 * Drives a probe against a control array with no EMPTY byte left in it.
 *
 * Run as a subprocess by `test/probe-bound.test.ts`, because the failure
 * being guarded against is an unbounded loop inside WebAssembly. That wedges
 * the thread with no way back — a timeout in the test runner could not
 * interrupt it, so the whole suite would hang instead of reporting.
 *
 * Usage: `bun run test/fixtures/probe-bound.ts <u32|u64> <lookup|insert>`
 * Prints the probe result, or exits non-zero with a diagnostic.
 *
 * Both operations are covered because they probe through different loops:
 * `lookup` runs find_slot, `insert` runs find_insert_slot, and each has to
 * be bounded on its own.
 */

import { decodeBase64 } from "../../src/embedded.ts";
import { SWISS_U32_WASM_BASE64 } from "../../src/generated/swiss_u32.ts";
import { SWISS_U64_WASM_BASE64 } from "../../src/generated/swiss_u64.ts";

interface Probe {
  memory: WebAssembly.Memory;
  init(expectedEntries: number): number;
  has(key: number): number;
  capacity(): number;
}

const variant = process.argv[2];
const base64 =
  variant === "u64" ? SWISS_U64_WASM_BASE64
  : variant === "u32" ? SWISS_U32_WASM_BASE64
  : undefined;

if (base64 === undefined) {
  console.error(`unknown variant ${String(variant)}; expected u32 or u64`);
  process.exit(2);
}

const { instance } = await WebAssembly.instantiate(decodeBase64(base64));
const wasm = instance.exports as unknown as Probe;
const setKey = (instance.exports as Record<string, CallableFunction>)["set"]!;

wasm.init(1024);
const capacity = wasm.capacity() >>> 0;

/**
 * Locates the live control array without a test-only export.
 *
 * `initialize_bank` memsets exactly `capacity` bytes to CTRL_EMPTY (0xff)
 * inside an otherwise-zeroed BSS, so a run of that exact length is the
 * control array. The insert below confirms it: writing a key must turn
 * exactly one byte of the run into a fingerprint, which has its high bit
 * clear.
 */
function findControlArray(bytes: Uint8Array): number {
  for (let i = 0; i + capacity <= bytes.length; i += 1) {
    if (bytes[i] !== 0xff) continue;

    let run = 0;
    while (i + run < bytes.length && bytes[i + run] === 0xff) run += 1;

    if (run === capacity) return i;
    i += run;
  }

  console.error("could not locate the control array");
  return process.exit(3);
}

const bytes = new Uint8Array(wasm.memory.buffer);
const ctrl = findControlArray(bytes);

setKey(0xdead_beef, 1, 0);

const live = bytes.subarray(ctrl, ctrl + capacity).filter((b) => b < 0x80);
if (live.length !== 1) {
  console.error(`expected 1 live control byte, found ${live.length}`);
  process.exit(4);
}

// Every slot DELETED: no fingerprint can match and no EMPTY can end the
// search, so an unbounded probe never leaves the loop.
bytes.fill(0x80, ctrl, ctrl + capacity);

const operation = process.argv[3];

if (operation === "lookup") {
  console.log(wasm.has(0x1234_5678));
} else if (operation === "insert") {
  // A tombstone is the only slot an insert can take here. Reusing one is
  // sound: the lookup above already established the key is absent.
  console.log(setKey(0x1234_5678, 7, 0));
} else {
  console.error(`unknown operation ${String(operation)}`);
  process.exit(5);
}
