// design.ts — design study: a Task-based web server where the try/catch KEYWORD exists in
// exactly ONE function body in the entire program (Result.try). Endpoints stay flat.
// run:   node design.ts                 (starts on an ephemeral port, demos every endpoint, exits)
//        node design.ts --serve         (keeps serving; GITHUB_TOKEN honored if set)
// check: deno check design.ts
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
//    the try/catch keyword once for the whole program and returns the same flat { ok, value, error }
//    shape, so error handling never adds indentation anywhere else. A server wants BOTH layers.
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

// ── Task<T, E> core, with the two-tier .result() gate ────────────────────────

/** The declared-failure tier: anything a caller is EXPECTED to handle carries an HTTP status.
 *  Everything else that throws is a bug and belongs to the boundary, not to .result(). */
export class Failure extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'Failure';
    this.httpStatus = httpStatus;
  }
}

export type Result<T, E> =
  | { ok: true; value: T; error?: never }
  | { ok: false; value?: never; error: E };

/** The sync twin of Task — and THE ONLY place in the entire program where the try/catch keyword
 *  exists. Mirrors Promise.try's signature: `Result.try(fn, ...args)` runs fn NOW, synchronously.
 *  It boxes EVERY throw (this is the raw sync edge — classifying the boxed error into a declared
 *  Failure happens flat at the call site, exactly like adapters do for async). Note the mirrored
 *  gates: Result.try boxes everything; Task.result() boxes only declared Failures. Anything
 *  returning a promise belongs in Task, not here. */
export const Result = {
  try<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Result<T, unknown> {
    try {
      return { ok: true, value: fn(...args) };
    } catch (error) {
      return { ok: false, error };
    }
  },
};

class TaskImpl<T, E extends Failure = Failure> implements PromiseLike<T> {
  #recipe: () => Promise<T>;
  #memo: Promise<T> | undefined;
  constructor(recipe: () => Promise<T>) { this.#recipe = recipe; }

  /** Start the run NOW without suspending; `await t` later joins it. */
  perform(): Promise<T> {
    this.#memo ??= this.#recipe();
    return this.#memo;
  }

  /** Lazy: the recipe runs on the FIRST await/then, then memoizes (a promise settles once). */
  then<R1 = T, R2 = never>(
    onOk?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onErr?: ((reason: E) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.perform().then(onOk, onErr);
  }

  /** A fresh execution of THIS task's recipe (shallow on derived tasks — retry re-runs the
   *  derivation but hits the source's memo; deep retry is `source.retry().map(...)`). */
  retry(): Task<T, E> {
    return Task<T, E>(this.#recipe);
  }

  /** anyhow-style context. Wraps DECLARED failures only — a bug passes through untouched,
   *  because promoting a bug into the declared tier would hide it from the boundary. */
  expect(message: string): Task<T, Failure> {
    return Task<T, Failure>(() =>
      this.perform().catch((cause) => {
        if (cause instanceof Failure) throw new Failure(message, cause.httpStatus, { cause });
        throw cause;
      }),
    );
  }

  /** `.then(fn)` that STAYS a Task — lazy, retryable, E preserved. */
  map<U>(fn: (value: T) => U | PromiseLike<U>): Task<U, E> {
    return Task<U, E>(() => this.perform().then(fn));
  }

  /** Transform the failure channel E→F; success passes through. */
  mapErr<F extends Failure>(fn: (error: E) => F): Task<T, F> {
    return Task<T, F>(() =>
      this.perform().catch((error) => { throw error instanceof Failure ? fn(error as E) : error; }),
    );
  }

  /** The bridge out of throw-land — and the TWO-TIER GATE: a declared Failure becomes err,
   *  a bug RETHROWS so it lands at the server boundary instead of being silently boxed. */
  result(): Promise<Result<T, E>> {
    return this.perform().then(
      (value): Result<T, E> => ({ ok: true, value }),
      (error): Result<T, E> => {
        if (error instanceof Failure) return { ok: false, error: error as E };
        throw error;
      },
    );
  }
}

export function Task<T, E extends Failure = Failure>(recipe: () => Promise<T>): Task<T, E> {
  return new TaskImpl<T, E>(recipe);
}
export type Task<T, E extends Failure = Failure> = TaskImpl<T, E>;

/** A pre-failed Task — for routing dead-ends, so every path speaks the same pattern. */
function fail(message: string, httpStatus: number): Task<never, Failure> {
  return Task(() => Promise.reject(new Failure(message, httpStatus)));
}

// ── shared JSON typing ────────────────────────────────────────────────────────

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Reply = { status: number; body: JsonValue };

// ── adapter: upstream JSON APIs (the ordinary async world + one conversion) ──

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!response.ok) {
    // Edge classification: upstream's 404 is OUR 404; any other upstream failure is OUR 502.
    throw new Failure(`upstream ${response.status} from ${url}`, response.status === 404 ? 404 : 502);
  }
  return await response.json() as T;
}

function taskJson<T>(url: string, headers?: Record<string, string>): Task<T, Failure> {
  return Task(() => fetchJson<T>(url, headers)); // closure keeps args, defers the fetch
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

function githubProfile(username: string): Task<Profile, Failure> {
  const token = process.env.GITHUB_TOKEN;
  return taskJson<GithubApiUser>(
    `https://api.github.com/users/${encodeURIComponent(username)}`,
    token ? { authorization: `Bearer ${token}` } : {},
  )
    .map((u): Profile => ({ source: 'github', username: u.login, name: u.name, url: u.html_url, followers: u.followers }))
    .expect(`github profile: ${username}`);
}

function gitlabProfile(username: string): Task<Profile, Failure> {
  return taskJson<GitlabApiUser[]>(`https://gitlab.com/api/v4/users?username=${encodeURIComponent(username)}`)
    .map(([user]): Profile => {
      if (!user) throw new Failure(`gitlab user not found: ${username}`, 404); // a Failure may rise mid-pipeline
      return { source: 'gitlab', username: user.username, name: user.name, url: user.web_url, followers: null };
    })
    .expect(`gitlab profile: ${username}`);
}

// ── endpoint: /fs/{path} — file-system exposure, rooted and traversal-safe ───

const ROOT = process.cwd();
const MAX_CONTENT = 16_384;

type FsEntry =
  | { type: 'directory'; path: string; entries: string[] }
  | { type: 'file'; path: string; size: number; truncated: boolean; content: string };

/** Edge classification for raw fs errors: known errnos become declared Failures, unknown stay bugs. */
function classifyErrno(error: Error & { code?: string }, path: string): Error {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return new Failure(`no such path: ${path}`, 404, { cause: error });
  if (error.code === 'EACCES' || error.code === 'EPERM') return new Failure(`forbidden: ${path}`, 403, { cause: error });
  return error;
}

async function readEntry(relPath: string): Promise<FsEntry> {
  const full = resolve(ROOT, relPath);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) throw new Failure(`path escapes served root: ${relPath}`, 400);
  const stats = await stat(full).catch((e) => { throw classifyErrno(e, relPath); });
  if (stats.isDirectory()) {
    return { type: 'directory', path: relPath, entries: await readdir(full) };
  }
  const content = await readFile(full, 'utf8').catch((e) => { throw classifyErrno(e, relPath); });
  return { type: 'file', path: relPath, size: stats.size, truncated: content.length > MAX_CONTENT, content: content.slice(0, MAX_CONTENT) };
}

function taskFs(rawPath: string): Task<FsEntry, Failure> {
  return Task(async () => {
    // The sync edge, flat: Result.try boxes the raw URIError, one `if` classifies it — no
    // indentation, no keyword. This is DESIGN NOTE 1 in action.
    const decoded = Result.try(decodeURIComponent, rawPath);
    if (!decoded.ok) throw new Failure(`malformed percent-encoding: ${rawPath}`, 400, { cause: decoded.error });
    return await readEntry(decoded.value);
  }).expect(`fs entry: ${rawPath || '(root)'}`);
}

// ── THE handler pattern: every endpoint is one pipeline + one destructure ────

function causeChain(failure: Error): string[] {
  const chain: string[] = [];
  for (let cause = failure.cause; cause instanceof Error; cause = cause.cause) chain.push(cause.message);
  return chain;
}

async function reply<T extends JsonValue>(task: Task<T, Failure>): Promise<Reply> {
  const { ok, value, error } = await task.result(); // never rejects for DECLARED failures
  return ok
    ? { status: 200, body: value }
    : { status: error.httpStatus, body: { error: error.message, chain: causeChain(error) } };
}

const INDEX: JsonValue = {
  routes: ['/fs/{path}', '/github/:username', '/gitlab/:username', '/bug'],
};

function route(req: IncomingMessage): Promise<Reply> {
  if (req.method !== 'GET') return reply(fail(`method not allowed: ${req.method}`, 405));
  const { pathname } = new URL(req.url ?? '/', 'http://internal');
  const segments = pathname.split('/').filter(Boolean);
  const head = segments.at(0) ?? '';
  const username = segments.at(1) ?? '';

  if (segments.length === 0) return reply(Task(async () => INDEX));
  else if (head === 'fs') return reply(taskFs(segments.slice(1).join('/')));
  else if (head === 'github' && segments.length === 2) return reply(githubProfile(username));
  else if (head === 'gitlab' && segments.length === 2) return reply(gitlabProfile(username));
  else if (head === 'bug') return reply(Task(async () => JSON.parse('{malformed') as JsonValue)); // tier-2 on purpose
  else return reply(fail(`no route: ${pathname}`, 404));
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
  res.writeHead(outcome.status, { 'content-type': 'application/json' })
    .end(JSON.stringify(outcome.body, null, 2));
});

await new Promise<void>((listening) => server.listen(0, listening));
const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

// ── demo mode: exercise every endpoint and status class against ourselves ────

const DEMO_PATHS = [
  '/',                                //  200 index
  '/fs/package.json',                 //  200 file content
  '/fs/lib',                          //  200 directory listing
  '/fs/no-such-file.txt',             //  404 declared: ENOENT classified at the fs edge
  '/fs/%2e%2e%2fetc%2fpasswd',        //  400 declared: traversal rejected
  '/github/izelnakri',                //  200 upstream API → Profile
  '/github/no-such-user-8f3a1c9d2e',  //  404 declared: upstream 404 classified at the http edge
  '/gitlab/sytses',                   //  200 same Profile shape, different API
  '/bug',                             //  500 tier-2: rethrown by .result(), caught at THE boundary
];

if (process.argv.includes('--serve')) {
  console.log(`serving ${origin}  (root: ${ROOT})`);
} else {
  console.log(`demo against ${origin}\n`);
  for (const path of DEMO_PATHS) {
    const response = await fetch(origin + path);
    const body = JSON.stringify(await response.json());
    console.log(String(response.status).padEnd(5), `GET ${path}`.padEnd(38), body.length > 90 ? `${body.slice(0, 87)}...` : body);
  }
  server.close();
}
