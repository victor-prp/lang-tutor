import type {
  PhotoImport,
  PhotoImportItem,
  PhotoImportItemUpdate,
  PhotoImportSummary,
  SaveVocabularyResponse,
} from '@lang-tutor/core/api';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';

import type { ApiClient } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import type { Photo, PhotoPicker, PickResult } from '@/photos';

type PhotoImportsValue = {
  pick: (source: 'camera' | 'gallery') => Promise<PickResult>;
  /** Phase 53 (spec D10). Several photos from the library at once, for the photo flow;
   *  none when the learner cancels. */
  pickMany: () => Promise<Photo[]>;
  upload: (photo: Photo) => Promise<PhotoImportSummary>;
  fetchImport: (id: string) => Promise<PhotoImport>;
  updateItem: (id: string, position: number, update: PhotoImportItemUpdate) => Promise<PhotoImportItem>;
  save: (id: string) => Promise<SaveVocabularyResponse>;
  discard: (id: string) => Promise<void>;
};

const PhotoImportsContext = createContext<PhotoImportsValue | null>(null);

/** Phase 26, phase 64 (spec D8, R12). The photo flow's imports: picking, sending, the review's
 *  reads and changes, saving and discarding. No list of open imports is kept any more: the
 *  flow waits for its own and discards them when it is left. */
export function PhotoImportsProvider({ api, picker, children }: { api: ApiClient; picker: PhotoPicker; children: ReactNode }) {
  const { active } = useCurrentUser();

  // Stable identities, not inline arrows in the memo below: the review puts fetchImport in
  // its load callback, which its focus and poll effects depend on. New functions whenever
  // the provider rendered would re-run them.
  const pick = useCallback(
    (source: 'camera' | 'gallery') => (source === 'camera' ? picker.take() : picker.choose()),
    [picker],
  );
  const pickMany = useCallback(() => picker.chooseMany(), [picker]);
  const upload = useCallback(
    async (photo: Photo) => {
      if (!active) throw new Error('no active enrollment');
      return api.createPhotoImport(active.id, { mime_type: photo.mimeType, image: photo.base64 });
    },
    [api, active],
  );
  const fetchImport = useCallback((id: string) => api.getPhotoImport(id), [api]);
  const updateItem = useCallback(
    (id: string, position: number, update: PhotoImportItemUpdate) => api.updatePhotoImportItem(id, position, update),
    [api],
  );
  const save = useCallback((id: string) => api.savePhotoImport(id), [api]);
  const discard = useCallback((id: string) => api.discardPhotoImport(id), [api]);

  const value = useMemo<PhotoImportsValue>(
    () => ({ pick, pickMany, upload, fetchImport, updateItem, save, discard }),
    [pick, pickMany, upload, fetchImport, updateItem, save, discard],
  );

  return <PhotoImportsContext.Provider value={value}>{children}</PhotoImportsContext.Provider>;
}

export function usePhotoImports(): PhotoImportsValue {
  const value = useContext(PhotoImportsContext);
  if (!value) throw new Error('usePhotoImports must be used inside a PhotoImportsProvider');
  return value;
}
