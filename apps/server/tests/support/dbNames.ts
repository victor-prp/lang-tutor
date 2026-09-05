const HOST = process.env.PGHOST ?? 'localhost';
const PORT = process.env.PGPORT ?? '5432';

/** The maintenance database. CREATE/DROP DATABASE cannot run from inside the target. */
export const ADMIN_URL = `postgres://postgres:postgres@${HOST}:${PORT}/postgres`;

export function urlFor(name: string): string {
  return `postgres://postgres:postgres@${HOST}:${PORT}/${name}`;
}

// One template per Jest worker, not one shared template: CREATE DATABASE locks
// its template for the duration of the copy, so a single template would make
// every worker serialise on it.
export function templateName(workerId: string | number): string {
  return `lang_tutor_tmpl_${workerId}`;
}

/** Jest sets JEST_WORKER_ID from 1; it is unset outside a worker. */
export function currentWorkerId(): string {
  return process.env.JEST_WORKER_ID ?? '1';
}
