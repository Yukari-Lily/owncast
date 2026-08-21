import React, { FC } from 'react';
import videojs from 'video.js';
import type VideoJsPlayer from 'video.js/dist/types/player';

import styles from './VideoJS.module.scss';

require('video.js/dist/video-js.css');

type XhrRequestOptions = {
  uri: string;
  [key: string]: unknown;
};

// Append a cachebuster to HLS playlist URLs so browsers/proxies do not serve a
// stale m3u8. Registered once via the non-deprecated VHS onRequest hook.
const cacheBustPlaylistRequest = (options: XhrRequestOptions): XhrRequestOptions => {
  if (options.uri && options.uri.includes('m3u8')) {
    const cachebuster = Math.random().toString(16).substr(2, 8);
    const sep = options.uri.includes('?') ? '&' : '?';
    // eslint-disable-next-line no-param-reassign
    options.uri = `${options.uri}${sep}cachebust=${cachebuster}`;
  }
  return options;
};

let cacheBustHookRegistered = false;

function ensureCacheBustHook() {
  const vhsXhr = (videojs as any).Vhs?.xhr;
  if (!vhsXhr?.onRequest || cacheBustHookRegistered) {
    return;
  }
  vhsXhr.onRequest(cacheBustPlaylistRequest);
  cacheBustHookRegistered = true;
}

export type VideoJSProps = {
  options: any;
  onReady: (player: VideoJsPlayer, vjsInstance: typeof videojs) => void;
  'aria-label'?: string;
};

export const VideoJS: FC<VideoJSProps> = ({ options, onReady, 'aria-label': ariaLabel }) => {
  const videoRef = React.useRef<HTMLDivElement | null>(null);
  const playerRef = React.useRef<VideoJsPlayer | null>(null);
  const onReadyRef = React.useRef(onReady);

  onReadyRef.current = onReady;

  React.useEffect(() => {
    if (!videoRef.current) {
      return undefined;
    }

    // React Strict Mode mounts effects twice in development. Creating the
    // element here gives each Video.js instance a fresh element after dispose.
    const videoElement = document.createElement('video-js');
    videoElement.className = `video-js vjs-big-play-centered vjs-show-big-play-button-on-pause ${styles.player} vjs-owncast`;
    if (ariaLabel) {
      videoElement.setAttribute('aria-label', ariaLabel);
    }
    videoRef.current.appendChild(videoElement);

    // Register before the source handler starts its first playlist request.
    ensureCacheBustHook();

    const player: VideoJsPlayer = videojs(videoElement, options, () => {
      onReadyRef.current?.(player, videojs);
    });
    playerRef.current = player;
    // Some Video.js builds expose VHS only after the first player is created.
    ensureCacheBustHook();

    return () => {
      if (!player.isDisposed()) {
        player.dispose();
      }
      if (playerRef.current === player) {
        playerRef.current = null;
      }
    };
  }, [ariaLabel, options]);

  return (
    <div data-vjs-player>
      <div ref={videoRef} />
    </div>
  );
};
