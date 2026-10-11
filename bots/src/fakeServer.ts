import type {
  CreateSessionResponse,
  CurrentSessionResponse,
  Enrollment,
  JudgedAnswerResponse,
  NextStepRequest,
  NextStepResponse,
  Question,
  SaveVocabularyResponse,
  SessionView,
  SpeechAnswerResponse,
  TranslationResponse,
  VocabularyPage,
} from '@lang-tutor/core/api';

import { ApiError, type BotApi, type BotRoute } from './api.ts';

/**
 * Test support: the server as the bots see it, in memory. Every call is recorded as one line,
 * `<bot> <operation>`, so a test can assert the exact conversation. A list session's cards come
 * from `cardsFor`, given the words the bot has saved.
 */
export type FakeOptions = {
  /** The cards of each list session, from the saved forms and their meanings. */
  cardsFor?: (saved: { form: string; meaning: string }[]) => Question[];
  /** A call that answers 500: `true` for `<bot> <operation>` lines that should fail. */
  failOn?: (call: string) => boolean;
  /** A call that throws a plain Error, as a bug in the driver would: never an ApiError. */
  crashOn?: (call: string) => boolean;
  speechVerdict?: 'understood' | 'unheard';
};

export const meaningOf = (form: string) => `משמעות-${form}`;

export function choiceCard(id: string, form: string): Question {
  return {
    id,
    type: 'multiple_choice',
    vocab_term_id: `g-${form}`,
    question: form,
    options: [meaningOf(form), 'דלת', 'קיר', 'תקרה'],
    correct_option: 0,
    context: null,
  };
}

export function sayCard(id: string, form: string): Question {
  return {
    id,
    type: 'say_translation',
    vocab_term_id: `g-${form}`,
    question: meaningOf(form),
    part_of_speech: 'noun',
    answer: form,
    lemma: form,
    alternatives: [],
    context: null,
  };
}

export function readCard(id: string, form: string): Question {
  return { id, type: 'read_aloud', vocab_term_id: `g-${form}`, question: form, meaning: meaningOf(form) };
}

type Session = { id: string; source: 'seed' | 'list'; status: SessionView['status']; polls: number; cards: Question[]; at: number };

export class FakeServer {
  readonly calls: string[] = [];
  readonly bodies: { call: string; body: unknown }[] = [];
  private readonly saved = new Map<string, { form: string; meaning: string }[]>();
  private readonly enrollments = new Map<string, Enrollment>();
  private readonly sessions = new Map<string, Session>();
  private readonly cookies = new Map<string, string>();
  private count = 0;

  constructor(private readonly options: FakeOptions = {}) {}

  private record(bot: string, operation: string, body?: unknown) {
    const call = `${bot} ${operation}`;
    this.calls.push(call);
    if (body !== undefined) this.bodies.push({ call, body });
    if (this.options.crashOn?.(call)) throw new Error(`crash on ${call}`);
    if (this.options.failOn?.(call)) throw new ApiError('POST', operation, 500, '{"error":"boom"}');
  }

  readonly route: BotRoute = {
    signIn: async (name) => {
      this.record(name, 'sign-in');
      const cookie = `session=${name}`;
      this.cookies.set(cookie, name);
      return cookie;
    },
    setDay: async (name, day) => {
      this.record(name, `day ${day}`);
    },
  };

  apiFor(cookie: string): BotApi {
    const bot = this.cookies.get(cookie);
    if (!bot) throw new Error(`unknown cookie ${cookie}`);
    const savedOf = () => this.saved.get(bot) ?? [];
    const session = (id: string) => {
      const found = this.sessions.get(id);
      if (!found) throw new ApiError('GET', `/sessions/${id}`, 404, '{"error":"session not found"}');
      return found;
    };
    const view = (s: Session): SessionView => ({
      session_id: s.id,
      status: s.status,
      source: s.source,
      position: { position: s.at + 1, total: s.cards.length },
      question: s.status === 'ready' ? (s.cards[s.at] ?? null) : null,
      pending_retry: null,
      progress: [],
    });
    const advance = (s: Session): NextStepResponse => {
      s.at += 1;
      if (s.at >= s.cards.length) {
        s.status = 'completed';
        return {
          session_id: s.id,
          question: null,
          position: { position: s.cards.length, total: s.cards.length },
          complete: true,
          score: { correct: 0, total: s.cards.length },
          missed_questions: [],
          progress: [],
        };
      }
      return { session_id: s.id, question: s.cards[s.at], position: { position: s.at + 1, total: s.cards.length }, complete: false, pending_retry: null };
    };
    return {
      enrollments: async () => {
        this.record(bot, 'enrollments');
        const mine = this.enrollments.get(bot);
        return mine ? [mine] : [];
      },
      enroll: async (target) => {
        this.record(bot, `enroll ${target}`);
        const enrollment: Enrollment = { id: `e-${bot}`, user_id: bot, source_language: 'he', target_language: target, created_at: '' };
        this.enrollments.set(bot, enrollment);
        return enrollment;
      },
      translate: async (text): Promise<TranslationResponse> => {
        this.record(bot, `translate ${text}`);
        return {
          text,
          from: 'en',
          to: 'he',
          kind: 'word',
          senses: [{ translation: meaningOf(text), gloss_id: `g-${text}`, variant_id: `v-${text}`, saved: false }],
        };
      },
      save: async (_enrollmentId, entries): Promise<SaveVocabularyResponse> => {
        this.record(bot, 'save', entries);
        const list = savedOf();
        for (const entry of entries) {
          const form = entry.gloss_id.slice(2);
          list.push({ form, meaning: meaningOf(form) });
        }
        this.saved.set(bot, list);
        return { saved_gloss_ids: entries.map((e) => e.gloss_id) };
      },
      vocabulary: async (): Promise<VocabularyPage> => {
        this.record(bot, 'vocabulary');
        const items = [...savedOf()].reverse().map((w) => ({
          lemma: w.form,
          parts_of_speech: ['noun'],
          headline: { gloss_id: `g-${w.form}`, translation: w.meaning, form: w.form },
          saved_count: 1,
          gloss_count: 1,
          level: 1,
          added_by: [],
        }));
        return { items, next_cursor: null };
      },
      createSession: async (_enrollmentId, devices): Promise<CreateSessionResponse> => {
        this.record(bot, 'create-session', devices);
        const seed = ![...this.sessions.values()].some((s) => s.id.startsWith(`${bot}-`));
        const id = `${bot}-s${++this.count}`;
        const cards = seed ? [choiceCard(`${id}-q1`, 'seedword')] : (this.options.cardsFor ?? defaultCards)(savedOf());
        this.sessions.set(id, { id, source: seed ? 'seed' : 'list', status: seed ? 'ready' : 'preparing', polls: 0, cards, at: 0 });
        return { session_id: id, status: seed ? 'ready' : 'preparing', source: seed ? 'seed' : 'list' };
      },
      currentSession: async (): Promise<CurrentSessionResponse> => {
        this.record(bot, 'current-session');
        return { current: null, next_source: 'list', saved_count: savedOf().length };
      },
      session: async (id) => {
        this.record(bot, 'get-session');
        const s = session(id);
        // Preparing for one poll, then ready.
        if (s.status === 'preparing' && s.polls++ > 0) s.status = 'ready';
        return view(s);
      },
      skip: async (id) => {
        this.record(bot, 'skip');
        session(id).status = 'skipped';
      },
      nextStep: async (id, body: NextStepRequest) => {
        this.record(bot, 'next-step', body);
        return advance(session(id));
      },
      speech: async (id, body): Promise<SpeechAnswerResponse> => {
        this.record(bot, 'speech', { question_id: body.question_id, mime_type: body.mime_type });
        const s = session(id);
        if ((this.options.speechVerdict ?? 'understood') === 'unheard') return { heard: '', verdict: 'unheard' };
        return { heard: 'x', verdict: 'understood', next: advance(s) };
      },
      judged: async (id, body): Promise<JudgedAnswerResponse> => {
        this.record(bot, 'judged', body);
        return { verdict: 'exact', next: advance(session(id)) };
      },
      signOut: async () => {
        this.record(bot, 'sign-out');
      },
    };
  }
}

/** One choice of meanings per saved word. */
function defaultCards(saved: { form: string }[]): Question[] {
  return saved.map((w, i) => choiceCard(`q${i + 1}-${w.form}`, w.form));
}
