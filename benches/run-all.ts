#!/usr/bin/env bun
/**
 * Runs the benchmark under every runtime on this machine, one after another.
 *
 * Strictly one at a time. Two runtimes benchmarking at once would compete
 * for the same cores and cache and the results would say more about the
 * scheduler than about either container.
 *
 * The whole sweep repeats, and `compare.ts` reduces the repeats by median.
 * A single pass is not stable enough to publish: within one pass every
 * contender already reports the median of its own rounds, but a whole pass
 * can still land somewhere unrepresentative — a browser fill measured 15.4
 * ns in one pass and 10.0 ns in the next. What varies across a pass is the
 * machine, not the container, and a median across passes is what removes it.
 *
 * Each pass writes `benches/results/<runtime>.<pass>.json`.
 *
 * Usage: bun run benches/run-all.ts [--runtime=name,...] [--scenario=name,...]
 *                                   [--repeat=n]
 */

import { mkdir, writeFile } from "node:fs/promises";

/**
 * What the browsers run.
 *
 * Every row the README and the comparison table publish, and nothing else:
 * a browser pass isolates each contender in a worker, and the scenarios
 * left out here are the ones whose numbers are about the library's internals
 * rather than about how it compares to `Map`.
 */
const BROWSER_SCENARIOS =
  "fill,lookup,has,overwrite,delete,churn,bulk,string-keys,iteration,scale-sweep";

/** Passes over the whole field, reduced by median in `compare.ts`. */
const DEFAULT_REPEATS = 3;

interface RuntimeRun {
  readonly name: string;
  /** Built at run time so a missing runtime can be reported, not crash. */
  command(scenarios: string | null, output: string): readonly string[];
  /** Where the JSON lands; a browser run writes the file itself. */
  readonly writesOwnOutput: boolean;
}

const benchEntry = new URL("./bench.ts", import.meta.url).pathname;
const browserEntry = new URL("./browser.ts", import.meta.url).pathname;
const resultsDirectory = new URL("./results/", import.meta.url).pathname;

function scenarioFlag(scenarios: string | null): string[] {
  return scenarios === null ? [] : [`--scenario=${scenarios}`];
}

const RUNS: readonly RuntimeRun[] = [
  {
    name: "bun",
    command: (scenarios) => [
      "bun",
      benchEntry,
      "--json",
      ...scenarioFlag(scenarios),
    ],
    writesOwnOutput: false,
  },
  {
    name: "node",
    command: (scenarios) => [
      "node",
      // The harness collects between warmup and measured rounds; without
      // this the run silently skips that and reports noisier mutation rows.
      "--expose-gc",
      "--disable-warning=ExperimentalWarning",
      benchEntry,
      "--json",
      ...scenarioFlag(scenarios),
    ],
    writesOwnOutput: false,
  },
  {
    name: "deno",
    command: (scenarios) => [
      "deno",
      "run",
      "--quiet",
      "--allow-read",
      "--allow-run",
      "--v8-flags=--expose-gc",
      benchEntry,
      "--json",
      ...scenarioFlag(scenarios),
    ],
    writesOwnOutput: false,
  },
  {
    name: "chrome",
    command: (scenarios, output) => [
      "bun",
      browserEntry,
      "--browser=chrome",
      `--scenario=${scenarios ?? BROWSER_SCENARIOS}`,
      `--out=${output}`,
    ],
    writesOwnOutput: true,
  },
  {
    name: "firefox",
    command: (scenarios, output) => [
      "bun",
      browserEntry,
      "--browser=firefox",
      `--scenario=${scenarios ?? BROWSER_SCENARIOS}`,
      `--out=${output}`,
    ],
    writesOwnOutput: true,
  },
];

interface Options {
  readonly runtimes: ReadonlySet<string> | null;
  readonly scenarios: string | null;
  readonly repeats: number;
}

function parseArgs(argv: readonly string[]): Options {
  let runtimes: Set<string> | null = null;
  let scenarios: string | null = null;
  let repeats = DEFAULT_REPEATS;

  for (const arg of argv) {
    if (arg.startsWith("--runtime=")) {
      runtimes = new Set(arg.slice("--runtime=".length).split(","));
    } else if (arg.startsWith("--scenario=")) {
      scenarios = arg.slice("--scenario=".length);
    } else if (arg.startsWith("--repeat=")) {
      repeats = Number(arg.slice("--repeat=".length));
      if (!Number.isInteger(repeats) || repeats < 1) {
        throw new Error(`bench: --repeat expects a positive integer`);
      }
    } else {
      throw new Error(`bench: unrecognized argument "${arg}"`);
    }
  }

  return { runtimes, scenarios, repeats };
}

const options = parseArgs(Bun.argv.slice(2));
await mkdir(resultsDirectory, { recursive: true });

const failures: string[] = [];

// Pass by pass rather than runtime by runtime, so a machine that warms up or
// throttles part way through spreads that across every column instead of
// charging it to whichever runtime happened to run then.
for (let pass = 1; pass <= options.repeats; pass++) {
  for (const run of RUNS) {
    if (options.runtimes !== null && !options.runtimes.has(run.name)) continue;

    const output = `${resultsDirectory}${run.name}.${pass}.json`;
    const command = run.command(options.scenarios, output);
    const started = Date.now();
    console.log(`\n=== ${run.name} (pass ${pass}/${options.repeats}) ===`);

    const child = Bun.spawn({
      cmd: [...command],
      stdout: run.writesOwnOutput ? "inherit" : "pipe",
      stderr: "inherit",
    });

    const stdout = run.writesOwnOutput
      ? ""
      : await new Response(child.stdout).text();

    if ((await child.exited) !== 0) {
      failures.push(`${run.name} pass ${pass}`);
      console.error(`${run.name}: failed`);
      continue;
    }

    if (!run.writesOwnOutput) {
      await writeFile(output, stdout);
    }

    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`${run.name}: done in ${minutes} min`);
  }
}

if (failures.length > 0) {
  console.error(`\nbench: ${failures.join(", ")} did not produce results`);
  process.exit(1);
}
