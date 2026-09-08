/** The Hono server started by playwright.config.ts's first webServer entry. */
export const API_URL = 'http://localhost:3001';

/** The static web export served by the second webServer entry. */
export const APP_URL = 'http://localhost:8082';

/** The shared MockServer compose service, standing in for the Gemini API. */
export const MOCKSERVER_URL = 'http://localhost:1080';
