import { describe, expect, it } from '@jest/globals';

import {
  createFakeLlmClient,
  createFakeLogger,
  createFakeTransaction,
  createFakeVocabRepo,
} from '../../tests/support/fakes';
import type { SenseRow } from '../domain/vocabulary';
import { LlmUnavailable, TranslationUnreadable } from '../errors';
import { createTranslationService } from './translations';

const reply = (payload: unknown) => JSON.stringify(payload);

/** One entry, for the many tests that do not care about the nesting. */
const oneEntry = (lemma: string, senses: Record<string, unknown>[]) => ({
  entries: [{ lemma, senses }],
});

function serviceWith(...replies: (string | Error)[]) {
  const llm = createFakeLlmClient(...replies);
  const logger = createFakeLogger();
  const vocab = createFakeVocabRepo();
  const transaction = createFakeTransaction({ vocab });
  return { service: createTranslationService({ llm, transaction, logger }), llm, logger, vocab };
}

const row = (translation: string): SenseRow => ({
  termId: 't-1',
  rank: 0,
  entryRank: 0,
  partOfSpeech: null,
  exampleSource: null,
  translation,
  exampleTarget: null,
});

describe('translate', () => {
  it('detects the direction and echoes the trimmed text back', async () => {
    const { service } = serviceWith(
      reply({
        kind: 'word',
        ...oneEntry('book', [{ translation: 'ספר', sense_code: 'printed_book' }]),
      }),
    );

    const result = await service.translate({ text: '  book  ' });

    expect(result.text).toBe('book');
    expect(result.direction).toBe('en_he');
  });

  it('honours an explicit direction, which is what the flip control sends', async () => {
    const { service, llm } = serviceWith(reply({ kind: 'word', entries: [] }));

    const result = await service.translate({ text: 'book', direction: 'he_en' });

    expect(result.direction).toBe('he_en');
    expect(llm.calls[0].system).toContain('Hebrew to English');
  });

  it('passes the prompt straight through to the client', async () => {
    const { service, llm } = serviceWith(reply({ kind: 'word', entries: [] }));

    await service.translate({ text: 'book' });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].user).toBe('book');
    expect(typeof llm.calls[0].schema.safeParse).toBe('function');
  });

  it('overrides the model when a single token is called a sentence', async () => {
    const { service } = serviceWith(
      reply({
        kind: 'sentence',
        ...oneEntry('book', [{ translation: 'ספר', sense_code: 'printed_book' }]),
      }),
    );

    const result = await service.translate({ text: 'book' });

    expect(result.kind).toBe('word');
  });

  it('reduces a real sentence to one bare sense', async () => {
    const { service } = serviceWith(
      reply({
        kind: 'sentence',
        ...oneEntry('I read a book', [
          {
            translation: 'קראתי ספר.',
            part_of_speech: 'verb',
            example: { source: 'a', target: 'b' },
            sense_code: 's',
          },
          { translation: 'אחר', sense_code: 't' },
        ]),
      }),
    );

    const result = await service.translate({ text: 'I read a book' });

    expect(result.kind).toBe('sentence');
    expect(result.senses).toEqual([{ translation: 'קראתי ספר.' }]);
  });

  it('treats no content as an empty result rather than a failure', async () => {
    const { service, logger } = serviceWith('');

    const result = await service.translate({ text: 'asdkjhasd' });

    expect(result.senses).toEqual([]);
    expect(logger.events.map((event) => event.event)).toContain('translation_no_content');
  });

  it('treats an empty sense list from the model as an empty result', async () => {
    const { service } = serviceWith(reply({ kind: 'word', entries: [] }));
    await expect(service.translate({ text: 'asdkjhasd' })).resolves.toMatchObject({ senses: [] });
  });

  it('raises TranslationUnreadable for output that does not match the schema', async () => {
    const { service } = serviceWith('I cannot help with that.');
    await expect(service.translate({ text: 'book' })).rejects.toBeInstanceOf(
      TranslationUnreadable,
    );
  });

  it('truncates the excerpt it carries, so a log line cannot be flooded', async () => {
    const { service } = serviceWith('x'.repeat(5000));
    await expect(service.translate({ text: 'book' })).rejects.toMatchObject({
      rawExcerpt: expect.stringMatching(/^x{200}$/),
    });
  });

  it('lets LlmUnavailable through untouched', async () => {
    const { service } = serviceWith(new LlmUnavailable('responded 500'));
    await expect(service.translate({ text: 'book' })).rejects.toBeInstanceOf(LlmUnavailable);
  });

  it('flattens two entries into one ranked list, round-robin by rank', async () => {
    const { service } = serviceWith(
      reply({
        kind: 'word',
        entries: [
          {
            lemma: 'see',
            senses: [
              { translation: 'לראות', sense_code: 'perceive' },
              { translation: 'להבין', sense_code: 'understand' },
            ],
          },
          { lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] },
        ],
      }),
    );

    const result = await service.translate({ text: 'saw' });

    expect(result.senses.map((sense) => sense.translation)).toEqual(['לראות', 'מסור', 'להבין']);
    expect(result.senses[0]).not.toHaveProperty('sense_code');
  });

  it('serves a hit from the database and calls the model zero times', async () => {
    const { service, llm, vocab, logger } = serviceWith(reply({ kind: 'word', entries: [] }));
    vocab.hit = [row('סולם')];

    const result = await service.translate({ text: 'ladder' });

    expect(llm.calls).toHaveLength(0);
    expect(result.senses).toEqual([{ translation: 'סולם' }]);
    expect(logger.events[0]).toEqual({
      event: 'vocab_cache_hit',
      direction: 'en_he',
      term_count: 1,
      sense_count: 1,
    });
  });

  it('reads with the normalized form and the direction\'s language pair', async () => {
    const { service, vocab } = serviceWith(reply({ kind: 'word', entries: [] }));

    await service.translate({ text: '  good   morning ' });

    expect(vocab.reads[0]).toEqual({
      form: 'good morning',
      languageCode: 'en',
      userLanguageCode: 'he',
    });
  });

  it('writes every entry on a miss, with the queried form and the resolved kind', async () => {
    const { service, llm, vocab } = serviceWith(
      reply({
        kind: 'word',
        entries: [
          { lemma: 'see', senses: [{ translation: 'לראות', sense_code: 'perceive' }] },
          { lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] },
        ],
      }),
    );

    await service.translate({ text: 'saw' });

    expect(llm.calls).toHaveLength(1);
    expect(vocab.persisted).toHaveLength(1);
    expect(vocab.persisted[0]).toMatchObject({
      form: 'saw',
      languageCode: 'en',
      userLanguageCode: 'he',
      kind: 'word',
    });
    expect(vocab.persisted[0].entries.map((entry) => entry.lemma)).toEqual(['see', 'saw']);
  });

  it('answers with what the write re-read, not with what the model replied', async () => {
    // The re-read is what makes the writer's answer identical to the next
    // reader's, so the service must not shortcut it.
    const { service, vocab } = serviceWith(
      reply({
        kind: 'word',
        entries: [{ lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] }],
      }),
    );
    vocab.reread = [row('לראות'), row('מסור')];

    const result = await service.translate({ text: 'saw' });

    expect(result.senses.map((sense) => sense.translation)).toEqual(['לראות', 'מסור']);
  });

  it('merges two entries for one lemma before writing, so neither is dropped', async () => {
    const { service, vocab } = serviceWith(
      reply({
        kind: 'word',
        entries: [
          { lemma: 'book', senses: [{ translation: 'ספר', sense_code: 'printed_book' }] },
          { lemma: 'book', senses: [{ translation: 'להזמין', sense_code: 'reserve' }] },
        ],
      }),
    );

    await service.translate({ text: 'book' });

    expect(vocab.persisted[0].entries).toHaveLength(1);
    expect(vocab.persisted[0].entries[0].senses).toHaveLength(2);
  });

  it('still answers 200 with the flattened entries when the write throws', async () => {
    const { service, vocab, logger } = serviceWith(
      reply({
        kind: 'word',
        entries: [{ lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] }],
      }),
    );
    vocab.persistError = new Error('deadlock detected');

    const result = await service.translate({ text: 'saw' });

    expect(result.senses).toEqual([{ translation: 'מסור' }]);
    expect(logger.errors.map((entry) => entry.message)).toContain('vocab_persist_failed');
  });

  it('writes nothing for a sentence, an empty entry list, or a provider failure', async () => {
    const sentence = serviceWith(
      reply({
        kind: 'sentence',
        entries: [
          { lemma: 'I read a book', senses: [{ translation: 'קראתי ספר.', sense_code: 's' }] },
        ],
      }),
    );
    await sentence.service.translate({ text: 'I read a book' });
    expect(sentence.vocab.persisted).toHaveLength(0);

    const empty = serviceWith(reply({ kind: 'word', entries: [] }));
    await empty.service.translate({ text: 'asdkjhasd' });
    expect(empty.vocab.persisted).toHaveLength(0);

    const blocked = serviceWith('');
    await blocked.service.translate({ text: 'asdkjhasd' });
    expect(blocked.vocab.persisted).toHaveLength(0);

    const down = serviceWith(new LlmUnavailable('responded 500'));
    await expect(down.service.translate({ text: 'saw' })).rejects.toBeInstanceOf(LlmUnavailable);
    expect(down.vocab.persisted).toHaveLength(0);
  });

  it('logs what it persisted', async () => {
    const { service, logger } = serviceWith(
      reply({
        kind: 'word',
        entries: [{ lemma: 'saw', senses: [{ translation: 'מסור', sense_code: 'tool' }] }],
      }),
    );

    await service.translate({ text: 'saw' });

    expect(logger.events).toEqual([
      { event: 'vocab_persisted', entry_count: 1, terms_created: 1 },
      { event: 'translated', direction: 'en_he', kind: 'word', sense_count: 1 },
    ]);
  });
});
