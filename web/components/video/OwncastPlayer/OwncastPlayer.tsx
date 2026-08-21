import React, { FC, useContext, useEffect } from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import classNames from 'classnames';
import { ErrorBoundary } from 'react-error-boundary';
import { VideoJS } from '../VideoJS/VideoJS';
import ViewerPing from '../viewer-ping';
import { VideoPoster } from '../VideoPoster/VideoPoster';
import { getLocalStorage, setLocalStorage } from '../../../utils/localStorage';
import { isVideoPlayingAtom, clockSkewAtom } from '../../stores/ClientConfigStore';
import PlaybackMetrics from '../metrics/playback';
import { createVideoSettingsMenuButton } from '../settings-menu';
import LatencyCompensator from '../latencyCompensator';
import styles from './OwncastPlayer.module.scss';
import { VideoSettingsServiceContext } from '../../../services/video-settings-service';
import { ComponentError } from '../../ui/ComponentError/ComponentError';

const PLAYER_VOLUME = 'owncast_volume';

export type OwncastPlayerProps = {
  source: string;
  online: boolean;
  initiallyMuted?: boolean;
  title: string;
  className?: string;
};

export const OwncastPlayer: FC<OwncastPlayerProps> = ({
  source,
  online,
  initiallyMuted = false,
  title,
  className,
}) => {
  const VideoSettingsService = useContext(VideoSettingsServiceContext);
  const playerRef = React.useRef(null);
  const pingRef = React.useRef<ViewerPing | null>(null);
  const playbackMetricsRef = React.useRef<PlaybackMetrics | null>(null);
  const latencyCompensatorRef = React.useRef<LatencyCompensator | null>(null);
  const latencyCompensatorEnabledRef = React.useRef(false);
  const [videoPlaying, setVideoPlaying] = useRecoilState<boolean>(isVideoPlayingAtom);
  const clockSkew = useRecoilValue<Number>(clockSkewAtom);
  const clockSkewRef = React.useRef(clockSkew);

  if (!pingRef.current) {
    pingRef.current = new ViewerPing();
  }
  clockSkewRef.current = clockSkew;

  const setSavedVolume = player => {
    try {
      player.volume(getLocalStorage(PLAYER_VOLUME) || 1);
    } catch (err) {
      console.warn(err);
    }
  };

  const handleVolume = player => {
    setLocalStorage(PLAYER_VOLUME, player.muted() ? 0 : player.volume());
  };

  const stopLatencyCompensator = React.useCallback(() => {
    latencyCompensatorRef.current?.dispose();
    latencyCompensatorRef.current = null;
    latencyCompensatorEnabledRef.current = false;
  }, []);

  const startLatencyCompensator = React.useCallback(
    player => {
      if (!player || player.isDisposed()) {
        return;
      }

      stopLatencyCompensator();
      const compensator = new LatencyCompensator(player);
      compensator.setClockSkew(clockSkewRef.current);
      compensator.enable();
      latencyCompensatorRef.current = compensator;
      latencyCompensatorEnabledRef.current = true;
    },
    [stopLatencyCompensator],
  );

  // Toggle minimized latency mode. Return the new state.
  const toggleLatencyCompensator = () => {
    if (latencyCompensatorEnabledRef.current) {
      stopLatencyCompensator();
    } else {
      startLatencyCompensator(playerRef.current);
    }
    return latencyCompensatorEnabledRef.current;
  };

  const setupLatencyCompensator = player => {
    const tech = player.tech({ IWillNotUseThisInPlugins: true });

    // VHS is required.
    if (!tech || !tech.vhs) {
      return;
    }

    if (!latencyCompensatorRef.current) {
      startLatencyCompensator(player);
    }
  };

  const createSettings = async (player, videojs) => {
    const videoQualities = await VideoSettingsService.getVideoQualities();
    if (player.isDisposed() || playerRef.current !== player) {
      return;
    }

    setupLatencyCompensator(player);
    const menuButton = createVideoSettingsMenuButton(
      player,
      videojs,
      videoQualities,
      toggleLatencyCompensator,
      latencyCompensatorEnabledRef.current,
    );
    player.controlBar.addChild(
      menuButton,
      {},
      // eslint-disable-next-line no-underscore-dangle
      player.controlBar.children_.length - 2,
    );
  };

  const setupAirplay = (player, videojs) => {
    // eslint-disable-next-line no-prototype-builtins
    if (window.hasOwnProperty('WebKitPlaybackTargetAvailabilityEvent')) {
      const VJSButtonClass = videojs.getComponent('Button');

      class ConcreteButtonClass extends VJSButtonClass {
        constructor() {
          super(player);
        }

        // eslint-disable-next-line class-methods-use-this
        handleClick() {
          try {
            const videoElement = player.el().querySelector('video');
            (videoElement as any).webkitShowPlaybackTargetPicker();
          } catch (e) {
            console.error(e);
          }
        }
      }

      const ccbc = new ConcreteButtonClass();
      const concreteButtonInstance = player.controlBar.addChild(ccbc);
      concreteButtonInstance.addClass('vjs-airplay');
    }
  };

  const videoJsOptions = React.useMemo(
    () => ({
      autoplay: false,
      controls: true,
      responsive: true,
      fluid: false,
      fill: true,
      playsinline: true,
      liveui: true,
      preload: 'auto',
      muted: initiallyMuted,
      controlBar: {
        progressControl: {
          seekBar: false,
        },
      },
      html5: {
        vhs: {
          // used to select the lowest bitrate playlist initially. This helps to decrease playback start time. This setting is false by default.
          enableLowInitialPlaylist: true,
          experimentalBufferBasedABR: true,
          useNetworkInformationApi: true,
          maxPlaylistRetries: 30,
        },
      },
      liveTracker: {
        trackingThreshold: 0,
        liveTolerance: 15,
      },
      sources: [
        {
          src: source,
          type: 'application/x-mpegURL',
        },
      ],
    }),
    [initiallyMuted, source],
  );

  const handlePlayerReady = (player, videojs) => {
    playerRef.current = player;
    setSavedVolume(player);
    setupAirplay(player, videojs);
    setupLatencyCompensator(player);

    // You can handle player events here, for example:
    player.on('waiting', () => {
      console.debug('player is waiting');
    });

    player.on('dispose', () => {
      console.debug('player will dispose');
      if (playerRef.current !== player) {
        return;
      }

      pingRef.current?.stop();
      playbackMetricsRef.current?.stop();
      playbackMetricsRef.current = null;
      stopLatencyCompensator();
      playerRef.current = null;
      setVideoPlaying(false);
    });

    player.on('playing', () => {
      console.debug('player is playing');
      pingRef.current?.start();
      setVideoPlaying(true);
    });

    player.on('pause', () => {
      console.debug('player is paused');
      pingRef.current?.stop();
      setVideoPlaying(false);
    });

    player.on('ended', () => {
      console.debug('player is ended');
      pingRef.current?.stop();
      setVideoPlaying(false);
    });

    player.on('volumechange', () => handleVolume(player));

    playbackMetricsRef.current?.stop();
    playbackMetricsRef.current = new PlaybackMetrics(player);
    playbackMetricsRef.current.setClockSkew(clockSkewRef.current);

    createSettings(player, videojs).catch(error => console.error(error));
  };

  useEffect(() => {
    playbackMetricsRef.current?.setClockSkew(clockSkew);
    latencyCompensatorRef.current?.setClockSkew(clockSkew);
  }, [clockSkew]);

  useEffect(
    () => () => {
      stopLatencyCompensator();
      playbackMetricsRef.current?.stop();
      playbackMetricsRef.current = null;
      pingRef.current?.stop();
    },
    [stopLatencyCompensator],
  );

  return (
    <ErrorBoundary
      // eslint-disable-next-line react/no-unstable-nested-components
      fallbackRender={({ error, resetErrorBoundary }) => (
        <ComponentError
          componentName="OwncastPlayer"
          message={error.message}
          retryFunction={resetErrorBoundary}
        />
      )}
    >
      <div className={classNames(styles.container, className)} id="player">
        {online && (
          <div className={styles.player}>
            <VideoJS options={videoJsOptions} onReady={handlePlayerReady} aria-label={title} />
          </div>
        )}
        <div className={styles.poster}>
          {!videoPlaying && (
            <VideoPoster online={online} initialSrc="/thumbnail.jpg" src="/thumbnail.jpg" />
          )}
        </div>
      </div>
    </ErrorBoundary>
  );
};
