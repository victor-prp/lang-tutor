import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * Phase 30 (spec D1, D15). The web export, served by the same process as the
 * API, so the page and the API share one origin. app.ts registers this with
 * `app.use`, after every route, so it only sees requests no route answered.
 *
 * Three answers, in order:
 *   1. a file in the export, when one matches the path;
 *   2. index.html, for an app route — a path outside /api whose last segment
 *      has no dot. The export is a single page (D15), and a reload on /session
 *      asks the server for /session;
 *   3. nothing, which is the app's 404, for everything else. A missing bundle
 *      file must not come back as HTML, and an unknown API path keeps the
 *      API's 404.
 */

const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * index.html is revalidated every time: after a release it names new bundle
 * files, and a cached copy would point at files the new image does not have.
 * Files under /_expo/static/ carry a content hash in their names, so a given
 * name never changes and can be cached for a year.
 */
export function cacheControlFor(filePath: string): string | null {
  if (filePath.endsWith('.html')) return NO_CACHE;
  if (filePath.includes('/_expo/static/')) return IMMUTABLE;
  return null;
}

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

export function isAppRoute(path: string): boolean {
  if (isApiPath(path)) return false;
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  return !lastSegment.includes('.');
}

export function createWebHandler(root: string): MiddlewareHandler {
  const onFound = (filePath: string, c: Context) => {
    const value = cacheControlFor(filePath);
    if (value) c.header('Cache-Control', value);
  };
  const files = serveStatic({ root, onFound });
  const page = serveStatic({ root, path: 'index.html', onFound });
  const nothing = async () => {};

  return async (c, next) => {
    const method = c.req.method;
    if ((method !== 'GET' && method !== 'HEAD') || isApiPath(c.req.path)) return next();
    const file = await files(c, nothing);
    if (file) return file;
    if (!isAppRoute(c.req.path)) return next();
    return (await page(c, nothing)) ?? next();
  };
}
