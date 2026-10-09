import { describe, expect, it } from '@jest/globals';

import { cacheControlFor, isApiPath, isAppRoute } from './web';

describe('cacheControlFor', () => {
  it('makes the browser revalidate every HTML page', () => {
    expect(cacheControlFor('/app/web/index.html')).toBe('no-cache');
  });

  it('caches a hashed bundle for a year', () => {
    expect(cacheControlFor('/app/web/_expo/static/js/web/entry-3f9a.js')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('leaves any other file to the browser default', () => {
    expect(cacheControlFor('/app/web/favicon.ico')).toBeNull();
  });
});

describe('isApiPath', () => {
  it('is true for /api and everything under it', () => {
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/users')).toBe(true);
  });

  it('is false for a path that only starts with the letters', () => {
    expect(isApiPath('/apiary')).toBe(false);
  });
});

describe('isAppRoute', () => {
  it('is true for the root and for screens, nested or not', () => {
    expect(isAppRoute('/')).toBe(true);
    expect(isAppRoute('/session')).toBe(true);
    expect(isAppRoute('/vocabulary/42')).toBe(true);
  });

  it('is false for a file, whatever the directory', () => {
    expect(isAppRoute('/_expo/static/js/web/entry-old.js')).toBe(false);
    expect(isAppRoute('/favicon.ico')).toBe(false);
  });

  it('is false under /api', () => {
    expect(isAppRoute('/api/nothing')).toBe(false);
  });
});
