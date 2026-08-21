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

const ping = new ViewerPing();
let playbackMetrics = null;
let latencyCompensator = null;
let latencyCompensatorEnabled = false;

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
  const [videoPlaying, setVideoPlaying] = useRecoilState<boolean>(isVideoPlayingAtom);
  const clockSkew = useRecoilValue<Number>(clockSkewAtom);

  const setSavedVolume = () => {
    try {
      playerRef.current.volume(getLocalStorage(PLAYER_VOLUME) || 1);
    } catch (err) {
      console.warn(err);
    }
  };

  const handleVolume = () => {
    setLocalStorage(PLAYER_VOLUME, playerRef.current.muted() ? 0 : playerRef.current.volume());
  };

  const startLatencyCompensator = () => {
    if (latencyCompensator) {
      latencyCompensator.stop();
    }

    latencyCompensatorEnabled = true;

    latencyCompensator = new LatencyCompensator(playerRef.current);
    latencyCompensator.setClockSkew(clockSkew);
    latencyCompensator.enable();
  };

  const stopLatencyCompensator = () => {
    if (latencyCompensator) {
      latencyCompensator.disable();
    }
    latencyCompensator = null;
    latencyCompensatorEnabled = false;
  };

  // Toggle minimized latency mode. Return the new state.
  const toggleLatencyCompensator = () => {
    if (latencyCompensatorEnabled) {
      stopLatencyCompensator();
    } else {
      startLatencyCompensator();
    }
    return latencyCompensatorEnabled;
  };

  const setupLatencyCompensator = player => {
    const tech = player.tech({ IWillNotUseThisInPlugins: true });

    // VHS is required.
    if (!tech || !tech.vhs) {
      return;
    }

    startLatencyCompensator();
  };

  const createSettings = async (player, videojs) => {
    const videoQualities = await VideoSettingsService.getVideoQualities();
    setupLatencyCompensator(player);
    const menuButton = createVideoSettingsMenuButton(
      player,
      videojs,
      videoQualities,
      toggleLatencyCompensator,
      latencyCompensatorEnabled,
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
            const videoElement = document.getElementsByTagName('video')[0];
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

  const videoJsOptions = {
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
  };

  const handlePlayerReady = (player, videojs) => {
    playerRef.current = player;
    setSavedVolume();
    setupAirplay(player, videojs);

    // You can handle player events here, for example:
    player.on('waiting', () => {
      console.debug('player is waiting');
    });

    player.on('dispose', () => {
      console.debug('player will dispose');
      ping.stop();
    });

    player.on('playing', () => {
      console.debug('player is playing');
      ping.start();
      setVideoPlaying(true);
    });

    player.on('pause', () => {
      console.debug('player is paused');
      ping.stop();
      setVideoPlaying(false);
    });

    player.on('ended', () => {
      console.debug('player is ended');
      ping.stop();
      setVideoPlaying(false);
    });

    videojs.hookOnce();

    player.on('volumechange', handleVolume);

    playbackMetrics = new PlaybackMetrics(player, videojs);
    playbackMetrics.setClockSkew(clockSkew);

    createSettings(player, videojs);
  };

  useEffect(() => {
    if (playbackMetrics) {
      playbackMetrics.setClockSkew(clockSkew);
    }
  }, [clockSkew]);

  useEffect(
    () => () => {
      stopLatencyCompensator();
      playbackMetrics?.stop();
    },
    [],
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
