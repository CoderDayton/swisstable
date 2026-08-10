/*
 * swiss_u64.c
 *
 * WASM-resident SwissTable for uint32_t -> uint64_t, with a bulk API.
 *
 * Build with `bun run build`; see scripts/build-wasm.ts for the exact clang
 * invocation, exported symbols, and linear memory size.
 *
 * The engine — probing, growth, deletion, iteration, and their invariants —
 * lives in swiss_core.h, shared with swiss_u32.c. This file supplies what
 * the payload shape decides — the Entry lanes, the has_get() output lanes,
 * the set() export, and the lane-splitting half of the bulk API.
 *
 * Value packing:
 *   u64 value = (hi << 32) | lo
 *
 * Recommended {offset,length} convention for string pools / KV-cache spans:
 *   lo = offset (u32)
 *   hi = length (u32)
 *
 * Values are carried as two u32 lanes rather than one i64 because an i64
 * crossing the WebAssembly boundary is boxed as a BigInt on every call,
 * which costs more than the lookup it accompanies. A packed return could
 * not report absence either: 0 is a legitimate stored value, so single-key
 * lookups use has_get() followed by a read at last_value_ptr().
 *
 * Bulk transfers stage through module-owned buffers (bulk_*_ptr below), so
 * the caller never has to guess an address that is free in linear memory.
 */

/*
 * Key and both value lanes share one 12-byte record.
 *
 * A lookup is a chain of dependent loads: control byte, then the key to
 * confirm the match, then the value. Separate arrays put each on its own
 * cache line, so a hit costs four serialized misses; one record costs two.
 */
#define SWISS_ENTRY_FIELDS uint32_t lo; uint32_t hi;

/*
 * Staging capacity of the bulk API, in keys per call.
 *
 * Batches larger than this are chunked by the caller.
 */
#define BULK_CAPACITY 65536u

/*
 * Slots one scan() call visits.
 *
 * At MAX_CAPACITY a full walk is 16 crossings. A larger window costs only
 * staging memory; a smaller one costs crossings. See scan() in
 * swiss_core.h for how a window partitions the slot space.
 */
#define SCAN_WINDOW BULK_CAPACITY

/*
 * Slots this module's table can reach, as a power-of-two exponent.
 *
 * One lower than swiss_u32.c: a 12-byte payload makes each bank half again
 * as wide, and three of them have to address inside wasm32 — see the
 * _Static_assert in swiss_core.h. At 7/8 that is 58,720,256 live entries.
 *
 * It costs address space, not memory: an instance reserves its static data
 * and grows into a bank only as the table reaches it.
 *
 * Guarded so scripts/build-wasm.ts can override it with -D.
 */
#ifndef MAX_CAPACITY_LOG2
#define MAX_CAPACITY_LOG2 26
#endif

#include "swiss_core.h"

/*
 * Output lanes for the last has_get() call.
 *
 * Adjacent by construction, so the caller reads both with one typed-array
 * access at last_value_ptr() and a lookup costs a single boundary crossing
 * rather than three. Holding the result here also spares the caller from
 * passing an output pointer on the single-key path.
 */
static uint32_t g_last_value[2] = {0, 0};

/*
 * Value lanes of the bulk staging area. The key and flag buffers, and the
 * checks that guard every address argument, are shared and live in
 * swiss_core.h.
 */
static uint32_t g_bulk_vals_lo[BULK_CAPACITY];
static uint32_t g_bulk_vals_hi[BULK_CAPACITY];

/* Staging buffers for scan(), deliberately separate from the bulk ones. */
static uint32_t g_scan_keys[SCAN_WINDOW];
static uint32_t g_scan_vals_lo[SCAN_WINDOW];
static uint32_t g_scan_vals_hi[SCAN_WINDOW];

/* Latches the payload has_get() reports. See g_last_value. */
static void latch_value(const Entry *entry) {
  g_last_value[0] = entry->lo;
  g_last_value[1] = entry->hi;
}

/* Stages one live entry during scan(). */
static void stage_entry(uint32_t index, const Entry *entry) {
  g_scan_keys[index] = entry->key;
  g_scan_vals_lo[index] = entry->lo;
  g_scan_vals_hi[index] = entry->hi;
}

/*
 * Inserts `key`, or overwrites both lanes if it is already present.
 *
 * upsert_slot() runs the existence check before any growth decision — see
 * the note there — and handles control byte, key, and size accounting, so
 * only the payload store is left to do here.
 */
static int32_t set_one(uint32_t key, uint32_t lo, uint32_t hi) {
  uint32_t slot;
  const int32_t status = upsert_slot(key, &slot);
  if (status != STATUS_OK) return status;

  g_entries[slot].lo = lo;
  g_entries[slot].hi = hi;

  return STATUS_OK;
}

/*
 * Address of the has_get() output lanes, two consecutive u32. Constant for
 * the module's lifetime, so the caller builds its view once at load.
 */
__attribute__((export_name("last_value_ptr")))
uint32_t last_value_ptr(void) { return (uint32_t)(uintptr_t)g_last_value; }

/* Inserts `key`, or overwrites both lanes if it is already present. */
__attribute__((export_name("set")))
int32_t set(uint32_t key, uint32_t lo, uint32_t hi) {
  return set_one(key, lo, hi);
}

/*
 * Returns the value stored for `key`, inserting (lo, hi) first if it was
 * absent. The resulting value is latched at last_value_ptr() either way.
 *
 * One probe, one crossing. The alternative the caller would otherwise
 * write — has_get() then set() — probes twice and crosses twice, and races
 * nothing only because the table is single-threaded.
 */
__attribute__((export_name("get_or_insert")))
int32_t get_or_insert(uint32_t key, uint32_t lo, uint32_t hi) {
  uint32_t slot;
  uint32_t inserted;
  const int32_t status = upsert_slot_tracked(key, &slot, &inserted);
  if (status != STATUS_OK) return status;

  Entry *entry = &g_entries[slot];

  if (inserted) {
    entry->lo = lo;
    entry->hi = hi;
  }

  latch_value(entry);

  return STATUS_OK;
}

/*
 * Adds the u64 (delta_hi << 32 | delta_lo) to the value stored for `key`,
 * treating an absent key as 0 so the first call stores the delta itself.
 * The new value is latched at last_value_ptr().
 *
 * Wraps modulo 2^64, which is what the lanes can represent; a counter that
 * must saturate has to check before calling.
 */
__attribute__((export_name("increment")))
int32_t increment(uint32_t key, uint32_t delta_lo, uint32_t delta_hi) {
  uint32_t slot;
  uint32_t inserted;
  const int32_t status = upsert_slot_tracked(key, &slot, &inserted);
  if (status != STATUS_OK) return status;

  Entry *entry = &g_entries[slot];

  const uint64_t current =
    inserted ? 0u : ((uint64_t)entry->hi << 32) | (uint64_t)entry->lo;
  const uint64_t next =
    current + (((uint64_t)delta_hi << 32) | (uint64_t)delta_lo);

  entry->lo = (uint32_t)next;
  entry->hi = (uint32_t)(next >> 32);

  latch_value(entry);

  return STATUS_OK;
}

/* ── Bulk API: one call amortizes N operations ─────────────────────── */

/*
 * Inserts or overwrites `count` pairs staged in linear memory.
 *
 * keys_ptr, vals_lo_ptr and vals_hi_ptr each address a u32[count] the
 * caller has already written, normally the module's own staging buffers.
 *
 * Returns STATUS_OK, or STATUS_CAPACITY_EXCEEDED if the batch outgrew the
 * table partway — the pairs before the failure are applied and g_size
 * reflects them, so the batch is not atomic.
 */
__attribute__((export_name("set_many")))
int32_t set_many(
  uint32_t keys_ptr,
  uint32_t vals_lo_ptr,
  uint32_t vals_hi_ptr,
  uint32_t count
) {
  if (
    !bulk_count_ok(count) ||
    !is_bulk_ptr(keys_ptr, g_bulk_keys) ||
    !is_bulk_ptr(vals_lo_ptr, g_bulk_vals_lo) ||
    !is_bulk_ptr(vals_hi_ptr, g_bulk_vals_hi)
  ) {
    return STATUS_INVALID_ARGUMENT;
  }

  const uint32_t *keys = (const uint32_t *)(uintptr_t)keys_ptr;
  const uint32_t *los = (const uint32_t *)(uintptr_t)vals_lo_ptr;
  const uint32_t *his = (const uint32_t *)(uintptr_t)vals_hi_ptr;

  /*
   * Reserve once for the whole batch instead of once per key.
   * This is the primary amortization win versus N individual set() calls:
   * a single growth check/rehash decision covers the entire batch.
   *
   * The bound is pessimistic — keys already present, or duplicated within
   * the batch, overwrite rather than insert — so it can over-reserve and
   * may report STATUS_CAPACITY_EXCEEDED for a batch that in fact fits. Its
   * status is therefore advisory and deliberately ignored: a failed reserve
   * leaves the table untouched, and set_one() below reports the real
   * ceiling per key if one is genuinely hit.
   */
  (void)reserve(g_size + count);

  for (uint32_t i = 0; i < count; i++) {
    const int32_t status = set_one(keys[i], los[i], his[i]);
    if (status != STATUS_OK) return status;
  }

  return STATUS_OK;
}

/*
 * Looks up `count` keys staged at keys_ptr.
 *
 * Writes vals_lo_ptr[i], vals_hi_ptr[i] and found_ptr[i] for each key.
 * found_ptr addresses a u8[count]: 1 present, 0 absent. Both lanes are
 * written as 0 on absence, so the output buffers never carry stale values
 * from a previous batch.
 */
__attribute__((export_name("get_many")))
int32_t get_many(
  uint32_t keys_ptr,
  uint32_t vals_lo_ptr,
  uint32_t vals_hi_ptr,
  uint32_t found_ptr,
  uint32_t count
) {
  if (
    !bulk_count_ok(count) ||
    !is_bulk_ptr(keys_ptr, g_bulk_keys) ||
    !is_bulk_ptr(vals_lo_ptr, g_bulk_vals_lo) ||
    !is_bulk_ptr(vals_hi_ptr, g_bulk_vals_hi) ||
    !is_bulk_ptr(found_ptr, g_bulk_flags)
  ) {
    return STATUS_INVALID_ARGUMENT;
  }

  const uint32_t *keys = (const uint32_t *)(uintptr_t)keys_ptr;
  uint32_t *los = (uint32_t *)(uintptr_t)vals_lo_ptr;
  uint32_t *his = (uint32_t *)(uintptr_t)vals_hi_ptr;
  uint8_t *found = (uint8_t *)(uintptr_t)found_ptr;

  for (uint32_t i = 0; i < count; i++) {
    const uint32_t slot = lookup_slot(keys[i]);

    if (slot == UINT32_MAX) {
      los[i] = 0; his[i] = 0; found[i] = 0;
    } else {
      los[i] = g_entries[slot].lo;
      his[i] = g_entries[slot].hi;
      found[i] = 1;
    }
  }

  return STATUS_OK;
}

/* ── Staging buffer accessors ──────────────────────────────────────── */

/* Addresses of the value lanes. Constant for the module's lifetime. */

__attribute__((export_name("bulk_values_lo_ptr")))
uint32_t bulk_values_lo_ptr(void) { return (uint32_t)(uintptr_t)g_bulk_vals_lo; }

__attribute__((export_name("bulk_values_hi_ptr")))
uint32_t bulk_values_hi_ptr(void) { return (uint32_t)(uintptr_t)g_bulk_vals_hi; }

__attribute__((export_name("scan_keys_ptr")))
uint32_t scan_keys_ptr(void) { return (uint32_t)(uintptr_t)g_scan_keys; }

__attribute__((export_name("scan_values_lo_ptr")))
uint32_t scan_values_lo_ptr(void) { return (uint32_t)(uintptr_t)g_scan_vals_lo; }

__attribute__((export_name("scan_values_hi_ptr")))
uint32_t scan_values_hi_ptr(void) { return (uint32_t)(uintptr_t)g_scan_vals_hi; }
