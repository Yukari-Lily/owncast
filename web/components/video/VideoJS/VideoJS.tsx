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
};

export const VideoJS: FC<VideoJSProps> = ({ options, onReady }) => {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const playerRef = React.useRef<VideoJsPlayer | null>(null);

  React.useEffect(() => {
    // Make sure Video.js player is only initialized once
    if (!playerRef.current) {
      const videoElement = videoRef.current;

      // eslint-disable-next-line no-multi-assign
      const player: VideoJsPlayer = (playerRef.current = videojs(
        videoElement,
        options,
        () => onReady && onReady(player, videojs),
      ));

      player.autoplay(options.autoplay);
      player.src(options.sources);
    }

    // Register after player/src setup so VHS is present on videojs.
    ensureCacheBustHook();
  }, [options, videoRef]);

  return (
    <div data-vjs-player>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        className={`video-js vjs-big-play-centered vjs-show-big-play-button-on-pause ${styles.player} vjs-owncast`}
      />
    </div>
  );
};
