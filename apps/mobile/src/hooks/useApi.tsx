import { createContext, useContext, type ReactNode } from 'react';

import type { ApiClient } from '@/api/client';

// Phase 28. The one ApiClient, for a screen that nests its own provider (the
// student's words screen nests a TranslationProvider). Received from the
// composition root like every other collaborator (ADR 0002).
const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const value = useContext(ApiContext);
  if (!value) throw new Error('useApi must be used inside an ApiProvider');
  return value;
}
