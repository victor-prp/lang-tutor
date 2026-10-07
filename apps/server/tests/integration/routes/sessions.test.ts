import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import {
  enrollmentOf,
  enrollmentOfSession,
  seedEnrollment,
  seedLegacyLearner,
  seedUser,
} from '../../support/seedUser';
import { saveSessionSenses } from '../../support/progressRows';
import { insertListSession } from '../../support/questions';
import { seedSavedSenses } from '../../support/vocabularyRows';
import { createTestDb, type TestDb } from '../../support/testDb';
import { createFakeLogger } from '../../support/fakes';
import { testRng } from '../../support/testRng';
import { createTestServerDeps } from '../../support/serverDeps';
import { createSessionsRouter } from '../../../src/routes/sessions';

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedUser(t.db, 'u_2');
});

afterEach(async () => {
  await t.close();
});

// Production's assembly, called with a per-test database — this test mounts the
// router alone, but it does not hand-wire the graph behind it. Reaching past
// composition for the repositories is what R1 forbids of routes, and a route
// test that does it anyway is not testing the seam it claims to.
function buildTestApp() {
  const app = new Hono();
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
  app.route('/api', createSessionsRouter(deps.sessions));
  return app;
}

function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getJson(app: Hono, path: string) {
  return app.request(path, { method: 'GET' });
}

// Loose on purpose: a walk reassigns it from next-step responses, which share
// the session id and the question but carry `complete` too.
type SeedView = {
  session_id: string;
  question: { id: string; question: string; options: string[]; correct_option: number };
  position: unknown;
  complete?: boolean;
};

/** The seed session and its first question, the way the app now gets them:
 *  create, then read. */
async function startSeed(app: Hono, enrollmentId: string) {
  const created = await (await postJson(app, '/api/sessions', { enrollment_id: enrollmentId })).json();
  const view = await (await getJson(app, `/api/sessions/${created.session_id}`)).json();
  return view as SeedView;
}

describe('POST /api/sessions', () => {
  it('creates the seed session: 201, ready, seed', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', { enrollment_id: enrollmentOf('u_1') });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.session_id).toBe('string');
    expect(body).toMatchObject({ status: 'ready', source: 'seed' });
  });

  it('accepts listening: true', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', { enrollment_id: enrollmentOf('u_1'), listening: true });
    expect(res.status).toBe(201);
  });

  it('rejects a listening that is not a boolean', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', { enrollment_id: enrollmentOf('u_1'), listening: 'yes' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('rejects a missing enrollment_id', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', {});
    expect(res.status).toBe(400);
  });

  // A characterisation test, added precisely because nothing asserted this
  // before. @hono/zod-openapi's built-in 400 carries a Zod issue payload
  // instead; the defaultHook restoring this body is the only thing between this
  // phase and a silent contract change. The other route tests assert
  // `res.status` only, and apps/mobile's client does `throw new
  // ApiError(res.status)` — so nothing else in this repository would notice.
  it('returns { error: "invalid request" } as the validation body', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
  it('returns 404 for an enrollment that does not exist', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', { enrollment_id: 'e_nobody' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'enrollment not found' });
  });

  it('returns 409 when the pair has too few questions — a legacy English-native learner', async () => {
    // native en, learning Hebrew: the seed holds no he/en questions. A 500 here
    // is what this phase replaced.
    const { enrollmentId } = await seedLegacyLearner(t.db);
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions', { enrollment_id: enrollmentId });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not enough questions' });
  });

  it("draws each enrollment's own pair for one learner holding two", async () => {
    await seedEnrollment(t.db, { id: 'e_u_1_ru', userId: 'u_1', targetLanguage: 'ru' });
    const app = buildTestApp();
    // The pool is keyed by the enrollment's pair and not by the learner: each
    // session is walked to the end, every prompt is in its own pair's script,
    // and each session's row names the enrollment that started it.
    const walk = async (enrollmentId: string, script: RegExp) => {
      let current = await startSeed(app, enrollmentId);
      // Spec §6: each session is attributed to its own enrollment, not merely
      // drawn from its pair.
      expect(await enrollmentOfSession(t.db, current.session_id)).toBe(enrollmentId);
      for (let i = 0; i < 10; i++) {
        expect(current.question.question).toMatch(script);
        current = await (
          await postJson(app, `/api/sessions/${current.session_id}/next-step`, {
            user_id: 'u_1',
            question_id: current.question.id,
            option_index: current.question.correct_option,
          })
        ).json();
      }
      expect(current.complete).toBe(true);
    };

    await walk('e_u_1_ru', /^\p{Script=Cyrillic}[\p{Script=Cyrillic} ]*$/u);
    await walk(enrollmentOf('u_1'), /^[A-Za-z][A-Za-z ?!']*$/);
  });

  // Phase 22. English and Italian share a script, so the regexes above cannot
  // tell their pools apart. The ten Italian seed queries are named here, as the
  // seed's own test names its counts: every Italian prompt is one of them, and
  // no English prompt is.
  it('draws Italian, never English, for a learner holding both', async () => {
    const ITALIAN = new Set([
      'finestra',
      'libro',
      'acqua',
      'amico',
      'difficile',
      'ricordare',
      'per favore',
      'buongiorno',
      'grazie mille',
      'arrivederci',
    ]);
    await seedEnrollment(t.db, { id: 'e_u_1_it', userId: 'u_1', targetLanguage: 'it' });
    const app = buildTestApp();
    const walk = async (enrollmentId: string, isItalian: boolean) => {
      let current = await startSeed(app, enrollmentId);
      expect(await enrollmentOfSession(t.db, current.session_id)).toBe(enrollmentId);
      for (let i = 0; i < 10; i++) {
        expect(ITALIAN.has(current.question.question)).toBe(isItalian);
        current = await (
          await postJson(app, `/api/sessions/${current.session_id}/next-step`, {
            user_id: 'u_1',
            question_id: current.question.id,
            option_index: current.question.correct_option,
          })
        ).json();
      }
      expect(current.complete).toBe(true);
    };

    await walk('e_u_1_it', true);
    await walk(enrollmentOf('u_1'), false);
  });
});

// Phase 23. A ready list session of three saved words, so of all three types.
async function startMixed() {
  const asked = [];
  for (const [lemma, translation] of [
    ['tome', 'ספר'],
    ['quill', 'נוצה'],
    ['lantern', 'פנס'],
  ]) {
    const saved = await seedSavedSenses(t.db, { enrollmentId: enrollmentOf('u_1'), lemma, translations: [translation] });
    asked.push({ senseId: saved.senseIds[0], variantId: saved.variantId, lexemeId: saved.lexemeId, form: lemma, lemma, translation });
  }
  return insertListSession(t.db, { userId: 'u_1', enrollmentId: enrollmentOf('u_1'), asked, alternatives: ['lamp'] });
}

describe('POST /api/sessions/:id/next-step, phase 23', () => {
  it('serves the three types and answers a typed card by its text', async () => {
    const app = buildTestApp();
    const { sessionId, questions } = await startMixed();
    const step = (question_id: string, answer: object) =>
      postJson(app, `/api/sessions/${sessionId}/next-step`, { user_id: 'u_1', question_id, ...answer });

    const first = await (await step(questions[0].id, { option_index: 0 })).json();
    expect(first.question).toMatchObject({ type: 'reverse_choice', question: 'נוצה', part_of_speech: 'noun' });
    const second = await (await step(questions[1].id, { option_index: 0 })).json();
    expect(second.question).toEqual({
      id: questions[2].id,
      type: 'typed_translation',
      vocab_term_id: questions[2].vocab_term_id,
      question: 'פנס',
      part_of_speech: 'noun',
      answer: 'lantern',
      lemma: 'lantern',
      alternatives: ['lamp'],
    });

    const done = await step(questions[2].id, { text: 'lamp' });
    expect(done.status).toBe(200);
    const body = await done.json();
    expect(body).toMatchObject({ complete: true, score: { correct: 3, total: 3 }, missed_questions: [] });
    // An alternative is right but says nothing about this sense: nothing rose.
    const lantern = body.progress.find((item: { form: string }) => item.form === 'lantern');
    expect(lantern).toMatchObject({ translation: 'פנס', raised: [] });
    const quill = body.progress.find((item: { form: string }) => item.form === 'quill');
    expect(quill).toMatchObject({ translation: 'נוצה', raised: ['written_receptive', 'written_productive'] });
  });

  it('400s an answer of the wrong kind, either way round', async () => {
    const app = buildTestApp();
    const { sessionId, questions } = await startMixed();
    const res = await postJson(app, `/api/sessions/${sessionId}/next-step`, {
      user_id: 'u_1',
      question_id: questions[0].id,
      text: 'tome',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'the answer is not the kind this question takes' });

    await postJson(app, `/api/sessions/${sessionId}/next-step`, { user_id: 'u_1', question_id: questions[0].id, option_index: 0 });
    await postJson(app, `/api/sessions/${sessionId}/next-step`, { user_id: 'u_1', question_id: questions[1].id, option_index: 0 });
    const typed = await postJson(app, `/api/sessions/${sessionId}/next-step`, {
      user_id: 'u_1',
      question_id: questions[2].id,
      option_index: 0,
    });
    expect(typed.status).toBe(400);
  });

  it('400s typed text over 100 characters', async () => {
    const app = buildTestApp();
    const { sessionId, questions } = await startMixed();
    const res = await postJson(app, `/api/sessions/${sessionId}/next-step`, {
      user_id: 'u_1',
      question_id: questions[0].id,
      text: 'x'.repeat(101),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
});

describe('POST /api/sessions/:id/next-step', () => {
  it('404s for an unknown session id', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions/00000000-0000-0000-0000-000000000000/next-step', {
      user_id: 'u_1',
      question_id: 'q0',
      option_index: 0,
    });
    expect(res.status).toBe(404);
  });

  // `sessions.id` is a `uuid` column: before the id reaches the query, a
  // malformed string must 404 like any other unknown id, not 500 with a raw
  // driver error (Postgres would otherwise reject it at the SQL level with
  // 22P02 "invalid input syntax for type uuid").
  it('404s for a malformed (non-UUID) session id, not 500', async () => {
    const app = buildTestApp();
    const res = await postJson(app, '/api/sessions/not-a-uuid/next-step', {
      user_id: 'u_1',
      question_id: 'q0',
      option_index: 0,
    });
    expect(res.status).toBe(404);
  });

  it('advances to the next question on a fresh answer', async () => {
    const app = buildTestApp();
    const created = await startSeed(app, enrollmentOf('u_1'));

    const res = await postJson(app, `/api/sessions/${created.session_id}/next-step`, {
      user_id: 'u_1',
      question_id: created.question.id,
      option_index: created.question.correct_option,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.complete).toBe(false);
    expect(body.position).toEqual({ position: 2, total: 10 });
    expect(body.question.id).not.toBe(created.question.id);
  });

  it('replays the same response when the same step is retried', async () => {
    const app = buildTestApp();
    const created = await startSeed(app, enrollmentOf('u_1'));
    const stepBody = {
      user_id: 'u_1',
      question_id: created.question.id,
      option_index: created.question.correct_option,
    };

    const first = await (
      await postJson(app, `/api/sessions/${created.session_id}/next-step`, stepBody)
    ).json();
    const retry = await (
      await postJson(app, `/api/sessions/${created.session_id}/next-step`, stepBody)
    ).json();
    expect(retry).toEqual(first);
  });

  it("409s when question_id does not match the session's current question", async () => {
    const app = buildTestApp();
    const created = await startSeed(app, enrollmentOf('u_1'));

    const res = await postJson(app, `/api/sessions/${created.session_id}/next-step`, {
      user_id: 'u_1',
      question_id: 'not-the-current-question',
      option_index: 0,
    });
    expect(res.status).toBe(409);
  });

  it('completes the session on the 10th answer, returning score and missed_questions', async () => {
    const app = buildTestApp();
    let current = await startSeed(app, enrollmentOf('u_1'));

    let last;
    for (let i = 0; i < 10; i++) {
      last = await (
        await postJson(app, `/api/sessions/${current.session_id}/next-step`, {
          user_id: 'u_1',
          question_id: current.question.id,
          option_index: current.question.correct_option,
        })
      ).json();
      current = last;
    }

    expect(last.complete).toBe(true);
    expect(last.question).toBeNull();
    expect(last.score).toEqual({ correct: 10, total: 10 });
    expect(last.missed_questions).toEqual([]);
  });

  it('tracks an incorrect answer in the final score and missed_questions', async () => {
    const app = buildTestApp();
    let current = await startSeed(app, enrollmentOf('u_1'));
    const firstQuestion = current.question;
    const wrongIndex = (firstQuestion.correct_option + 1) % firstQuestion.options.length;

    let last = await (
      await postJson(app, `/api/sessions/${current.session_id}/next-step`, {
        user_id: 'u_1',
        question_id: current.question.id,
        option_index: wrongIndex,
      })
    ).json();
    current = last;

    for (let i = 1; i < 10; i++) {
      last = await (
        await postJson(app, `/api/sessions/${current.session_id}/next-step`, {
          user_id: 'u_1',
          question_id: current.question.id,
          option_index: current.question.correct_option,
        })
      ).json();
      current = last;
    }

    expect(last.score).toEqual({ correct: 9, total: 10 });
    expect(last.missed_questions).toEqual([
      {
        question: firstQuestion,
        correct_answer: firstQuestion.options[firstQuestion.correct_option],
      },
    ]);
  });

  it('400s when option_index is past the last option', async () => {
    const app = buildTestApp();
    const created = await startSeed(app, enrollmentOf('u_1'));
    const res = await postJson(app, `/api/sessions/${created.session_id}/next-step`, {
      user_id: 'u_1',
      question_id: created.question.id,
      option_index: 99,
    });
    expect(res.status).toBe(400);
  });
});

describe('phase 19 session routes', () => {
  const E = () => enrollmentOf('u_1');

  it('GET /api/sessions/:id returns the view with the current question', async () => {
    const app = buildTestApp();
    const view = await startSeed(app, E());
    expect(view).toMatchObject({ status: 'ready', source: 'seed', position: { position: 1, total: 10 } });
    expect(view.question.id).toBeDefined();
  });

  it('GET /api/sessions/:id is 404 for an unknown and a malformed id alike', async () => {
    const app = buildTestApp();
    for (const id of ['00000000-0000-0000-0000-000000000000', 'nope']) {
      const res = await getJson(app, `/api/sessions/${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'session not found' });
    }
  });

  it('a second create while one is open is 409 session_open', async () => {
    const app = buildTestApp();
    await postJson(app, '/api/sessions', { enrollment_id: E() });
    const res = await postJson(app, '/api/sessions', { enrollment_id: E() });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'session_open' });
  });

  it('skip is 200 twice, and then the next create asks for saved words', async () => {
    const app = buildTestApp();
    const { session_id } = await startSeed(app, E());
    for (let i = 0; i < 2; i++) {
      const res = await postJson(app, `/api/sessions/${session_id}/skip`, {});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ session_id, status: 'skipped' });
    }
    const next = await postJson(app, '/api/sessions', { enrollment_id: E() });
    expect(next.status).toBe(409);
    expect(await next.json()).toEqual({ error: 'no_saved_words' });
  });

  it('skip of an unknown session is 404', async () => {
    const res = await postJson(buildTestApp(), '/api/sessions/00000000-0000-0000-0000-000000000000/skip', {});
    expect(res.status).toBe(404);
  });

  it('answering a skipped session is 409 session_not_ready', async () => {
    const app = buildTestApp();
    const view = await startSeed(app, E());
    await postJson(app, `/api/sessions/${view.session_id}/skip`, {});
    const res = await postJson(app, `/api/sessions/${view.session_id}/next-step`, {
      user_id: 'u_1',
      question_id: view.question.id,
      option_index: 0,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'session_not_ready' });
  });

  it('skip of a completed session is 409 session_not_skippable', async () => {
    const app = buildTestApp();
    let current: { session_id: string; question: { id: string } | null } = await startSeed(app, E());
    const sessionId = current.session_id;
    while (current.question) {
      const res = await postJson(app, `/api/sessions/${sessionId}/next-step`, {
        user_id: 'u_1',
        question_id: current.question.id,
        option_index: 0,
      });
      current = await res.json();
    }
    const res = await postJson(app, `/api/sessions/${sessionId}/skip`, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'session_not_skippable' });
  });

  it('GET current answers before, during and after a session, and 404s an unknown enrollment', async () => {
    const app = buildTestApp();
    const before = await (await getJson(app, `/api/enrollments/${E()}/sessions/current`)).json();
    expect(before).toEqual({ current: null, next_source: 'seed', saved_count: 0 });

    const { session_id } = await startSeed(app, E());
    const during = await (await getJson(app, `/api/enrollments/${E()}/sessions/current`)).json();
    expect(during).toEqual({
      current: { session_id, status: 'ready', source: 'seed', answered: 0, total: 10 },
      next_source: 'list',
      saved_count: 0,
    });

    const missing = await getJson(app, '/api/enrollments/e_nobody/sessions/current');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'enrollment not found' });
  });
});

describe('the progress block (phase 20)', () => {
  type Item = { sense_id: string; form: string; translation: string; level_before: number; level_after: number };
  type Step = { complete: boolean; question: SeedView['question'] | null; progress?: Item[] };

  /** Answers all ten questions right; returns the last response and the questions asked. */
  async function answerAll(app: Hono, first: SeedView) {
    const asked: SeedView['question'][] = [];
    let current = first.question;
    let last: Step = { complete: false, question: current };
    for (let i = 0; i < 10; i += 1) {
      asked.push(current);
      last = (await (
        await postJson(app, `/api/sessions/${first.session_id}/next-step`, {
          user_id: 'u_1',
          question_id: current.id,
          option_index: current.correct_option,
        })
      ).json()) as Step;
      if (!last.complete) current = last.question!;
    }
    return { last, asked };
  }

  it('the completing answer carries what the session did to the saved words, and a read repeats it', async () => {
    const app = buildTestApp();
    const first = await startSeed(app, enrollmentOf('u_1'));
    const [s0, s1] = await saveSessionSenses(t.db, {
      sessionId: first.session_id,
      enrollmentId: enrollmentOf('u_1'),
      positions: [0, 1],
    });

    const { last, asked } = await answerAll(app, first);
    expect(last.complete).toBe(true);
    // Phase 23: the badge averages three live dimensions, so recognition alone,
    // (2, 1, 1), reads 1; `raised` names what moved.
    const item = (senseId: string, q: SeedView['question']) => ({
      sense_id: senseId,
      form: q.question,
      translation: q.options[q.correct_option],
      level_before: 1,
      level_after: 1,
      raised: ['written_receptive'],
    });
    expect(last.progress).toEqual([item(s0, asked[0]), item(s1, asked[1])]);

    const read = await (await getJson(app, `/api/sessions/${first.session_id}`)).json();
    expect(read.progress).toEqual(last.progress);
  });

  it('is empty for an open session, and for one about words that are not saved', async () => {
    const app = buildTestApp();
    const first = await startSeed(app, enrollmentOf('u_1'));
    expect((first as SeedView & { progress: unknown }).progress).toEqual([]);
    const { last } = await answerAll(app, first);
    expect(last.progress).toEqual([]);
  });
});
