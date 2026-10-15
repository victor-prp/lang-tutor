import type { MiddlewareHandler } from 'hono';

import type { Logger } from '../logger';

/** A request body over this many bytes is not read for the log: a photo import
 *  is about 2.7 MB of base64, and is never even parsed for it. */
export const MAX_LOGGED_BODY_BYTES = 256 * 1024;
/** A string over this many characters is media (base64 audio or a photo), the
 *  only data this API carries in strings that long. */
export const MAX_LOGGED_STRING_CHARS = 2_000;

const MASKED = '<masked>';
// The session cookie, and the bearer secrets of the bot route and the reminder tick.
const MASKED_HEADERS = new Set(['cookie', 'authorization']);
// Better Auth's `token`, the email code's `otp`, a push device's `token`, the
// bot sign-in's session `cookie`.
const MASKED_FIELD = /(token|password|secret|otp|cookie)$/i;

/** Every header by its lower-case name, credentials masked. */
export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name] = MASKED_HEADERS.has(name) ? MASKED : value;
  });
  return out;
}

/** A parsed JSON body as it may be logged: credential fields masked at any
 *  depth, and strings long enough to be media left out. */
export function redactBody(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_LOGGED_STRING_CHARS ? `<omitted: ${value.length} chars>` : value;
  }
  if (Array.isArray(value)) return value.map(redactBody);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, MASKED_FIELD.test(key) ? MASKED : redactBody(field)]),
    );
  }
  return value;
}

// What a request or response body becomes in the log. A copy is read, never the
// original, so the handler (Better Auth reads the raw request) still gets it.
// Only a JSON request body that declares a length within the limit is read at
// all: one with no length could be any size, and is read before any route's own
// limit. A response is this server's own JSON, which Hono sends without a
// length, so it is read and then held to the same limit.
// Anything that goes wrong here is a line in the log, never a failed request.
async function loggedBody(message: Request | Response, side: 'request' | 'response'): Promise<unknown> {
  try {
    // A plain object, by lower-case name: Headers lower-cases them as it iterates.
    const headers: Record<string, string> = Object.fromEntries(message.headers);
    const length = headers['content-length'];
    if (length === undefined && side === 'request') return '<omitted: no content-length>';
    if (length !== undefined && !(Number(length) <= MAX_LOGGED_BODY_BYTES)) return `<omitted: ${length} bytes>`;
    const type = headers['content-type'] ?? 'no content-type';
    if (!type.includes('json')) return `<omitted: ${type}${length === undefined ? '' : `, ${length} bytes`}>`;
    const text = await message.clone().text();
    if (text.length > MAX_LOGGED_BODY_BYTES) return `<omitted: ${Buffer.byteLength(text)} bytes>`;
    try {
      return redactBody(JSON.parse(text));
    } catch {
      return `<omitted: unparsable json, ${Buffer.byteLength(text)} bytes>`;
    }
  } catch {
    return '<omitted: unreadable>';
  }
}

/** What `/api/*` runs where no request is logged: a test's app, whose logger
 *  keeps to the events the test asserts on. */
export const passRequestsThrough: MiddlewareHandler = (_c, next) => next();

/**
 * Lines per request, through the one Logger, joined by `req`: `request_started`
 * the moment it arrives, `request_body` once its body has arrived, and
 * `request_finished` when its response is ready. A request that never finishes
 * is a started line with no finished line, which is what makes a stalled
 * request findable after the fact; the started line never waits on the body,
 * so a slow upload is on record too.
 *
 * `req` is a counter this closure holds: short enough to grep, no randomness to
 * inject (ADR 0002), and the timestamps around the line tell two runs apart.
 * `bodies` is the one switch that takes request and response bodies out.
 */
export function createRequestLog({ logger, now, bodies }: { logger: Logger; now: () => number; bodies: boolean }): MiddlewareHandler {
  let count = 0;
  return async (c, next) => {
    count += 1;
    const req = `r${count}`;
    const url = new URL(c.req.url);
    const line = { req, method: c.req.method, path: url.pathname };
    const startedAt = now();
    logger.info({
      event: 'request_started',
      ...line,
      query: url.search.replace(/^\?/, ''),
      headers: redactHeaders(c.req.raw.headers),
    });
    // Read beside the handler, never ahead of it: loggedBody does not reject.
    if (bodies && c.req.raw.body !== null) {
      void loggedBody(c.req.raw, 'request').then((body) => logger.info({ event: 'request_body', req, body }));
    }

    await next();

    logger.info({
      event: 'request_finished',
      ...line,
      status: c.res.status,
      duration_ms: now() - startedAt,
      ...(bodies && c.res.body !== null ? { body: await loggedBody(c.res, 'response') } : {}),
    });
  };
}
