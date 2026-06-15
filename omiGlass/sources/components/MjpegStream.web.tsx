import React from 'react';
import { ViewStyle } from 'react-native';

export interface MjpegStreamProps {
  uri: string;
  style?: ViewStyle;
}

export const MjpegStream: React.FC<MjpegStreamProps> = ({ uri, style }) => {
  if (!uri) return null;

  return (
    <iframe
      src={uri}
      style={{
        ...style,
        border: 0,
        width: '100%',
        height: '100%',
      } as React.CSSProperties}
      frameBorder={0}
      allow="autoplay"
    />
  );
};