import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { GLOBE_HTML } from '../webview/globeHtml';
import { AstroLine } from '../lib/astro/types';

type WebViewOutMessage = { type: 'ready' } | { type: 'tap'; lon: number; lat: number };

type Props = {
  lines: AstroLine[];
  onTapLocation: (lat: number, lon: number) => void;
};

export function Globe({ lines, onTapLocation }: Props) {
  const webviewRef = useRef<WebView>(null);
  const [ready, setReady] = useState(false);

  const sendLines = useCallback(() => {
    webviewRef.current?.postMessage(JSON.stringify({ type: 'lines', lines }));
  }, [lines]);

  useEffect(() => {
    if (ready) sendLines();
  }, [ready, sendLines]);

  const handleMessage = (event: WebViewMessageEvent) => {
    let message: WebViewOutMessage;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (message.type === 'ready') {
      setReady(true);
    } else if (message.type === 'tap') {
      onTapLocation(message.lat, message.lon);
    }
  };

  return (
    <View style={styles.container}>
      <WebView
        ref={webviewRef}
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
