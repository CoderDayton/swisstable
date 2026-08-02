/**
 * WASM-resident SwissTables for unsigned 32-bit keys, plus the string
 * interner that bridges string-keyed data onto them.
 *
 * The `*WasmExports` interfaces describing the raw module ABI are
 * deliberately not re-exported here: they mirror the native sources and are
 * an implementation detail of the two table classes.
 *
 * @packageDocumentation
 */

export type { BulkU32Source } from "./abi.ts";

export type { WasmSource } from "./wasm.ts";

export { SwissU32ToU32 } from "./swiss-u32.ts";

export { SwissU32ToU64, spanToLanes, lanesToSpan } from "./swiss-u64.ts";
export type {
  BulkDeleteResult,
  BulkGetResult,
  Span,
  U64Lanes,
} from "./swiss-u64.ts";

export { InternedSwissMap, StringInterner } from "./string-interner.ts";
export type { NumericKeyTable } from "./string-interner.ts";
