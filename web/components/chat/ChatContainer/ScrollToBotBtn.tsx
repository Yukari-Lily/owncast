import { Button } from 'antd';
import dynamic from 'next/dynamic';
import { FC } from 'react';
import styles from './ChatContainer.module.scss';

// Lazy loaded components

const VerticalAlignBottomOutlined = dynamic(
  () => import('@ant-design/icons/VerticalAlignBottomOutlined'),
  {
    ssr: false,
  },
);

type Props = {
  onClick: () => void;
  count?: number;
};

export const ScrollToBotBtn: FC<Props> = ({ onClick, count = 0 }) => (
  <div className={styles.toBottomWrap} id="scroll-to-chat-bottom">
    <Button
      type="default"
      style={{ color: 'currentColor' }}
      icon={<VerticalAlignBottomOutlined />}
      onClick={onClick}
    >
      {count > 0 ? `${count} new message${count === 1 ? '' : 's'}` : 'Go to last message'}
    </Button>
  </div>
);
