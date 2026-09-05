// Shaped by the three application call sites: one structured event
// (services/sessions.ts) and two error reports (app.ts, and db/client.ts's error
// policy). A logging library would be a dependency and a configuration surface
// for three call sites; this type does not foreclose putting one behind it later.
export type Logger = {
  info(event: Record<string, unknown>): void;
  error(message: string, cause?: unknown): void;
};

// A composition root names a concrete thing — that is what it is for. This is
// the only implementation, and the only file under services/, repo/, routes/ or
// the wiring layer allowed to touch `console`.
export function createConsoleLogger(): Logger {
  return {
    // An object, not a string: the one info site is an event you tail and grep
    // without opening psql.
    info: (event) => {
      console.log(JSON.stringify(event));
    },
    error: (message, cause) => {
      if (cause === undefined) console.error(message);
      else console.error(message, cause);
    },
  };
}
