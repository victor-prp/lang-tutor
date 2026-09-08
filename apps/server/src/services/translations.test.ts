import { describe, expect, it } from '@jest/globals';

import { createFakeLlmClient, createFakeLogger } from '../../tests/support/fakes';
import { LlmUnavailable, TranslationUnreadable } from '../errors';
import { createTranslationService } from './translations';

const reply = (payload: unknown) => JSON.stringify(payload);

function serviceWith(...replies: (string | Error)[]) {
  const llm = createFakeLlmClient(...replies);
  const logger = createFakeLogger();
  return { service: createTranslationService({ llm, logger }), llm, logger };
}

describe('translate', () => {
  it('detects the direction and echoes the trimmed text back', async () => {
    const { service } = serviceWith(reply({ kind: 'word', senses: [{ translation: 'ספר' }] }));

    const result = await service.translate({ text: '  book  ' });

    expect(result.text).toBe('book');
    expect(result.direction).toBe('en_he');
  });

  it('honours an explicit direction, which is what the flip control sends', async () => {
    const { service, llm } = serviceWith(reply({ kind: 'word', senses: [] }));

    const result = await service.translate({ text: 'book', direction: 'he_en' });

    expect(result.direction).toBe('he_en');
    expect(llm.calls[0].system).toContain('Hebrew to English');
  });

  it('passes the prompt straight through to the client', async () => {
    const { service, llm } = serviceWith(reply({ kind: 'word', senses: [] }));

    await service.translate({ text: 'book' });

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].user).toBe('book');
    expect(typeof llm.calls[0].schema.safeParse).toBe('function');
  });

  it('overrides the model when a single token is called a sentence', async () => {
    const { service } = serviceWith(reply({ kind: 'sentence', senses: [{ translation: 'ספר' }] }));

    const result = await service.translate({ text: 'book' });

    expect(result.kind).toBe('word');
  });

  it('reduces a real sentence to one bare sense', async () => {
    const { service } = serviceWith(
      reply({
        kind: 'sentence',
        senses: [
          {
            translation: 'קראתי ספר.',
            part_of_speech: 'verb',
            example: { source: 'a', target: 'b' },
          },
          { translation: 'אחר' },
        ],
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
    const { service } = serviceWith(reply({ kind: 'word', senses: [] }));
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

  it('logs one event per successful translation', async () => {
    const { service, logger } = serviceWith(
      reply({ kind: 'word', senses: [{ translation: 'ספר' }] }),
    );

    await service.translate({ text: 'book' });

    expect(logger.events).toEqual([
      { event: 'translated', direction: 'en_he', kind: 'word', sense_count: 1 },
    ]);
  });
});
