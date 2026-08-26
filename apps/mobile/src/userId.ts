import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const STORAGE_KEY = 'lang-tutor:user-id';

// A client-generated placeholder — no auth exists yet. Persisted so the same
// install keeps the same id across app restarts; unused server-side beyond
// appearing in the completion log line, groundwork for a future phase that
// ties sessions to a real identity.
export async function getOrCreateUserId(): Promise<string> {
  const existing = await AsyncStorage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const created = Crypto.randomUUID();
  await AsyncStorage.setItem(STORAGE_KEY, created);
  return created;
}
