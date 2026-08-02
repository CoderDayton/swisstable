/*
 * swiss_u32.c
 *
 * WASM-resident SwissTable for uint32_t -> uint32_t.
 *
 * Build with `bun run build`; see scripts/build-wasm.ts for the exact clang
 * invocation, exported symbols, and linear memory size.
 *
 * The module holds exactly one table in static storage. There is no
 * allocator (it links -nostdlib), so capacity is bounded at build time by
 * MAX_CAPACITY and instances are created by instantiating the module again.
 *
 * Design follows Abseil's raw_hash_set: an array of 1-byte control values
 * scanned 16 at a time with SIMD, and a parallel array of entries. See
 * https://abseil.io/about/design/swisstables and google/cwisstable.
 */

#include <stdint.h>
#include <stddef.h>
#include <wasm_simd128.h>

/* Returned by every fallible export when the operation succeeded. */
#define STATUS_OK 0

/*
 * Returned when a request would exceed MAX_CAPACITY. The table is left
 * usable and unchanged in size, but the request was not applied.
 */
#define STATUS_CAPACITY_EXCEEDED (-2)

/* Control values scanned per SIMD probe; also the probe stride. */
#define GROUP_WIDTH 16u

/*
 * Control-byte states. A slot holding an entry stores the 7-bit fingerprint
 * h2(hash) with its high bit clear, so the high bit alone distinguishes a
 * live slot from EMPTY or DELETED — see is_full() and match_special().
 */
#define CTRL_EMPTY   0xffu
#define CTRL_DELETED 0x80u

/* Slots per bank. Two banks of this size are reserved statically. */
#define MAX_CAPACITY (1u << 20)

/*
 * Maximum live entries for a given capacity: the 7/8 load factor.
 *
 * Above it, probe sequences lengthen sharply; below it, the SIMD group scan
 * almost always resolves a lookup in its first iteration.
 */
#define MAX_LIVE(capacity) (((capacity) * 7u) >> 3)

/*
 * Key and value share one 8-byte record.
 *
 * A lookup is a chain of dependent loads: control byte, then the key to
 * confirm the match, then the value. Splitting keys and values into
 * separate arrays makes the last two land on different cache lines, so a
 * hit costs three serialized misses instead of two. Interleaving them
 * removes one from the critical path.
 */
typedef struct {
  uint32_t key;
  uint32_t value;
} Entry;

/*
 * Two banks, so a rehash can copy from the old table into the new one
 * without allocating. Only one is live at a time; the other is scratch.
 * This trades double the memory for needing no allocator at all.
 */
static uint8_t g_ctrl[2][MAX_CAPACITY];
static Entry   g_entries[2][MAX_CAPACITY];

/* Index of the live bank, 0 or 1. */
static uint32_t g_active_bank = 0;

/* Slots in the live bank; always a power of two, or 0 before init(). */
static uint32_t g_capacity = 0;

/* g_capacity - 1, so a hash wraps to a slot index with one AND. */
static uint32_t g_mask = 0;

/* Live entries, excluding tombstones. */
static uint32_t g_size = 0;

/*
 * Inserts still allowed before the table must grow.
 *
 * Decremented only when an insert consumes an EMPTY slot, never when it
 * reuses a tombstone. That keeps at least capacity/8 slots EMPTY at all
 * times, which is what guarantees find_insert_slot() terminates.
 */
static uint32_t g_growth_left = 0;

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
 * Freestanding builds have no libc, but clang still lowers bulk stores to
 * a memset call, so one has to exist. Only ever called on control arrays.
 */
void *memset(void *destination, int byte, size_t count) {
  uint8_t *out = (uint8_t *)destination;
  for (size_t i = 0; i < count; i++) out[i] = (uint8_t)byte;
  return destination;
}

/* True for a slot holding an entry: fingerprints have their high bit clear. */
static inline uint32_t is_full(uint8_t control) { return control < 0x80u; }

/* Index of the lowest set bit. Callers guarantee value != 0. */
static inline uint32_t ctz32(uint32_t value) { return (uint32_t)__builtin_ctz(value); }

/*
 * Murmur3 finalizer.
 *
 * Keys are frequently dense or strided (indices, IDs, pointers >> 3), which
 * a bare identity hash would map onto a handful of groups. The finalizer
 * spreads every input bit across the whole word, which both h1 and h2 need.
 */
static inline uint32_t mix_u32(uint32_t value) {
  value ^= value >> 16;
  value *= 0x85ebca6bu;
  value ^= value >> 13;
  value *= 0xc2b2ae35u;
  value ^= value >> 16;
  return value;
}

/*
 * h1 selects the probe position, h2 is the control-byte fingerprint.
 *
 * h1 discards the 7 bits h2 consumes. Without the shift, the low bits of
 * the group index and the fingerprint come from the same hash bits, so
 * every slot in a group shares part of its fingerprint and the SIMD match
 * degenerates into a near-constant candidate set.
 */
static inline uint32_t h1(uint32_t hash) { return hash >> 7; }
static inline uint32_t h2(uint32_t hash) { return hash & 0x7fu; }

/*
 * Bitmask of the lanes in the group at `position` equal to `needle`.
 *
 * Bit i is set when control[position + i] == needle. Probe positions are
 * always group-aligned and below capacity, so the 16-byte load never runs
 * past the end of the bank and no mirrored sentinel prefix is needed.
 */
static inline uint32_t match_byte(
  const uint8_t *control, uint32_t position, uint8_t needle
) {
  const v128_t group = wasm_v128_load(control + position);
  const v128_t target = wasm_i8x16_splat((int8_t)needle);
  return (uint32_t)wasm_i8x16_bitmask(wasm_i8x16_eq(group, target));
}

/*
 * Bitmask of the lanes in the group at `position` that are not live,
 * i.e. EMPTY or DELETED. Selects on the high bit alone, so one compare
 * covers both states.
 */
static inline uint32_t match_special(
  const uint8_t *control, uint32_t position
) {
  const v128_t group = wasm_v128_load(control + position);
  const v128_t high_bit = wasm_i8x16_splat((int8_t)0x80);
  return (uint32_t)wasm_i8x16_bitmask(wasm_v128_and(group, high_bit));
}

/*
 * Smallest power-of-two capacity that holds `entries` under the load
 * factor, saturating at MAX_CAPACITY.
 *
 * The extra GROUP_WIDTH is headroom. Without it, a count that divides
 * evenly lands exactly on the threshold (14 entries in 16 slots), so the
 * table sits at its load factor the moment the expected fill completes and
 * the very next insert rehashes. With it, there is room to spare.
 */
static uint32_t capacity_for_entries(uint32_t entries) {
  uint32_t required = entries < GROUP_WIDTH ? GROUP_WIDTH : entries;
  uint64_t buckets = (((uint64_t)required * 8u) + 6u) / 7u + GROUP_WIDTH;
  uint32_t capacity = GROUP_WIDTH;

  while ((uint64_t)capacity < buckets) {
    if (capacity >= MAX_CAPACITY) return MAX_CAPACITY;
    capacity <<= 1u;
  }

  return capacity;
}

/*
 * Marks every slot of a bank EMPTY. Entries are left as they are: a slot
 * is only ever read after its control byte says it is live.
 */
static void initialize_bank(uint32_t bank, uint32_t capacity) {
  memset(g_ctrl[bank], CTRL_EMPTY, capacity);
}

/*
 * Returns the slot holding `key`, or UINT32_MAX if it is absent.
 *
 * Probing is quadratic over whole groups: the visited group indices are the
 * triangular numbers modulo the group count, which for a power-of-two
 * capacity enumerates every group exactly once before repeating. So the
 * loop terminates even on a table with no EMPTY slot left.
 *
 * A group containing an EMPTY slot ends the search: an insert would have
 * stopped there, so the key cannot lie further along the sequence. Note
 * that tombstones deliberately do not end it — that is the whole reason
 * deletion writes DELETED rather than EMPTY.
 */
static uint32_t find_slot(
  uint32_t bank, uint32_t mask, uint32_t key, uint32_t hash
) {
  const uint8_t fingerprint = (uint8_t)h2(hash);
  const uint8_t *control = g_ctrl[bank];
  const Entry *entries = g_entries[bank];

  uint32_t position = (h1(hash) & mask) & ~(GROUP_WIDTH - 1u);
  uint32_t step = GROUP_WIDTH;

  for (;;) {
    uint32_t matches = match_byte(control, position, fingerprint);

    /*
     * The fingerprint is 7 bits, so a match is only a candidate; confirm
     * against the full key. At the 7/8 load factor a group yields at most
     * a handful of candidates and usually exactly one.
     */
    while (matches != 0) {
      const uint32_t lane = ctz32(matches);
      matches &= matches - 1u;
      const uint32_t slot = position + lane;
      if (entries[slot].key == key) return slot;
    }

    if (match_byte(control, position, CTRL_EMPTY) != 0) return UINT32_MAX;

    position = (position + step) & mask;
    step += GROUP_WIDTH;
  }
}

/*
 * Returns the slot a key hashing to `hash` should be written to.
 *
 * Callers must have established that the key is absent. Prefers the first
 * tombstone seen, which reclaims it, but only returns once an EMPTY slot
 * has been found: stopping at the tombstone could place the key ahead of a
 * live duplicate further along the same probe sequence.
 *
 * Terminates because g_growth_left keeps at least capacity/8 slots EMPTY.
 */
static uint32_t find_insert_slot(uint32_t bank, uint32_t mask, uint32_t hash) {
  const uint8_t *control = g_ctrl[bank];
  uint32_t position = (h1(hash) & mask) & ~(GROUP_WIDTH - 1u);
  uint32_t step = GROUP_WIDTH;
  uint32_t first_deleted = UINT32_MAX;

  for (;;) {
    uint32_t special = match_special(control, position);

    while (special != 0) {
      const uint32_t lane = ctz32(special);
      special &= special - 1u;
      const uint32_t slot = position + lane;
      const uint8_t state = control[slot];

      if (state == CTRL_EMPTY) {
        return first_deleted == UINT32_MAX ? slot : first_deleted;
      }

      if (first_deleted == UINT32_MAX) first_deleted = slot;
    }

    position = (position + step) & mask;
    step += GROUP_WIDTH;
  }
}

/*
 * Writes an entry known not to be in `bank`, skipping the lookup that set()
 * performs. Used by rehash(), where the source table is already deduplicated.
 */
static void insert_known_absent(
  uint32_t bank, uint32_t mask, uint32_t key, uint32_t value
) {
  const uint32_t hash = mix_u32(key);
  const uint32_t slot = find_insert_slot(bank, mask, hash);

  g_ctrl[bank][slot] = (uint8_t)h2(hash);
  g_entries[bank][slot].key = key;
  g_entries[bank][slot].value = value;
}

/*
 * Rebuilds the table at `next_capacity` in the idle bank, then swaps banks.
 *
 * Tombstones are not carried over, so this also reclaims the slots consumed
 * by deletions — which is why ensure_insert_space() can rehash at the same
 * capacity when growth ran out but the live count did not.
 */
static int32_t rehash(uint32_t next_capacity) {
  if (next_capacity > MAX_CAPACITY) return STATUS_CAPACITY_EXCEEDED;

  const uint32_t old_bank = g_active_bank;
  const uint32_t new_bank = old_bank ^ 1u;
  const uint32_t old_capacity = g_capacity;

  initialize_bank(new_bank, next_capacity);
  const uint32_t new_mask = next_capacity - 1u;
  uint32_t new_size = 0;

  for (uint32_t i = 0; i < old_capacity; i++) {
    if (!is_full(g_ctrl[old_bank][i])) continue;

    insert_known_absent(
      new_bank, new_mask,
      g_entries[old_bank][i].key,
      g_entries[old_bank][i].value
    );

    new_size++;
  }

  g_active_bank = new_bank;
  g_capacity = next_capacity;
  g_mask = new_mask;
  g_size = new_size;
  g_growth_left = MAX_LIVE(next_capacity) - new_size;

  return STATUS_OK;
}

/*
 * Makes room for one more insert, growing or compacting if needed.
 *
 * Three cases: an untouched table gets a minimal bank; a table with
 * remaining growth is already fine; a table out of growth either doubles
 * (if genuinely full of live entries) or rehashes in place (if its growth
 * was spent on entries since deleted, which the rehash reclaims).
 */
static int32_t ensure_insert_space(void) {
  if (g_capacity == 0) {
    const uint32_t initial_capacity = GROUP_WIDTH;
    initialize_bank(g_active_bank, initial_capacity);
    g_capacity = initial_capacity;
    g_mask = initial_capacity - 1u;
    g_size = 0;
    g_growth_left = MAX_LIVE(initial_capacity);
    return STATUS_OK;
  }

  if (g_growth_left != 0) return STATUS_OK;

  uint32_t next_capacity = g_capacity;

  if (g_size >= MAX_LIVE(g_capacity)) {
    if (g_capacity >= MAX_CAPACITY) return STATUS_CAPACITY_EXCEEDED;
    next_capacity = g_capacity << 1u;
  }

  return rehash(next_capacity);
}

/* ── Exported API ──────────────────────────────────────────────────── */

/*
 * Sizes the table for `expected_entries` and empties it.
 *
 * Safe to call again to reset the table to a different size.
 */
__attribute__((export_name("init")))
int32_t init(uint32_t expected_entries) {
  const uint32_t next_capacity = capacity_for_entries(expected_entries);
  if (expected_entries > MAX_LIVE(next_capacity)) {
    return STATUS_CAPACITY_EXCEEDED;
  }

  g_active_bank = 0;
  g_capacity = next_capacity;
  g_mask = next_capacity - 1u;
  g_size = 0;
  g_growth_left = MAX_LIVE(next_capacity);
  initialize_bank(g_active_bank, g_capacity);

  return STATUS_OK;
}

/*
 * Grows the table so `entries` fit without a further rehash, preserving
 * its contents. A no-op when the current capacity already suffices.
 */
__attribute__((export_name("reserve")))
int32_t reserve(uint32_t entries) {
  if (g_capacity == 0) return init(entries);
  if (entries <= MAX_LIVE(g_capacity)) return STATUS_OK;

  const uint32_t next_capacity = capacity_for_entries(entries);
  if (entries > MAX_LIVE(next_capacity)) return STATUS_CAPACITY_EXCEEDED;

  return rehash(next_capacity);
}

/* Empties the table, retaining the current capacity. */
__attribute__((export_name("clear")))
void clear(void) {
  if (g_capacity == 0) return;
  initialize_bank(g_active_bank, g_capacity);
  g_size = 0;
  g_growth_left = MAX_LIVE(g_capacity);
}

/*
 * Lookup returning presence and value in one crossing.
 *
 * Returns 1 and latches the value into g_last_value when the key is
 * present, 0 otherwise. Read the value from the address reported by
 * last_value_ptr(); it is only meaningful immediately after a has_get()
 * that returned 1.
 */
__attribute__((export_name("has_get")))
int32_t has_get(uint32_t key) {
  if (g_capacity == 0) return 0;

  const uint32_t hash = mix_u32(key);
  const uint32_t slot = find_slot(g_active_bank, g_mask, key, hash);

  if (slot == UINT32_MAX) return 0;

  g_last_value = g_entries[g_active_bank][slot].value;

  return 1;
}

/*
 * Address of the has_get() output slot. Constant for the module's lifetime,
 * so the caller builds its view once at load.
 */
__attribute__((export_name("last_value_ptr")))
uint32_t last_value_ptr(void) { return (uint32_t)(uintptr_t)&g_last_value; }

/* Returns 1 if `key` is present, 0 otherwise. */
__attribute__((export_name("has")))
int32_t has(uint32_t key) {
  if (g_capacity == 0) return 0;
  const uint32_t hash = mix_u32(key);
  return find_slot(g_active_bank, g_mask, key, hash) != UINT32_MAX;
}

/*
 * Inserts `key`, or overwrites its value if it is already present.
 *
 * The existence check runs first, before any growth decision: overwriting a
 * key already in the table consumes no slot, so it must succeed even on a
 * table sitting at MAX_CAPACITY, and must not trigger a rehash merely
 * because growth ran out.
 */
__attribute__((export_name("set")))
int32_t set(uint32_t key, uint32_t value) {
  const uint32_t hash = mix_u32(key);

  if (g_capacity != 0) {
    const uint32_t existing = find_slot(g_active_bank, g_mask, key, hash);

    if (existing != UINT32_MAX) {
      g_entries[g_active_bank][existing].value = value;
      return STATUS_OK;
    }
  }

  /* Established absent, so a rehash here cannot introduce a duplicate. */
  const int32_t space_status = ensure_insert_space();
  if (space_status != STATUS_OK) return space_status;

  const uint32_t slot = find_insert_slot(g_active_bank, g_mask, hash);

  /* Reusing a tombstone consumes no growth: the slot was already spent. */
  if (g_ctrl[g_active_bank][slot] == CTRL_EMPTY) g_growth_left--;

  g_ctrl[g_active_bank][slot] = (uint8_t)h2(hash);
  g_entries[g_active_bank][slot].key = key;
  g_entries[g_active_bank][slot].value = value;
  g_size++;

  return STATUS_OK;
}

/*
 * Removes `key`, returning 1 if it was present.
 *
 * Named delete_key because `delete` is reserved in the languages this is
 * bound from. The slot becomes a tombstone rather than EMPTY, so probe
 * sequences running through it stay intact; rehash() reclaims it later.
 */
__attribute__((export_name("delete_key")))
int32_t delete_key(uint32_t key) {
  if (g_capacity == 0) return 0;

  const uint32_t hash = mix_u32(key);
  const uint32_t slot = find_slot(g_active_bank, g_mask, key, hash);

  if (slot == UINT32_MAX) return 0;

  g_ctrl[g_active_bank][slot] = CTRL_DELETED;
  g_size--;

  return 1;
}

/* Live entries, excluding tombstones. */
__attribute__((export_name("size")))
uint32_t size(void) { return g_size; }

/* Allocated slots in the live bank. */
__attribute__((export_name("capacity")))
uint32_t capacity(void) { return g_capacity; }
