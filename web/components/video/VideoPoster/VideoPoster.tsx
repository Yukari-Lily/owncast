import { FC, useEffect, useState } from 'react';
import { CrossfadeImage } from '../../ui/CrossfadeImage/CrossfadeImage';
import styles from './VideoPoster.module.scss';

const REFRESH_INTERVAL = 20_000;

export type VideoPosterProps = {
  initialSrc: string;
  src: string;
  online: boolean;
};

export const VideoPoster: FC<VideoPosterProps> = ({ online, initialSrc, src: base }) => {
  const [src, setSrc] = useState(initialSrc);
  const [duration, setDuration] = useState('0s');

  useEffect(() => {
    if (!online) {
      return undefined;
    }

    const timer = setInterval(() => {
      setDuration(currentDuration => (currentDuration === '0s' ? '3s' : currentDuration));
      setSrc(`${base}?${Date.now()}`);
    }, REFRESH_INTERVAL);

    return () => clearInterval(timer);
  }, [base, online]);

  return (
    <div className={styles.poster}>
      {!online && <img src={initialSrc} alt="logo" />}

      {online && (
        <CrossfadeImage
          src={src}
          duration={duration}
          objectFit="contain"
          height="auto"
          width="100%"
          className={styles.image}
        />
      )}
    </div>
  );
};
