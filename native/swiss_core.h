/*
 * swiss_core.h
 *
 * The shared SwissTable engine: probing, growth, deletion, iteration, and
 * the invariants they rest on. Included — not linked — by each module's
 * single translation unit, so every function here is `static` and the
 * compiler sees the whole table through one Entry type.
 *
 * A module defines its payload before including this header:
 *
 *   #define SWISS_ENTRY_FIELDS uint32_t value;   // swiss_u32.c
 *   #define SCAN_WINDOW 65536u
 *   #include "swiss_core.h"
 *
 * and then supplies the two payload hooks declared below (latch_value,
 * stage_entry), its staging buffers, and its payload-shaped exports
 * (set, last_value_ptr, and any bulk API).
 *
 * Design follows Abseil's raw_hash_set: an array of 1-byte control values
 * scanned 16 at a time with SIMD, and a parallel array of entries. See
 * https://abseil.io/about/design/swisstables and google/cwisstable.
 *
 * The module holds exactly one table in static storage. There is no
 * allocator (it links -nostdlib), so capacity is bounded at build time by
 * MAX_CAPACITY and instances are created by instantiating the module again.
 */

#ifndef SWISS_ENTRY_FIELDS
#error "define SWISS_ENTRY_FIELDS before including swiss_core.h"
#endif

#ifndef SCAN_WINDOW
#error "define SCAN_WINDOW before including swiss_core.h"
#endif

#include <stdint.h>
#include <stddef.h>
#include <wasm_simd128.h>

/* Returned by every fallible export when the operation succeeded. */
#define STATUS_OK 0

/*
 * Returned when a request would exceed MAX_CAPACITY. The table is left
 * usable, but the request was not applied in full — see set_many() in
 * swiss_u64.c.
 */
#define STATUS_CAPACITY_EXCEEDED (-2)

/*
 * Returned when an export is called with arguments it cannot honour: a scan
 * cursor that is not group-aligned, a bulk count past BULK_CAPACITY, or a
 * staging pointer the module does not own.
 *
 * Distinct from STATUS_CAPACITY_EXCEEDED, which describes a well-formed
 * request the table has no room for. Nothing is applied, so the table is
 * left exactly as it was.
 */
#define STATUS_INVALID_ARGUMENT (-3)

/* Control values scanned per SIMD probe; also the probe stride. */
#define GROUP_WIDTH 16u

/*
 * Control-byte states. A slot holding an entry stores the 7-bit fingerprint
 * h2(hash) with its high bit clear, so the high bit alone distinguishes a
 * live slot from EMPTY or DELETED — see is_full() and match_special().
 */
#define CTRL_EMPTY   0xffu
#define CTRL_DELETED 0x80u

/*
 * Slots per bank. Two banks of this size are reserved statically.
 *
 * This is the module's whole memory budget: the banks are reserved in .bss
 * at instantiation whether the table holds one entry or a million. One
 * instance is one table, so a workload with many small tables pays it per
 * table — build a second module with a lower exponent for that case.
 *
 * Overridable at build time as a power-of-two exponent, which is what keeps
 * the mask arithmetic valid; scripts/build-wasm.ts sizes linear memory from
 * the same number. See SWISS_MAX_CAPACITY_LOG2 there.
 */
#ifndef MAX_CAPACITY_LOG2
#define MAX_CAPACITY_LOG2 20
#endif

/*
 * Both ends are load bearing, and neither is enforced by the arithmetic
 * itself, so the header refuses the build rather than trusting its caller:
 * scripts/build-wasm.ts applies the same bounds, but the sources compile
 * standalone with -DMAX_CAPACITY_LOG2 and would otherwise miscompute in
 * silence. Below 4 a bank holds less than one SIMD group, so a group load
 * would run past it. Above 25 h1() runs out of bits: it discards the 7 the
 * fingerprint consumes, so it yields 25, and a wider mask would leave the
 * upper half of the slot space unreachable as a probe start — still correct,
 * since probing enumerates every group regardless, but with probe lengths
 * roughly doubled and the load factor no longer describing the table.
 * Further out the two banks and the staging buffers stop addressing inside
 * wasm32's 4 GiB at 27, MAX_LIVE()'s 32-bit product wraps at 30, and at 32
 * the shift below is undefined.
 */
#if MAX_CAPACITY_LOG2 < 4 || MAX_CAPACITY_LOG2 > 25
#error "MAX_CAPACITY_LOG2 must be in [4, 25]"
#endif

#define MAX_CAPACITY (1u << MAX_CAPACITY_LOG2)

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
 * Key and payload share one record; the module defines the payload.
 *
 * A lookup is a chain of dependent loads: control byte, then the key to
 * confirm the match, then the value. Separate key and value arrays would
 * put each on its own cache line; one record keeps the confirm-and-read on
 * the same line, removing a serialized miss from the critical path.
 */
typedef struct {
  uint32_t key;
  SWISS_ENTRY_FIELDS
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
 * Per-instance hash seed, mixed into every key before the finalizer.
 *
 * Zero until set_seed() runs, which the bindings do once at construction,
 * before the first insert. An unseeded table is still correct — it is the
 * fixed-permutation table this module shipped before — but its slot layout
 * is identical in every process, so a chosen key set that collides in one
 * collides in all of them. The seed is what makes that set unknowable
 * without first learning the seed.
 *
 * It cannot change while entries exist: every live key was placed by the
 * old permutation, and reseeding without a rehash would leave all of them
 * unfindable. set_seed() enforces that rather than documenting it.
 */
static uint32_t g_seed = 0;

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
 * Payload hooks, defined by the module after this include.
 *
 * latch_value() copies an entry's payload into the module's has_get()
 * output slot; stage_entry() copies one live entry into the module's scan
 * staging buffers. They are the only two places the shared engine touches
 * payload lanes it cannot name, and both inline under LTO.
 */
static void latch_value(const Entry *entry);
static void stage_entry(uint32_t index, const Entry *entry);

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
static inline uint32_t ctz32(uint32_t value) {
  return (uint32_t)__builtin_ctz(value);
}

/*
 * Murmur3 finalizer, keyed by g_seed.
 *
 * Keys are frequently dense or strided (indices, IDs, pointers >> 3), which
 * a bare identity hash would map onto a handful of groups. The finalizer
 * spreads every input bit across the whole word, which both h1 and h2 need.
 *
 * The seed is mixed in ahead of the finalizer rather than xored onto its
 * result: the finalizer is what spreads a one-bit difference across the
 * word, so a seed applied afterwards would leave keys differing in their
 * low bits landing in the same group whatever the seed was.
 */
static inline uint32_t mix_u32(uint32_t value) {
  value ^= g_seed;
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
 *
 * Spelled as the builtin so it lowers to the `memory.fill` instruction the
 * engine implements, rather than to a call to the byte loop above: the
 * build passes -fno-builtin-memset to keep that loop from recursing, and
 * that would otherwise cost this path a megabyte of scalar stores per
 * clear, reserve, and rehash.
 */
static void initialize_bank(uint32_t bank, uint32_t capacity) {
  __builtin_memset(g_ctrl[bank], CTRL_EMPTY, capacity);
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
 * Returns the active-bank slot holding `key`, or UINT32_MAX if it is
 * absent — including before init(), when there is no bank to probe.
 */
static uint32_t lookup_slot(uint32_t key) {
  if (g_capacity == 0) return UINT32_MAX;
  return find_slot(g_active_bank, g_mask, key, mix_u32(key));
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
 * Writes an entry known not to be in `bank`, skipping the lookup that an
 * upsert performs. Used by rehash(), where the source table is already
 * deduplicated; the struct assignment carries the payload whatever its
 * shape.
 */
static void insert_known_absent(
  uint32_t bank, uint32_t mask, const Entry *entry
) {
  const uint32_t hash = mix_u32(entry->key);
  const uint32_t slot = find_insert_slot(bank, mask, hash);

  /*
   * find_insert_slot() reports UINT32_MAX for a bank with neither an empty
   * nor a deleted slot. rehash() is the only caller and always writes into
   * a bank it has just emptied, so this cannot fire — but the alternative
   * to checking is an out-of-bounds write, and upsert_slot() guards the
   * same return for the same reason. Trapping keeps a broken invariant
   * loud instead of turning it into silent corruption or a dropped entry.
   */
  if (slot == UINT32_MAX) __builtin_trap();

  g_ctrl[bank][slot] = (uint8_t)h2(hash);
  g_entries[bank][slot] = *entry;
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

    insert_known_absent(new_bank, new_mask, &g_entries[old_bank][i]);
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
    /* Creating the slot space is an event a cursor cannot be held across,
     * the same as init() and clear(); see g_generation. */
    g_generation += 1u;
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
     *
     * The fall-through is also where the 25/32 line stops protecting the
     * table: doubling is unavailable, so a workload sitting just under
     * MAX_LIVE(MAX_CAPACITY) and alternating insert with delete compacts on
     * every insert, at O(MAX_CAPACITY) each. Raise the exponent or shard
     * rather than running a table at its ceiling under churn.
     */
    return STATUS_CAPACITY_EXCEEDED;
  }

  return rehash(next_capacity);
}

/*
 * Finds or creates the active-bank slot for `key`, leaving only the
 * payload for the caller to store.
 *
 * On STATUS_OK, *slot_out indexes the entry: for a key already present it
 * is the existing slot, untouched; for a new key the control byte, key,
 * and size accounting are already written and the payload lanes are
 * whatever the slot last held — the caller stores them next. Any other
 * status means the table is unchanged.
 *
 * *inserted_out distinguishes those two cases, which is what lets
 * get_or_insert() and increment() decide whether to keep the stored payload
 * or write a fresh one without probing a second time. Reporting it here
 * rather than re-looking-up costs nothing: both paths already know which
 * branch they took.
 *
 * The existence check runs first, before any growth decision: overwriting a
 * key already in the table consumes no slot, so it must succeed even on a
 * table sitting at MAX_CAPACITY, and must not trigger a rehash merely
 * because growth ran out.
 *
 * always_inline is load bearing, not a hint. Every caller of this is a hot
 * exported path, and clang stops inlining it once there is more than one —
 * which set(), get_or_insert(), increment() and set_many() all are. Letting
 * it become a shared out-of-line call costs 10% on a pre-sized fill on both
 * JavaScriptCore and V8, measured by adding a second caller to an otherwise
 * unchanged module. Callers that only need the slot go through upsert_slot
 * below, whose `inserted` local is dead after inlining and folds away.
 */
__attribute__((always_inline))
static inline int32_t upsert_slot_tracked(
  uint32_t key, uint32_t *slot_out, uint32_t *inserted_out
) {
  const uint32_t hash = mix_u32(key);

  if (g_capacity != 0) {
    const uint32_t existing = find_slot(g_active_bank, g_mask, key, hash);

    if (existing != UINT32_MAX) {
      *slot_out = existing;
      *inserted_out = 0;
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
  g_size++;

  *slot_out = slot;
  *inserted_out = 1;
  return STATUS_OK;
}

/*
 * upsert_slot_tracked() for the callers that only store a payload and do
 * not care which branch ran. The local is dead in the caller after
 * inlining, so this costs nothing over writing the flag nowhere.
 */
__attribute__((always_inline))
static inline int32_t upsert_slot(uint32_t key, uint32_t *slot_out) {
  uint32_t inserted;
  return upsert_slot_tracked(key, slot_out, &inserted);
}

/* ── Shared exported API ───────────────────────────────────────────── */

/*
 * Sets the hash seed. See g_seed.
 *
 * Rejected once the table holds entries, because their slots were chosen
 * under the current seed and nothing here rehashes them.
 */
__attribute__((export_name("set_seed")))
int32_t set_seed(uint32_t seed) {
  if (g_size != 0) return STATUS_INVALID_ARGUMENT;

  g_seed = seed;
  return STATUS_OK;
}

/*
 * Sizes the table for `expected_entries` and empties it.
 *
 * Safe to call again to reset the table to a different size. Leaves the
 * seed alone: it belongs to the instance, not to a sizing.
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
 * Grows the table so `entries` total fit without a further rehash,
 * preserving its contents. A no-op when the live bank already has room.
 */
__attribute__((export_name("reserve")))
int32_t reserve(uint32_t entries) {
  if (g_capacity == 0) return init(entries);

  /*
   * An insert consumes growth only when it takes an EMPTY slot, so
   * g_growth_left is the worst-case budget, and capacity alone does not
   * decide whether the next insert rehashes. A table whose growth went to
   * since-deleted entries has the capacity for `entries` and rehashes on
   * the next one regardless.
   */
  if (entries <= g_size || entries - g_size <= g_growth_left) {
    return STATUS_OK;
  }

  uint32_t next_capacity = g_capacity;

  if (entries > MAX_LIVE(g_capacity)) {
    next_capacity = capacity_for_entries(entries);
    if (entries > MAX_LIVE(next_capacity)) return STATUS_CAPACITY_EXCEEDED;
  }

  /*
   * Otherwise `entries` fit at this capacity and only the tombstones are in
   * the way, so a rehash in place is enough: it restores growth_left to
   * MAX_LIVE(capacity) - size, which covers them by the test above.
   */
  return rehash(next_capacity);
}

/*
 * Shrinks the table to the smallest capacity that holds its live entries,
 * preserving contents. A no-op when it is already there.
 *
 * Capacity otherwise only ever rises: reserve() and the growth path raise
 * it, clear() retains it, and a delete leaves a tombstone rather than a
 * freed slot. Lookups do not care — they probe from a hash — but scan()
 * visits every group in the slot space, so iteration costs O(capacity) and
 * a table that once peaked large keeps paying peak walk cost forever. This
 * is the one way back down.
 *
 * capacity_for_entries() leaves a group of headroom above the load factor,
 * so the result has room for further inserts and this cannot produce a
 * table that rehashes on the very next set().
 */
__attribute__((export_name("shrink_to_fit")))
int32_t shrink_to_fit(void) {
  if (g_capacity == 0) return STATUS_OK;

  const uint32_t next_capacity = capacity_for_entries(g_size);
  if (next_capacity >= g_capacity) return STATUS_OK;

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
 * Lookup returning presence and the payload in one crossing.
 *
 * Latches the payload into the module's output slot via latch_value() and
 * returns 1 if present, 0 if absent. Read the payload from the address
 * last_value_ptr() reports; it is meaningful only immediately after a
 * has_get() that returned 1. Reporting presence separately is what lets a
 * stored value of 0 be distinguished from absence.
 */
__attribute__((export_name("has_get")))
int32_t has_get(uint32_t key) {
  const uint32_t slot = lookup_slot(key);

  if (slot == UINT32_MAX) return 0;

  latch_value(&g_entries[g_active_bank][slot]);

  return 1;
}

/* Returns 1 if `key` is present, 0 otherwise. */
__attribute__((export_name("has")))
int32_t has(uint32_t key) {
  return lookup_slot(key) != UINT32_MAX;
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
  const uint32_t slot = lookup_slot(key);

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

/*
 * Addresses of the two counters above, so the binding can read them as
 * memory rather than as calls.
 *
 * `size` and `capacity` are properties on the JavaScript side, and a
 * property that costs a boundary crossing sets the wrong expectation: a
 * caller writing `for (i = 0; i < table.size; i++)` pays per iteration for
 * what reads like a field. A cached view over these addresses makes the
 * read cost the same as a local variable — measured at 0.19 ns against
 * 0.95 ns for the export call.
 *
 * This is the same trick last_value_ptr() uses, and it is sound for the
 * same two reasons: the counters are ordinary statics in linear memory, so
 * exposing an address costs the hot path nothing, and the module links with
 * initial memory equal to maximum memory and never calls memory.grow, so a
 * view built once is never detached.
 *
 * The exports above stay: they are the module's ABI, they are what the
 * binding validates on load, and they are the definition these addresses
 * merely point at. There is no second copy of the count to keep in step.
 */
__attribute__((export_name("size_ptr")))
uint32_t size_ptr(void) { return (uint32_t)(uintptr_t)&g_size; }

__attribute__((export_name("capacity_ptr")))
uint32_t capacity_ptr(void) { return (uint32_t)(uintptr_t)&g_capacity; }

/* ── Iteration ─────────────────────────────────────────────────────── */

/* Slots one scan() visits; also the staging length, in entries. */
__attribute__((export_name("scan_window")))
uint32_t scan_window(void) { return SCAN_WINDOW; }

/* Bumped by every rehash, clear, and init. See g_generation. */
__attribute__((export_name("generation")))
uint32_t generation(void) { return g_generation; }

/*
 * Copies the live entries in the slot window at `cursor` into the module's
 * staging buffers via stage_entry(), returning how many were written.
 *
 * `cursor` must be a multiple of GROUP_WIDTH, and is rejected with
 * STATUS_INVALID_ARGUMENT rather than trusted otherwise: an unaligned
 * position would let the final group's 16-byte load read past the bank. A
 * cursor at or beyond capacity is the end of the walk, and reports 0.
 *
 * A window is a fixed span of slots rather than a fixed number of entries.
 * That is what lets the caller advance its own cursor without the module
 * reporting where the scan stopped: the windows [0, W), [W, 2W), ...
 * partition the slot space, so every live slot falls in exactly one and is
 * reported exactly once. A window of W slots holds at most W entries, so
 * the staging buffers cannot overflow either.
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
      stage_entry(count, &entries[slot]);
      count++;
    }
  }

  return (int32_t)count;
}


/* ── Bulk API scaffolding ──────────────────────────────────────────── */

#ifdef BULK_CAPACITY

/*
 * Everything the bulk API needs that does not depend on the payload shape:
 * the key and flag staging buffers, the argument checks, and delete_many(),
 * which touches only keys and control bytes and so is identical in both
 * modules. Each .c supplies its own value buffers, set_many(), get_many(),
 * and the accessors for the value lanes it happens to have.
 *
 * A module opts in by defining BULK_CAPACITY before including this header.
 */

/*
 * delete_many() reports how many keys it removed, so it has no room for a
 * negative status. A removal count can never exceed BULK_CAPACITY, which
 * makes UINT32_MAX unambiguous as a failure sentinel.
 */
#define DELETE_MANY_FAILED 0xffffffffu

/*
 * Staging buffers for the bulk API.
 *
 * Owned by the module so their addresses are assigned by the linker rather
 * than hardcoded by the caller: the JS side reads bulk_capacity() and the
 * bulk_*_ptr() accessors and builds its views from those. An earlier
 * revision picked the offsets caller-side and silently aliased the banks.
 *
 * Deliberately separate from the scan buffers. Sharing them would cost
 * nothing in memory and would be correct for the shipped binding, which
 * copies each window out before it issues anything else. It would still be
 * wrong: an exported function is reachable by every holder of the instance,
 * and a caller that staged a bulk batch, walked the table, then issued the
 * batch would read the walk's entries back as its own arguments — wrong
 * values, no trap, nothing in the data to show it. Separate arrays make
 * that unrepresentable rather than merely documented.
 */
static uint32_t g_bulk_keys[BULK_CAPACITY];
static uint8_t  g_bulk_flags[BULK_CAPACITY];

/*
 * True when `ptr` is the address of the staging buffer it is meant to be.
 *
 * The bulk exports take addresses, which makes every one of them a write
 * primitive aimed anywhere in linear memory unless it is checked. There is
 * no range to check against: the only legitimate value for each argument is
 * the single buffer it names, whose address the caller obtained from this
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
 * Removes `count` keys staged at keys_ptr.
 *
 * Writes deleted_ptr[i] = 1 if the key was present and removed, else 0.
 * deleted_ptr addresses a u8[count]. Returns the number removed, which is
 * the number of 1s written.
 *
 * Payload-independent — a removal only rewrites a control byte — so this is
 * shared rather than duplicated per module.
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

  for (uint32_t i = 0; i < count; i++) {
    const uint32_t slot = lookup_slot(keys[i]);

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

/* Maximum keys the staging buffers hold; larger batches must be chunked. */
__attribute__((export_name("bulk_capacity")))
uint32_t bulk_capacity(void) { return BULK_CAPACITY; }

/* Addresses of the shared staging buffers. Constant for the module's life. */

__attribute__((export_name("bulk_keys_ptr")))
uint32_t bulk_keys_ptr(void) { return (uint32_t)(uintptr_t)g_bulk_keys; }

/* Doubles as the delete_many() output buffer; only one is live at a time. */
__attribute__((export_name("bulk_flags_ptr")))
uint32_t bulk_flags_ptr(void) { return (uint32_t)(uintptr_t)g_bulk_flags; }

#endif /* BULK_CAPACITY */
