/*
 * swiss_u64.c
 *
 * WASM-resident SwissTable for uint32_t -> uint64_t, with a bulk API.
 *
 * Build with `bun run build`; see scripts/build-wasm.ts for the exact clang
 * invocation, exported symbols, and linear memory size.
 *
 * The module holds exactly one table in static storage. There is no
 * allocator (it links -nostdlib), so capacity is bounded at build time by
 * MAX_CAPACITY and instances are created by instantiating the module again.
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
 * usable, but the request was not applied in full — see set_many().
 */
#define STATUS_CAPACITY_EXCEEDED (-2)

/*
 * Returned when an export is called with arguments it cannot honour: a bulk
 * count past BULK_CAPACITY, or a staging pointer this module does not own.
 *
 * Distinct from STATUS_CAPACITY_EXCEEDED, which describes a well-formed
 * request the table has no room for. Nothing is applied, so the table is
 * left exactly as it was.
 */
#define STATUS_INVALID_ARGUMENT (-3)

/*
 * delete_many() reports how many keys it removed, so it has no room for a
 * negative status. A removal count can never exceed BULK_CAPACITY, which
 * makes UINT32_MAX unambiguous as a failure sentinel.
 */
#define DELETE_MANY_FAILED 0xffffffffu

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
 * Live-entry share above which spent growth is reclaimed by doubling rather
 * than by compacting in place, as 25/32 (78.125%).
 *
 * Below the line a rehash at the same capacity recovers enough tombstoned
 * slots to be worth the scan. At or above it there are too few tombstones
 * left to recover: compacting at the 7/8 load factor hands back a single
 * slot, so the very next insert rehashes again and steady-state churn — a
 * cache evicting as fast as it fills — degrades to a full table scan per
 * insert. Abseil's raw_hash_set draws the line in the same place.
 *
 * Kept in 64 bits so both products stay exact however far MAX_CAPACITY is
 * raised; at today's ceiling they still fit a uint32_t.
 */
#define SHOULD_GROW(size, capacity) \
  ((uint64_t)(size) * 32u > (uint64_t)(capacity) * 25u)

/*
 * Key and both value lanes share one 12-byte record.
 *
 * A lookup is a chain of dependent loads: control byte, then the key to
 * confirm the match, then the value. Separate arrays put each on its own
 * cache line, so a hit costs four serialized misses; one record costs two.
 */
typedef struct {
  uint32_t key;
  uint32_t lo;
  uint32_t hi;
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
 * Output lanes for the last has_get() call.
 *
 * Adjacent by construction, so the caller reads both with one typed-array
 * access at last_value_ptr() and a lookup costs a single boundary crossing
 * rather than three. Holding the result here also spares the caller from
 * passing an output pointer on the single-key path.
 */
static uint32_t g_last_value[2] = {0, 0};

/*
 * Staging buffers for the bulk API.
 *
 * Owned by this module so their addresses are assigned by the linker rather
 * than hardcoded by the caller: the JS side reads bulk_capacity() and the
 * bulk_*_ptr() accessors and builds its views from those. An earlier
 * revision picked the offsets caller-side and silently aliased the banks.
 *
 * Batches larger than BULK_CAPACITY are chunked by the caller.
 */
#define BULK_CAPACITY 65536u

static uint32_t g_bulk_keys[BULK_CAPACITY];
static uint32_t g_bulk_vals_lo[BULK_CAPACITY];
static uint32_t g_bulk_vals_hi[BULK_CAPACITY];
static uint8_t  g_bulk_flags[BULK_CAPACITY];

/*
 * Counter of every event that re-permutes the slots: a rehash, a clear, or
 * an init.
 *
 * A scan cursor names a slot, and those events move entries between slots,
 * so a cursor held across one is meaningless — resuming with it would skip
 * some entries and repeat others with nothing to signal it. Capacity cannot
 * stand in for this: an in-place compaction rehashes without changing it.
 */
static uint32_t g_generation = 0;

/*
 * Slots one scan() call visits.
 *
 * A window is a fixed span of slots rather than a fixed number of entries.
 * That is what lets the caller advance its own cursor without the module
 * reporting where the scan stopped: the windows [0, W), [W, 2W), ...
 * partition the slot space, so every live slot falls in exactly one and is
 * reported exactly once. A window of W slots holds at most W entries, which
 * is why it can share the bulk staging buffers without overflowing them.
 *
 * At MAX_CAPACITY a full walk is 16 crossings. A larger window costs only
 * staging memory; a smaller one costs crossings.
 */
#define SCAN_WINDOW BULK_CAPACITY

/*
 * True when `ptr` is the address of the staging buffer it is meant to be.
 *
 * The bulk exports take addresses, which makes every one of them a write
 * primitive aimed anywhere in linear memory unless it is checked. There is
 * no range to check against: the only legitimate value for each argument is
 * the single buffer below, whose address the caller obtained from this
 * module in the first place. So the test is equality, not containment.
 *
 * This has to live here rather than in the JavaScript binding. The binding
 * is one caller among however many hold the instance, and an exported
 * function is reachable by all of them.
 */
static inline uint32_t is_bulk_ptr(uint32_t ptr, const void *buffer) {
  return ptr == (uint32_t)(uintptr_t)buffer;
}

/* True when a bulk batch fits the staging buffers. */
static inline uint32_t bulk_count_ok(uint32_t count) {
  return count <= BULK_CAPACITY;
}

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

/* Index of the lowest set bit. Callers guarantee v != 0. */
static inline uint32_t ctz32(uint32_t v) { return (uint32_t)__builtin_ctz(v); }

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
 * capacity enumerates every group exactly once before repeating.
 *
 * Enumerating every group is not the same as leaving the loop: the only
 * exits are a key match and an EMPTY byte, so a control array holding
 * neither would spin forever, and WebAssembly has no interrupt to break out
 * with — the calling thread would be wedged for good. g_growth_left keeps at
 * least capacity/8 slots EMPTY, which makes that state unreachable, but the
 * sequence is bounded anyway.
 *
 * The bound rides on `step` rather than a separate counter. `step` advances
 * by GROUP_WIDTH per group, so after k groups it holds (k + 1) * GROUP_WIDTH
 * and passes `capacity` exactly once the whole sequence has been walked.
 * Reusing a value already live costs nothing measurable: an interleaved A/B
 * against an unbounded build put the difference inside run-to-run noise.
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
    if (step > mask + 1u) return UINT32_MAX;
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
 * The probe sequence is bounded anyway, the same way find_slot bounds its
 * own. If that invariant ever stops holding, the first tombstone is the only
 * slot left to take, and taking it is sound: the caller has already
 * established that the key is absent.
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
    if (step > mask + 1u) return first_deleted;
  }
}

/*
 * Writes an entry known not to be in `bank`, skipping the lookup that
 * set_one() performs. Used by rehash(), where the source table is already
 * deduplicated.
 */
static void insert_known_absent(
  uint32_t bank, uint32_t mask, uint32_t key, uint32_t lo, uint32_t hi
) {
  const uint32_t hash = mix_u32(key);
  const uint32_t slot = find_insert_slot(bank, mask, hash);

  g_ctrl[bank][slot] = (uint8_t)h2(hash);
  g_entries[bank][slot].key = key;
  g_entries[bank][slot].lo = lo;
  g_entries[bank][slot].hi = hi;
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
      g_entries[old_bank][i].lo,
      g_entries[old_bank][i].hi
    );

    new_size++;
  }

  g_active_bank = new_bank;
  g_capacity = next_capacity;
  g_mask = new_mask;
  g_size = new_size;
  g_growth_left = MAX_LIVE(next_capacity) - new_size;
  g_generation++;

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

  if (SHOULD_GROW(g_size, g_capacity) && g_capacity < MAX_CAPACITY) {
    next_capacity = g_capacity << 1u;
  } else if (g_size >= MAX_LIVE(g_capacity)) {
    /*
     * Only the load factor decides that the table is full, so the ceiling
     * stays MAX_LIVE(MAX_CAPACITY) entries. A table already at MAX_CAPACITY
     * cannot grow, and falls through to an in-place compaction instead.
     */
    return STATUS_CAPACITY_EXCEEDED;
  }

  return rehash(next_capacity);
}

/*
 * Inserts `key`, or overwrites both lanes if it is already present.
 *
 * The existence check runs first, before any growth decision: overwriting a
 * key already in the table consumes no slot, so it must succeed even on a
 * table sitting at MAX_CAPACITY, and must not trigger a rehash merely
 * because growth ran out.
 */
static int32_t set_one(uint32_t key, uint32_t lo, uint32_t hi) {
  const uint32_t hash = mix_u32(key);

  if (g_capacity != 0) {
    const uint32_t existing = find_slot(g_active_bank, g_mask, key, hash);

    if (existing != UINT32_MAX) {
      g_entries[g_active_bank][existing].lo = lo;
      g_entries[g_active_bank][existing].hi = hi;
      return STATUS_OK;
    }
  }

  /* Established absent, so a rehash here cannot introduce a duplicate. */
  const int32_t space_status = ensure_insert_space();
  if (space_status != STATUS_OK) return space_status;

  const uint32_t slot = find_insert_slot(g_active_bank, g_mask, hash);

  /*
   * find_insert_slot() reports UINT32_MAX only if it walked the whole probe
   * sequence without seeing an EMPTY or a DELETED slot, which g_growth_left
   * makes unreachable. Refusing the insert is what keeps that sentinel from
   * being used as a slot index if the invariant ever breaks.
   */
  if (slot == UINT32_MAX) return STATUS_CAPACITY_EXCEEDED;

  /* Reusing a tombstone consumes no growth: the slot was already spent. */
  if (g_ctrl[g_active_bank][slot] == CTRL_EMPTY) g_growth_left--;

  g_ctrl[g_active_bank][slot] = (uint8_t)h2(hash);
  g_entries[g_active_bank][slot].key = key;
  g_entries[g_active_bank][slot].lo = lo;
  g_entries[g_active_bank][slot].hi = hi;
  g_size++;

  return STATUS_OK;
}

/* ── Single-key API ────────────────────────────────────────────────── */

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
  g_generation++;
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
  g_generation++;
}

/*
 * Lookup returning presence and both value lanes in one crossing.
 *
 * Latches the lanes into g_last_value and returns 1 if present, 0 if
 * absent. Read the lanes from last_value_ptr(); they are meaningful only
 * immediately after a has_get() that returned 1. Reporting presence
 * separately is what lets a stored value of 0 be distinguished from
 * absence across the full u64 range.
 */
__attribute__((export_name("has_get")))
int32_t has_get(uint32_t key) {
  if (g_capacity == 0) return 0;

  const uint32_t hash = mix_u32(key);
  const uint32_t slot = find_slot(g_active_bank, g_mask, key, hash);

  if (slot == UINT32_MAX) return 0;

  g_last_value[0] = g_entries[g_active_bank][slot].lo;
  g_last_value[1] = g_entries[g_active_bank][slot].hi;

  return 1;
}

/*
 * Address of the has_get() output lanes, two consecutive u32. Constant for
 * the module's lifetime, so the caller builds its view once at load.
 */
__attribute__((export_name("last_value_ptr")))
uint32_t last_value_ptr(void) { return (uint32_t)(uintptr_t)g_last_value; }

/* Returns 1 if `key` is present, 0 otherwise. */
__attribute__((export_name("has")))
int32_t has(uint32_t key) {
  if (g_capacity == 0) return 0;
  const uint32_t hash = mix_u32(key);
  return find_slot(g_active_bank, g_mask, key, hash) != UINT32_MAX;
}

/* Inserts `key`, or overwrites both lanes if it is already present. */
__attribute__((export_name("set")))
int32_t set(uint32_t key, uint32_t lo, uint32_t hi) {
  return set_one(key, lo, hi);
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

  if (g_capacity == 0) {
    for (uint32_t i = 0; i < count; i++) {
      los[i] = 0; his[i] = 0; found[i] = 0;
    }
    return STATUS_OK;
  }

  for (uint32_t i = 0; i < count; i++) {
    const uint32_t key = keys[i];
    const uint32_t hash = mix_u32(key);
    const uint32_t slot = find_slot(g_active_bank, g_mask, key, hash);

    if (slot == UINT32_MAX) {
      los[i] = 0; his[i] = 0; found[i] = 0;
    } else {
      los[i] = g_entries[g_active_bank][slot].lo;
      his[i] = g_entries[g_active_bank][slot].hi;
      found[i] = 1;
    }
  }

  return STATUS_OK;
}

/*
 * Removes `count` keys staged at keys_ptr.
 *
 * Writes deleted_ptr[i] = 1 if the key was present and removed, else 0.
 * deleted_ptr addresses a u8[count]. Returns the number removed, which is
 * the number of 1s written.
 */
__attribute__((export_name("delete_many")))
uint32_t delete_many(
  uint32_t keys_ptr,
  uint32_t deleted_ptr,
  uint32_t count
) {
  if (
    !bulk_count_ok(count) ||
    !is_bulk_ptr(keys_ptr, g_bulk_keys) ||
    !is_bulk_ptr(deleted_ptr, g_bulk_flags)
  ) {
    return DELETE_MANY_FAILED;
  }

  const uint32_t *keys = (const uint32_t *)(uintptr_t)keys_ptr;
  uint8_t *deleted = (uint8_t *)(uintptr_t)deleted_ptr;
  uint32_t removed = 0;

  if (g_capacity == 0) {
    for (uint32_t i = 0; i < count; i++) deleted[i] = 0;
    return 0;
  }

  for (uint32_t i = 0; i < count; i++) {
    const uint32_t key = keys[i];
    const uint32_t hash = mix_u32(key);
    const uint32_t slot = find_slot(g_active_bank, g_mask, key, hash);

    if (slot == UINT32_MAX) {
      deleted[i] = 0;
      continue;
    }

    g_ctrl[g_active_bank][slot] = CTRL_DELETED;
    g_size--;
    deleted[i] = 1;
    removed++;
  }

  return removed;
}

/* ── Staging buffer accessors ──────────────────────────────────────── */

/* Maximum keys the staging buffers hold; larger batches must be chunked. */
__attribute__((export_name("bulk_capacity")))
uint32_t bulk_capacity(void) { return BULK_CAPACITY; }

/* Addresses of the staging buffers. Constant for the module's lifetime. */

__attribute__((export_name("bulk_keys_ptr")))
uint32_t bulk_keys_ptr(void) { return (uint32_t)(uintptr_t)g_bulk_keys; }

__attribute__((export_name("bulk_vals_lo_ptr")))
uint32_t bulk_vals_lo_ptr(void) { return (uint32_t)(uintptr_t)g_bulk_vals_lo; }

__attribute__((export_name("bulk_vals_hi_ptr")))
uint32_t bulk_vals_hi_ptr(void) { return (uint32_t)(uintptr_t)g_bulk_vals_hi; }

/* Doubles as the delete_many() output buffer; only one is live at a time. */
__attribute__((export_name("bulk_flags_ptr")))
uint32_t bulk_flags_ptr(void) { return (uint32_t)(uintptr_t)g_bulk_flags; }

/* Live entries, excluding tombstones. */
__attribute__((export_name("size")))
uint32_t size(void) { return g_size; }

/* Allocated slots in the live bank. */
__attribute__((export_name("capacity")))
uint32_t capacity(void) { return g_capacity; }

/* ── Iteration ─────────────────────────────────────────────────────── */

/* Slots one scan() visits. Never more than BULK_CAPACITY, whose buffers it
 * borrows: the caller copies each chunk out before it can issue another
 * bulk call, so only one of the two ever holds live data at a time. */
__attribute__((export_name("scan_window")))
uint32_t scan_window(void) { return SCAN_WINDOW; }

/* Bumped by every rehash, clear, and init. See g_generation. */
__attribute__((export_name("generation")))
uint32_t generation(void) { return g_generation; }

/*
 * Copies the live entries in the slot window at `cursor` into the staging
 * buffers, returning how many were written.
 *
 * `cursor` must be a multiple of GROUP_WIDTH, and is rejected with
 * STATUS_INVALID_ARGUMENT rather than trusted otherwise: an unaligned
 * position would let the final group's 16-byte load read past the bank. A
 * cursor at or beyond capacity is the end of the walk, and reports 0.
 *
 * Capacity is a power of two and at least GROUP_WIDTH, so a group-aligned
 * cursor gives a group-aligned end however the window is clamped, and the
 * loop never has a partial group to handle.
 *
 * Cost is one SIMD load per group plus one copy per live entry, so a full
 * walk is O(capacity / GROUP_WIDTH + size): the empty stretches of a sparse
 * table are skipped 16 slots at a time rather than examined byte by byte.
 */
__attribute__((export_name("scan")))
int32_t scan(uint32_t cursor) {
  if ((cursor & (GROUP_WIDTH - 1u)) != 0) return STATUS_INVALID_ARGUMENT;
  if (g_capacity == 0 || cursor >= g_capacity) return 0;

  const uint8_t *control = g_ctrl[g_active_bank];
  const Entry *entries = g_entries[g_active_bank];

  uint32_t end = cursor + SCAN_WINDOW;
  if (end > g_capacity) end = g_capacity;

  uint32_t count = 0;

  for (uint32_t position = cursor; position < end; position += GROUP_WIDTH) {
    /* match_special selects EMPTY and DELETED, so its complement is live. */
    uint32_t live = ~match_special(control, position) & 0xffffu;

    while (live != 0) {
      const uint32_t slot = position + ctz32(live);
      live &= live - 1u;
      g_bulk_keys[count] = entries[slot].key;
      g_bulk_vals_lo[count] = entries[slot].lo;
      g_bulk_vals_hi[count] = entries[slot].hi;
      count++;
    }
  }

  return (int32_t)count;
}
