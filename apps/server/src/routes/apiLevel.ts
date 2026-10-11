import { API_LEVEL_HEADER } from '@lang-tutor/core/apiLevel';
import type { MiddlewareHandler } from 'hono';

/**
 * Phase 32 (spec D9). Answers 426 to a native app older than the wire contract,
 * which the app turns into its "update required" screen.
 *
 * Only a well-formed lower level is refused. No header is the web app, which
 * is served by this same image and is never behind, or a tool like curl; a
 * garbled one is let through, because locking a current client out is worse
 * than letting an old one meet an error.
 */
export function createApiLevelGate({ apiLevel }: { apiLevel: number }): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.header(API_LEVEL_HEADER);
    if (raw !== undefined && /^\d+$/.test(raw) && Number(raw) < apiLevel) {
      return c.json({ error: 'app_update_required' }, 426);
    }
    await next();
  };
}
