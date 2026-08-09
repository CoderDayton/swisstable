/**
 * The parts of the benchmark that differ between JavaScript runtimes.
 *
 * `bench.ts` is written against this interface and nothing else, so the same
 * scenarios produce the same measurements under Bun, Node, Deno, and a
 * browser page. Every runtime has to supply four things the harness cannot
 * do portably: a nanosecond clock, a way to read the WASM modules, a way to
 * run one contender in a fresh isolate, and somewhere to put the results.
 *
 * Isolation is the interesting one. On the server runtimes it is a child
 * process; in a browser it is a `Worker`, which likewise gets its own
 * global object and its own inline caches. Both give a contender an engine
 * that has never executed another contender's code — which is the property
 * the numbers depend on.
 */

/** Whether a value is a usable object, without tripping over `null`. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const globals = globalThis as Record<string, any>;

/** The engine underneath, which is what a cross-runtime table compares. */
export type Engine = "JavaScriptCore" | "V8" | "SpiderMonkey" | "unknown";

export type RuntimeName = "bun" | "node" | "deno" | "browser";

export interface HostInfo {
  /** Stable key for a results file and a table column. */
  readonly runtime: RuntimeName;
  /** What a reader should see: `Node 24.15.0`, `Chrome 141`. */
  readonly label: string;
  readonly engine: Engine;
  readonly os: string;
  readonly arch: string;
  readonly cpu: string;
  /**
   * Whether {@link Runtime.gc} actually collects. Node and Deno need a
   * flag, Firefox has no hook at all — and a runtime that cannot collect on
   * demand reports noisier mutation rows, so the table has to say which.
   */
  readonly gcAvailable: boolean;
  /**
   * Measured granularity of {@link Runtime.now}, in nanoseconds. Browsers
   * coarsen their clock deliberately; a round has to be long enough that
   * this does not matter, and the number is recorded so a reader can check
   * that it was.
   */
  readonly timerResolutionNs: number;
}

export interface Runtime {
  readonly host: HostInfo;
  /** Monotonic, in nanoseconds. */
  now(): number;
  /** Collects if the host allows it; otherwise does nothing. */
  gc(): void;
  /**
   * Bytes currently held by the JavaScript heap, or null where the host does
   * not report it. Meaningful only either side of a {@link gc}, and only on
   * a host that has one — which is why the memory scenario skips a browser
   * rather than publishing a number it cannot stand behind.
   */
  heapUsed(): number | null;
  /**
   * Resident bytes for the whole process, or null where unavailable.
   *
   * The only figure that covers a WASM table and a `Map` on the same terms:
   * linear memory is reserved outside the JavaScript heap, and is committed
   * page by page as it is touched rather than all at once when it is
   * reserved.
   */
  residentBytes(): number | null;
  /** Arguments after the script name, in `--flag=value` form. */
  argv(): readonly string[];
  /** Loads one of the compiled modules by file name. */
  readWasm(fileName: string): Promise<ArrayBuffer>;
  /**
   * Runs this benchmark's entry point again in a fresh isolate with `args`,
   * and returns the single line of JSON it emitted.
   */
  isolate(args: readonly string[]): Promise<string>;
  /** Hands one line back to whoever called {@link isolate}. */
  emit(line: string): void;
  /** Where a completed run's output goes: stdout, or back to the server. */
  publish(text: string): void | Promise<void>;
  /** Ends this isolate. A worker has no exit, so it just stops running. */
  finish(): void;
}

/** Marks the one line of an isolated run's output the parent wants. */
export const ISOLATED_RESULT = "#result ";

const WASM_DIRECTORY = "../dist/wasm/";

/**
 * Smallest non-zero gap the clock reports, sampled rather than assumed.
 *
 * Browsers round `performance.now()` to a fixed grid — 100 us in a plain
 * page, 5 us in a cross-origin-isolated one — and a benchmark that does not
 * know which grid it is on cannot say whether its rounds are long enough.
 */
function measureTimerResolution(now: () => number): number {
  let smallest = Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < 100; attempt++) {
    const start = now();
    let end = now();
    while (end === start) end = now();
    smallest = Math.min(smallest, end - start);
  }

  return smallest;
}

/**
 * A dynamic import the bundler must not follow.
 *
 * The browser build goes through `bun build`, which resolves every static
 * specifier it can see — including `node:fs/promises`, which would then
 * fail to bundle for a target that has no such module. Assembling the
 * specifier at run time keeps the node-only branches out of the browser
 * bundle entirely, since nothing in them is reachable there.
 */
function importNodeBuiltin(name: string): Promise<any> {
  const specifier = "node:" + name;
  return import(/* @vite-ignore */ specifier);
}

/** As {@link importNodeBuiltin}, for the modules only Bun provides. */
function importBunBuiltin(name: string): Promise<any> {
  const specifier = "bun:" + name;
  return import(/* @vite-ignore */ specifier);
}

/** `Chrome 141`, from the user-agent, falling back to the whole string. */
function browserLabel(): { label: string; engine: Engine } {
  const agent = globals.navigator?.userAgent ?? "";

  const firefox = /Firefox\/(\d+)/.exec(agent);
  if (firefox) return { label: `Firefox ${firefox[1]}`, engine: "SpiderMonkey" };

  const edge = /Edg\/(\d+)/.exec(agent);
  if (edge) return { label: `Edge ${edge[1]}`, engine: "V8" };

  const chrome = /Chrome\/(\d+)/.exec(agent);
  if (chrome) return { label: `Chrome ${chrome[1]}`, engine: "V8" };

  const safari = /Version\/(\d+[\d.]*).*Safari/.exec(agent);
  if (safari) return { label: `Safari ${safari[1]}`, engine: "JavaScriptCore" };

  return { label: agent || "unknown browser", engine: "unknown" };
}

/**
 * A worker's arguments, carried on the URL it was constructed with.
 *
 * A worker has no argv, and its script URL is the only channel that is
 * readable before the first message arrives — which matters because the
 * benchmark decides what to build during module evaluation.
 */
function workerArgv(): readonly string[] {
  const encoded = new URL(import.meta.url).searchParams.get("args");
  return encoded === null ? [] : (JSON.parse(encoded) as string[]);
}

async function createBrowserRuntime(): Promise<Runtime> {
  const isWorker = typeof globals.WorkerGlobalScope !== "undefined";
  const now = (): number => performance.now() * 1e6;

  // The page passes its own query string on to every worker it spawns, so a
  // worker inherits `--scenario` and adds only its `--isolate`.
  const pageArgs = isWorker
    ? []
    : new URL(globals.location.href).searchParams.getAll("arg");

  const { label, engine } = browserLabel();

  const host: HostInfo = {
    runtime: "browser",
    label,
    engine,
    os: globals.navigator?.platform ?? "unknown",
    arch: globals.navigator?.userAgentData?.architecture ?? "unknown",
    cpu: `${globals.navigator?.hardwareConcurrency ?? "?"} logical cores`,
    gcAvailable: typeof globals.gc === "function",
    timerResolutionNs: measureTimerResolution(now),
  };

  return {
    host,
    now,
    gc: () => {
      globals.gc?.();
    },
    // A page cannot read its heap synchronously, and the async API it does
    // have reports the whole agent cluster rather than one container.
    heapUsed: () => null,
    residentBytes: () => null,
    argv: () => (isWorker ? workerArgv() : pageArgs),
    readWasm: async (fileName) => {
      const response = await fetch(`/dist/wasm/${fileName}`);
      if (!response.ok) throw new Error(`bench: GET ${fileName} ${response.status}`);
      return response.arrayBuffer();
    },
    isolate: (args) =>
      new Promise<string>((resolve, reject) => {
        // The worker runs this same bundle. Its arguments ride on the URL
        // because module evaluation starts before any message could arrive.
        const url = new URL(import.meta.url);
        url.searchParams.set("args", JSON.stringify([...args]));

        const worker = new Worker(url.href, { type: "module" });

        worker.addEventListener("message", (event: MessageEvent) => {
          worker.terminate();

          // Symmetry with the server runtimes, which pick their one line out
          // of a child's stdout: the marker is part of the line either way,
          // and the caller is handed JSON.
          const line = String(event.data);
          resolve(
            line.startsWith(ISOLATED_RESULT)
              ? line.slice(ISOLATED_RESULT.length)
              : line,
          );
        });

        worker.addEventListener("error", (event: ErrorEvent) => {
          worker.terminate();
          reject(new Error(`bench: worker failed: ${event.message}`));
        });
      }),
    emit: (line) => {
      globals.postMessage(line);
    },
    publish: async (text) => {
      // The launcher is waiting on this POST; it is how a headless browser
      // hands results back and how the launcher knows the run finished.
      await fetch("/results", { method: "POST", body: text });
    },
    finish: () => {
      /* A worker stops when the page terminates it. */
    },
  };
}

/**
 * The absolute path of the benchmark entry point, for re-execution.
 *
 * Async because it resolves `fileURLToPath` the way everything else here
 * reaches a node builtin — through {@link importNodeBuiltin}, so the browser
 * bundle never carries a specifier its target cannot resolve. `.pathname`
 * would need no import, but on Windows it keeps the URL's leading slash and
 * `/D:/...` is not a path any process can open.
 */
async function entryPath(): Promise<string> {
  const { fileURLToPath } = await importNodeBuiltin("url");
  return fileURLToPath(new URL("./bench.ts", import.meta.url)) as string;
}

/**
 * Runs `command` to completion and returns its stdout, or throws with
 * whatever it wrote to stderr — the only way an isolated failure is
 * debuggable from the parent.
 */
async function runChild(command: readonly string[]): Promise<string> {
  if (globals.Bun !== undefined) {
    const child = globals.Bun.spawn({
      cmd: [...command],
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if ((await child.exited) !== 0) {
      throw new Error(`bench: ${command.join(" ")} failed\n${stderr}`);
    }

    return stdout;
  }

  if (globals.Deno !== undefined) {
    const child = new globals.Deno.Command(command[0], {
      args: command.slice(1),
      stdout: "piped",
      stderr: "piped",
    });

    const output = await child.output();
    const decoder = new TextDecoder();

    if (!output.success) {
      throw new Error(
        `bench: ${command.join(" ")} failed\n${decoder.decode(output.stderr)}`,
      );
    }

    return decoder.decode(output.stdout);
  }

  const { execFile } = await importNodeBuiltin("child_process");
  const { promisify } = await importNodeBuiltin("util");

  try {
    const { stdout } = await promisify(execFile)(command[0], command.slice(1), {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout as string;
  } catch (cause) {
    const stderr = isObject(cause) ? cause.stderr : "";
    throw new Error(`bench: ${command.join(" ")} failed\n${String(stderr)}`);
  }
}

async function createBunRuntime(): Promise<Runtime> {
  const Bun = globals.Bun;
  const now = (): number => Bun.nanoseconds();

  // Bun's process.memoryUsage().heapUsed does not track JavaScriptCore's
  // heap — it answers with the same figure before and after a container is
  // built, which would report every container as free. bun:jsc reports the
  // collector's own accounting.
  const { heapStats } = await importBunBuiltin("jsc");

  const host: HostInfo = {
    runtime: "bun",
    label: `Bun ${Bun.version}`,
    engine: "JavaScriptCore",
    os: process.platform,
    arch: process.arch,
    cpu: await cpuModel(),
    gcAvailable: true,
    timerResolutionNs: measureTimerResolution(now),
  };

  return {
    host,
    now,
    gc: () => Bun.gc(true),
    heapUsed: () => heapStats().heapSize,
    residentBytes: () => process.memoryUsage().rss,
    argv: () => Bun.argv.slice(2),
    readWasm: (fileName) =>
      Bun.file(new URL(WASM_DIRECTORY + fileName, import.meta.url)).arrayBuffer(),
    isolate: async (args) =>
      childResult([process.execPath, await entryPath(), ...args]),
    emit: (line) => console.log(line),
    publish: (text) => console.log(text),
    finish: () => process.exit(0),
  };
}

async function createNodeRuntime(): Promise<Runtime> {
  const { hrtime, execPath, argv, platform, arch, exit } = globals.process;
  const now = (): number => Number(hrtime.bigint());

  const host: HostInfo = {
    runtime: "node",
    label: `Node ${globals.process.versions.node}`,
    engine: "V8",
    os: platform,
    arch,
    cpu: await cpuModel(),
    gcAvailable: typeof globals.gc === "function",
    timerResolutionNs: measureTimerResolution(now),
  };

  const { fileURLToPath } = await importNodeBuiltin("url");
  const { readFile } = await importNodeBuiltin("fs/promises");

  return {
    host,
    now,
    gc: () => {
      globals.gc?.();
    },
    heapUsed: () => globals.process.memoryUsage().heapUsed,
    residentBytes: () => globals.process.memoryUsage().rss,
    argv: () => argv.slice(2),
    readWasm: async (fileName) => {
      const path = fileURLToPath(new URL(WASM_DIRECTORY + fileName, import.meta.url));
      const buffer = await readFile(path);
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      );
    },
    // The child needs the same flags this process was given, or it would
    // measure with a collector it cannot trigger and strip types with a
    // warning on stdout.
    isolate: async (args) =>
      childResult([
        execPath,
        "--expose-gc",
        "--disable-warning=ExperimentalWarning",
        await entryPath(),
        ...args,
      ]),
    emit: (line) => console.log(line),
    publish: (text) => console.log(text),
    finish: () => exit(0),
  };
}

async function createDenoRuntime(): Promise<Runtime> {
  const Deno = globals.Deno;
  const now = (): number => performance.now() * 1e6;

  const host: HostInfo = {
    runtime: "deno",
    label: `Deno ${Deno.version.deno}`,
    engine: "V8",
    os: Deno.build.os,
    arch: Deno.build.arch,
    cpu: await cpuModel(),
    gcAvailable: typeof globals.gc === "function",
    timerResolutionNs: measureTimerResolution(now),
  };

  return {
    host,
    now,
    gc: () => {
      globals.gc?.();
    },
    heapUsed: () => Deno.memoryUsage().heapUsed,
    residentBytes: () => Deno.memoryUsage().rss,
    argv: () => Deno.args,
    readWasm: async (fileName) => {
      const url = new URL(WASM_DIRECTORY + fileName, import.meta.url);
      const bytes = await Deno.readFile(url);
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
    isolate: async (args) =>
      childResult([
        Deno.execPath(),
        "run",
        "--quiet",
        "--allow-read",
        "--allow-run",
        "--v8-flags=--expose-gc",
        await entryPath(),
        ...args,
      ]),
    emit: (line) => console.log(line),
    publish: (text) => console.log(text),
    finish: () => Deno.exit(0),
  };
}

/** Runs a child and pulls the one line it was spawned to produce. */
async function childResult(command: readonly string[]): Promise<string> {
  const stdout = await runChild(command);

  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(ISOLATED_RESULT));

  if (line === undefined) {
    throw new Error(`bench: ${command.join(" ")} produced no result\n${stdout}`);
  }

  return line.slice(ISOLATED_RESULT.length);
}

/**
 * The CPU the numbers came from, which is most of what makes a result
 * comparable to somebody else's.
 */
async function cpuModel(): Promise<string> {
  try {
    const { cpus } = await importNodeBuiltin("os");
    const all = cpus();
    return `${all[0]?.model ?? "unknown"} (${all.length} logical cores)`;
  } catch {
    return "unknown";
  }
}

function detect(): RuntimeName {
  if (globals.Bun !== undefined) return "bun";
  if (globals.Deno !== undefined) return "deno";
  if (globals.process?.versions?.node !== undefined) return "node";
  return "browser";
}

const factories: Record<RuntimeName, () => Promise<Runtime>> = {
  bun: createBunRuntime,
  node: createNodeRuntime,
  deno: createDenoRuntime,
  browser: createBrowserRuntime,
};

/** The adapter for whichever runtime is executing this module. */
export const runtime: Runtime = await factories[detect()]();
