import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  GoogleRefused,
  NoGoogleCredentials,
  SCOPE,
  driveTypes,
  googleToken,
  uploadToDrive,
} from '../../lib/record/google.ts';
import { invalidOptionReason } from '../../lib/record/options.ts';
import { parse } from '../../lib/commands/record/parse.ts';
import * as Failure from '../../lib/result/failure.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

const CLI = path.resolve('cli.ts');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

// A fetch that answers from `reply` and keeps every request it was given.
function fakeFetch(reply: (url: string, init: RequestInit) => Response) {
  const requests: { url: string; init: RequestInit }[] = [];
  const request = ((url: string | URL, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return Promise.resolve(reply(String(url), init));
  }) as typeof fetch;
  return { request, requests };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

// A JWT's claims, after checking its signature against the test key.
function verified(assertion: string): Record<string, unknown> {
  const [header, claims, signature] = assertion.split('.');
  const valid = createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(publicKey, signature, 'base64url');
  if (!valid) throw new Error('bad signature');
  return JSON.parse(Buffer.from(claims, 'base64url').toString());
}

module('Record | google | token', { concurrency: true }, () => {
  test('a token in the environment is used as is', async (assert) => {
    assert.equal(await googleToken({ GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.given' }), 'ya29.given');
  });

  test('a service account signs a JWT for drive.file and trades it for a token', async (assert) => {
    await using dir = await tempDir('google-service-account');
    const key = path.join(dir.path, 'key.json');
    await fs.writeFile(
      key,
      JSON.stringify({
        type: 'service_account',
        client_email: 'bot@project.iam.gserviceaccount.com',
        private_key: PRIVATE_PEM,
        token_uri: 'https://example.test/token',
      }),
    );
    const { request, requests } = fakeFetch(() => json({ access_token: 'ya29.signed' }));
    const token = await googleToken({ GOOGLE_APPLICATION_CREDENTIALS: key }, request);
    const form = new URLSearchParams(requests[0].init.body as URLSearchParams);
    const claims = verified(form.get('assertion')!);

    assert.equal(token, 'ya29.signed');
    assert.equal(requests[0].url, 'https://example.test/token');
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.deepEqual(
      [claims.iss, claims.scope, claims.aud, (claims.exp as number) - (claims.iat as number)],
      ['bot@project.iam.gserviceaccount.com', SCOPE, 'https://example.test/token', 3600],
      'signed by its own key, for the one scope, an hour',
    );
  });

  test("a user's application-default credentials trade their refresh token, from gcloud's own place", async (assert) => {
    await using dir = await tempDir('google-adc');
    await fs.writeFile(
      path.join(dir.path, 'application_default_credentials.json'),
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'id',
        client_secret: 'secret',
        refresh_token: 'refresh',
      }),
    );
    const { request, requests } = fakeFetch(() => json({ access_token: 'ya29.user' }));
    const token = await googleToken({ CLOUDSDK_CONFIG: dir.path }, request);

    assert.equal(token, 'ya29.user');
    assert.equal(requests[0].url, 'https://oauth2.googleapis.com/token');
    assert.equal(
      String(requests[0].init.body),
      'grant_type=refresh_token&client_id=id&client_secret=secret&refresh_token=refresh',
    );
  });

  test('no credentials, or credentials Google turns down, fail saying what to do', async (assert) => {
    await using dir = await tempDir('google-none');
    const missing = await googleToken({ CLOUDSDK_CONFIG: dir.path }).catch((error) => error);
    await fs.writeFile(
      path.join(dir.path, 'application_default_credentials.json'),
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'a',
        client_secret: 'b',
        refresh_token: 'c',
      }),
    );
    const { request } = fakeFetch(() =>
      json(
        { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
        400,
      ),
    );
    const refused = await googleToken({ CLOUDSDK_CONFIG: dir.path }, request).catch(
      (error) => error,
    );

    assert.true(NoGoogleCredentials.is(missing));
    assert.includes(missing.message, 'gcloud auth application-default login --scopes=');
    assert.true(GoogleRefused.is(refused));
    assert.equal(
      refused.message,
      'Google refused to give a token (400): Token has been expired or revoked.',
    );
  });
});

module('Record | google | upload', { concurrency: true }, () => {
  test('an Office file or CSV converts unless asked not to; anything else goes as it is', (assert) => {
    assert.deepEqual(
      ['a.docx', 'a.XLSX', 'a.csv', 'a.tsv', 'a.pptx', 'a.png', 'a.pdf', 'a.bin'].map(
        (file) => driveTypes(file, true).google,
      ),
      [
        'application/vnd.google-apps.document',
        'application/vnd.google-apps.spreadsheet',
        'application/vnd.google-apps.spreadsheet',
        'application/vnd.google-apps.spreadsheet',
        'application/vnd.google-apps.presentation',
        null,
        null,
        null,
      ],
    );
    assert.equal(driveTypes('a.bin', true).type, 'application/octet-stream');
    assert.equal(driveTypes('a.pptx', false).google, null);
  });

  test('a resumable upload: metadata first, its bytes to the session; converted, its name has no extension', async (assert) => {
    await using dir = await tempDir('google-upload');
    const file = path.join(dir.path, 'deck.pptx');
    await fs.writeFile(file, 'PK fake');
    const { request, requests } = fakeFetch((url) =>
      url.includes('uploadType=resumable')
        ? new Response(null, {
            status: 200,
            headers: { location: 'https://upload.test/session/1' },
          })
        : json({ id: 'f1', webViewLink: 'https://docs.google.com/presentation/d/f1/edit' }),
    );
    const uploaded = await uploadToDrive(
      file,
      'ya29.t',
      { to: 'google', folder: 'folder-1' },
      request,
      'https://api.test',
    );
    const [start, put] = requests;
    const headers = start.init.headers as Record<string, string>;

    assert.deepEqual(uploaded, {
      path: file,
      id: 'f1',
      url: 'https://docs.google.com/presentation/d/f1/edit',
    });
    assert.equal(
      start.url,
      'https://api.test/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink',
    );
    assert.deepEqual(
      [headers.authorization, headers['x-upload-content-type'], headers['x-upload-content-length']],
      [
        'Bearer ya29.t',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '7',
      ],
    );
    assert.deepEqual(JSON.parse(start.init.body as string), {
      name: 'deck',
      mimeType: 'application/vnd.google-apps.presentation',
      parents: ['folder-1'],
    });
    assert.deepEqual(
      [put.url, put.init.method, String(put.init.body)],
      ['https://upload.test/session/1', 'PUT', 'PK fake'],
    );
  });

  test("Drive's refusal is named, with its own reason", async (assert) => {
    await using dir = await tempDir('google-refused');
    const file = path.join(dir.path, 'a.png');
    await fs.writeFile(file, 'png');
    const { request } = fakeFetch(() =>
      json({ error: { message: 'Service Accounts do not have storage quota.' } }, 403),
    );
    const error = await uploadToDrive(
      file,
      't',
      { to: 'google' },
      request,
      'https://api.test',
    ).catch((caught) => caught);

    assert.equal(
      error.message,
      'Google refused to upload a.png (403): Service Accounts do not have storage quota.',
    );
  });
});

module('Record | google | options', { concurrency: true }, () => {
  test('the flags and the option are held to one rule', (assert) => {
    const parsed = parse(
      ['a.html', '--upload=google', '--upload-folder', 'abc', '--no-upload-convert'],
      {},
    );

    assert.deepEqual(!Failure.is(parsed) && parsed.options.upload, {
      to: 'google',
      folder: 'abc',
      convert: false,
    });
    assert.deepEqual(
      [
        invalidOptionReason('upload', 'google'),
        invalidOptionReason('upload', 'proton'),
        invalidOptionReason('upload', { to: 'google', folder: '' }),
        invalidOptionReason('upload', { to: 'google', shared: true }),
      ],
      [
        null,
        `expected 'google' or { to: 'google', folder, convert }, got "proton"`,
        `expected 'google' or { to: 'google', folder, convert }, got {"to":"google","folder":""}`,
        `expected 'google' or { to: 'google', folder, convert }, got {"to":"google","shared":true}`,
      ],
    );
    assert.true(Failure.is(parse(['a.html', '--upload=dropbox'], {})));
  });
});

module('Commands | record | upload', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('--upload=google puts each file written on Drive and prints its link; without credentials, nothing is recorded', async (assert, testMetadata) => {
    await using dir = await tempDir('record-upload');
    const received: { path: string; body: Buffer; auth?: string }[] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        received.push({ path: request.url!, body, auth: request.headers.authorization });
        if (request.url === '/token') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ access_token: 'ya29.fake' }));
        } else if (request.url!.startsWith('/upload/')) {
          response.setHeader('location', `http://127.0.0.1:${port}/session`);
          response.end();
        } else {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ id: 'f1', webViewLink: 'https://drive.test/f1' }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await fs.writeFile(path.join(dir.path, 'a.html'), '<body style="background:#08f">');
      await fs.writeFile(
        path.join(dir.path, 'key.json'),
        JSON.stringify({
          type: 'service_account',
          client_email: 'bot@x.iam.gserviceaccount.com',
          private_key: PRIVATE_PEM,
          token_uri: `http://127.0.0.1:${port}/token`,
        }),
      );
      const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
      const result = await shell(
        `GOOGLE_OAUTH_ACCESS_TOKEN= GOOGLE_APPLICATION_CREDENTIALS=key.json QUNITX_GOOGLE_API=http://127.0.0.1:${port} ` +
          `node ${CLI} record a.html -f a.png -w 80 -h 60 --upload=google --upload-folder=F1 --output=${dir.path}`,
        metadata,
      );
      const none = await shellFails(
        `GOOGLE_OAUTH_ACCESS_TOKEN= GOOGLE_APPLICATION_CREDENTIALS=${path.join(dir.path, 'missing.json')} ` +
          `node ${CLI} record a.html -f b.png --upload=google --output=${dir.path}`,
        metadata,
      );
      const png = await fs.readFile(path.join(dir.path, 'a.png'));
      // Under --compare a.png is the baseline: a snapshot that held writes nothing to send, and one
      // that changed sends what it wrote beside it.
      const uploaded = received.length;
      const compare = `GOOGLE_OAUTH_ACCESS_TOKEN=ya29.fake QUNITX_GOOGLE_API=http://127.0.0.1:${port} node ${CLI} record a.html -f a.png -w 80 -h 60 --compare --upload=google --output=${dir.path}`;
      await shell(compare, metadata);
      const held = received.length;
      await fs.writeFile(path.join(dir.path, 'a.html'), '<body style="background:#f00">');
      await shellFails(compare, metadata);
      const sent = received
        .slice(held)
        .filter((entry) => entry.path.startsWith('/upload/'))
        .map((entry) => JSON.parse(entry.body.toString()).name);

      assert.includes(result.stdout, 'a.png  → https://drive.test/f1');
      assert.deepEqual(
        received.slice(0, uploaded).map((entry) => entry.path),
        [
          '/token',
          '/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink',
          '/session',
        ],
      );
      assert.equal(received[1].auth, 'Bearer ya29.fake');
      assert.deepEqual(JSON.parse(received[1].body.toString()), { name: 'a.png', parents: ['F1'] });
      assert.true(received[2].body.equals(png), 'the file, byte for byte');
      assert.equal(held, uploaded, 'a snapshot that held sends nothing');
      assert.deepEqual(
        sent,
        ['a.diff.png', 'a.new.png'],
        'one that changed, its diff and new screenshot',
      );
      assert.includes(none.stderr, '--upload=google needs Google credentials');
      assert.false(
        await fs.stat(path.join(dir.path, 'b.png')).then(
          () => true,
          () => false,
        ),
        'checked before anything was recorded',
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
