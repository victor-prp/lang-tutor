import { PushUnavailable } from '../errors';

/**
 * Phase 52 (spec D7). Expo's push service over plain `fetch`. `expo-server-sdk` hard-codes its
 * host, and ADR 0001's providers take a base URL so that tests and e2e reach MockServer, as
 * GEMINI_BASE_URL and RESEND_BASE_URL do. Only composition.ts imports this file (ADR 0001 R11),
 * and it satisfies the `PushSender` contract in services/reminders.ts, which providers/ may
 * not import (R10): the annotation at the call site checks it.
 */
export const PUSH_TIMEOUT_MS = 10_000;

// Expo's documented limits for one request: 100 messages to send, 1000 ids to ask receipts for.
const SEND_CHUNK = 100;
const RECEIPT_CHUNK = 1000;

const HEADERS = { accept: 'application/json', 'content-type': 'application/json' };

type Message = {
  to: string;
  title: string;
  body: string;
  channelId: string;
  priority: 'default' | 'normal' | 'high';
  data: Record<string, string>;
};
type Ticket = { status: 'ok'; id: string } | { status: 'error'; message: string; details?: { error?: string } };
type Receipt = { status: 'ok' } | { status: 'error'; message: string; details?: { error?: string } };

function chunksOf<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

const isTimeout = (error: unknown): boolean =>
  error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');

export function createExpoPushClient({
  fetch,
  baseUrl,
  timeoutMs,
}: {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  timeoutMs: number;
}) {
  /** One POST; the `data` member of Expo's answer. Every way it can fail is a PushUnavailable. */
  async function post(path: string, body: unknown): Promise<unknown> {
    // One signal for the whole request, body included: a server that answers its headers and
    // then stalls must not hold the tick.
    const signal = AbortSignal.timeout(timeoutMs);
    let json: unknown;
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new PushUnavailable(res.status);
      json = await res.json();
    } catch (error) {
      if (error instanceof PushUnavailable) throw error;
      if (isTimeout(error)) throw new PushUnavailable('timeout');
      // `res.json()` failing on a body that is not JSON is a SyntaxError; a refused or reset
      // connection is a TypeError. Neither is something the tick can do differently.
      throw new PushUnavailable(error instanceof SyntaxError ? 'unreadable' : 'network');
    }
    if (typeof json !== 'object' || json === null || !('data' in json)) throw new PushUnavailable('unreadable');
    return json.data;
  }

  return {
    /** One ticket per message, in the order the messages came. */
    send: async (messages: Message[]): Promise<Ticket[]> => {
      const tickets: Ticket[] = [];
      for (const chunk of chunksOf(messages, SEND_CHUNK)) {
        const data = await post('/--/api/v2/push/send', chunk);
        // Tickets are matched to messages by position. A list of another length would give a
        // device its neighbour's ticket, and a DeviceNotRegistered would delete the wrong token.
        if (!Array.isArray(data) || data.length !== chunk.length) throw new PushUnavailable('unreadable');
        tickets.push(...(data as Ticket[]));
      }
      return tickets;
    },

    /** The receipts Expo has so far, by ticket id; an id it has no receipt for yet is absent. */
    receipts: async (ids: string[]): Promise<Record<string, Receipt>> => {
      const receipts: Record<string, Receipt> = {};
      for (const chunk of chunksOf(ids, RECEIPT_CHUNK)) {
        const data = await post('/--/api/v2/push/getReceipts', { ids: chunk });
        if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new PushUnavailable('unreadable');
        Object.assign(receipts, data);
      }
      return receipts;
    },
  };
}
