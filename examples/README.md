# Examples

Four programs, in reading order. `01` establishes the API, `02` covers the
batching that produces the largest margin over `Map`, `03` covers string keys
and their caveat, and `04` covers instance lifecycle and sizing.

Every example uses `create()`, which decodes the module compiled into the
package, so none of them needs a build first:

```bash
bun run examples/01-basic.ts
```

| Example | Shows |
| --- | --- |
| [`01-basic.ts`](01-basic.ts) | Creating a table, `set`/`get`/`has`/`delete`, u32 validation, capacity and `clear` |
| [`02-bulk.ts`](02-bulk.ts) | `setMany`/`getMany`/`deleteMany`, automatic chunking, spans |
| [`03-string-pool.ts`](03-string-pool.ts) | `InternedSwissMap`, composite keys, and interning once to stay numeric |
| [`04-multiple-tables.ts`](04-multiple-tables.ts) | One compiled module shared across several instances, `reserve`, the capacity ceiling |

The timings `02` prints are single-shot and include JIT warmup, so they run
several times slower than steady state. Use `bun run bench` for numbers worth
comparing, and see [`../docs/performance.md`](../docs/performance.md) for
where these tables win and where they do not.
