import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { GLOBE_HTML } from '../webview/globeHtml';

type WebViewOutMessage = { type: 'ready' } | { type: 'pinTap'; placeId: string };

type GlobePlace = {
  id: string;
  lat: number;
  lon: number;
};

type Props = {
  onPinTap?: (placeId: string) => void;
  savedPlaces?: GlobePlace[];
};

export function Globe({ onPinTap, savedPlaces = [] }: Props) {
  const webViewRef = useRef<WebView>(null);
  const [webViewReady, setWebViewReady] = useState(false);

  useEffect(() => {
    if (!webViewReady) return;
    webViewRef.current?.postMessage(
      JSON.stringify({
        type: 'setSavedPlaces',
        places: savedPlaces.map((place) => ({ id: place.id, lat: place.lat, lon: place.lon })),
      })
    );
  }, [webViewReady, savedPlaces]);

  const handleMessage = (event: WebViewMessageEvent) => {
    let message: WebViewOutMessage;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (message.type === 'ready') {
      setWebViewReady(true);
    } else if (message.type === 'pinTap') {
      onPinTap?.(message.placeId);
    }
  };

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
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
