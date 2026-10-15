import { strings } from '@/strings';

// Phase 36 (spec D9). Where the update-required screen sends someone whose
// build the server has left behind: the store that holds the newer build.
// TestFlight's scheme opens the TestFlight app, which lists the update.
const TESTFLIGHT_URL = 'itms-beta://';
const PLAY_URL = 'market://details?id=ai.wordspal.app';

/** The store button's link and label for a platform (`Platform.OS`). */
export function storeLink(platform: string): { url: string; label: string } {
  return platform === 'ios'
    ? { url: TESTFLIGHT_URL, label: strings.updateRequiredButtonIos }
    : { url: PLAY_URL, label: strings.updateRequiredButton };
}
