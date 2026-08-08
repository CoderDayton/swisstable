#!/usr/bin/env bun
/**
 * Smoke test for the built package under a real, headless browser.
 *
 * CI otherwise only exercises Node (`smoke-node.mjs`) and Bun (`bun test`),
 * so a Node-only API creeping into `src/` — a `node:` import, `Buffer`,
 * `process` — would ship silently even though the README advertises browser
 * support. This loads `dist/js/index.js` as an ordinary `<script type=module>`
 * in Chrome or Firefox, exactly as a consumer's bundler would, and runs the
 * same assertions `smoke-node.mjs` makes.
 *
 * Reuses the discovery, profile, and report-over-`Bun.serve` approach from
 * `benches/browser.ts` rather than a WebDriver client: the page reporting
 * its own result is the whole channel, and nothing needs installing.
 *
 * Run after `bun run build`, from the repository root:
 *
 *   bun run scripts/smoke-browser.ts [--browser=chrome|firefox]
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Where the page is served from. Port 0 lets the OS pick a free one. */
const HOST = "127.0.0.1";

/** A browser that never reports is a hang; fail the run instead. */
const RUN_TIMEOUT_MS = 60 * 1000;

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
      contents: [
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
}

function parseArgs(argv: readonly string[]): Options {
  let browser: BrowserName = "chrome";

  for (const arg of argv) {
    if (arg.startsWith("--browser=")) {
      const value = arg.slice("--browser=".length);
      if (value !== "chrome" && value !== "firefox") {
        throw new Error(`smoke: unknown browser "${value}" (chrome or firefox)`);
      }
      browser = value;
    } else {
      throw new Error(`smoke: unrecognized argument "${arg}"`);
    }
  }

  return { browser };
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
      const root = join(common, "smoke-profiles");
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
    `smoke: no ${spec.name} executable found (tried ${spec.executables.join(", ")})`,
  );
}

/**
 * The page. It imports the built entry point exactly as a consumer's
 * bundler would and runs the same assertions `smoke-node.mjs` makes against
 * the Node build, then POSTs the outcome back.
 *
 * A page that dies silently would look exactly like a page still working,
 * so both an explicit failure and an uncaught error are reported.
 */
function pageHtml(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>swisstable browser smoke</title>
<body>
<pre id="log">running…</pre>
<script>
  const report = (result) =>
    fetch("/result", { method: "POST", body: JSON.stringify(result) });
  addEventListener("error", (event) =>
    report({ ok: false, error: String(event.message) }));
  addEventListener("unhandledrejection", (event) =>
    report({ ok: false, error: String(event.reason) }));
</script>
<script type="module">
  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }
  function assertEqual(actual, expected, message) {
    assert(actual === expected, \`\${message} (got \${actual}, expected \${expected})\`);
  }
  function assertDeepEqual(actual, expected, message) {
    const a = JSON.stringify([...actual]);
    const e = JSON.stringify([...expected]);
    assert(a === e, \`\${message} (got \${a}, expected \${e})\`);
  }

  const { SwissU32ToU32, SwissU32ToU64, InternedSwissMap, supportsSimd } =
    await import("/dist/js/index.js");

  assert(supportsSimd(), "supportsSimd should report true in a headless browser");

  const u32 = await SwissU32ToU32.create(1024);
  u32.set(0xdead_beef, 42);
  assertEqual(u32.get(0xdead_beef), 42, "u32 get should return what set stored");
  assertEqual(u32.size, 1, "u32 size should count the one entry");
  assertEqual(u32.get(1), undefined, "u32 get should report an absent key");
  assertDeepEqual([...u32], [[0xdead_beef, 42]], "u32 should iterate its entry");

  const u64 = await SwissU32ToU64.create(1024);
  u64.setMany([1, 2, 3], [10, 20, 30], [0, 0, 1]);
  const { valsLo, valsHi, found } = u64.getMany([1, 3, 4]);
  assertDeepEqual(valsLo, [10, 30, 0], "u64 low lanes should round-trip");
  assertDeepEqual(valsHi, [0, 1, 0], "u64 high lanes should round-trip");
  assertDeepEqual(found, [1, 1, 0], "u64 should report the absent key");

  const map = new InternedSwissMap(await SwissU32ToU32.create(64));
  map.set("hello", 5);
  assertEqual(map.get("hello"), 5, "interned map should round-trip a string key");
  assertEqual(map.get("world"), undefined, "interned map should report a miss");

  document.getElementById("log").textContent = "ok";
  report({ ok: true });
</script>
</body>`;
}

/** Content type for a file under `dist/js`, so the module loads as one. */
function contentTypeFor(path: string): string {
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".map")) return "application/json";
  return "application/octet-stream";
}

const options = parseArgs(Bun.argv.slice(2));
const spec = BROWSERS[options.browser];
const executable = await locate(spec);

const distJsRoot = new URL("../dist/js/", import.meta.url);

/** What the page reported, or what stopped it from reporting at all. */
interface Outcome {
  readonly ok: boolean;
  readonly error?: string;
}

let settle: (value: Outcome) => void;
const finished = new Promise<Outcome>((resolve) => {
  settle = resolve;
});

const server = Bun.serve({
  hostname: HOST,
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/result") {
      const body = await request.text();
      try {
        settle(JSON.parse(body) as Outcome);
      } catch (cause) {
        settle({ ok: false, error: `unparseable result: ${body}` });
      }
      return new Response("ok");
    }

    if (url.pathname === "/") {
      return new Response(pageHtml(), {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (url.pathname.startsWith("/dist/js/")) {
      const relative = url.pathname.slice("/dist/js/".length);
      const file = Bun.file(new URL(relative, distJsRoot));
      if (!(await file.exists())) {
        return new Response("not found", { status: 404 });
      }
      return new Response(file, {
        headers: { "Content-Type": contentTypeFor(relative) },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

const pageUrl = `http://${HOST}:${server.port}/`;
const profileDirectory = await mkdtemp(
  join(await profileRoot(spec), "swisstable-smoke-"),
);

const profile = spec.profileFile();
if (profile !== null) {
  await writeFile(join(profileDirectory, profile.name), profile.contents);
}

console.error(`smoke: ${spec.name} → ${pageUrl}`);

const browser = Bun.spawn({
  cmd: [executable, ...spec.buildArgs(pageUrl, profileDirectory)],
  stdout: "ignore",
  stderr: "ignore",
});

const timeout = setTimeout(() => {
  settle({ ok: false, error: `no result after ${RUN_TIMEOUT_MS / 1000} seconds` });
}, RUN_TIMEOUT_MS);

// A browser that dies on launch — a missing shared library, a profile it
// cannot write — never reports, and waiting the full timeout for that hides
// the reason behind a generic one. The exit is only an error if it beats the
// page's own answer; a browser that reports and then quits is normal.
void browser.exited.then((code) => {
  settle({ ok: false, error: `${spec.name} exited with ${code} before reporting` });
});

let outcome: Outcome;
try {
  outcome = await finished;
} finally {
  clearTimeout(timeout);
  browser.kill();
  await browser.exited;
  server.stop(true);
  await rm(profileDirectory, { recursive: true, force: true });
}

if (!outcome.ok) {
  console.error(`smoke: ${spec.name} failed: ${outcome.error ?? "unknown error"}`);
  process.exit(1);
}

console.log(`smoke test passed on ${spec.name}`);
