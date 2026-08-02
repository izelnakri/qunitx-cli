// A runnable end-to-end example of this repo's error handling: a Task-based web server in which
// the try/catch KEYWORD appears in exactly ONE function body in the whole program (Result.try).
// Endpoints stay flat.
//
// It runs the REAL lib/result/ and lib/task/ — not a distillation of them — so what you read here
// is what the library actually does against live HTTP and filesystem edges.
// run:   node examples/error-handling-server.ts          (ephemeral port, demos every endpoint, exits)
//        node examples/error-handling-server.ts --serve  (keeps serving; GITHUB_TOKEN honored if set)
// check: deno check examples/error-handling-server.ts
//
// Routes:
//   GET /                    index
//   GET /fs/{path}           file-system exposure (file content / directory listing), traversal-safe
//   GET /github/:username    GitHub public profile  → unified Profile JSON
//   GET /gitlab/:username    GitLab public profile  → unified Profile JSON (same shape, other API)
//   GET /bug                 deliberate tier-2 bug — proves the boundary catches what .result() rethrows
//
// The architecture in one sentence: adapters classify raw throws into declared Failures at the edge,
// endpoints are pure pipelines ending in `await task.result()`, bugs funnel through ONE .catch()
// boundary — and the try/catch keyword survives only inside Result.try.
//
// ── DESIGN NOTES: calibrated claims — what this buys, and what it does not ──────────────────
// 1. Sync fallible code is unavoidable in a real server (JSON.parse of bodies, decodeURIComponent,
//    date parsing, schema validation). That is Result.try's job — the sync twin of Task: it buries
//    the try/catch keyword once for the whole program and hands back a flat { ok, value, error }
//    box, the one place a box survives because a caught `unknown` carries no brand to discriminate
//    on. Async failures need no box: `.result()` settles to the bare `T | Failure` union.
// 2. Performance: a Task is a promise + one closure + one small allocation — neutral overhead,
//    neither speedup nor cost. Laziness can save real work (un-awaited tasks never fire) and
//    memoization dedupes repeated awaits, but there is no throughput magic in this pattern.
// 3. Distribution: Task is purely in-process control flow. It makes this server a better CLIENT of
//    distributed systems (typed failures + retry policies for upstream calls); supervision,
//    restarts, and backpressure are orthogonal machinery (Erlang/OTP territory), not Task features.
// 4. THE LOAD-BEARING RULE — adapter discipline: every fallible operation must enter Task-land
//    through an adapter that declares its failures (taskJson, taskFs, …). One bare `await fetch()`
//    or raw driver call mid-pipeline reintroduces undeclared throw-land, and its errors sail past
//    .result() as "bugs". The real engineering artifact is not the Task class — it is the adapter
//    layer plus the lintable team rule: endpoint code never touches a bare promise, never writes
//    try/catch (grep for the keyword: it must only match Result.try).
// Net: business code is try/catch-free with typed, exhaustive, cause-chained failures; bugs still
// crash loudly at one well-lit boundary; same performance and same single process as plain promises.

import { createServer, type IncomingMessage } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import * as Result from '../lib/result/index.ts';
import { Failure } from '../lib/result/index.ts';
import { Task } from '../lib/task/index.ts';

// ── the declared failures, and the ONE place HTTP status is decided ──────────
//
// Status lives here, not on the failure: the same NotFound is 404 over HTTP, exit code 1 in a CLI
// and a retry in a queue. The domain names the failure; the transport maps it.

const BadRequest = Failure.define('BadRequest', (d: { detail: string }) => d.detail);
const Forbidden = Failure.define('Forbidden', (d: { path: string }) => `forbidden: ${d.path}`);
const NotFound = Failure.define('NotFound', (d: { detail: string }) => d.detail);
const MethodNotAllowed = Failure.define(
  'MethodNotAllowed',
  (d: { method: string }) => `method not allowed: ${d.method}`,
);
const UpstreamFailed = Failure.define(
  'UpstreamFailed',
  (d: { status: number; url: string }) => `upstream ${d.status} from ${d.url}`,
);

/** Every failure this server declares — the union each endpoint carries in its signature. */
type ApiFailure = Failure.Of<
  | typeof BadRequest
  | typeof Forbidden
  | typeof NotFound
  | typeof MethodNotAllowed
  | typeof UpstreamFailed
>;

const STATUS: Record<string, number> = {
  BadRequest: 400,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  UpstreamFailed: 502,
};

// ── shared JSON typing ────────────────────────────────────────────────────────

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Reply = { status: number; body: JsonValue };

// ── adapter: upstream JSON APIs (the ordinary async world + one conversion) ──

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!response.ok) {
    // Edge classification, named at the condition: an upstream 404 is a NotFound, anything else
    // upstream is an UpstreamFailed. Both are declared; the status map turns them into HTTP.
    throw response.status === 404
      ? NotFound({ detail: `no such upstream resource: ${url}` })
      : UpstreamFailed({ status: response.status, url });
  }
  return (await response.json()) as T;
}

function taskJson<T>(url: string, headers?: Record<string, string>): Task<T, ApiFailure> {
  return Task<T, ApiFailure>(() => fetchJson<T>(url, headers)); // closure keeps args, defers the fetch
}

// ── endpoint: /github/:username and /gitlab/:username → one Profile shape ────

type Profile = {
  source: 'github' | 'gitlab';
  username: string;
  name: string | null;
  url: string;
  followers: number | null;
};

type GithubApiUser = { login: string; name: string | null; html_url: string; followers: number };
type GitlabApiUser = { username: string; name: string | null; web_url: string };

function githubProfile(username: string): Task<Profile, ApiFailure> {
  const token = process.env.GITHUB_TOKEN;
  return taskJson<GithubApiUser>(
    `https://api.github.com/users/${encodeURIComponent(username)}`,
    token ? { authorization: `Bearer ${token}` } : {},
  )
    .map((u): Profile => ({
      source: 'github',
      username: u.login,
      name: u.name,
      url: u.html_url,
      followers: u.followers,
    }))
    .context(`github profile: ${username}`);
}

function gitlabProfile(username: string): Task<Profile, ApiFailure> {
  return taskJson<GitlabApiUser[]>(
    `https://gitlab.com/api/v4/users?username=${encodeURIComponent(username)}`,
  )
    .map(([user]): Profile => {
      // A declared failure may rise mid-pipeline, named where the condition is known.
      if (!user) throw NotFound({ detail: `gitlab user not found: ${username}` });
      return {
        source: 'gitlab',
        username: user.username,
        name: user.name,
        url: user.web_url,
        followers: null,
      };
    })
    .context(`gitlab profile: ${username}`);
}

// ── endpoint: /fs/{path} — file-system exposure, rooted and traversal-safe ───

const ROOT = process.cwd();
const MAX_CONTENT = 16_384;

type FsEntry =
  | { type: 'directory'; path: string; entries: string[] }
  | { type: 'file'; path: string; size: number; truncated: boolean; content: string };

/** Edge classification for raw fs errors: known errnos become declared failures, and anything
 *  else is returned untouched so it stays a bug and reaches the boundary with its own stack. */
function classifyErrno(error: unknown, path: string): unknown {
  if (Result.isErrno(error, 'ENOENT', 'ENOTDIR'))
    return NotFound({ detail: `no such path: ${path}` }, { cause: error });
  if (Result.isErrno(error, 'EACCES', 'EPERM')) return Forbidden({ path }, { cause: error });
  return error;
}

async function readEntry(relPath: string): Promise<FsEntry> {
  const full = resolve(ROOT, relPath);
  if (full !== ROOT && !full.startsWith(ROOT + sep))
    throw BadRequest({ detail: `path escapes served root: ${relPath}` });
  const stats = await stat(full).catch((e) => {
    throw classifyErrno(e, relPath);
  });
  if (stats.isDirectory()) {
    return { type: 'directory', path: relPath, entries: await readdir(full) };
  }
  const content = await readFile(full, 'utf8').catch((e) => {
    throw classifyErrno(e, relPath);
  });
  return {
    type: 'file',
    path: relPath,
    size: stats.size,
    truncated: content.length > MAX_CONTENT,
    content: content.slice(0, MAX_CONTENT),
  };
}

function taskFs(rawPath: string): Task<FsEntry, ApiFailure> {
  return Task<FsEntry, ApiFailure>(async () => {
    // The sync edge, flat: Result.try boxes the raw URIError, one `if` classifies it — no
    // indentation, no keyword. This is DESIGN NOTE 1 in action.
    const decoded = Result.try(decodeURIComponent, rawPath);
    if (!decoded.ok)
      throw BadRequest(
        { detail: `malformed percent-encoding: ${rawPath}` },
        { cause: decoded.error },
      );
    return await readEntry(decoded.value);
  }).context(`fs entry: ${rawPath || '(root)'}`);
}

// ── THE handler pattern: every endpoint is one pipeline + one destructure ────

async function reply<T extends JsonValue>(task: Task<T, ApiFailure>): Promise<Reply> {
  // The bare union, not a box: `.result()` never rejects for a DECLARED failure, and Failure.is
  // narrows both arms — so the success value needs no unwrapping at all.
  const outcome = await task.result();
  if (!Failure.is(outcome)) return { status: 200, body: outcome };

  // Failure.causes walks the chain cycle-safely and depth-bounded, which the hand-rolled loop
  // this replaces did not.
  const chain = Failure.causes(outcome)
    .slice(1)
    .map((cause) => Failure.format(cause));
  return {
    status: STATUS[outcome.code] ?? 500,
    body: { error: outcome.message, code: outcome.code, chain },
  };
}

const INDEX: JsonValue = {
  routes: ['/fs/{path}', '/github/:username', '/gitlab/:username', '/bug'],
};

function route(req: IncomingMessage): Promise<Reply> {
  if (req.method !== 'GET')
    return reply(Task.fail(MethodNotAllowed({ method: req.method ?? '(none)' })));
  const { pathname } = new URL(req.url ?? '/', 'http://internal');
  const segments = pathname.split('/').filter(Boolean);
  const head = segments.at(0) ?? '';
  const username = segments.at(1) ?? '';

  if (segments.length === 0) return reply(Task<JsonValue, ApiFailure>(() => INDEX));
  else if (head === 'fs') return reply(taskFs(segments.slice(1).join('/')));
  else if (head === 'github' && segments.length === 2) return reply(githubProfile(username));
  else if (head === 'gitlab' && segments.length === 2) return reply(gitlabProfile(username));
  else if (head === 'bug')
    return reply(Task<JsonValue, ApiFailure>(() => JSON.parse('{malformed') as JsonValue)); // tier-2 on purpose
  else return reply(Task.fail(NotFound({ detail: `no route: ${pathname}` })));
}

// ── the server: ONE bug boundary — spelled with .catch(), not the keyword ────

const server = createServer(async (req, res) => {
  // THE boundary. Only undeclared throws (bugs) land here — .result() rethrew them on purpose.
  // Loud in the log, clean 500 to the client, the process survives. Note it needs no try/catch:
  // the promise .catch() method does the same job without the keyword or the indentation.
  const outcome = await route(req).catch((bug): Reply => {
    console.error('BUG escaped .result():', bug);
    return { status: 500, body: { error: 'internal error' } };
  });
  res
    .writeHead(outcome.status, { 'content-type': 'application/json' })
    .end(JSON.stringify(outcome.body, null, 2));
});

await new Promise<void>((listening) => server.listen(0, listening));
const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

// ── demo mode: exercise every endpoint and status class against ourselves ────

const DEMO_PATHS = [
  '/', //  200 index
  '/fs/package.json', //  200 file content
  '/fs/lib', //  200 directory listing
  '/fs/no-such-file.txt', //  404 declared: ENOENT classified at the fs edge
  '/fs/%2e%2e%2fetc%2fpasswd', //  400 declared: traversal rejected
  '/github/izelnakri', //  200 upstream API → Profile
  '/github/no-such-user-8f3a1c9d2e', //  404 declared: upstream 404 classified at the http edge
  '/gitlab/sytses', //  200 same Profile shape, different API
  '/bug', //  500 tier-2: rethrown by .result(), caught at THE boundary
];

if (process.argv.includes('--serve')) {
  console.log(`serving ${origin}  (root: ${ROOT})`);
} else {
  console.log(`demo against ${origin}\n`);
  for (const path of DEMO_PATHS) {
    const response = await fetch(origin + path);
    const body = JSON.stringify(await response.json());
    console.log(
      String(response.status).padEnd(5),
      `GET ${path}`.padEnd(38),
      body.length > 90 ? `${body.slice(0, 87)}...` : body,
    );
  }
  server.close();
}
