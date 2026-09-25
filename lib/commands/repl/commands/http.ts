import path from 'node:path';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { edit, openInEditor, readIfThere, whatToRun } from '../editor.ts';
import { MAX_BODY_PREVIEW_LINES_COUNT, printBody, printStatus } from '../print-request.ts';
import { red } from '../../../utils/color.ts';
import { request, resolveUserInputURL, setQueryParams, store } from '../../../repl/http-service.ts';
import type { ReplCommand, ReplContext } from '../command.ts';

/**
 * `.get`, `.post`, `.put`, `.patch` and `.delete` — one command each, one implementation.
 *
 * The same shape as {@link openingIn}: five names that differ only in a word, so the word is the
 * argument and the rest is written once.
 *
 * A path is the PAGE's own server — `.get /tests.js` is the file the suite loaded — which is the
 * whole reason this belongs in a browser REPL rather than in a terminal beside it. Anywhere else
 * is spelled with a scheme.
 *
 * The request is made from Node, not from the tab. A `fetch` inside the page cannot report what it
 * sent, cannot set `host` or `user-agent`, and cannot read `set-cookie` back — `.header sent` and
 * `.header received` would both be fiction. From here they are the truth.
 *
 * ```ts
 * import { buildCommand } from './http.ts';
 *
 * typeof buildCommand('GET').main; // 'function' — a command, waiting for a context
 * ```
 */
export function buildCommand(verb: string): ReplCommand {
  const name = verb.toLowerCase();
  // A GET has nowhere to put a body, so what follows its URL is the query instead. Both read the
  // input the same way — as JavaScript, in the page — so it is one rule with two destinations.
  const sendsBody = verb !== 'GET';

  return {
    description: buildDescription(verb),
    async main(repl, argument) {
      const asked = argument.trim();
      if (asked === '') return repl.log(printCommandUsage(name));

      const [target = '', ...words] = asked.split(/\s+/);
      const input = words.join(' ');
      const url = resolveUserInputURL(target, repl.session.url);
      if (url === null) return repl.log(red(`.${name} cannot make a URL out of ${target}`));

      const body = sendsBody ? await resolveRequestBodyFromInput(repl, input) : null;
      if (body !== null && typeof body !== 'string') return repl.log(red(body.refused));

      const requestedURL = sendsBody ? url : await buildQueryParamsFromInput(repl, url, input);
      if (typeof requestedURL !== 'string') return repl.log(red(requestedURL.refused));

      const finishedRequest = await request({
        verb,
        url: requestedURL,
        headers: repl.http.headers,
        body,
      });
      store(repl.http, finishedRequest);

      // No line for the target: it is what you just typed, and `printStatus` names it anyway.
      repl.log(printStatus(finishedRequest, repl.palette));
      if (finishedRequest.response !== null) {
        repl.log(printBody(finishedRequest.response, repl.palette, MAX_BODY_PREVIEW_LINES_COUNT));
      }
    },
  };
}

/**
 * The body a verb command was given, in the four spellings a body is said in:
 *
 * ```
 * { name: 'Ada' }   JavaScript, evaluated in the page — see `asTyped`
 * @body.json        a file, sent as it is on disk
 * :body.json        that file in $EDITOR first, sent once it is saved
 * :                 the session's body buffer in $EDITOR, prefilled with last time's
 * ```
 *
 * `@` for a file because that is the spelling `curl -d @body.json` taught everybody. `:` for an
 * edit because it is the key every editor this prompt hands over to starts a command with, and
 * because the two marks then read as what they are: one references, the other opens.
 *
 * Returns `{ refused }` rather than throwing, because every refusal here is a sentence the prompt
 * should print rather than a stack it should raise.
 */
async function resolveRequestBodyFromInput(
  repl: ReplContext,
  input: string,
): Promise<string | null | { refused: string }> {
  if (input === '') return null;
  if (input.startsWith(':')) return await resolveRequestBodyFromEditor(repl, input.slice(1).trim());
  if (!input.startsWith('@')) return await resolveRequestBodyFromJavaScript(repl, input);

  const file = path.resolve(repl.cwd, input.slice(1));
  try {
    return await readFile(file, 'utf8');
  } catch {
    return { refused: `no file at ${input.slice(1)} to send as the body` };
  }
}

/**
 * What a GET asks for: the URL, with its argument folded into the query.
 *
 * `{ page: 2 }` is `?page=2` — the object is evaluated in the page like any other argument, so a
 * variable holding a filter is a query too. Anything that is not an object cannot be one: a GET
 * has nowhere to put it, and the two commands that do are named in the refusal.
 */
async function buildQueryParamsFromInput(
  repl: ReplContext,
  url: string,
  input: string,
): Promise<string | { refused: string }> {
  if (input === '') return url;

  // `null` when the page could not say, and when there is no page to ask — a unit test's context.
  const page = repl.session as { toJSON?: (expression: string) => Promise<string | null> };
  const json =
    typeof page?.toJSON === 'function' ? await page.toJSON(input).catch(() => null) : null;

  const value = json === null ? null : (JSON.parse(json) as unknown);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      refused: `.get sends no body — an object after the URL is its query, or did you mean .post?`,
    };
  }

  return setQueryParams(url, value as Record<string, unknown>);
}

/**
 * The body an editor left: the session's buffer with nothing after the `:`, that file with a path
 * after it.
 *
 * Saving is the send. Quitting without writing means "never mind" — the same thing it means to the
 * scratchpad, and the reason a body you are unsure about is safe to open — and saving an empty
 * buffer is how the buffer is cleared, which is worth one sentence rather than a command of its
 * own. What comes back is read as JavaScript exactly as a typed body is: an editor is a bigger box
 * to type in, not a different language.
 */
async function resolveRequestBodyFromEditor(
  repl: ReplContext,
  where: string,
): Promise<string | { refused: string }> {
  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) return { refused: 'no $EDITOR set — nothing to open a body with' };

  if (where !== '') {
    const file = path.resolve(repl.cwd, where);
    const { failed, saved } = await openInEditor(file, 1, repl.server);
    if (failed !== null) return { refused: failed.trim() };
    if (!saved) return { refused: `nothing sent — ${where} was not written` };

    return await resolveRequestBodyFromJavaScript(repl, (readIfThere(file) ?? '').trim());
  }

  const done = await edit(editor, repl.http.scratchpadText, repl.server);
  const text = whatToRun(done);
  if (!done.saved || done.aborted) return { refused: 'nothing sent — the buffer was not saved' };

  repl.http.scratchpadText = text;
  if (text === '')
    return { refused: 'nothing sent — the body buffer is empty, which also clears it' };

  return await resolveRequestBodyFromJavaScript(repl, text);
}

/**
 * What was typed, as the page reads it.
 *
 * This is a JavaScript prompt, so a body typed at it is JavaScript: `{ name: 'Izel' }` is an
 * object with an unquoted key, `user` is the variable three lines above, `new User('Izel')` is an
 * instance, and each of them is sent as the JSON of what it evaluates to — `toJSON` included,
 * since the evaluation happens in the page. Demanding valid JSON instead would mean quoting keys
 * by hand at a prompt that understands them perfectly well.
 *
 * A string stays text, because that is what a text body is: `.post /x hello` sends `hello`, and a
 * template literal is how you interpolate one. The exception is a string that is itself a literal
 * — a body wrapped in backticks — which is JavaScript again rather than the five characters of
 * punctuation it looks like.
 *
 * And anything the page cannot make sense of is sent exactly as it was typed: an undeclared name,
 * a session with no page behind it, a body that is not an expression at all. The prompt never
 * refuses a body for not being code.
 */
async function resolveRequestBodyFromJavaScript(repl: ReplContext, input: string): Promise<string> {
  // `null` when the page could not say, and when there is no page to ask — a unit test's context.
  const page = repl.session as { toJSON?: (expression: string) => Promise<string | null> };
  const json =
    typeof page?.toJSON === 'function' ? await page.toJSON(input).catch(() => null) : null;

  if (json === null) return input;
  // A JSON document that starts with a quote is a string, and a string was meant as itself.
  if (!json.startsWith('"')) return json;

  const text = JSON.parse(json) as string;
  if (!looksLikeObjectLiteral(text) || isValidJSON(text)) return text;

  const inner =
    typeof page?.toJSON === 'function' ? await page.toJSON(text).catch(() => null) : null;

  return inner !== null && !inner.startsWith('"') ? inner : text;
}

/** Whether a body looks like it was written as an object or an array rather than as prose. */
function looksLikeObjectLiteral(text: string): boolean {
  const trimmed = text.trim();

  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/** Whether it is already JSON, in which case there is nothing for a second evaluation to add. */
function isValidJSON(text: string): boolean {
  try {
    JSON.parse(text);

    return true;
  } catch {
    return false;
  }
}

/** What `.help` says beside each of the five. The example is the shortest useful one. */
function buildDescription(verb: string): string {
  const name = verb.toLowerCase();
  if (verb === 'GET')
    return 'Request a URL — `.get /api/users { page: 2 }`, where an object is the query';

  return `Send a ${verb} — \`.${name} /api/users { name: 'Ada' }\`, \`@body.json\`, or \`:\` to edit one`;
}

/** The one line somebody who typed the command bare needs, which is the shape of its argument. */
function printCommandUsage(name: string): string {
  const body = name === 'get' ? ' [{ query }]' : ' [body|@file|:file|:]';

  return `Usage: .${name} <url>${body} — a path is the page’s own server, \`http://\` for anywhere else`;
}
