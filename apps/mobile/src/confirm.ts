import { Alert, Platform } from 'react-native';

/**
 * A yes/no question that also works on web. react-native-web's Alert is a
 * no-op, so there this is the browser's confirm(), which Playwright answers
 * through its `dialog` event.
 */
export function confirm(input: {
  title: string;
  message: string;
  confirm: string;
  cancel: string;
}): Promise<boolean> {
  if (Platform.OS === 'web') {
    const ask = (globalThis as { confirm?: (message: string) => boolean }).confirm;
    return Promise.resolve(ask ? ask(`${input.title}\n\n${input.message}`) : false);
  }
  return new Promise((resolve) => {
    Alert.alert(
      input.title,
      input.message,
      [
        { text: input.cancel, style: 'cancel', onPress: () => resolve(false) },
        { text: input.confirm, style: 'destructive', onPress: () => resolve(true) },
      ],
      // Android's back button would otherwise dismiss it without resolving.
      { cancelable: false },
    );
  });
}
