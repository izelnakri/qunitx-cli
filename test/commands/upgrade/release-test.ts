import { module, test } from 'qunitx';
import * as Release from '../../../lib/commands/upgrade/release.ts';
import { Failure } from '../../../lib/result/index.ts';
import '../../helpers/custom-asserts.ts';

// The release lookup, with `fetch` injected: no test here touches the network.

const respond = (status: number, body: unknown, statusText = ''): typeof fetch =>
  (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText,
      json: () => Promise.resolve(body),
    })) as unknown as typeof fetch;

module('Commands | Upgrade | Release.find', { concurrency: true }, () => {
  test('reads the latest release into tag, version and assets', async (assert) => {
    const requested: string[] = [];
    const fetchImpl = ((url: string) => {
      requested.push(url);
      return respond(200, {
        tag_name: 'v0.35.0',
        assets: [
          { name: 'checksums.txt', browser_download_url: 'https://dl.test/checksums.txt' },
          {
            name: 'qunitx-deno-linux-x64.tar.gz',
            browser_download_url: 'https://dl.test/qunitx-deno-linux-x64.tar.gz',
          },
        ],
      })(url);
    }) as unknown as typeof fetch;

    const release = await Release.find(undefined, fetchImpl);

    assert.strictEqual(release.tag, 'v0.35.0');
    assert.strictEqual(
      release.version,
      '0.35.0',
      'the v is stripped for comparison with package.json',
    );
    assert.deepEqual(release.assets[0], {
      name: 'checksums.txt',
      url: 'https://dl.test/checksums.txt',
    });
    assert.includes(requested[0], '/releases/latest');
  });

  test('a pinned version asks for that tag, and a 404 says so by name', async (assert) => {
    const requested: string[] = [];
    const fetchImpl = ((url: string) => {
      requested.push(url);
      return respond(404, {}, 'Not Found')(url);
    }) as unknown as typeof fetch;

    const failure = await Release.find('0.1.2', fetchImpl).catch((error: unknown) => error);

    assert.includes(requested[0], '/releases/tags/v0.1.2');
    assert.ok(Failure.is(failure) && failure.code === 'ReleaseNotFound');
    assert.includes(Failure.format(failure), '0.1.2');
  });

  test('a `v` prefix is accepted on the way in', async (assert) => {
    const requested: string[] = [];
    const fetchImpl = ((url: string) => {
      requested.push(url);
      return respond(200, { tag_name: 'v0.1.2', assets: [] })(url);
    }) as unknown as typeof fetch;

    assert.strictEqual((await Release.find('v0.1.2', fetchImpl)).version, '0.1.2');
    assert.includes(requested[0], '/releases/tags/v0.1.2');
  });

  test('no network is a declared failure carrying the reason, not a stack', async (assert) => {
    const offline = (() => Promise.reject(new Error('fetch failed'))) as unknown as typeof fetch;

    const failure = await Release.find(undefined, offline).catch((error: unknown) => error);

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeLookupFailed');
    assert.includes(Failure.format(failure), 'fetch failed');
  });

  test("GitHub's unauthenticated rate limit is named rather than reported as a bare 403", async (assert) => {
    const failure = await Release.find(undefined, respond(403, {}, 'rate limit exceeded')).catch(
      (error: unknown) => error,
    );

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeLookupFailed');
    assert.includes(Failure.format(failure), 'rate limit');
  });

  test('a 404 without a pin is a lookup failure, not a missing release', async (assert) => {
    // Nothing was pinned, so "not found" means the API answered something unexpected.
    const failure = await Release.find(undefined, respond(404, {}, 'Not Found')).catch(
      (error: unknown) => error,
    );

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeLookupFailed');
  });

  test('a response with no tag_name is refused rather than read as version ""', async (assert) => {
    const failure = await Release.find(undefined, respond(200, { assets: [] })).catch(
      (error: unknown) => error,
    );

    assert.ok(Failure.is(failure) && failure.code === 'UpgradeLookupFailed');
    assert.includes(Failure.format(failure), 'tag_name');
  });
});

module('Commands | Upgrade | Release.assetName', { concurrency: true }, () => {
  test('names the archive each build matrix in ci.yml actually publishes', (assert) => {
    assert.strictEqual(Release.assetName('deno', 'linux', 'x64'), 'qunitx-deno-linux-x64.tar.gz');
    assert.strictEqual(
      Release.assetName('deno', 'linux', 'arm64'),
      'qunitx-deno-linux-arm64.tar.gz',
    );
    assert.strictEqual(
      Release.assetName('deno', 'darwin', 'arm64'),
      'qunitx-deno-macos-arm64.tar.gz',
    );
    assert.strictEqual(Release.assetName('deno', 'win32', 'x64'), 'qunitx-deno-windows-x64.zip');
    assert.strictEqual(
      Release.assetName('deno', 'win32', 'arm64'),
      'qunitx-deno-windows-arm64.zip',
    );
    assert.strictEqual(Release.assetName('sea', 'linux', 'x64'), 'qunitx-linux-x64.tar.gz');
    assert.strictEqual(Release.assetName('sea', 'darwin', 'arm64'), 'qunitx-macos-arm64.tar.gz');
    assert.strictEqual(Release.assetName('sea', 'win32', 'x64'), 'qunitx-windows-x64.zip');
  });

  test('a target with no published build is null, never a near-miss archive', (assert) => {
    // build-binaries has three targets, build-deno-binaries five; Intel macOS is in neither.
    assert.strictEqual(Release.assetName('sea', 'linux', 'arm64'), null);
    assert.strictEqual(Release.assetName('sea', 'win32', 'arm64'), null);
    assert.strictEqual(Release.assetName('deno', 'darwin', 'x64'), null);
    assert.strictEqual(Release.assetName('deno', 'freebsd', 'x64'), null);
  });
});

module('Commands | Upgrade | Release.parseChecksums', { concurrency: true }, () => {
  test('reads the sha256sum output the release workflow uploads', (assert) => {
    const checksums = Release.parseChecksums(
      [
        '45a2254993effe18ed19630ec7df459957ab672bca0d0cbaf93c1130cee11c9f  qunitx-deno-linux-arm64.tar.gz',
        'c8e15a874ef603e742fbe0c67bd3ee8541232aeb84000c6b1b73091762e682ae  qunitx-deno-windows-x64.zip',
        '',
      ].join('\n'),
    );

    assert.strictEqual(
      checksums.get('qunitx-deno-linux-arm64.tar.gz'),
      '45a2254993effe18ed19630ec7df459957ab672bca0d0cbaf93c1130cee11c9f',
    );
    assert.strictEqual(checksums.size, 2, 'blank lines contribute nothing');
  });

  test('binary-mode lines (`*name`) and upper-case digests read the same', (assert) => {
    const checksums = Release.parseChecksums('ABCDEF  *qunitx-windows-x64.zip\n');

    assert.strictEqual(checksums.get('qunitx-windows-x64.zip'), 'abcdef');
  });
});

module('Commands | Upgrade | Release.compare', { concurrency: true }, () => {
  test('orders a release line by number, not by string', (assert) => {
    assert.ok(Release.compare('0.34.5', '0.35.0') < 0);
    assert.ok(Release.compare('0.35.0', '0.34.5') > 0);
    assert.strictEqual(Release.compare('1.2.3', '1.2.3'), 0);
    assert.ok(Release.compare('0.9.0', '0.10.0') < 0, '10 is not "smaller" than 9');
    assert.strictEqual(Release.compare('v1.2.3', '1.2.3'), 0, 'the tag form compares equal');
  });
});
