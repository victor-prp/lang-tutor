import { z } from 'zod';

/**
 * Phase 28 (spec D7, ADR 0008 R2). The ONE place on the server that names the
 * actor header. Hono lowercases header names, so the key is lowercase. Login
 * will replace this header with an authenticated identity; nothing behind it
 * changes when it does.
 */
export const ACTOR_HEADER = 'x-acting-user-id';

export const ActorHeadersSchema = z.object({
  [ACTOR_HEADER]: z
    .string()
    .min(1)
    .describe(
      'The id of the user this request acts as. ASSERTED, NOT AUTHENTICATED: the server checks ' +
        'what that user may do, and nothing proves the caller is them (ADR 0008). Login will ' +
        'replace it.',
    ),
});

export const actorOf = (headers: z.infer<typeof ActorHeadersSchema>): string => headers[ACTOR_HEADER];
