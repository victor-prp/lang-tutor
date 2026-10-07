import type {
  PhotoImport,
  PhotoImportItem,
  PhotoImportItemUpdate,
  PhotoImportSummary,
  SaveVocabularyResponse,
} from '@lang-tutor/core/api';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ApiClient } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { importsFor, type StoredImports } from '@/photoImports';
import type { Photo, PhotoPicker, PickResult } from '@/photos';

type PhotoImportsValue = {
  /** The active enrollment's open imports, newest first. */
  imports: PhotoImportSummary[];
  loadFailed: boolean;
  reload: () => void;
  pick: (source: 'camera' | 'gallery') => Promise<PickResult>;
  upload: (photo: Photo) => Promise<PhotoImportSummary>;
  fetchImport: (id: string) => Promise<PhotoImport>;
  updateItem: (id: string, position: number, update: PhotoImportItemUpdate) => Promise<PhotoImportItem>;
  save: (id: string) => Promise<SaveVocabularyResponse>;
  discard: (id: string) => Promise<void>;
};

const PhotoImportsContext = createContext<PhotoImportsValue | null>(null);

export function PhotoImportsProvider({ api, picker, children }: { api: ApiClient; picker: PhotoPicker; children: ReactNode }) {
  const { active } = useCurrentUser();
  // Keyed by the enrollment each list was read for, not cleared on a switch
  // (see importsFor). `reload` changes with `active`, so home's focus effect
  // runs again on a switch, and its read is the one that lands.
  const [stored, setStored] = useState<StoredImports | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const imports = importsFor(stored, active?.id);
  const loadFailed = active !== null && failedFor === active.id;
  // Reads are numbered as they start. An answer is shown unless a newer one
  // already has been, so an older poll answering late is dropped, and a slow
  // answer still lands while polls keep starting.
  const started = useRef(0);
  const applied = useRef(0);

  const reload = useCallback(() => {
    if (!active) return;
    const enrollmentId = active.id;
    const mine = ++started.current;
    api
      .listPhotoImports(enrollmentId)
      .then((list) => {
        if (mine < applied.current) return;
        applied.current = mine;
        setStored({ enrollmentId, imports: list });
        setFailedFor((failed) => (failed === enrollmentId ? null : failed));
      })
      .catch(() => {
        if (mine > applied.current) setFailedFor(enrollmentId);
      });
  }, [api, active]);

  // Stable identities, not inline arrows in the memo below: the review screen
  // puts fetchImport in its load callback, which its focus and poll effects
  // depend on. New functions whenever the list changed would re-run them.
  const pick = useCallback(
    (source: 'camera' | 'gallery') => (source === 'camera' ? picker.take() : picker.choose()),
    [picker],
  );
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
    () => ({ imports, loadFailed, reload, pick, upload, fetchImport, updateItem, save, discard }),
    [imports, loadFailed, reload, pick, upload, fetchImport, updateItem, save, discard],
  );

  return <PhotoImportsContext.Provider value={value}>{children}</PhotoImportsContext.Provider>;
}

export function usePhotoImports(): PhotoImportsValue {
  const value = useContext(PhotoImportsContext);
  if (!value) throw new Error('usePhotoImports must be used inside a PhotoImportsProvider');
  return value;
}
