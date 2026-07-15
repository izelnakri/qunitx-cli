import { resolveStack, type SourceMapDecoder } from '../utils/source-map-decoder.ts';
import type { TestDetails } from './types.ts';

/**
 * Extracts the source location from a stack trace string.
 * Supports Chrome/Node style "at func (url:line:col)" and Firefox/WebKit style "@url:line:col".
 * Returns a clean location string without surrounding parens, or null if nothing can be extracted.
 */
export function extractStackAt(stack: string | null | undefined): string | null {
  if (!stack) return null;
  // Chrome/Node: "at func (url:line:col)" — capture inside parens
  const chromeMatch = stack.match(/\(([^)\n]+:[0-9]+:[0-9]+)\)/);
  if (chromeMatch) return chromeMatch[1].replace('file://', '');
  // Firefox/WebKit: "funcname@url:line:col" or just "@url:line:col"
  const geckoMatch = stack.match(/@([^\s\n@]+:[0-9]+:[0-9]+)/);
  if (geckoMatch) return geckoMatch[1];
  return null;
}

/**
 * One failing assertion, normalized for rendering. Every reporter needs the same three
 * things — what failed, where in the *original* source, and the values involved — so the
 * source-map resolution and value normalization happen once here rather than per reporter.
 */
export interface FailureInfo {
  /** 1-based index of the assertion within the test (matches TAP's `Assertion #N`). */
  index: number;
  /** The assertion's message, or `null` when it had none. */
  message: string | null;
  /** The value the assertion saw, normalized so circular refs are safe to dump. */
  actual: unknown;
  /** The value the assertion required, normalized the same way as `actual`. */
  expected: unknown;
  /** Stack with bundle frames rewritten to original sources when a decoder is available. */
  stack: string | null;
  /** `path:line:col` of the first user frame (preferred) or the raw stack location. */
  at: string | null;
  /** The original source line's text, when the map embeds `sourcesContent`. */
  source: string | null;
}

/**
 * Extracts every genuinely-failing assertion (todo assertions are expected to fail and are
 * excluded) from a `testEnd` payload, resolving stacks back to original sources.
 */
export function failedAssertions(
  details: TestDetails,
  decoder?: SourceMapDecoder | null,
  projectRoot?: string,
): FailureInfo[] {
  // `index` counts every assertion, not only the failing ones — it is TAP's `Assertion #N`, so
  // it must not shift when passing ones drop out. flatMap keeps that index without a filter
  // pass: returning `[]` skips, returning the object keeps it (flatMap flattens one level).
  return (details.assertions ?? []).flatMap((assertion, index) =>
    assertion.passed || assertion.todo !== false
      ? []
      : {
          index: index + 1,
          message: assertion.message || null,
          actual: normalizeValue(assertion.actual),
          expected: normalizeValue(assertion.expected),
          ...resolveLocation(assertion.stack, decoder, projectRoot),
        },
  );
}

/** Splits an `at` string (`path:line:col`) into parts; returns null when it isn't a location. */
export function parseAt(at: string | null): { file: string; line: number; col: number } | null {
  if (!at) return null;
  const match = /^(.+):(\d+):(\d+)$/.exec(at);
  return match ? { file: match[1], line: Number(match[2]), col: Number(match[3]) } : null;
}

// Without a decoder the raw stack is all we have. With one, frames resolve back to the original
// sources and `at` prefers the first user frame — when every frame is node_modules or
// unresolvable, null is cleaner than pointing at the bundle URL.
function resolveLocation(
  stack: string | null | undefined,
  decoder?: SourceMapDecoder | null,
  projectRoot?: string,
): Pick<FailureInfo, 'stack' | 'at' | 'source'> {
  if (!decoder || !projectRoot || !stack) {
    return { stack: stack?.trim() || null, at: extractStackAt(stack), source: null };
  }

  const { resolvedStack, firstUserFrame, firstUserSourceText } = resolveStack(
    stack,
    decoder,
    projectRoot,
  );
  return { stack: resolvedStack.trim() || null, at: firstUserFrame, source: firstUserSourceText };
}

// QUnit assertion values can carry circular references (DOM nodes, framework objects). Round
// -tripping through JSON with a circular replacer keeps them dumpable by every reporter.
function normalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value, getCircularReplacer()));
}

function getCircularReplacer(): (_key: string, value: unknown) => unknown {
  const ancestors: object[] = [];
  return function (this: object, _key: string, value: unknown) {
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    while (ancestors.length > 0 && ancestors.at(-1) !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(value)) {
      return '[Circular]';
    }
    ancestors.push(value);
    return value;
  };
}
