import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AudioModule,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Stack } from 'expo-router';
import * as Speech from 'expo-speech';
import { I18nManager, Platform, StyleSheet, View, type ViewProps } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createApiClient } from '@/api/client';
import { requireEnvValue } from '@/config/requireEnvValue';
import { createRememberedEnrollmentStore, createRememberedUsernameStore } from '@/currentUser';
import { CurrentUserProvider } from '@/hooks/useCurrentUser';
import { NextSessionProvider } from '@/hooks/useNextSession';
import { PhotoImportsProvider } from '@/hooks/usePhotoImports';
import { RecordingProvider } from '@/hooks/useRecording';
import { SessionProvider } from '@/hooks/useSession';
import { SpeechProvider } from '@/hooks/useSpeech';
import { TranslationProvider } from '@/hooks/useTranslation';
import { VocabularyProvider } from '@/hooks/useVocabulary';
import { createPhotoPicker, type PhotoAsset } from '@/photos';
import { createRecorder, type RecordPermission } from '@/recording';
import { createSpeaker } from '@/speech';
import { colors } from '@/theme';

// Read directly off process.env.EXPO_PUBLIC_API_URL (not via an indirection)
// so Metro's build-time inlining for EXPO_PUBLIC_* variables recognizes and
// replaces it in the real app bundle. This is the one permitted exception to
// "no process.env at import time", and it belongs here because this file is the
// composition root — every other dependency is constructed here too. Wrapping
// the result in requireEnvValue doesn't hide this expression from Metro's
// inliner, which matches on the literal text at this call site.
const baseUrl = requireEnvValue(process.env.EXPO_PUBLIC_API_URL, 'EXPO_PUBLIC_API_URL');

const api = createApiClient({ baseUrl, fetch: globalThis.fetch });
const usernameStore = createRememberedUsernameStore({ storage: AsyncStorage });
const enrollmentStore = createRememberedEnrollmentStore({ storage: AsyncStorage });

const firstAsset = (result: ImagePicker.ImagePickerResult): PhotoAsset | null =>
  result.canceled || result.assets.length === 0
    ? null
    : { uri: result.assets[0].uri, width: result.assets[0].width, height: result.assets[0].height };

// Phase 26. The only file that names the image packages (ADR 0002 R1).
const photoPicker = createPhotoPicker({
  platform: Platform.OS,
  engine: {
    requestCameraPermission: async () => (await ImagePicker.requestCameraPermissionsAsync()).granted,
    requestLibraryPermission: async () => (await ImagePicker.requestMediaLibraryPermissionsAsync()).granted,
    launchCamera: async () => firstAsset(await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })),
    launchLibrary: async () =>
      firstAsset(await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 })),
    // The context and the rendered image hold native memory (a decoded camera
    // photo is tens of megabytes) until released, so both are released as soon
    // as the JPEG is saved, or the shrink fails. A no-op on web.
    shrink: async (uri, resize) => {
      const context = ImageManipulator.manipulate(uri);
      try {
        if (resize) context.resize(resize);
        const image = await context.renderAsync();
        try {
          const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
          return saved.base64 ?? '';
        } finally {
          image.release();
        }
      } finally {
        context.release();
      }
    },
  },
});

// Phase 23. The device's own speech engine (spec §1 D1). The audio mode is what
// lets a tap sound with an iPhone's ring switch on silent, with the learner's
// music kept playing underneath (D8). The speaker applies it on iOS only.
const speaker = createSpeaker({
  engine: Speech,
  platform: Platform.OS,
  prepareAudio: () => setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' }),
});

// Phase 25 (spec D12). The recorder class useAudioRecorder wraps, built outside
// any hook. The web build names it AudioRecorderWeb (POC).
const recorder = createRecorder({
  platform: Platform.OS,
  makeEngine: (options) =>
    Platform.OS === 'web'
      ? new (AudioModule as unknown as { AudioRecorderWeb: typeof AudioModule.AudioRecorder }).AudioRecorderWeb(options)
      : new AudioModule.AudioRecorder(options),
  // expo-audio's web read opens the browser's prompt when the site was never
  // granted, so the web reads the permission itself, which never prompts.
  permission: async (): Promise<RecordPermission> => {
    if (Platform.OS === 'web') {
      try {
        const { state } = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        return state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'undetermined';
      } catch {
        return 'denied';
      }
    }
    const answer = await getRecordingPermissionsAsync();
    return answer.granted ? 'granted' : answer.canAskAgain ? 'undetermined' : 'denied';
  },
  requestPermission: async () => (await requestRecordingPermissionsAsync()).granted,
  setRecordingMode: (on) =>
    setAudioModeAsync(
      on
        ? { allowsRecording: true, playsInSilentMode: true }
        : { allowsRecording: false, playsInSilentMode: true, interruptionMode: 'mixWithOthers' },
    ),
  // A phone reads the file directly: fetch(file://) with FileReader uploaded
  // 15 bytes from Android (POC). The web's uri is a blob: URL. fetch is held in
  // a local, because a browser refuses it called as a method of another object.
  readBase64: async (uri) => {
    if (Platform.OS !== 'web') {
      const file = new File(uri);
      return { base64: await file.base64(), bytes: file.size ?? 0 };
    }
    const fetchUri = globalThis.fetch;
    const blob = await (await fetchUri(uri)).blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), bytes: blob.size };
  },
});

// RTL is set two different ways because the platforms disagree about how.
//
// Native: I18nManager is the real mechanism, but it only applies a flip on
// reload, so the `direction` style below makes the very first render RTL too.
//
// Web: react-native-web stubs I18nManager out entirely — forceRTL is a no-op and
// isRTL is hardcoded false — and its StyleSheet validator deletes a `direction`
// property outright. Its actual mechanism is the `dir` prop, which sets the DOM
// attribute and installs the LocaleProvider that every descendant reads to
// resolve start/end and mirror flex rows. `dir` is not in React Native's own
// ViewProps, so it is cast in for the one platform that reads it.
I18nManager.allowRTL(true);
I18nManager.forceRTL(true);

const rtlProps = { dir: 'rtl' } as unknown as ViewProps;

export default function RootLayout() {
  return (
    // Every screen uses SafeAreaView. The navigator happens to provide a
    // fallback provider, but relying on that is relying on an internal detail —
    // and on web the insets are zero without an explicit provider.
    <SafeAreaProvider>
      <SpeechProvider speaker={speaker}>
        <RecordingProvider recorder={recorder}>
          <CurrentUserProvider api={api} usernameStore={usernameStore}
            enrollmentStore={enrollmentStore}
          >
            <NextSessionProvider api={api}>
              <SessionProvider api={api}>
                <TranslationProvider api={api}>
                  <VocabularyProvider api={api}>
                    <PhotoImportsProvider api={api} picker={photoPicker}>
                      <View style={styles.root} {...rtlProps}>
                        <Stack screenOptions={{ headerShown: false, contentStyle: styles.content }} />
                      </View>
                    </PhotoImportsProvider>
                  </VocabularyProvider>
                </TranslationProvider>
              </SessionProvider>
            </NextSessionProvider>
          </CurrentUserProvider>
        </RecordingProvider>
      </SpeechProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    // Native-only: a valid Yoga style there, deleted with an error on web.
    ...Platform.select({ web: null, default: { direction: 'rtl' as const } }),
  },
  content: { backgroundColor: colors.background },
});
