#!/usr/bin/env bun
/**
 * Runs the benchmark inside a real browser and brings the results back.
 *
 * A page cannot spawn a process, so the browser column would otherwise have
 * to give up the isolation the other runtimes get. It does not: each
 * contender runs in a fresh `Worker`, which has its own global object and
 * its own inline caches, and is what a child process is for a page.
 *
 * This script builds the browser bundle, serves it beside the compiled WASM
 * modules, launches the browser at it, and waits for the page to POST its
 * results back. Nothing is installed and no driver protocol is involved —
 * the page reporting its own results is the whole channel.
 *
 * Usage: bun run benches/browser.ts [--browser=chrome|firefox]
 *                                   [--scenario=name,...] [--out=path]
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Where the page is served from. Port 0 lets the OS pick a free one. */
const HOST = "127.0.0.1";

/** A browser that never reports is a hang; fail the run instead. */
const RUN_TIMEOUT_MS = 45 * 60 * 1000;

type BrowserName = "chrome" | "firefox";

interface BrowserSpec {
  readonly name: BrowserName;
  /** Candidate executables, first one found wins. */
  readonly executables: readonly string[];
  /** Snap package names to check for, in {@link profileRoot}. */
  readonly snapNames: readonly string[];
  /** Flags that put it in headless mode pointed at `url`. */
  buildArgs(url: string, profileDirectory: string): string[];
  /**
   * Written into a fresh profile before launch, or null when the browser
   * takes everything on the command line.
   */
  profileFile(): { name: string; contents: string } | null;
}

const BROWSERS: Record<BrowserName, BrowserSpec> = {
  chrome: {
    name: "chrome",
    executables: [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ],
    snapNames: ["chromium"],
    buildArgs: (url, profileDirectory) => [
      "--headless=new",
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      // A backgrounded headless page gets its timers throttled, which would
      // land inside timed regions as multi-millisecond stalls.
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      // The harness collects between the warmup and measured rounds on
      // every other runtime; without this the browser column would be the
      // only one charging a contender for the harness's own garbage.
      "--js-flags=--expose-gc",
      url,
    ],
    profileFile: () => null,
  },
  firefox: {
    name: "firefox",
    executables: ["firefox"],
    snapNames: ["firefox"],
    buildArgs: (url, profileDirectory) => [
      "--headless",
      "--profile",
      profileDirectory,
      url,
    ],
    profileFile: () => ({
      name: "user.js",
      // Firefox rounds performance.now() to 1 ms by default, which is a
      // sixth of a measured round — the clock would decide the result. The
      // page is served cross-origin isolated, but that alone does not lift
      // the clamp, so the benchmarking profile turns it off explicitly.
      contents: [
        'user_pref("privacy.reduceTimerPrecision", false);',
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("datareporting.policy.firstRunURL", "");',
        'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
      ].join("\n"),
    }),
  },
};

interface Options {
  readonly browser: BrowserName;
  readonly scenarios: string | null;
  readonly out: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  let browser: BrowserName = "chrome";
  let scenarios: string | null = null;
  let out: string | null = null;

  for (const arg of argv) {
    if (arg.startsWith("--browser=")) {
      const value = arg.slice("--browser=".length);
      if (value !== "chrome" && value !== "firefox") {
        throw new Error(`bench: unknown browser "${value}" (chrome or firefox)`);
      }
      browser = value;
    } else if (arg.startsWith("--scenario=")) {
      scenarios = arg.slice("--scenario=".length);
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else {
      throw new Error(`bench: unrecognized argument "${arg}"`);
    }
  }

  return { browser, scenarios, out };
}

/**
 * Where a fresh profile can be created for `spec`.
 *
 * A snap-packaged browser runs in its own mount namespace with a private
 * `/tmp`, so a profile made with `mkdtemp` there is simply not present when
 * the browser looks — it starts and then waits forever. Snaps can always
 * read their own `~/snap/<name>/common`, so that is where their profiles
 * go; everything else uses the system temp directory.
 */
async function profileRoot(spec: BrowserSpec): Promise<string> {
  for (const snap of spec.snapNames) {
    const common = join(homedir(), "snap", snap, "common");

    const exists = await stat(common)
      .then((entry) => entry.isDirectory())
      .catch(() => false);

    if (exists) {
      const root = join(common, "bench-profiles");
      await mkdir(root, { recursive: true });
      return root;
    }
  }

  return tmpdir();
}

/** The first candidate executable that exists on PATH. */
async function locate(spec: BrowserSpec): Promise<string> {
  for (const candidate of spec.executables) {
    const which = Bun.spawn({
      cmd: ["which", candidate],
      stdout: "pipe",
      stderr: "ignore",
    });

    if ((await which.exited) === 0) {
      return (await new Response(which.stdout).text()).trim();
    }
  }

  throw new Error(
    `bench: no ${spec.name} executable found (tried ${spec.executables.join(", ")})`,
  );
}

/**
 * The page, which exists only to load the bundle and to make a failure
 * visible. Everything else happens in `bench.ts`.
 *
 * The benchmark's own arguments ride on the page URL rather than on this
 * markup: `bench.ts` reads them during module evaluation, before any
 * message could reach it.
 */
function pageHtml(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>swisstable bench</title>
<body>
<pre id="log">running…</pre>
<script>
  // A page that dies silently would look exactly like a page still working,
  // so anything thrown is reported back and ends the run.
  const fail = (what) =>
    fetch("/error", { method: "POST", body: String(what) });
  addEventListener("error", (event) => fail(event.message));
  addEventListener("unhandledrejection", (event) => fail(event.reason));
</script>
<script type="module" src="/bench.js"></script>
</body>`;
}

/**
 * Builds the browser bundle.
 *
 * The same `bench.ts` the server runtimes execute directly; only the module
 * loader differs, so a browser row measures the same code as every other
 * row.
 */
async function buildBundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [new URL("./bench.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    // The page and its workers load the same file; a minified bundle would
    // measure the bundler's inlining decisions rather than the library's.
    minify: false,
  });

  if (!built.success) {
    throw new Error(
      `bench: browser bundle failed\n${built.logs.map(String).join("\n")}`,
    );
  }

  return built.outputs[0]!.text();
}

const options = parseArgs(Bun.argv.slice(2));
const spec = BROWSERS[options.browser];
const executable = await locate(spec);
const bundle = await buildBundle();

const wasmDirectory = new URL("../dist/wasm/", import.meta.url);
const pageArgs = ["--json", ...(options.scenarios === null ? [] : [`--scenario=${options.scenarios}`])];

let settle: (value: { ok: true; body: string } | { ok: false; body: string }) => void;
const finished = new Promise<{ ok: boolean; body: string }>((resolve) => {
  settle = resolve;
});

const server = Bun.serve({
  hostname: HOST,
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);

    // Cross-origin isolation buys the page a 5 us clock instead of a 100 us
    // one. Rounds are milliseconds long either way, but the harness records
    // the resolution it measured and this is what makes that number good.
    const isolation = {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    };

    if (url.pathname === "/results") {
      settle({ ok: true, body: await request.text() });
      return new Response("ok", { headers: isolation });
    }

    if (url.pathname === "/error") {
      settle({ ok: false, body: await request.text() });
      return new Response("ok", { headers: isolation });
    }

    if (url.pathname === "/bench.js") {
      return new Response(bundle, {
        headers: { ...isolation, "Content-Type": "text/javascript" },
      });
    }

    if (url.pathname.startsWith("/dist/wasm/")) {
      const file = Bun.file(new URL(url.pathname.slice("/dist/wasm/".length), wasmDirectory));
      return new Response(file, {
        headers: { ...isolation, "Content-Type": "application/wasm" },
      });
    }

    if (url.pathname === "/") {
      return new Response(pageHtml(), {
        headers: { ...isolation, "Content-Type": "text/html" },
      });
    }

    return new Response("not found", { status: 404, headers: isolation });
  },
});

const query = pageArgs.map((arg) => `arg=${encodeURIComponent(arg)}`).join("&");
const pageUrl = `http://${HOST}:${server.port}/?${query}`;
const profileDirectory = await mkdtemp(
  join(await profileRoot(spec), "swisstable-bench-"),
);

const profile = spec.profileFile();
if (profile !== null) {
  await writeFile(join(profileDirectory, profile.name), profile.contents);
}

console.error(`bench: ${spec.name} → ${pageUrl}`);

const browser = Bun.spawn({
  cmd: [executable, ...spec.buildArgs(pageUrl, profileDirectory)],
  stdout: "ignore",
  stderr: "ignore",
});

const timeout = setTimeout(() => {
  settle({ ok: false, body: `no results after ${RUN_TIMEOUT_MS / 60000} minutes` });
}, RUN_TIMEOUT_MS);

const result = await finished;

clearTimeout(timeout);
browser.kill();
await browser.exited;
server.stop(true);
await rm(profileDirectory, { recursive: true, force: true });

if (!result.ok) {
  console.error(`bench: ${spec.name} run failed: ${result.body}`);
  process.exit(1);
}

if (options.out === null) {
  console.log(result.body);
} else {
  await writeFile(options.out, result.body);
  console.error(`bench: wrote ${options.out}`);
}
