#!/usr/bin/env bun
/**
 * Resolves the Zig toolchain that compiles the wasm modules.
 *
 * The payload committed in src/generated is compiler output, so the compiler
 * is part of the source: two different builds need not agree byte for byte,
 * and the drift gate in CI would then blame native/*.c for a change in the
 * toolchain. Zig ships as a single hermetic archive carrying its own clang,
 * lld, and headers, so pinning one release pins the bytes on every host —
 * which a distro package cannot do, since it links against whatever system
 * LLVM the image happens to carry.
 *
 * Run directly to install the toolchain and print its path:
 *
 *     bun run toolchain
 */

import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** Where downloaded toolchains are unpacked. Ignored by git. */
const TOOLCHAIN_DIR = join(ROOT, ".zig");

/**
 * The pinned release. Bumping it changes the compiled output, so it comes
 * with a rebuilt src/generated in the same commit or CI's drift gate fails.
 */
export const ZIG_VERSION = "0.16.0";

interface Release {
  /** File name under https://ziglang.org/download/<version>/. */
  readonly archive: string;
  /** SHA-256 from that release's entry in ziglang.org/download/index.json. */
  readonly sha256: string;
}

/**
 * Hosts a build can run on, keyed by `<platform>-<arch>` as Node reports
 * them. Zig publishes more targets than this; these are the ones CI and a
 * development machine actually use. Building on anything else works by
 * pointing ZIG at a matching toolchain.
 */
const RELEASES: Readonly<Record<string, Release>> = {
  "linux-x64": {
    archive: `zig-x86_64-linux-${ZIG_VERSION}.tar.xz`,
    sha256: "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00",
  },
  "linux-arm64": {
    archive: `zig-aarch64-linux-${ZIG_VERSION}.tar.xz`,
    sha256: "ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17",
  },
  "darwin-x64": {
    archive: `zig-x86_64-macos-${ZIG_VERSION}.tar.xz`,
    sha256: "0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7",
  },
  "darwin-arm64": {
    archive: `zig-aarch64-macos-${ZIG_VERSION}.tar.xz`,
    sha256: "b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489",
  },
  "win32-x64": {
    archive: `zig-x86_64-windows-${ZIG_VERSION}.zip`,
    sha256: "68659eb5f1e4eb1437a722f1dd889c5a322c9954607f5edcf337bc3684a75a7e",
  },
  "win32-arm64": {
    archive: `zig-aarch64-windows-${ZIG_VERSION}.zip`,
    sha256: "aee38316ee4111717900f45dd3130145c39289e105541d737eb8c5ed653c78ef",
  },
};

const DOWNLOAD_BASE = `https://ziglang.org/download/${ZIG_VERSION}`;
const MIB = 1024 * 1024;

/** Executable bit for the unpacked binary, which the archive does not set. */
const EXECUTABLE_MODE = 0o755;

function hostKey(): string {
  return `${process.platform}-${process.arch}`;
}

function release(): Release {
  const key = hostKey();
  const found = RELEASES[key];
  if (found !== undefined) return found;

  throw new Error(
    `no pinned Zig ${ZIG_VERSION} build for ${key}; ` +
      `supported hosts are ${Object.keys(RELEASES).join(", ")}. ` +
      `Install Zig ${ZIG_VERSION} yourself and set ZIG to its path.`,
  );
}

function executableName(): string {
  return process.platform === "win32" ? "zig.exe" : "zig";
}

/** Directory the archive unpacks into, which matches its base name. */
function extractedName(archive: string): string {
  return archive.replace(/\.(tar\.xz|zip)$/, "");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the version a Zig executable reports, or null if it cannot be run.
 * A toolchain on PATH is frequently a different release, so this is asked
 * before trusting one rather than after a confusing build failure.
 */
function reportedVersion(executable: string): string | null {
  let result;
  try {
    result = Bun.spawnSync([executable, "version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return null;
  }

  if (result.exitCode !== 0) return null;
  return result.stdout.toString().trim();
}

/** SHA-256 of a file, streamed so a 50 MiB archive is not held in memory. */
async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/**
 * Downloads the pinned archive. Verification is a separate step that runs
 * against the file on disk whether it arrived just now or was left by an
 * earlier install, because a truncated cached archive is exactly as unsafe
 * as a truncated download and far easier to end up with.
 */
async function download(target: Release, destination: string): Promise<void> {
  const url = `${DOWNLOAD_BASE}/${target.archive}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    throw new Error(
      `could not reach ${url}. Set ZIG to a local Zig ${ZIG_VERSION} ` +
        `to build without network access.`,
      { cause },
    );
  }

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }
  if (response.body === null) {
    throw new Error(`${url} returned an empty body`);
  }

  console.log(`fetching ${target.archive}`);

  // Written under a scratch name and renamed only once the body is complete,
  // so an interrupted transfer cannot be mistaken for a cached archive.
  const partial = `${destination}.part`;
  const sink = Bun.file(partial).writer();

  try {
    for await (const chunk of response.body) sink.write(chunk);
    await sink.end();
  } catch (cause) {
    await Promise.resolve(sink.end()).catch(() => {});
    await rm(partial, { force: true });
    throw new Error(`download of ${target.archive} failed`, { cause });
  }

  await rename(partial, destination);
}

/**
 * Checks an archive against its published hash. This is the only thing
 * standing between the build and whatever landed on disk, so a mismatch
 * deletes the file and stops rather than reporting a warning.
 */
async function verify(target: Release, archive: string): Promise<void> {
  const digest = await sha256(archive);
  if (digest === target.sha256) return;

  await rm(archive, { force: true });
  throw new Error(
    `${target.archive} does not match its published checksum.\n` +
      `  expected ${target.sha256}\n` +
      `  received ${digest}\n` +
      `The file has been removed. Treat this as a compromised or corrupt ` +
      `download, not a flaky one, and rerun to fetch it again.`,
  );
}

/**
 * The `tar` that can read the archive for this host.
 *
 * Every host but Windows gets a `tar` that detects xz, and PATH is the right
 * way to find it. Windows is the exception twice over: the download there is
 * a zip, which only bsdtar reads, and the first `tar` on PATH under the
 * git-bash shell CI runs is GNU tar, which reads no zip at all. Windows
 * ships bsdtar at a fixed location under System32, so naming it outright is
 * what makes the format work.
 */
function tarBinary(): string {
  if (process.platform !== "win32") return "tar";

  return join(Bun.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

/**
 * Unpacks into a scratch directory and moves the result into place, so an
 * interrupted extraction never leaves a half-populated toolchain that the
 * next build would pick up and use.
 */
async function extract(archive: string, into: string): Promise<void> {
  const staging = `${into}.incoming`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  // Named without its directory, from that directory. An absolute Windows
  // path opens with a drive letter, which tar reads as the `host:path` of a
  // remote archive and refuses to resolve before it ever opens the file.
  const result = Bun.spawnSync(
    [tarBinary(), "-xf", basename(archive), "-C", staging],
    {
      cwd: dirname(archive),
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  if (result.exitCode !== 0) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(
      `tar could not unpack ${archive} (exit ${result.exitCode}); ` +
        `a working tar is required to install the toolchain`,
    );
  }

  await rm(into, { recursive: true, force: true });
  await rename(join(staging, extractedName(archive.split(/[\\/]/).pop()!)), into);
  await rm(staging, { recursive: true, force: true });
}

/**
 * Path to the pinned `zig`, installing it under .zig/ if it is not already
 * there. Resolution order:
 *
 *   1. ZIG, for an air-gapped build or a locally built compiler.
 *   2. The toolchain this script installed previously.
 *   3. A `zig` on PATH, but only if it is the pinned release.
 *   4. A fresh download.
 *
 * Steps 1 and 3 both check the version, because a build against a different
 * Zig produces different bytes and the failure would otherwise surface as an
 * unexplained diff in src/generated.
 */
export async function zigExecutable(): Promise<string> {
  const override = Bun.env.ZIG;
  if (override !== undefined && override !== "") {
    const version = reportedVersion(override);
    if (version === null) {
      throw new Error(`ZIG is set to ${override}, which does not run`);
    }
    if (version !== ZIG_VERSION && Bun.env.SWISS_ALLOW_ZIG_MISMATCH !== "1") {
      throw new Error(
        `ZIG is Zig ${version}, but the build pins ${ZIG_VERSION}. ` +
          `A different release compiles to different bytes, which CI reports ` +
          `as stale src/generated. Unset ZIG to use the pinned toolchain, or ` +
          `set SWISS_ALLOW_ZIG_MISMATCH=1 to build anyway.`,
      );
    }
    return override;
  }

  const target = release();
  const home = join(TOOLCHAIN_DIR, extractedName(target.archive));
  const installed = join(home, executableName());

  if (await exists(installed)) return installed;

  const onPath = reportedVersion("zig") === ZIG_VERSION ? "zig" : null;
  if (onPath !== null) return onPath;

  if (Bun.env.SWISS_NO_FETCH === "1") {
    throw new Error(
      `Zig ${ZIG_VERSION} is not installed and SWISS_NO_FETCH=1 forbids ` +
        `downloading it. Run 'bun run toolchain' with network access, or ` +
        `set ZIG to a local Zig ${ZIG_VERSION}.`,
    );
  }

  await mkdir(TOOLCHAIN_DIR, { recursive: true });
  const archive = join(TOOLCHAIN_DIR, target.archive);

  if (!(await exists(archive))) await download(target, archive);
  await verify(target, archive);
  await extract(archive, home);
  await chmod(installed, EXECUTABLE_MODE);

  const version = reportedVersion(installed);
  if (version !== ZIG_VERSION) {
    throw new Error(
      `unpacked toolchain reports ${version ?? "nothing"}, ` +
        `expected ${ZIG_VERSION}`,
    );
  }

  // Kept, not deleted: a rebuild after `rm -rf .zig/zig-*` then costs an
  // unpack rather than another 50 MiB across the network.
  console.log(
    `installed Zig ${ZIG_VERSION} to ${home} ` +
      `(archive cached, ${(Bun.file(archive).size / MIB).toFixed(0)} MiB)`,
  );

  return installed;
}

if (import.meta.main) {
  console.log(await zigExecutable());
}
