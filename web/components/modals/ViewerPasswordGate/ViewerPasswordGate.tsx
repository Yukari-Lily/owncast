import React, { FC, useState } from 'react';
import { Button, Input, Alert, Typography } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { setLocalStorage } from '../../../utils/localStorage';
import styles from './ViewerPasswordGate.module.scss';

const VIEWER_AUTH_KEY = 'viewerAuthenticated';

interface ViewerPasswordGateProps {
  onAuthenticated: () => void;
}

export const ViewerPasswordGate: FC<ViewerPasswordGateProps> = ({ onAuthenticated }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (loading) return;
    if (!password) {
      setError('Please enter a password');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/viewer/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        setError('Server error. Please try again later.');
        return;
      }

      const data = await response.json();

      if (data.authenticated) {
        // Persist to localStorage (permanent, like user display name)
        setLocalStorage(VIEWER_AUTH_KEY, 'true');
        onAuthenticated();
      } else {
        setError('Incorrect password. Please try again.');
        setPassword('');
      }
    } catch (e) {
      setError('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.iconContainer}>
          <LockOutlined className={styles.icon} />
        </div>
        <Typography.Title level={3} className={styles.title}>
          需要密码喵
        </Typography.Title>
        <Typography.Title level={5} className={styles.subtitle}>
          提示：臭臭的6位数字
        </Typography.Title>
        <div className={styles.form}>
          <Input.Password
            placeholder="Enter password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            size="large"
            className={styles.input}
            disabled={loading}
          />
          {error && <Alert message={error} type="error" showIcon className={styles.error} />}
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={loading}
            size="large"
            block
            className={styles.button}
          >
            Submit
          </Button>
        </div>
      </div>
    </div>
  );
};
