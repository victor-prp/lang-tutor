import { describe, expect, it } from '@jest/globals';

import { MAX_EDGE, createPhotoPicker, resizeFor, type PhotoAsset, type PhotoEngine } from './photos';

function fakeEngine(
  over: Partial<{
    granted: boolean;
    asset: PhotoAsset | null;
    assets: PhotoAsset[];
    base64: string;
    base64Of: (uri: string) => string;
  }> = {},
) {
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
    chooseMany: async () => {
      calls.push('library-many');
      return (
        over.assets ?? [
          { uri: 'file:///c.jpg', width: 4032, height: 3024 },
          { uri: 'file:///d.jpg', width: 1200, height: 1600 },
        ]
      );
    },
    shrink: async (uri, resize) => {
      shrinks.push([uri, resize]);
      return over.base64Of?.(uri) ?? over.base64 ?? 'QUJD';
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

  // Phase 53 (spec D10). The target wizard takes several photos at once.
  describe('chooseMany', () => {
    it('chooses several from the gallery and shrinks each as a single choice is, in order', async () => {
      const { engine, calls, shrinks } = fakeEngine({ base64Of: (uri) => 'B64-' + uri });
      const picker = createPhotoPicker({ engine, platform: 'android' });
      expect(await picker.chooseMany()).toEqual([
        { base64: 'B64-file:///c.jpg', mimeType: 'image/jpeg' },
        { base64: 'B64-file:///d.jpg', mimeType: 'image/jpeg' },
      ]);
      expect(calls).toEqual(['library-permission', 'library-many']);
      expect(shrinks).toEqual([
        ['file:///c.jpg', { width: 2048 }],
        ['file:///d.jpg', null],
      ]);
    });

    it('answers [] when the learner backs out, and shrinks nothing', async () => {
      const { engine, shrinks } = fakeEngine({ assets: [] });
      expect(await createPhotoPicker({ engine, platform: 'ios' }).chooseMany()).toEqual([]);
      expect(shrinks).toEqual([]);
    });

    it('answers [] and opens nothing without permission', async () => {
      const { engine, calls } = fakeEngine({ granted: false });
      expect(await createPhotoPicker({ engine, platform: 'ios' }).chooseMany()).toEqual([]);
      expect(calls).toEqual(['library-permission']);
    });

    it('asks no permission on the web, where the file chooser is the permission', async () => {
      const { engine, calls } = fakeEngine();
      await createPhotoPicker({ engine, platform: 'web' }).chooseMany();
      expect(calls).toEqual(['library-many']);
    });

    it('strips the data URL prefix the web returns from each photo', async () => {
      const { engine } = fakeEngine({ base64: 'data:image/jpeg;base64,QUJD' });
      expect(await createPhotoPicker({ engine, platform: 'web' }).chooseMany()).toEqual([
        { base64: 'QUJD', mimeType: 'image/jpeg' },
        { base64: 'QUJD', mimeType: 'image/jpeg' },
      ]);
    });

    // A decoded camera photo is tens of megabytes until released: ten at once is
    // how a low-end phone runs out of memory.
    it('shrinks one photo at a time', async () => {
      const events: string[] = [];
      const { engine } = fakeEngine();
      engine.shrink = async (uri) => {
        events.push('start ' + uri);
        await Promise.resolve();
        await Promise.resolve();
        events.push('end ' + uri);
        return 'QUJD';
      };
      await createPhotoPicker({ engine, platform: 'android' }).chooseMany();
      expect(events).toEqual([
        'start file:///c.jpg',
        'end file:///c.jpg',
        'start file:///d.jpg',
        'end file:///d.jpg',
      ]);
    });

    it('fails as a whole when one photo cannot be shrunk, as a single choice does', async () => {
      const { engine } = fakeEngine();
      engine.shrink = async (uri) => {
        if (uri.endsWith('d.jpg')) throw new Error('shrink failed');
        return 'QUJD';
      };
      await expect(createPhotoPicker({ engine, platform: 'android' }).chooseMany()).rejects.toThrow('shrink failed');
    });
  });
});
