import { describe, expect, it } from '@jest/globals';

import { storeLink } from './storeLink';
import { strings } from './strings';

describe('storeLink (phase 36 D9)', () => {
  it('sends an iPhone or iPad to TestFlight, where the newer build waits', () => {
    expect(storeLink('ios')).toEqual({ url: 'itms-beta://', label: 'לעדכון ב‑TestFlight' });
  });

  it('sends Android to the app on Play', () => {
    expect(storeLink('android')).toEqual({
      url: 'market://details?id=ai.wordspal.app',
      label: strings.updateRequiredButton,
    });
  });

  it('falls back to Play for any other platform', () => {
    expect(storeLink('web')).toEqual(storeLink('android'));
  });
});
