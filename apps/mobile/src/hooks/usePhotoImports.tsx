import type {
  PhotoImport,
  PhotoImportItem,
  PhotoImportItemUpdate,
  PhotoImportSummary,
  SaveVocabularyResponse,
} from '@lang-tutor/core/api';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ApiClient } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
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
  const [imports, setImports] = useState<PhotoImportSummary[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setImports([]);
    setLoadFailed(false);
  }, [active]);

  const reload = useCallback(() => {
    if (!active) return;
    const mine = ++generation.current;
    api
      .listPhotoImports(active.id)
      .then((list) => {
        if (mine !== generation.current) return;
        setImports(list);
        setLoadFailed(false);
      })
      .catch(() => {
        if (mine === generation.current) setLoadFailed(true);
      });
  }, [api, active]);

  const value = useMemo<PhotoImportsValue>(
    () => ({
      imports,
      loadFailed,
      reload,
      pick: (source) => (source === 'camera' ? picker.take() : picker.choose()),
      upload: async (photo) => {
        if (!active) throw new Error('no active enrollment');
        return api.createPhotoImport(active.id, { mime_type: photo.mimeType, image: photo.base64 });
      },
      fetchImport: (id) => api.getPhotoImport(id),
      updateItem: (id, position, update) => api.updatePhotoImportItem(id, position, update),
      save: (id) => api.savePhotoImport(id),
      discard: (id) => api.discardPhotoImport(id),
    }),
    [api, picker, active, imports, loadFailed, reload],
  );

  return <PhotoImportsContext.Provider value={value}>{children}</PhotoImportsContext.Provider>;
}

export function usePhotoImports(): PhotoImportsValue {
  const value = useContext(PhotoImportsContext);
  if (!value) throw new Error('usePhotoImports must be used inside a PhotoImportsProvider');
  return value;
}
