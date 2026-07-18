import { Typography } from 'antd';
import React, { ReactElement, useContext, useEffect, useState } from 'react';
import { TextFieldWithSubmit } from '../../components/admin/TextFieldWithSubmit';
import { ToggleSwitch } from '../../components/admin/ToggleSwitch';
import { UpdateArgs } from '../../types/config-section';
import {
  FIELD_PROPS_VIEWER_PASSWORD_ENABLED,
  TEXTFIELD_PROPS_VIEWER_PASSWORD,
} from '../../utils/config-constants';
import { ServerStatusContext } from '../../utils/server-status-context';
import { AdminLayout } from '../../components/layouts/AdminLayout';

export default function ConfigSecret() {
  const { Title } = Typography;
  const [formDataValues, setFormDataValues] = useState(null);
  const serverStatusData = useContext(ServerStatusContext);
  const { serverConfig } = serverStatusData || {};

  const { viewerPasswordEnabled, viewerPassword } = serverConfig;

  const handleFieldChange = ({ fieldName, value }: UpdateArgs) => {
    setFormDataValues({
      ...formDataValues,
      [fieldName]: value,
    });
  };

  function handleViewerPasswordEnabledChange(enabled: boolean) {
    handleFieldChange({ fieldName: 'viewerPasswordEnabled', value: enabled });
  }

  useEffect(() => {
    setFormDataValues({
      viewerPasswordEnabled,
      viewerPassword: viewerPassword || '',
    });
  }, [serverConfig]);

  if (!formDataValues) {
    return null;
  }

  return (
    <div className="config-server-details-form">
      <Title>Secret</Title>
      <div className="form-module config-server-details-container">
        <ToggleSwitch
          fieldName="viewerPasswordEnabled"
          {...FIELD_PROPS_VIEWER_PASSWORD_ENABLED}
          checked={formDataValues.viewerPasswordEnabled}
          onChange={handleViewerPasswordEnabledChange}
        />
        <TextFieldWithSubmit
          fieldName="viewerPassword"
          {...TEXTFIELD_PROPS_VIEWER_PASSWORD}
          value={formDataValues.viewerPassword}
          initialValue={viewerPassword || ''}
          onChange={handleFieldChange}
        />
      </div>
    </div>
  );
}

ConfigSecret.getLayout = function getLayout(page: ReactElement) {
  return <AdminLayout page={page} />;
};
