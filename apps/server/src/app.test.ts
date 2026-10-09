import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from './app';
import type { AppDeps } from './composition';
import type { EnrollmentService } from './services/enrollments';
import type { SessionService } from './services/sessions';
import type { TranslationService } from './services/translations';
import type { UserService } from './services/users';
import type { GrantService } from './services/grants';
import type { VocabularyService } from './services/vocabulary';
import { createFakeAppDeps, createFakeLogger } from '../tests/support/fakes';

// A service that fails if it is called at all. Passing it alongside a health fake
// proves the health route never reaches the service, rather than assuming it.
const unreachableSessions: SessionService = {
  answerJudged: () => {
    throw new Error('the health route must not reach the session service');
  },
  answerBySpeech: () => {
    throw new Error('the health route must not reach the session service');
  },
  createNextSession: () => {
    throw new Error('the health route must not reach the session service');
  },
  getSession: () => {
    throw new Error('the health route must not reach the session service');
  },
  currentSession: () => {
    throw new Error('the health route must not reach the session service');
  },
  skipSession: () => {
    throw new Error('the health route must not reach the session service');
  },
  submitAnswer: () => {
    throw new Error('the health route must not reach the session service');
  },
  prepareSession: () => {
    throw new Error('the health route must not reach the session service');
  },
  failPreparation: () => {
    throw new Error('the health route must not reach the session service');
  },
};

const unreachableUsers: UserService = {
  createProfile: () => {
    throw new Error('the health route must not reach the user service');
  },
  me: () => {
    throw new Error('the health route must not reach the user service');
  },
  hasProfile: () => {
    throw new Error('the health route must not reach the user service');
  },
};

const unreachableEnrollments: EnrollmentService = {
  enroll: () => {
    throw new Error('the health route must not reach the enrollment service');
  },
  list: () => {
    throw new Error('the health route must not reach the enrollment service');
  },
};

const unreachableTranslations: TranslationService = {
  translate: () => {
    throw new Error('the health route must not reach the translation service');
  },
};

const unreachableVocabulary: VocabularyService = {
  save: () => {
    throw new Error('the health route must not reach the vocabulary service');
  },
  unsave: () => {
    throw new Error('the health route must not reach the vocabulary service');
  },
  listWords: () => {
    throw new Error('the health route must not reach the vocabulary service');
  },
  wordDetail: () => {
    throw new Error('the health route must not reach the vocabulary service');
  },
};

const unreachableGrants: GrantService = {
  invite: () => {
    throw new Error('the health route must not reach the grant service');
  },
  list: () => {
    throw new Error('the health route must not reach the grant service');
  },
  accept: () => {
    throw new Error('the health route must not reach the grant service');
  },
  end: () => {
    throw new Error('the health route must not reach the grant service');
  },
};
const unreachablePhotoImports = createFakeAppDeps().photoImports;

function depsWithPing(ok: boolean): AppDeps {
  return {
    grants: unreachableGrants,
    sessions: unreachableSessions,
    users: unreachableUsers,
    enrollments: unreachableEnrollments,
    translations: unreachableTranslations,
    vocabulary: unreachableVocabulary,
    photoImports: unreachablePhotoImports,
    health: { ping: async () => ok },
    identity: { lane: 'phase_15', database: 'lang_tutor_phase_15', port: 4001, version: 'v-test' },
    webDistDir: null,
    logger: createFakeLogger(),
    auth: createFakeAppDeps().auth,
    signedIn: createFakeAppDeps().signedIn,
    webOrigins: createFakeAppDeps().webOrigins,
  };
}

// No database: the health route's two branches are both reachable with a fake.
// The app's one database-backed case lives in tests/integration/app.test.ts.
describe('GET /health', () => {
  it('returns 200 and names the lane that answered when the check passes', async () => {
    const res = await createApp(depsWithPing(true)).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      lane: 'phase_15',
      database: 'lang_tutor_phase_15',
      port: 4001,
      version: 'v-test',
    });
  });

  // The identity is on the failure body too, and deliberately: a 503 from the
  // wrong lane is exactly as misleading as a 200 from it, and this is the body
  // a developer reads while wondering which server they reached.
  it('returns 503 and still names the lane when the check fails', async () => {
    const res = await createApp(depsWithPing(false)).request('/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      lane: 'phase_15',
      database: 'lang_tutor_phase_15',
      port: 4001,
      version: 'v-test',
    });
  });
});

// The documentation routes need no database: after phase 5, createApp takes
// fakes. Their contents are asserted in src/openapi.test.ts once all three
// routes are declared; these two are the "it is mounted and it renders" pair.
describe('the documentation routes', () => {
  it('serves an OpenAPI 3.1 document at /openapi.json', async () => {
    const res = await createApp(depsWithPing(true)).request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('lang-tutor API');
    expect(Object.keys(doc.paths)).toContain('/health');
  });

  it('serves the Scalar reference at /docs', async () => {
    const res = await createApp(depsWithPing(true)).request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

// /health is the first route converted to a createRoute definition, so its
// declared statuses are the first proof that a route's failures are published
// rather than implied.
describe('the /health route definition', () => {
  it('declares both 200 and 503 in the document', async () => {
    const res = await createApp(depsWithPing(true)).request('/openapi.json');
    const doc = await res.json();
    expect(Object.keys(doc.paths['/health'].get.responses).sort()).toEqual(['200', '503']);
  });
});

// Phase 29 (spec D11). The gate's order in createApp: open paths answer first,
// everything else under /api meets the session middleware before any service.
describe('the session gate in createApp', () => {
  it('answers 401 to an /api route with no session, before any service is reached', async () => {
    const res = await createApp(depsWithPing(true)).request('/api/enrollments');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not signed in' });
  });

  it('answers 404, not 401, to an auth path Better Auth is not mounted on', async () => {
    const res = await createApp(depsWithPing(true)).request('/api/auth/update-user', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('leaves /health and the documents open', async () => {
    const app = createApp(depsWithPing(true));
    for (const path of ['/health', '/openapi.json', '/docs']) {
      expect((await app.request(path)).status).toBe(200);
    }
  });
});

// Phase 30 (spec D1, D15). The web export is served only when webDistDir is set,
// which happens only inside the image. A temp directory stands in for the export.
describe('serving the web export (phase 30)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'web-export-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    mkdirSync(join(dir, '_expo', 'static', 'js', 'web'), { recursive: true });
    writeFileSync(join(dir, '_expo', 'static', 'js', 'web', 'entry-3f9a.js'), 'globalThis.loaded = true;');
    writeFileSync(join(dir, 'favicon.ico'), 'icon');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const app = () => createApp({ ...depsWithPing(true), webDistDir: dir });

  it('serves index.html at / and makes the browser revalidate it', async () => {
    const res = await app().request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('id="root"');
  });

  it('serves a hashed bundle with a year-long immutable cache', async () => {
    const res = await app().request('/_expo/static/js/web/entry-3f9a.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('answers an app route with index.html, so a reload on a screen works', async () => {
    for (const path of ['/session', '/vocabulary/42']) {
      const res = await app().request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('id="root"');
    }
  });

  it('answers a missing bundle file with 404, never with the page', async () => {
    const res = await app().request('/_expo/static/js/web/entry-old.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  // Phase 29's session gate answers an /api path before the export is reached.
  it('leaves an unknown /api path to the API, never the page', async () => {
    const res = await app().request('/api/nothing-here');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('id="root"');
  });

  it('still answers /health with its JSON body', async () => {
    const res = await app().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version: 'v-test' });
  });

  it('does not answer a POST to an app route with the page', async () => {
    const res = await app().request('/session', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('serves nothing at / when webDistDir is null, as in every lane', async () => {
    const res = await createApp(depsWithPing(true)).request('/');
    expect(res.status).toBe(404);
  });
});
