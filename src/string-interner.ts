import { asCallback, asString } from "./abi.ts";

/**
 * The minimal numeric-table contract {@link InternedSwissMap} depends on.
 *
 * {@link SwissU32ToU32} satisfies it directly for `V = number`.
 * {@link SwissU32ToU64} takes its value as two lanes rather than one, so wrap
 * its `set`/`get` at the call site to adapt it.
 *
 * @typeParam V - Value type stored against each numeric key.
 */
export interface NumericKeyTable<V> {
  /** Number of live entries. */
  readonly size: number;
  /** Inserts `key`, or overwrites the value if it is already present. */
  set(key: number, value: V): void;
  /** Returns the value stored for `key`, or `undefined` if absent. */
  get(key: number): V | undefined;
  /** Reports whether `key` is present. */
  has(key: number): boolean;
  /** Removes `key`, returning `true` if it was present. */
  delete(key: number): boolean;

  /**
   * Calls `callback` once per entry, in unspecified order.
   *
   * Optional, and feature-detected rather than required: widening the four
   * methods above into six would break every table already written against
   * this interface. A table without it is fully usable and only gives up
   * {@link InternedSwissMap.forEach}.
   */
  forEach?(callback: (value: V, key: number) => void): void;

  /**
   * Yields every entry as a `[key, value]` pair, in unspecified order.
   *
   * Optional for the same reason as {@link NumericKeyTable.forEach}. A
   * table without it gives up the pull iterators
   * ({@link InternedSwissMap.keys}, `values`, `entries`, and `for…of`).
   */
  entries?(): IterableIterator<[number, V]>;
}

/** Options for {@link StringInterner}. */
export interface StringInternerOptions {
  /**
   * Hand released IDs back out to later strings instead of retiring them.
   *
   * Off by default, because turning it on gives up the guarantee the class
   * otherwise makes: that an ID identifies the same string for the lifetime
   * of the instance. Turn it on for a long-lived map whose keys rotate,
   * where retiring an ID per distinct key ever seen is a leak; leave it off
   * when IDs are held anywhere outside the one map that owns the interner.
   */
  recycleIds?: boolean;
}

/**
 * Assigns unsigned 32-bit IDs to exact strings.
 *
 * IDs are handed out in first-seen order starting at 0 — 0 is a valid,
 * assignable ID. By default they remain stable for the lifetime of the
 * instance. This is the bridge between string-keyed data (tokenizer
 * vocabularies, cache namespaces, structured cache keys) and a u32-keyed
 * SwissTable.
 *
 * With {@link StringInternerOptions.recycleIds} on, a released ID is handed
 * to the next new string instead, which bounds the ID space at the number of
 * strings live at once rather than the number ever seen — at the cost of
 * that stability. See {@link StringInterner.release}.
 *
 * Interning itself is a JavaScript `Map` lookup, so it is worth doing once
 * per string and reusing the ID; a table keyed by IDs is where the win is.
 *
 * @example
 * ```ts
 * const interner = new StringInterner();
 * const id = interner.intern("temperature");
 * interner.resolve(id); // "temperature"
 * ```
 */
export class StringInterner {
  /** Forward index, string to assigned ID. Also the live-string count. */
  private readonly stringToId = new Map<string, number>();

  /**
   * Reverse index; an ID is its position in this array.
   *
   * A released ID leaves `undefined` behind rather than shortening the
   * array, so every other ID keeps its position.
   */
  private readonly idToString: (string | undefined)[] = [];

  /**
   * Released IDs waiting to be handed out again, most recent first.
   *
   * Empty unless {@link StringInterner.recyclesIds} is on, since nothing
   * else ever releases one.
   */
  private readonly pool: number[] = [];

  /**
   * The ID {@link StringInterner.intern} last took from the pool, if it has
   * not been handed back since.
   *
   * {@link StringInterner.forgetLast} needs it: a recycled ID is not at the
   * end of the reverse index, so the tail rule alone cannot recognise it.
   */
  private lastRecycled: number | undefined;

  /** Set once an {@link InternedSwissMap} has claimed this interner. */
  private claimed = false;

  /** Whether released IDs are handed out again. Fixed at construction. */
  readonly recyclesIds: boolean;

  /**
   * @param options - See {@link StringInternerOptions}.
   */
  constructor(options: StringInternerOptions = {}) {
    this.recyclesIds = options.recycleIds === true;
  }

  /**
   * Number of strings currently interned.
   *
   * Without recycling this only ever grows, and equals the number of IDs
   * ever assigned. With it, released strings are subtracted, which is what
   * makes this the number to watch for unbounded growth.
   */
  get size(): number {
    return this.stringToId.size;
  }

  /**
   * Binds this interner to a single {@link InternedSwissMap}.
   *
   * Only recycling interners are claimed. Two maps sharing one would corrupt
   * each other: a delete in the first returns an ID to the pool, the next
   * new string takes it, and the second map's entry under that ID then
   * answers for a key it never held. Without recycling an ID never changes
   * meaning, so sharing stays safe and this is not called.
   *
   * @throws {TypeError} If another map has already claimed it.
   * @internal
   */
  claim(): void {
    if (this.claimed) {
      throw new TypeError(
        "a recycling StringInterner cannot be shared between maps: its IDs " +
          "change meaning, so only the owner that releases them can hold them",
      );
    }
    this.claimed = true;
  }

  /**
   * Releases `id`, forgetting its string and returning the ID to the pool.
   *
   * The ID is handed to a later string, so anything still holding it now
   * refers to whatever that turns out to be. Only the owner that assigned it
   * can know it is safe to release, which is why this is refused unless
   * recycling was asked for at construction.
   *
   * @param id - ID to release.
   * @returns `true` if it was assigned and has been released, `false` if it
   *   was never assigned or was already released. Nothing changes on
   *   `false`, so a repeated release cannot put an ID in the pool twice.
   * @throws {TypeError} If this interner does not recycle IDs.
   */
  release(id: number): boolean {
    if (!this.recyclesIds) {
      throw new TypeError(
        "this StringInterner does not recycle IDs; construct it with " +
          "{ recycleIds: true } to release them",
      );
    }

    const text = this.assignedText(id);
    if (text === undefined) return false;

    this.idToString[id] = undefined;
    this.stringToId.delete(text);
    this.pool.push(id);

    if (this.lastRecycled === id) this.lastRecycled = undefined;

    return true;
  }

  /**
   * The string `id` is assigned to, or `undefined` if it is not assigned.
   *
   * A released ID reads back as a hole, and an out-of-range or non-integer
   * one reads back as `undefined` from the array, so one lookup covers all
   * three.
   */
  private assignedText(id: number): string | undefined {
    if (!Number.isInteger(id) || id < 0) return undefined;
    return this.idToString[id];
  }

  /**
   * Returns the existing ID for `text`, assigning a new one if needed.
   *
   * @param text - String to intern.
   * @returns The stable ID for `text`.
   * @throws {RangeError} If the u32 ID space is exhausted.
   */
  intern(text: string): number {
    asString(text, "text");

    const existing = this.stringToId.get(text);
    if (existing !== undefined) return existing;

    const recycled = this.pool.pop();
    const id = recycled ?? this.idToString.length;

    // The highest assignable ID is 0xffff_fffe: the reverse index is a
    // plain array, whose maximum index is 2**32 - 2, so 0xffff_ffff could
    // never be stored positionally — pushing it would throw with the
    // forward map already updated. Checking before any mutation keeps the
    // two indexes consistent when this throws; a recycled ID was assigned
    // before, so it is always under the bound.
    if (id >= 0xffff_ffff) {
      throw new RangeError("StringInterner exhausted the u32 ID space");
    }

    this.stringToId.set(text, id);

    if (recycled === undefined) {
      this.idToString.push(text);
    } else {
      this.idToString[id] = text;
    }

    this.lastRecycled = recycled;

    return id;
  }

  /**
   * Interns every string in order.
   *
   * @param texts - Strings to intern.
   * @returns Their IDs, positionally matching `texts`.
   * @throws {RangeError} If the u32 ID space is exhausted.
   */
  internAll(texts: Iterable<string>): Uint32Array {
    const ids: number[] = [];
    for (const text of texts) ids.push(this.intern(text));
    return Uint32Array.from(ids);
  }

  /**
   * Returns the ID for `text` without assigning one.
   *
   * @param text - String to look up.
   * @returns The ID, or `undefined` if `text` was never interned.
   */
  lookup(text: string): number | undefined {
    asString(text, "text");
    return this.stringToId.get(text);
  }

  /**
   * Releases the most recently assigned ID, undoing a single {@link
   * StringInterner.intern}.
   *
   * This exists so a caller that interns a key and then fails to store it
   * can avoid leaking the ID — see {@link InternedSwissMap.set}. Without
   * recycling it is deliberately limited to the last ID: releasing an
   * arbitrary one would either leave a hole in the ID space or renumber the
   * IDs that follow, and stable IDs are the point of the class.
   *
   * With recycling on it also accepts an ID that {@link
   * StringInterner.intern} has just taken from the pool, which is not at the
   * end of the reverse index and so cannot be recognised by position. That
   * ID goes back to the pool rather than being retired.
   *
   * @param id - The ID to release, which must be the one most recently
   *   assigned.
   * @returns `true` if it was released, `false` otherwise, in which case
   *   nothing changed.
   */
  forgetLast(id: number): boolean {
    if (id === this.idToString.length - 1) {
      // Read before popping: with recycling the tail can already be a hole,
      // and popping it would shorten the array on the way to returning false.
      const text = this.assignedText(id);
      if (text === undefined) return false;

      this.idToString.pop();
      this.stringToId.delete(text);
      if (this.lastRecycled === id) this.lastRecycled = undefined;

      return true;
    }

    if (this.recyclesIds && id === this.lastRecycled) return this.release(id);

    return false;
  }

  /**
   * Returns the string an ID was assigned to.
   *
   * @param id - ID previously returned by {@link StringInterner.intern}.
   * @returns The original string, or `undefined` if `id` was never assigned.
   */
  resolve(id: number): string | undefined {
    return this.assignedText(id);
  }

  /**
   * Interns a composite key built from several string parts.
   *
   * Each part is length-prefixed, which removes the ambiguity that plain
   * concatenation or a separator character would introduce:
   * `["ab", "c"]` encodes to `"2:ab1:c"` while `["a", "bc"]` encodes to
   * `"1:a2:bc"`, so no two distinct part lists can collide.
   *
   * @param parts - Ordered key components.
   * @returns The stable ID for that exact part list.
   * @throws {RangeError} If the u32 ID space is exhausted.
   */
  internParts(parts: readonly string[]): number {
    return this.intern(encodeParts(parts));
  }

  /**
   * Returns the ID for a composite key without assigning one.
   *
   * @param parts - Ordered key components.
   * @returns The ID, or `undefined` if that part list was never interned.
   */
  lookupParts(parts: readonly string[]): number | undefined {
    return this.lookup(encodeParts(parts));
  }
}

/**
 * Length-prefixes and concatenates key parts into an unambiguous string.
 *
 * @param parts - Ordered key components.
 * @returns The encoded key.
 */
function encodeParts(parts: readonly string[]): string {
  let encoded = "";
  for (const part of parts) {
    // A non-string part has no length, which would encode as "undefined:"
    // and collide with any other non-string in the same position.
    asString(part, "part");
    encoded += part.length;
    encoded += ":";
    encoded += part;
  }
  return encoded;
}

/**
 * A string-keyed facade over a u32-keyed numeric table.
 *
 * Strings are interned in JavaScript and the resulting IDs are what reach
 * the table, so the table's hot path stays entirely numeric. Note that this
 * makes a lookup strictly more work than `Map<string, V>`, which gets the
 * string's hash cached by the engine — the facade pays off when IDs are
 * interned once and reused, not when every lookup starts from a string.
 *
 * @typeParam V - Value type stored against each key.
 *
 * @example
 * ```ts
 * const map = new InternedSwissMap(await SwissU32ToU32.load(bytes));
 * map.set("temperature", 42);
 * map.get("temperature"); // 42
 * ```
 */
export class InternedSwissMap<V> {
  /** The interner assigning IDs to keys. Shareable across several maps. */
  readonly interner: StringInterner;

  /** The numeric table holding the values. */
  readonly table: NumericKeyTable<V>;

  /**
   * @param table - Numeric table to store values in.
   * @param interner - Interner to assign key IDs, so several maps can share
   *   one ID space. A fresh interner is created when omitted.
   * @throws {TypeError} If `table` is not a {@link NumericKeyTable}, if
   *   `interner` is not a {@link StringInterner}, or if it recycles IDs and
   *   another map already owns it.
   */
  constructor(table: NumericKeyTable<V>, interner = new StringInterner()) {
    // Checked here rather than at first use: a map built around the wrong
    // object otherwise fails somewhere far from the line that built it.
    if (table === null || typeof table !== "object") {
      throw new TypeError("table must be a NumericKeyTable");
    }

    for (const method of ["set", "get", "has", "delete"] as const) {
      if (typeof table[method] !== "function") {
        throw new TypeError(`table must be a NumericKeyTable: ${method} is missing`);
      }
    }

    if (!(interner instanceof StringInterner)) {
      throw new TypeError("interner must be a StringInterner");
    }

    // A recycling interner's IDs change meaning, so only the map that
    // releases them may hold them. See StringInterner.claim.
    if (interner.recyclesIds) interner.claim();

    this.table = table;
    this.interner = interner;
  }

  /**
   * Number of live entries.
   *
   * This is the table's count, not the interner's: an interned string whose
   * entry was deleted, or that was never written, does not count.
   * {@link StringInterner.size} can be larger, and is the number to watch
   * for unbounded growth in a long-lived map — without recycling it never
   * falls, since a deleted key keeps its ID forever.
   */
  get size(): number {
    return this.table.size;
  }

  /**
   * Interns a known vocabulary up front, so later `set`/`get` calls never
   * assign an ID on the hot path.
   *
   * @param vocabulary - Strings to intern.
   * @returns Their IDs, positionally matching `vocabulary`.
   */
  preloadVocabulary(vocabulary: Iterable<string>): Uint32Array {
    return this.interner.internAll(vocabulary);
  }

  /**
   * Inserts `key`, or overwrites the value if it is already present.
   * Interns `key` if it is new.
   *
   * If the table rejects the write — the compiled capacity being the usual
   * reason — an ID assigned for this call is released again, so a failed
   * `set` does not permanently consume an ID for a key that was never
   * stored. IDs assigned by an earlier successful call are left alone.
   *
   * @returns This map, for chaining.
   * @throws Whatever the underlying table throws, unchanged.
   */
  set(key: string, value: V): this {
    return this.store(this.interner.lookup(key), () => this.interner.intern(key), value);
  }

  /** Returns the value stored for `key`, or `undefined` if absent. */
  get(key: string): V | undefined {
    const id = this.interner.lookup(key);
    return id === undefined ? undefined : this.table.get(id);
  }

  /** Reports whether `key` is present. */
  has(key: string): boolean {
    const id = this.interner.lookup(key);
    return id !== undefined && this.table.has(id);
  }

  /**
   * Removes `key`.
   *
   * Without recycling the key keeps its interned ID, so re-inserting it
   * later reuses the same one. With recycling the ID is returned to the pool
   * and re-inserting the key assigns whatever is free at the time.
   *
   * @returns `true` if the key was present.
   */
  delete(key: string): boolean {
    return this.remove(this.interner.lookup(key));
  }

  /**
   * {@link InternedSwissMap.set} for a composite key, with the same
   * rollback behaviour on a rejected write.
   *
   * @see {@link StringInterner.internParts} for the encoding.
   * @returns This map, for chaining.
   * @throws Whatever the underlying table throws, unchanged.
   */
  setParts(parts: readonly string[], value: V): this {
    return this.store(
      this.interner.lookupParts(parts),
      () => this.interner.internParts(parts),
      value,
    );
  }

  /**
   * Writes `value` under an existing or freshly interned ID, releasing a
   * fresh ID again if the table rejects the write.
   *
   * @param known - The key's ID if it was already interned, else undefined.
   * @param assign - Interns the key, returning its new ID.
   * @param value - Value to store.
   */
  private store(
    known: number | undefined,
    assign: () => number,
    value: V,
  ): this {
    const id = known ?? assign();

    try {
      this.table.set(id, value);
    } catch (error) {
      if (known === undefined) this.interner.forgetLast(id);
      throw error;
    }

    return this;
  }

  /** {@link InternedSwissMap.get} for a composite key. */
  getParts(parts: readonly string[]): V | undefined {
    const id = this.interner.lookupParts(parts);
    return id === undefined ? undefined : this.table.get(id);
  }

  /** {@link InternedSwissMap.delete} for a composite key. */
  deleteParts(parts: readonly string[]): boolean {
    return this.remove(this.interner.lookupParts(parts));
  }

  /**
   * Resolves one entry's ID back to the string it was interned from.
   *
   * An ID the interner cannot resolve means the table holds an entry this
   * map did not write — the usual cause is writing through the public
   * {@link InternedSwissMap.table} directly, which bypasses interning. It
   * has no string key to report, so it is an error rather than an entry
   * quietly skipped or handed back as `undefined`.
   *
   * @throws {Error} If `id` was never interned.
   */
  private keyOf(id: number): string {
    const key = this.interner.resolve(id);

    if (key === undefined) {
      throw new Error(
        `the table holds key ${id}, which this map's interner cannot ` +
          `resolve to a string; it was written to the table directly ` +
          `rather than through the map`,
      );
    }

    return key;
  }

  /**
   * The table's own `forEach`, or an explanation of why there is none.
   *
   * @throws {TypeError} If the table does not support iteration.
   */
  private tableForEach(): NonNullable<NumericKeyTable<V>["forEach"]> {
    const walk = this.table.forEach;

    if (typeof walk !== "function") {
      throw new TypeError(
        "the underlying table does not support forEach, so this map cannot " +
          "be iterated",
      );
    }

    return walk.bind(this.table);
  }

  /**
   * The table's own `entries`, or an explanation of why there is none.
   *
   * @throws {TypeError} If the table does not support iteration.
   */
  private tableEntries(): IterableIterator<[number, V]> {
    const walk = this.table.entries;

    if (typeof walk !== "function") {
      throw new TypeError(
        "the underlying table does not support entries, so this map cannot " +
          "be iterated",
      );
    }

    return walk.call(this.table);
  }

  /**
   * Calls `callback` once per entry, with the key resolved back to its
   * string.
   *
   * Order is the table's, which is slot order and therefore unspecified —
   * not insertion order, and not the order keys were interned in. A key
   * built with {@link InternedSwissMap.setParts} comes back in its encoded
   * form, since that is the string that was interned.
   *
   * This is the allocation-free walk: it hands the callback the key string
   * the interner already holds rather than building a pair per entry.
   *
   * @param callback - Receives the value, the key, and this map — the
   *   argument order `Map.prototype.forEach` uses.
   * @param thisArg - Bound as `this` inside `callback`.
   * @throws {TypeError} If `callback` is not a function, or the underlying
   *   table does not support iteration.
   * @throws {Error} If the table holds an ID this map's interner cannot
   *   resolve, or if the table is rehashed mid-walk.
   */
  forEach(
    callback: (value: V, key: string, map: this) => void,
    thisArg?: unknown,
  ): void {
    asCallback(callback, "forEach");

    const walk = this.tableForEach();

    walk((value, id) => {
      callback.call(thisArg, value, this.keyOf(id), this);
    });
  }

  /**
   * Yields every key as the string it was interned from, in the same
   * unspecified order as {@link InternedSwissMap.forEach}.
   *
   * @throws {TypeError} If the underlying table does not support iteration.
   * @throws {Error} If the table holds an unresolvable ID, or is rehashed
   *   while the iterator is open.
   */
  *keys(): IterableIterator<string> {
    for (const [id] of this.tableEntries()) yield this.keyOf(id);
  }

  /**
   * Yields every value, in the same unspecified order as
   * {@link InternedSwissMap.forEach}.
   *
   * @throws {TypeError} If the underlying table does not support iteration.
   * @throws {Error} If the table is rehashed while the iterator is open.
   */
  *values(): IterableIterator<V> {
    for (const [, value] of this.tableEntries()) yield value;
  }

  /**
   * Yields every entry as a `[key, value]` pair, in the same unspecified
   * order as {@link InternedSwissMap.forEach}.
   *
   * Each pair is a fresh array, matching `Map`. Prefer
   * {@link InternedSwissMap.forEach} on a hot path.
   *
   * @throws {TypeError} If the underlying table does not support iteration.
   * @throws {Error} If the table holds an unresolvable ID, or is rehashed
   *   while the iterator is open.
   */
  *entries(): IterableIterator<[string, V]> {
    for (const [id, value] of this.tableEntries()) yield [this.keyOf(id), value];
  }

  /**
   * Yields every entry as a `[key, value]` pair, so the map works in
   * `for…of` and spreads. Same as {@link InternedSwissMap.entries}.
   */
  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries();
  }

  /**
   * Removes the entry under `id`, releasing the ID when recycling is on.
   *
   * The release is conditional on the table actually having held the entry.
   * A key that was interned but never stored, or already deleted, keeps its
   * ID: releasing it here would hand a live interned string's ID to another
   * key while `resolve` still answered for it.
   *
   * @param id - The key's ID, or undefined if it was never interned.
   * @returns `true` if an entry was removed.
   */
  private remove(id: number | undefined): boolean {
    if (id === undefined || !this.table.delete(id)) return false;

    if (this.interner.recyclesIds) this.interner.release(id);

    return true;
  }
}
