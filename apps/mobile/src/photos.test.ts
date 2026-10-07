import { describe, expect, it } from '@jest/globals';

import { MAX_EDGE, createPhotoPicker, resizeFor, type PhotoAsset, type PhotoEngine } from './photos';

function fakeEngine(over: Partial<{ granted: boolean; asset: PhotoAsset | null; base64: string }> = {}) {
  const calls: string[] = [];
  const shrinks: unknown[] = [];
  const engine: PhotoEngine = {
    requestCameraPermission: async () => {
      calls.push('camera-permission');
      return over.granted ?? true;
    },
    requestLibraryPermission: async () => {
      calls.push('library-permission');
      return over.granted ?? true;
    },
    launchCamera: async () => {
      calls.push('camera');
      return over.asset === undefined ? { uri: 'file:///a.jpg', width: 4032, height: 3024 } : over.asset;
    },
    launchLibrary: async () => {
      calls.push('library');
      return over.asset === undefined ? { uri: 'file:///b.jpg', width: 1200, height: 1600 } : over.asset;
    },
    shrink: async (uri, resize) => {
      shrinks.push([uri, resize]);
      return over.base64 ?? 'QUJD';
    },
  };
  return { engine, calls, shrinks };
}

describe('resizeFor', () => {
  it('shrinks the long edge to 2048 and leaves a smaller photo alone', () => {
    expect(MAX_EDGE).toBe(2048);
    expect(resizeFor(4032, 3024)).toEqual({ width: 2048 });
    expect(resizeFor(3024, 4032)).toEqual({ height: 2048 });
    expect(resizeFor(2048, 1000)).toBeNull();
    expect(resizeFor(1200, 1600)).toBeNull();
  });
});

describe('createPhotoPicker', () => {
  it('asks for the camera, shrinks the photo and returns it as JPEG base64', async () => {
    const { engine, calls, shrinks } = fakeEngine();
    const picker = createPhotoPicker({ engine, platform: 'ios' });
    expect(await picker.take()).toEqual({ kind: 'photo', photo: { base64: 'QUJD', mimeType: 'image/jpeg' } });
    expect(calls).toEqual(['camera-permission', 'camera']);
    expect(shrinks).toEqual([['file:///a.jpg', { width: 2048 }]]);
  });

  it('chooses from the gallery, and passes a small photo through unresized', async () => {
    const { engine, calls, shrinks } = fakeEngine();
    const picker = createPhotoPicker({ engine, platform: 'android' });
    expect((await picker.choose()).kind).toBe('photo');
    expect(calls).toEqual(['library-permission', 'library']);
    expect(shrinks).toEqual([['file:///b.jpg', null]]);
  });

  it('answers denied, and opens nothing, without permission', async () => {
    const { engine, calls } = fakeEngine({ granted: false });
    expect(await createPhotoPicker({ engine, platform: 'ios' }).take()).toEqual({ kind: 'denied' });
    expect(calls).toEqual(['camera-permission']);
  });

  it('answers cancelled when the learner backs out', async () => {
    const { engine } = fakeEngine({ asset: null });
    expect(await createPhotoPicker({ engine, platform: 'ios' }).choose()).toEqual({ kind: 'cancelled' });
  });

  it('asks no permission on the web, where the file chooser is the permission', async () => {
    const { engine, calls } = fakeEngine();
    await createPhotoPicker({ engine, platform: 'web' }).choose();
    expect(calls).toEqual(['library']);
  });

  it('strips a data URL prefix, which the web returns, before the upload (Review Focus 5)', async () => {
    const { engine } = fakeEngine({ base64: 'data:image/jpeg;base64,QUJD' });
    expect(await createPhotoPicker({ engine, platform: 'web' }).choose()).toEqual({
      kind: 'photo',
      photo: { base64: 'QUJD', mimeType: 'image/jpeg' },
    });
  });
});
