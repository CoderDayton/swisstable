# Examples

Four programs, in reading order. `01` establishes the API, `02` covers the
batching that produces the largest margin over `Map`, `03` covers string keys
and their caveat, and `04` covers instance lifecycle and sizing.

Build the modules first — every example loads them from `dist/wasm/`:

```bash
bun run build
bun run examples/01-basic.ts
```

| Example | Shows |
| --- | --- |
| [`01-basic.ts`](01-basic.ts) | Loading a module, `set`/`get`/`has`/`delete`, u32 validation, capacity and `clear` |
| [`02-bulk.ts`](02-bulk.ts) | `setMany`/`getMany`/`deleteMany`, automatic chunking, spans |
| [`03-string-pool.ts`](03-string-pool.ts) | `InternedSwissMap`, composite keys, and interning once to stay numeric |
| [`04-multiple-tables.ts`](04-multiple-tables.ts) | One compiled module, several instances, `reserve`, the capacity ceiling |

The timings `02` prints are single-shot and include JIT warmup, so they run
several times slower than steady state. Use `bun run bench` for numbers worth
comparing, and see [`../docs/performance.md`](../docs/performance.md) for
where these tables win and where they do not.
