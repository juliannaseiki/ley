import React from 'react';
import { StyleSheet, View } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { GLOBE_HTML } from '../webview/globeHtml';

type WebViewOutMessage = { type: 'ready' } | { type: 'tap'; lon: number; lat: number };

type Props = {
  onTapLocation?: (lat: number, lon: number) => void;
};

export function Globe({ onTapLocation }: Props) {
  const handleMessage = (event: WebViewMessageEvent) => {
    let message: WebViewOutMessage;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (message.type === 'tap') {
      onTapLocation?.(message.lat, message.lon);
    }
  };

  return (
    <View style={styles.container}>
      <WebView
        source={{ html: GLOBE_HTML }}
        onMessage={handleMessage}
        style={styles.webview}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        originWhitelist={['*']}
        setSupportMultipleWindows={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
});
