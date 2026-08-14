import { Failure } from '../../result/index.ts';
import pkg from '../../../package.json' with { type: 'json' };

// GitHub Releases is the source of truth for "what is the newest version", for two reasons that
// are already settled elsewhere in this repo: install.sh resolves `releases/latest` and jsr/cli.ts
// downloads release assets, so this is the version line both existing installers already trust;
// and `make release` publishes to npm BEFORE it tags, so a release here can never name a version
// npm does not have yet — the error only ever points the other way.
const RELEASES_API = 'https://api.github.com/repos/izelnakri/qunitx-cli/releases';

// Release naming, from the ci.yml matrices: `build-binaries` (Node SEA) publishes three targets,
// `build-deno-binaries` (deno compile) publishes five. Anything absent here has no asset, which is
// a refusal rather than a download of the wrong architecture.
const TARGETS: Record<string, string> = {
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'darwin-arm64': 'macos-arm64',
  'win32-x64': 'windows-x64',
  'win32-arm64': 'windows-arm64',
};
const SEA_TARGETS = new Set(['linux-x64', 'macos-arm64', 'windows-x64']);
const DENO_TARGETS = new Set(Object.values(TARGETS));

/**
 * The release lookup could not be answered — no network, a proxy, an HTTP error, or GitHub's
 * unauthenticated rate limit.
 *
 * ```ts
 * import * as Release from './release.ts';
 *
 * Release.LookupFailed({ url: 'https://api.github.com/x', reason: 'fetch failed' }).code; // 'UpgradeLookupFailed'
 * ```
 */
export const LookupFailed: Failure.FailureFactory<
  'UpgradeLookupFailed',
  { url: string; reason: string }
> = Failure.define(
  'UpgradeLookupFailed',
  (data: { url: string; reason: string }) =>
    `Could not reach GitHub Releases (${data.url}): ${data.reason}`,
);

/**
 * A pinned version that has no published release.
 *
 * ```ts
 * import * as Release from './release.ts';
 *
 * Release.NotFound({ version: '9.9.9' }).message; // 'No published release for qunitx-cli 9.9.9'
 * ```
 */
export const NotFound: Failure.FailureFactory<'ReleaseNotFound', { version: string }> =
  Failure.define(
    'ReleaseNotFound',
    (data: { version: string }) => `No published release for qunitx-cli ${data.version}`,
  );

/**
 * One downloadable file on a release.
 *
 * ```ts
 * import type { ReleaseAsset } from './release.ts';
 *
 * const asset: ReleaseAsset = { name: 'checksums.txt', url: 'https://example.test/checksums.txt' };
 * asset.name; // 'checksums.txt'
 * ```
 */
export interface ReleaseAsset {
  /** The asset's file name, e.g. `qunitx-deno-linux-x64.tar.gz`. */
  name: string;
  /** Its `browser_download_url`. */
  url: string;
}

/**
 * A published release, reduced to what an upgrade needs.
 *
 * ```ts
 * import type { Release } from './release.ts';
 *
 * const release: Release = { tag: 'v1.2.3', version: '1.2.3', assets: [] };
 * release.version; // '1.2.3' — the tag without its leading v
 * ```
 */
export interface Release {
  /** The git tag, `v`-prefixed as the workflow creates it. */
  tag: string;
  /** The tag without its `v`, which is what package.json and `--version` speak. */
  version: string;
  /** Every asset the release publishes, including `checksums.txt`. */
  assets: ReleaseAsset[];
}

/**
 * Fetches the newest release, or the one matching `version` when pinned.
 *
 * ```ts
 * import * as Release from './release.ts';
 *
 * // Defined, not invoked: reaches the GitHub API over the network.
 * async function newest() {
 *   return (await Release.find()).version; // '0.34.5'
 * }
 * ```
 */
export async function find(version?: string, fetchImpl: typeof fetch = fetch): Promise<Release> {
  const wanted = version?.replace(/^v/, '');
  const url = wanted ? `${RELEASES_API}/tags/v${wanted}` : `${RELEASES_API}/latest`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `qunitx-cli/${pkg.version}` },
  }).catch((error: unknown) => {
    throw LookupFailed({ url, reason: error instanceof Error ? error.message : String(error) });
  });

  if (response.status === 404 && wanted) throw NotFound({ version: wanted });
  else if (!response.ok) {
    // 403/429 here is nearly always the 60-requests-per-hour unauthenticated limit, which is
    // worth naming: the fix is to wait, not to retry harder.
    const limited = response.status === 403 || response.status === 429;
    throw LookupFailed({
      url,
      reason: limited
        ? `${response.status} ${response.statusText} — GitHub's unauthenticated API rate limit`
        : `${response.status} ${response.statusText}`,
    });
  }

  const body = (await response.json().catch((error: unknown) => {
    throw LookupFailed({ url, reason: `unreadable response: ${String(error)}` });
  })) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };

  if (!body.tag_name) throw LookupFailed({ url, reason: 'response carried no tag_name' });

  return {
    tag: body.tag_name,
    version: body.tag_name.replace(/^v/, ''),
    assets: (body.assets ?? []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
    })),
  };
}

/**
 * The release asset that replaces a running binary of this `flavor`, or `null` when this
 * platform has no published build — the SEA matrix covers three targets, the deno one five.
 *
 * ```ts
 * import * as Release from './release.ts';
 *
 * Release.assetName('deno', 'linux', 'arm64'); // 'qunitx-deno-linux-arm64.tar.gz'
 * Release.assetName('sea', 'linux', 'arm64'); // null — no SEA is built for it
 * ```
 */
export function assetName(
  flavor: 'sea' | 'deno',
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const target = TARGETS[`${platform}-${arch}`];
  const published = flavor === 'sea' ? SEA_TARGETS : DENO_TARGETS;
  if (!target || !published.has(target)) return null;

  const stem = flavor === 'sea' ? `qunitx-${target}` : `qunitx-deno-${target}`;

  return target.startsWith('windows') ? `${stem}.zip` : `${stem}.tar.gz`;
}

/**
 * Parses the release's `checksums.txt` (`sha256sum` output) into `name → sha256`.
 *
 * ```ts
 * import * as Release from './release.ts';
 *
 * Release.parseChecksums('abc123  qunitx-deno-linux-x64.tar.gz\n').get('qunitx-deno-linux-x64.tar.gz'); // 'abc123'
 * ```
 */
export function parseChecksums(text: string): Map<string, string> {
  return new Map(
    text
      .split('\n')
      .map((line) => line.trim().match(/^([0-9a-fA-F]{64}|[0-9a-fA-F]+)\s+\*?(.+)$/))
      .filter((match) => match !== null)
      .map((match) => [match[2].trim(), match[1].toLowerCase()] as const),
  );
}

/**
 * Compares two `x.y.z` versions the way a release line orders them: negative when `a` is older,
 * 0 when they are the same, positive when `a` is newer.
 *
 * ```ts
 * import * as Release from './release.ts';
 *
 * Release.compare('0.34.5', '0.35.0') < 0; // true — 0.34.5 is the older one
 * ```
 */
export function compare(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }

  return 0;
}

function parts(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split(/[.\-+]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}
