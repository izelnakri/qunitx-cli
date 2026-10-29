// Google Drive, spoken to directly: an OAuth token from the environment or a credentials file, and
// a resumable upload per file. Two REST calls and a signed JWT, so no SDK and no dependency.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createSign } from 'node:crypto';
import * as Failure from '../result/failure.ts';

/**
 * Where and how recordings go to Google Drive: into `folder` (a folder's id, from its URL; a
 * shared drive's folder for a service account, which has no storage of its own), and whether
 * Office files and CSV become Google Docs, Sheets and Slides (`convert`, the default) or stay
 * as they are.
 *
 * ```ts
 * const upload: GoogleUpload = { to: 'google', folder: '1AbCdEfGhIjK', convert: true };
 * ```
 */
export interface GoogleUpload {
  /** The service: Google Drive. */
  to: 'google';
  /** A folder's id; the account's own Drive root without one. */
  folder?: string;
  /** Make Office files and CSV Google Docs, Sheets and Slides. Defaults to true. */
  convert?: boolean;
}

/**
 * One file put on Google Drive: where it came from, its id there, and the link that opens it.
 *
 * ```ts
 * const uploaded: Uploaded = { path: '/out/deck.pptx', id: '1x', url: 'https://docs.google.com/presentation/d/1x/edit' };
 * ```
 */
export interface Uploaded {
  /** The file written, absolute. */
  path: string;
  /** Its id on Drive. */
  id: string;
  /** Opens it in Drive, Docs, Sheets or Slides. */
  url: string;
}

/**
 * No way to act for anyone on Google: no token in the environment and no credentials file. The
 * message says how to get one.
 *
 * ```ts
 * import { NoGoogleCredentials } from './google.ts';
 *
 * NoGoogleCredentials({}).message.startsWith('--upload=google needs Google credentials'); // true
 * ```
 */
export const NoGoogleCredentials: Failure.FailureFactory<
  'NoGoogleCredentials',
  Record<string, never>
> = Failure.define(
  'NoGoogleCredentials',
  () =>
    '--upload=google needs Google credentials: set GOOGLE_OAUTH_ACCESS_TOKEN, or ' +
    'GOOGLE_APPLICATION_CREDENTIALS to a service account key, or run ' +
    `gcloud auth application-default login --scopes=${SCOPE},https://www.googleapis.com/auth/cloud-platform`,
);

/**
 * Google turned a request down: getting a token, or putting a file on Drive.
 *
 * ```ts
 * import { GoogleRefused } from './google.ts';
 *
 * GoogleRefused({ action: 'upload deck.pptx', status: 403, reason: 'Insufficient permissions' }).message;
 * // 'Google refused to upload deck.pptx (403): Insufficient permissions'
 * ```
 */
export const GoogleRefused: Failure.FailureFactory<
  'GoogleRefused',
  { action: string; status: number; reason: string }
> = Failure.define(
  'GoogleRefused',
  (data: { action: string; status: number; reason: string }) =>
    `Google refused to ${data.action} (${data.status}): ${data.reason}`,
);

/**
 * The one scope asked for: files this app creates, and nothing else of anyone's Drive.
 *
 * ```ts
 * import { SCOPE } from './google.ts';
 *
 * SCOPE; // 'https://www.googleapis.com/auth/drive.file'
 * ```
 */
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

// What each kind of file is, by extension, and what Drive makes of it when converting.
const TYPES: Record<string, { type: string; google?: string }> = {
  png: { type: 'image/png' },
  jpg: { type: 'image/jpeg' },
  jpeg: { type: 'image/jpeg' },
  gif: { type: 'image/gif' },
  webp: { type: 'image/webp' },
  webm: { type: 'video/webm' },
  mp4: { type: 'video/mp4' },
  pdf: { type: 'application/pdf' },
  html: { type: 'text/html' },
  md: { type: 'text/markdown' },
  csv: { type: 'text/csv', google: 'spreadsheet' },
  tsv: { type: 'text/tab-separated-values', google: 'spreadsheet' },
  docx: {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    google: 'document',
  },
  xlsx: {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    google: 'spreadsheet',
  },
  pptx: {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    google: 'presentation',
  },
};

/**
 * The file's own content type, and the Google type Drive converts it to — when it converts, and
 * `convert` asks it to.
 *
 * ```ts
 * import { driveTypes } from './google.ts';
 *
 * driveTypes('deck.pptx', true).google; // 'application/vnd.google-apps.presentation'
 * driveTypes('deck.pptx', false).google; // null
 * driveTypes('home.png', true); // { type: 'image/png', google: null }
 * ```
 */
export function driveTypes(
  file: string,
  convert: boolean,
): { type: string; google: string | null } {
  const known = TYPES[path.extname(file).slice(1).toLowerCase()];
  return {
    type: known?.type ?? 'application/octet-stream',
    google: convert && known?.google ? `application/vnd.google-apps.${known.google}` : null,
  };
}

/**
 * An access token for Drive, from the first of: `GOOGLE_OAUTH_ACCESS_TOKEN`; the credentials file
 * `GOOGLE_APPLICATION_CREDENTIALS` names; gcloud's application-default credentials. A service
 * account's key signs a JWT for one; a user's (`authorized_user`) refresh token is exchanged for
 * one. Fails with {@link NoGoogleCredentials} when there is none to use.
 *
 * ```ts
 * import { googleToken } from './google.ts';
 *
 * await googleToken({ GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.x' }); // 'ya29.x'
 * ```
 */
export async function googleToken(
  env: Record<string, string | undefined>,
  request: typeof fetch = fetch,
): Promise<string> {
  if (env.GOOGLE_OAUTH_ACCESS_TOKEN) return env.GOOGLE_OAUTH_ACCESS_TOKEN;
  const file = env.GOOGLE_APPLICATION_CREDENTIALS || defaultCredentials(env);
  let credentials: Record<string, string>;
  try {
    credentials = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    throw NoGoogleCredentials({});
  }
  const tokenUri = credentials.token_uri || TOKEN_URI;
  let body: URLSearchParams;
  if (credentials.type === 'service_account') {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: credentials.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(credentials.private_key, 'base64url');
    body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    });
  } else if (credentials.type === 'authorized_user') {
    body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
    });
  } else {
    throw NoGoogleCredentials({});
  }
  const response = await request(tokenUri, { method: 'POST', body });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok || !answer.access_token) {
    throw GoogleRefused({
      action: 'give a token',
      status: response.status,
      reason: answer.error_description ?? answer.error ?? response.statusText,
    });
  }
  return answer.access_token;
}

/**
 * Puts `file` on Google Drive as `upload` says, in one resumable upload — any size — and returns
 * where it went. Fails with {@link GoogleRefused} when Drive says no. `root` is the API's address:
 * `QUNITX_GOOGLE_API` points it elsewhere, for tests.
 *
 * ```ts
 * import { uploadToDrive } from './google.ts';
 *
 * // Defined, not invoked: puts a file on someone's Drive.
 * async function share(token: string) {
 *   return (await uploadToDrive('/out/deck.pptx', token, { to: 'google' })).url;
 * }
 * ```
 */
export async function uploadToDrive(
  file: string,
  token: string,
  upload: GoogleUpload,
  request: typeof fetch = fetch,
  root = process.env.QUNITX_GOOGLE_API || 'https://www.googleapis.com',
): Promise<Uploaded> {
  const bytes = await fs.promises.readFile(file);
  const { type, google } = driveTypes(file, upload.convert ?? true);
  const name = path.basename(file);
  const refused = async (response: Response, action: string) => {
    const answer = await response.json().catch(() => ({}));
    return GoogleRefused({
      action,
      status: response.status,
      reason: answer.error?.message ?? response.statusText,
    });
  };
  const started = await request(
    `${root}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': type,
        'x-upload-content-length': String(bytes.length),
      },
      body: JSON.stringify({
        // Converted, it is a document, not a file: its name drops the extension, as Drive's own does.
        name: google ? name.slice(0, -path.extname(name).length) : name,
        ...(google ? { mimeType: google } : {}),
        ...(upload.folder ? { parents: [upload.folder] } : {}),
      }),
    },
  );
  const session = started.headers.get('location');
  if (!started.ok || !session) throw await refused(started, `upload ${name}`);
  const sent = await request(session, {
    method: 'PUT',
    headers: { 'content-type': type },
    body: bytes,
  });
  if (!sent.ok) throw await refused(sent, `upload ${name}`);
  const created = await sent.json();
  return {
    path: file,
    id: created.id,
    url: created.webViewLink ?? `https://drive.google.com/file/d/${created.id}/view`,
  };
}

// Where gcloud keeps application-default credentials: in CLOUDSDK_CONFIG when it is set, else
// %APPDATA%\gcloud on Windows and ~/.config/gcloud elsewhere.
function defaultCredentials(env: Record<string, string | undefined>): string {
  const directory =
    env.CLOUDSDK_CONFIG ??
    (process.platform === 'win32'
      ? path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud')
      : path.join(os.homedir(), '.config', 'gcloud'));
  return path.join(directory, 'application_default_credentials.json');
}
