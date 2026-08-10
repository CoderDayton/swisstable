/*
 * swiss_u32.c
 *
 * WASM-resident SwissTable for uint32_t -> uint32_t.
 *
 * Build with `bun run build`; see scripts/build-wasm.ts for the exact clang
 * invocation, exported symbols, and linear memory size.
 *
 * The engine — probing, growth, deletion, iteration, and their invariants —
 * lives in swiss_core.h, shared with swiss_u64.c, as does the shared half
 * of the bulk API. This file supplies what the payload shape decides: the
 * Entry fields, the has_get() output slot, the staging buffers for the
 * single value lane, and the exports that write it.
 */

/*
 * Key and value share one 8-byte record.
 *
 * A lookup is a chain of dependent loads: control byte, then the key to
 * confirm the match, then the value. Splitting keys and values into
 * separate arrays makes the last two land on different cache lines, so a
 * hit costs three serialized misses instead of two. Interleaving them
 * removes one from the critical path.
 */
#define SWISS_ENTRY_FIELDS uint32_t value;

/*
 * Staging capacity of the bulk API, in keys per call.
 *
 * Batches larger than this are chunked by the caller.
 */
#define BULK_CAPACITY 65536u

/*
 * Slots one scan() call visits, and the length of the buffers it fills.
 *
 * At MAX_CAPACITY a full walk is 16 crossings. A larger window costs only
 * staging memory; a smaller one costs crossings. See scan() in
 * swiss_core.h for how a window partitions the slot space.
 */
#define SCAN_WINDOW BULK_CAPACITY

/*
 * Slots this module's table can reach, as a power-of-two exponent.
 *
 * Set by the widest bank three of these entries can address inside wasm32 —
 * see the _Static_assert in swiss_core.h — which is what the ceiling is now
 * bounded by. At 7/8 that is 117,440,512 live entries.
 *
 * It costs address space, not memory: an instance reserves its static data
 * and grows into a bank only as the table reaches it.
 *
 * Guarded so scripts/build-wasm.ts can override it with -D.
 */
#ifndef MAX_CAPACITY_LOG2
#define MAX_CAPACITY_LOG2 27
#endif

#include "swiss_core.h"

/*
 * Output slot for the last has_get() call.
 *
 * Presence and value are reported separately so lookups can stay in u32:
 * packing both into a u64 return would box a BigInt on every lookup, which
 * costs more than the separate report. The caller reads the value straight
 * out of linear memory through last_value_ptr(), so a lookup is a single
 * boundary crossing rather than two.
 */
static uint32_t g_last_value = 0;

/*
 * Value lane of the bulk staging area. The key and flag buffers, and the
 * checks that guard every address argument, are shared and live in
 * swiss_core.h.
 */
static uint32_t g_bulk_values[BULK_CAPACITY];

/* Staging buffers for scan(), deliberately separate from the bulk ones. */
static uint32_t g_scan_keys[SCAN_WINDOW];
static uint32_t g_scan_values[SCAN_WINDOW];

/* Latches the payload has_get() reports. See g_last_value. */
static void latch_value(const Entry *entry) {
  g_last_value = entry->value;
}

/* Stages one live entry during scan(). */
static void stage_entry(uint32_t index, const Entry *entry) {
  g_scan_keys[index] = entry->key;
  g_scan_values[index] = entry->value;
}

/*
 * Address of the has_get() output slot. Constant for the module's lifetime,
 * so the caller builds its view once at load.
 */
__attribute__((export_name("last_value_ptr")))
uint32_t last_value_ptr(void) { return (uint32_t)(uintptr_t)&g_last_value; }

/*
 * Inserts `key`, or overwrites its value if it is already present.
 *
 * upsert_slot() runs the existence check before any growth decision — see
 * the note there — and handles control byte, key, and size accounting, so
 * only the payload store is left to do here.
 */
__attribute__((export_name("set")))
int32_t set(uint32_t key, uint32_t value) {
  uint32_t slot;
  const int32_t status = upsert_slot(key, &slot);
  if (status != STATUS_OK) return status;

  g_entries[slot].value = value;

  return STATUS_OK;
}

/*
 * Returns the value stored for `key`, inserting `value` first if it was
 * absent. The resulting value is latched at last_value_ptr() either way.
 *
 * One probe, one crossing. The alternative the caller would otherwise
 * write — has_get() then set() — probes twice and crosses twice.
 */
__attribute__((export_name("get_or_insert")))
int32_t get_or_insert(uint32_t key, uint32_t value) {
  uint32_t slot;
  uint32_t inserted;
  const int32_t status = upsert_slot_tracked(key, &slot, &inserted);
  if (status != STATUS_OK) return status;

  Entry *entry = &g_entries[slot];

  if (inserted) entry->value = value;

  latch_value(entry);

  return STATUS_OK;
}

/*
 * Adds `delta` to the value stored for `key`, treating an absent key as 0
 * so the first call stores the delta itself. The new value is latched at
 * last_value_ptr().
 *
 * Wraps modulo 2^32, which is what the lane can represent; a counter that
 * must saturate has to check before calling.
 */
__attribute__((export_name("increment")))
int32_t increment(uint32_t key, uint32_t delta) {
  uint32_t slot;
  uint32_t inserted;
  const int32_t status = upsert_slot_tracked(key, &slot, &inserted);
  if (status != STATUS_OK) return status;

  Entry *entry = &g_entries[slot];

  entry->value = inserted ? delta : entry->value + delta;

  latch_value(entry);

  return STATUS_OK;
}

/* ── Bulk API: one call amortizes N operations ─────────────────────── */

/*
 * Inserts or overwrites `count` pairs staged in linear memory.
 *
 * keys_ptr and vals_ptr each address a u32[count] the caller has already
 * written, which must be the module's own staging buffers.
 *
 * Returns STATUS_OK, or STATUS_CAPACITY_EXCEEDED if the batch outgrew the
 * table partway — the pairs before the failure are applied and g_size
 * reflects them, so the batch is not atomic.
 */
__attribute__((export_name("set_many")))
int32_t set_many(uint32_t keys_ptr, uint32_t vals_ptr, uint32_t count) {
  if (
    !bulk_count_ok(count) ||
    !is_bulk_ptr(keys_ptr, g_bulk_keys) ||
    !is_bulk_ptr(vals_ptr, g_bulk_values)
  ) {
    return STATUS_INVALID_ARGUMENT;
  }

  const uint32_t *keys = (const uint32_t *)(uintptr_t)keys_ptr;
  const uint32_t *values = (const uint32_t *)(uintptr_t)vals_ptr;

  /*
   * Reserve once for the whole batch instead of once per key.
   * This is the primary amortization win versus N individual set() calls:
   * a single growth check/rehash decision covers the entire batch.
   *
   * The bound is pessimistic — keys already present, or duplicated within
   * the batch, overwrite rather than insert — so it can over-reserve and
   * may report STATUS_CAPACITY_EXCEEDED for a batch that in fact fits. Its
   * status is therefore advisory and deliberately ignored: a failed reserve
   * leaves the table untouched, and set() below reports the real ceiling
   * per key if one is genuinely hit.
   */
  (void)reserve(g_size + count);

  for (uint32_t i = 0; i < count; i++) {
    uint32_t slot;
    const int32_t status = upsert_slot(keys[i], &slot);
    if (status != STATUS_OK) return status;

    g_entries[slot].value = values[i];
  }

  return STATUS_OK;
}

/*
 * Looks up `count` keys staged at keys_ptr.
 *
 * Writes vals_ptr[i] and found_ptr[i] for each key. found_ptr addresses a
 * u8[count]: 1 present, 0 absent. The value is written as 0 on absence, so
 * the output buffer never carries stale values from a previous batch.
 */
__attribute__((export_name("get_many")))
int32_t get_many(
  uint32_t keys_ptr,
  uint32_t vals_ptr,
  uint32_t found_ptr,
  uint32_t count
) {
  if (
    !bulk_count_ok(count) ||
    !is_bulk_ptr(keys_ptr, g_bulk_keys) ||
    !is_bulk_ptr(vals_ptr, g_bulk_values) ||
    !is_bulk_ptr(found_ptr, g_bulk_flags)
  ) {
    return STATUS_INVALID_ARGUMENT;
  }

  const uint32_t *keys = (const uint32_t *)(uintptr_t)keys_ptr;
  uint32_t *values = (uint32_t *)(uintptr_t)vals_ptr;
  uint8_t *found = (uint8_t *)(uintptr_t)found_ptr;

  for (uint32_t i = 0; i < count; i++) {
    const uint32_t slot = lookup_slot(keys[i]);

    if (slot == UINT32_MAX) {
      values[i] = 0;
      found[i] = 0;
    } else {
      values[i] = g_entries[slot].value;
      found[i] = 1;
    }
  }

  return STATUS_OK;
}

/* Address of the bulk value lane. Constant for the module's lifetime. */
__attribute__((export_name("bulk_values_ptr")))
uint32_t bulk_values_ptr(void) { return (uint32_t)(uintptr_t)g_bulk_values; }

/* Address of the scan key buffer. Constant for the module's lifetime. */
__attribute__((export_name("scan_keys_ptr")))
uint32_t scan_keys_ptr(void) { return (uint32_t)(uintptr_t)g_scan_keys; }

/* Address of the scan value buffer. Constant for the module's lifetime. */
__attribute__((export_name("scan_values_ptr")))
uint32_t scan_values_ptr(void) { return (uint32_t)(uintptr_t)g_scan_values; }
