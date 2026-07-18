import { FC } from 'react';
import styles from './Noscript.module.scss';

export const Noscript: FC = () => (
  <noscript className={styles.noscript}>
    <div className={styles.scrollContainer}>
      <div className={styles.content}>
        <br />
        <p>JavaScript is required to use this website.</p>
        <p>Please enable JavaScript in your browser settings for the best experience.</p>
      </div>
    </div>
  </noscript>
);
