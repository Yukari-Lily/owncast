import React, { useState, useEffect, ReactElement } from 'react';
import { LogTable } from '../../components/admin/LogTable';

import { LOGS_ALL, fetchData } from '../../utils/apis';

import { AdminLayout } from '../../components/layouts/AdminLayout';

const FETCH_INTERVAL = 5 * 1000; // 5 sec

export default function Logs() {
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    let mounted = true;
    const getInfo = async () => {
      try {
        const result = await fetchData(LOGS_ALL);
        if (mounted) {
          setLogs(result);
        }
      } catch (error) {
        console.log('==== error', error);
      }
    };

    getInfo();
    const getStatusIntervalId = setInterval(getInfo, FETCH_INTERVAL);

    return () => {
      mounted = false;
      clearInterval(getStatusIntervalId);
    };
  }, []);

  return <LogTable logs={logs} initialPageSize={20} />;
}

Logs.getLayout = function getLayout(page: ReactElement) {
  return <AdminLayout page={page} />;
};
