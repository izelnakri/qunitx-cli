// JSR bootstrap for `deno install -Agf jsr:@izelnakri/qunitx-cli` users.
// On first run, downloads the matching prebuilt qunitx-cli binary + esbuild
// sidecar from the GitHub release for this package's version, caches them
// under ~/.cache/qunitx/<version>/<target>/, then spawns the binary with
// stdio inherited and forwards the exit code. Subsequent runs skip straight
// to the spawn step.
//
// The cache is keyed on the published JSR version (NOT the latest GitHub
// release), so two installed launchers pinning different versions never
// race over the same on-disk binary.

import denoJson from './deno.json' with { type: 'json' };

const REPO = 'izelnakri/qunitx-cli';
const VERSION = `v${denoJson.version}`;

interface Target {
  archive: string;
  bin: string;
  isZip: boolean;
}

const TARGETS: Record<string, Target> = {
  'linux-x86_64':  { archive: 'qunitx-deno-linux-x64.tar.gz',     bin: 'qunitx',     isZip: false },
  'darwin-aarch64': { archive: 'qunitx-deno-macos-arm64.tar.gz',  bin: 'qunitx',     isZip: false },
  'windows-x86_64': { archive: 'qunitx-deno-windows-x64.zip',     bin: 'qunitx.exe', isZip: true  },
};

const platformKey = `${Deno.build.os}-${Deno.build.arch}`;
const target = TARGETS[platformKey];
if (!target) {
  console.error(`qunitx-cli: no prebuilt binary for ${platformKey}`);
  Deno.exit(1);
}

const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE');
if (!home) {
  console.error('qunitx-cli: cannot determine home directory (HOME/USERPROFILE unset)');
  Deno.exit(1);
}

const cacheDir = `${home}/.cache/qunitx/${denoJson.version}/${platformKey}`;
const binPath = `${cacheDir}/${target.bin}`;

let binStat: Deno.FileInfo | null = null;
try {
  binStat = await Deno.stat(binPath);
} catch (err) {
  if (!(err instanceof Deno.errors.NotFound)) throw err;
}

if (!binStat) {
  await downloadAndExtract();
}

// Spawn the cached binary with stdio inherited and forward its exit code.
// We use Deno.Command (not node:child_process) since this bootstrap is
// Deno-only by design — the JSR install flow targets `deno install`.
const child = new Deno.Command(binPath, {
  args: Deno.args,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
}).spawn();
const status = await child.status;
Deno.exit(status.code);

async function downloadAndExtract(): Promise<void> {
  const url = `https://github.com/${REPO}/releases/download/${VERSION}/${target.archive}`;
  console.error(`qunitx-cli: fetching ${VERSION} prebuilt binary`);
  console.error(`  ${url}`);

  await Deno.mkdir(cacheDir, { recursive: true });

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`qunitx-cli: download failed (${res.status} ${res.statusText})`);
    Deno.exit(1);
  }

  // Stage extraction in a sibling tmp dir so a failed extract doesn't leave a
  // half-populated cacheDir behind that the next run would mistake for a hit.
  const stageDir = `${cacheDir}.tmp-${crypto.randomUUID()}`;
  await Deno.mkdir(stageDir, { recursive: true });

  try {
    const archivePath = `${stageDir}/${target.archive}`;
    await Deno.writeFile(archivePath, new Uint8Array(await res.arrayBuffer()));
    await extract(archivePath, stageDir, target.isZip);
    // The archive layout is qunitx-deno-<target>/{qunitx[.exe], esbuild[.exe]}.
    const inner = `${stageDir}/${target.archive.replace(/\.(tar\.gz|zip)$/, '')}`;
    for (const entry of Deno.readDirSync(inner)) {
      const dest = `${cacheDir}/${entry.name}`;
      await Deno.rename(`${inner}/${entry.name}`, dest);
      if (Deno.build.os !== 'windows') await Deno.chmod(dest, 0o755);
    }
  } finally {
    await Deno.remove(stageDir, { recursive: true }).catch(() => {});
  }
}

async function extract(archivePath: string, dest: string, isZip: boolean): Promise<void> {
  // Shell out to system tar / unzip rather than pulling a JS extractor — the
  // bootstrap stays small (one fetch + one spawn) and the host always has these
  // binaries on every supported target (tar on POSIX, unzip is preinstalled on
  // macOS and added to Git Bash; Windows users running the JSR launcher have
  // PowerShell's Expand-Archive as a fallback if unzip is absent — handled below).
  if (isZip) {
    const unzip = new Deno.Command('unzip', { args: ['-q', archivePath, '-d', dest] });
    const status = await unzip.spawn().status.catch(() => null);
    if (!status?.success) {
      // PowerShell fallback for Windows shells that don't ship unzip on PATH.
      const ps = new Deno.Command('powershell', {
        args: [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Path '${archivePath}' -DestinationPath '${dest}' -Force`,
        ],
      });
      const psStatus = await ps.spawn().status;
      if (!psStatus.success) throw new Error('extract failed: unzip and Expand-Archive both failed');
    }
  } else {
    const tar = new Deno.Command('tar', { args: ['xzf', archivePath, '-C', dest] });
    const status = await tar.spawn().status;
    if (!status.success) throw new Error('tar extract failed');
  }
}
