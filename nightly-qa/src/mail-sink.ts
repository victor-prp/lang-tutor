import { createServer, type IncomingMessage } from 'node:http';

import { mailsFrom, renderInbox, type Mail } from './inbox.ts';

/**
 * Stands in for Resend during a QA run (phase 29): `POST /emails` keeps the
 * message and answers as Resend does, `GET /inbox?email=<address>` shows that
 * address's messages, newest first. In memory only; up.sh starts it and
 * down.sh stops it. Usage: tsx nightly-qa/src/mail-sink.ts <port>
 */
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  console.error('usage: tsx nightly-qa/src/mail-sink.ts <port>');
  process.exit(1);
}

const mails: Mail[] = [];

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/emails') {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      // Not JSON: refused below like any other malformed send.
    }
    const received = mailsFrom(parsed);
    if (!received) {
      res.writeHead(422, { 'content-type': 'application/json' }).end('{"message":"not an email"}');
      return;
    }
    mails.push(...received);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"qa"}');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/inbox') {
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(renderInbox(url.searchParams.get('email') ?? '', mails));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
}).listen(port, () => {
  console.log(`  ok         mail sink on :${port}`);
});
