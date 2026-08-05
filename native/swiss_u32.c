/*
 * swiss_u32.c
 *
 * WASM-resident SwissTable for uint32_t -> uint32_t.
 *
 * Build with `bun run build`; see scripts/build-wasm.ts for the exact clang
 * invocation, exported symbols, and linear memory size.
 *
 * The engine — probing, growth, deletion, iteration, and their invariants —
 * lives in swiss_core.h, shared with swiss_u64.c. This file supplies only
 * what the payload shape decides: the Entry fields, the has_get() output
 * slot, the scan staging buffers, and the set() export.
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
 * Slots one scan() call visits, and the length of the buffers it fills.
 *
 * At MAX_CAPACITY a full walk is 16 crossings. A larger window costs only
 * staging memory; a smaller one costs crossings. See scan() in
 * swiss_core.h for how a window partitions the slot space.
 */
#define SCAN_WINDOW 65536u

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

  g_entries[g_active_bank][slot].value = value;

  return STATUS_OK;
}

/* Address of the scan key buffer. Constant for the module's lifetime. */
__attribute__((export_name("scan_keys_ptr")))
uint32_t scan_keys_ptr(void) { return (uint32_t)(uintptr_t)g_scan_keys; }

/* Address of the scan value buffer. Constant for the module's lifetime. */
__attribute__((export_name("scan_values_ptr")))
uint32_t scan_values_ptr(void) { return (uint32_t)(uintptr_t)g_scan_values; }
