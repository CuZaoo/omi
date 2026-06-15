import React from 'react';
import { Platform, StyleSheet, ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';

export interface MjpegStreamProps {
  uri: string;
  style?: ViewStyle;
}

export const MjpegStream: React.FC<MjpegStreamProps> = ({ uri, style }) => {
  if (!uri) return null;

  if (Platform.OS === 'web') {
    return (
      <WebView
        source={{ uri }}
        style={style}
        originWhitelist={['*']}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        scrollEnabled={false}
        onError={(e) => console.warn('[MjpegStream] WebView error:', e.nativeEvent)}
      />
    );
  }

  return (
    <WebView
      source={{ uri }}
      style={style}
      originWhitelist={['*']}
      allowsInlineMediaPlayback={true}
      mediaPlaybackRequiresUserAction={false}
      scrollEnabled={false}
    />
  );
};

const styles = StyleSheet.create({});