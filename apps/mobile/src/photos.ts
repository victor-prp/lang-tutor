/**
 * Phase 26 (spec D13). Taking or choosing a photo of a word list, shrunk to
 * what the server takes: at most 2048 px on the long edge, as JPEG base64.
 *
 * The engine is received, never imported: only the composition root names
 * expo-image-picker and expo-image-manipulator (ADR 0002 R1), which is what
 * lets this be tested with a fake.
 */

export type PhotoAsset = { uri: string; width: number; height: number };

export type PhotoEngine = {
  requestCameraPermission: () => Promise<boolean>;
  requestLibraryPermission: () => Promise<boolean>;
  /** null when the learner cancels. */
  launchCamera: () => Promise<PhotoAsset | null>;
  launchLibrary: () => Promise<PhotoAsset | null>;
  /** Phase 53. Several from the library at once; none when the learner cancels. */
  chooseMany: () => Promise<PhotoAsset[]>;
  /** Resizes (or not) and saves as JPEG, answering its base64. */
  shrink: (uri: string, resize: { width: number } | { height: number } | null) => Promise<string>;
};

export type Photo = { base64: string; mimeType: 'image/jpeg' };
export type PickResult = { kind: 'photo'; photo: Photo } | { kind: 'cancelled' } | { kind: 'denied' };

export const MAX_EDGE = 2048;

export function resizeFor(width: number, height: number): { width: number } | { height: number } | null {
  if (Math.max(width, height) <= MAX_EDGE) return null;
  return width >= height ? { width: MAX_EDGE } : { height: MAX_EDGE };
}

// The web's manipulator can answer a data URL where native answers bare base64.
const bare = (base64: string) => base64.replace(/^data:[^;,]*;base64,/, '');

export function createPhotoPicker({ engine, platform }: { engine: PhotoEngine; platform: string }) {
  // On the web the browser's file chooser is the permission.
  const allowed = async (source: 'camera' | 'library'): Promise<boolean> =>
    platform === 'web' ||
    (source === 'camera' ? await engine.requestCameraPermission() : await engine.requestLibraryPermission());
  const shrunk = async (asset: PhotoAsset): Promise<Photo> => {
    const base64 = await engine.shrink(asset.uri, resizeFor(asset.width, asset.height));
    return { base64: bare(base64), mimeType: 'image/jpeg' };
  };
  const pick = async (source: 'camera' | 'library'): Promise<PickResult> => {
    if (!(await allowed(source))) return { kind: 'denied' };
    const asset = source === 'camera' ? await engine.launchCamera() : await engine.launchLibrary();
    if (!asset) return { kind: 'cancelled' };
    return { kind: 'photo', photo: await shrunk(asset) };
  };
  return {
    take: () => pick('camera'),
    choose: () => pick('library'),
    /** Phase 53 (spec D10). Several photos from the library, each shrunk as `choose`
     *  shrinks one, in the order chosen. Empty when the learner cancels, and when the
     *  library permission is refused: the wizard's photos are optional, and a refusal
     *  leaves it where it was. One failing to shrink fails them all, as it fails `choose`. */
    chooseMany: async (): Promise<Photo[]> => {
      if (!(await allowed('library'))) return [];
      const photos: Photo[] = [];
      // One at a time, never together: a decoded camera photo is tens of megabytes until
      // released, and ten of them at once is how a low-end phone runs out of memory.
      for (const asset of await engine.chooseMany()) photos.push(await shrunk(asset));
      return photos;
    },
  };
}

export type PhotoPicker = ReturnType<typeof createPhotoPicker>;
