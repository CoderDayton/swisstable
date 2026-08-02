import { asString } from "./abi.ts";

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
}

/**
 * Assigns stable unsigned 32-bit IDs to exact strings.
 *
 * IDs are handed out in first-seen order starting at 0 — 0 is a valid,
 * assignable ID — and remain stable for the lifetime of the instance. This
 * is the bridge between string-keyed data (tokenizer vocabularies, cache
 * namespaces, structured cache keys) and a u32-keyed SwissTable.
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
  /** Forward index, string to assigned ID. */
  private readonly stringToId = new Map<string, number>();

  /** Reverse index; an ID is its position in this array. */
  private readonly idToString: string[] = [];

  /** Number of distinct strings interned so far. */
  get size(): number {
    return this.idToString.length;
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

    const id = this.idToString.length;

    if (id > 0xffff_ffff) {
      throw new RangeError("StringInterner exhausted the u32 ID space");
    }

    this.stringToId.set(text, id);
    this.idToString.push(text);

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
   * can avoid leaking the ID — see {@link InternedSwissMap.set}. It is
   * deliberately limited to the last ID: releasing an arbitrary one would
   * either leave a hole in the ID space or renumber the IDs that follow,
   * and stable IDs are the point of the class.
   *
   * @param id - The ID to release, which must be the most recent one.
   * @returns `true` if it was released, `false` if `id` was not the last
   *   assigned ID, in which case nothing changed.
   */
  forgetLast(id: number): boolean {
    if (id !== this.idToString.length - 1) return false;

    const text = this.idToString.pop()!;
    this.stringToId.delete(text);

    return true;
  }

  /**
   * Returns the string an ID was assigned to.
   *
   * @param id - ID previously returned by {@link StringInterner.intern}.
   * @returns The original string, or `undefined` if `id` was never assigned.
   */
  resolve(id: number): string | undefined {
    if (!Number.isInteger(id) || id < 0 || id >= this.idToString.length) {
      return undefined;
    }
    return this.idToString[id];
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

    this.table = table;
    this.interner = interner;
  }

  /**
   * Number of live entries.
   *
   * This is the table's count, not the interner's: an interned string whose
   * entry was deleted, or that was never written, does not count. IDs are
   * never reclaimed, so {@link StringInterner.size} can be larger and is the
   * number to watch for unbounded growth in a long-lived map.
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
   * Removes `key`. The key keeps its interned ID, so re-inserting it later
   * reuses the same ID.
   *
   * @returns `true` if the key was present.
   */
  delete(key: string): boolean {
    const id = this.interner.lookup(key);
    return id !== undefined && this.table.delete(id);
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
    const id = this.interner.lookupParts(parts);
    return id !== undefined && this.table.delete(id);
  }
}
