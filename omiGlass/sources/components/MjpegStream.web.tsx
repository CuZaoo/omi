import React from 'react';
import { ViewStyle } from 'react-native';

export interface MjpegStreamProps {
  uri: string;
  style?: ViewStyle;
}

function toCssStyle(style?: ViewStyle): React.CSSProperties {
  const source = (style || {}) as ViewStyle & { resizeMode?: string };
  const { transform, resizeMode, ...rest } = source as any;

  const cssTransform = Array.isArray(transform)
    ? transform
        .map(item => {
          if ('rotate' in item) return `rotate(${item.rotate})`;
          if ('scale' in item) return `scale(${item.scale})`;
          if ('scaleX' in item) return `scaleX(${item.scaleX})`;
          if ('scaleY' in item) return `scaleY(${item.scaleY})`;
          if ('translateX' in item) return `translateX(${item.translateX}px)`;
          if ('translateY' in item) return `translateY(${item.translateY}px)`;
          return '';
        })
        .filter(Boolean)
        .join(' ')
    : undefined;

  return {
    ...rest,
    width: '100%',
    height: '100%',
    display: 'block',
    border: 0,
    backgroundColor: '#000',
    objectFit: resizeMode === 'cover' ? 'cover' : 'contain',
    transform: cssTransform,
    transformOrigin: 'center center',
  } as React.CSSProperties;
}

export const MjpegStream: React.FC<MjpegStreamProps> = ({ uri, style }) => {
  if (!uri) return null;

  // ESP32 /stream is multipart/x-mixed-replace MJPEG. Browsers render this
  // reliably through an <img>, while an <iframe> can stay blank inside the
  // React Native Web layout even though the stream works when opened directly.
  return <img src={uri} style={toCssStyle(style)} alt="Live MJPEG stream" draggable={false} />;
};
