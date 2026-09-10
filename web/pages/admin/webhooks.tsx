/* eslint-disable react/destructuring-assignment */
import {
  Alert,
  Button,
  Checkbox,
  Col,
  Divider,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Tooltip,
} from 'antd';
import dynamic from 'next/dynamic';
import React, { ReactElement, useEffect, useState } from 'react';
import {
  CREATE_WEBHOOK,
  DELETE_WEBHOOK,
  fetchData,
  ONEBOT_CONFIG,
  WEBHOOKS,
} from '../../utils/apis';
import { isValidUrl, DEFAULT_TEXTFIELD_URL_PATTERN } from '../../utils/validators';

import { AdminLayout } from '../../components/layouts/AdminLayout';

const { Title, Paragraph } = Typography;

// Lazy loaded components

const DeleteOutlined = dynamic(() => import('@ant-design/icons/DeleteOutlined'), {
  ssr: false,
});

type OneBotTargetType = 'group' | 'private';

interface OneBotConfiguration {
  apiUrl: string;
  targetType: OneBotTargetType;
  targetId: string;
  enabled: boolean;
  accessTokenConfigured: boolean;
}

const defaultOneBotConfiguration: OneBotConfiguration = {
  apiUrl: '',
  targetType: 'group',
  targetId: '',
  enabled: false,
  accessTokenConfigured: false,
};

const availableEvents = {
  CHAT: { name: 'Chat messages', description: 'When a user sends a chat message', color: 'purple' },
  USER_JOINED: { name: 'User joined', description: 'When a user joins the chat', color: 'green' },
  USER_PARTED: { name: 'User parted', description: 'When a user leaves the chat', color: 'green' },
  NAME_CHANGE: {
    name: 'User name changed',
    description: 'When a user changes their name',
    color: 'blue',
  },
  'VISIBILITY-UPDATE': {
    name: 'Message visibility changed',
    description: 'When a message visibility changes, likely due to moderation',
    color: 'red',
  },
  STREAM_STARTED: { name: 'Stream started', description: 'When a stream starts', color: 'orange' },
  STREAM_STOPPED: { name: 'Stream stopped', description: 'When a stream stops', color: 'cyan' },
  STREAM_TITLE_UPDATED: {
    name: 'Stream title updated',
    description: 'When a stream title is changed',
    color: 'yellow',
  },
};

function convertEventStringToTag(eventString: string) {
  if (!eventString || !availableEvents[eventString]) {
    return null;
  }

  const event = availableEvents[eventString];

  return (
    <Tooltip key={eventString} title={event.description}>
      <Tag color={event.color}>{event.name}</Tag>
    </Tooltip>
  );
}
interface Props {
  onCancel: () => void;
  onOk: any; // todo: make better type
  open: boolean;
}

const NewWebhookModal = (props: Props) => {
  const { onOk, onCancel, open } = props;

  const [selectedEvents, setSelectedEvents] = useState([]);
  const [webhookUrl, setWebhookUrl] = useState('');

  const events = Object.keys(availableEvents).map(key => ({
    value: key,
    label: availableEvents[key].description,
  }));

  function onChange(checkedValues) {
    setSelectedEvents(checkedValues);
  }

  function selectAll() {
    setSelectedEvents(Object.keys(availableEvents));
  }

  function save() {
    onOk(webhookUrl, selectedEvents);

    // Reset the modal
    setWebhookUrl('');
    setSelectedEvents(null);
  }

  const okButtonProps = {
    disabled: selectedEvents?.length === 0 || !isValidUrl(webhookUrl),
  };

  const checkboxes = events.map(singleEvent => (
    <Col span={8} key={singleEvent.value}>
      <Checkbox value={singleEvent.value}>{singleEvent.label}</Checkbox>
    </Col>
  ));

  return (
    <Modal
      title="Create New Webhook"
      open={open}
      onOk={save}
      onCancel={onCancel}
      okButtonProps={okButtonProps}
    >
      <div>
        <Input
          value={webhookUrl}
          placeholder="https://myserver.com/webhook"
          onChange={input => setWebhookUrl(input.currentTarget.value.trim())}
          type="url"
          pattern={DEFAULT_TEXTFIELD_URL_PATTERN}
        />
      </div>

      <p>Select the events that will be sent to this webhook.</p>
      <Checkbox.Group style={{ width: '100%' }} value={selectedEvents} onChange={onChange}>
        <Row>{checkboxes}</Row>
      </Checkbox.Group>
      <p>
        <Button type="primary" onClick={selectAll}>
          Select all
        </Button>
      </p>
    </Modal>
  );
};

const OneBotConfigurationForm = () => {
  const [configuration, setConfiguration] = useState<OneBotConfiguration>(
    defaultOneBotConfiguration,
  );
  const [accessToken, setAccessToken] = useState('');
  const [clearAccessToken, setClearAccessToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  useEffect(() => {
    async function loadConfiguration() {
      try {
        const result = await fetchData(ONEBOT_CONFIG);
        setConfiguration({ ...defaultOneBotConfiguration, ...result });
      } catch (error) {
        setFeedback({
          type: 'error',
          message: error instanceof Error ? error.message : '无法读取 OneBot 配置',
        });
      } finally {
        setLoading(false);
      }
    }

    loadConfiguration();
  }, []);

  const updateConfiguration = (field: keyof OneBotConfiguration, value: string | boolean) => {
    setConfiguration(current => ({ ...current, [field]: value }));
    setFeedback(null);
  };

  const targetIsValid = /^\d+$/.test(configuration.targetId) && configuration.targetId !== '0';
  const configurationIsValid =
    !configuration.enabled || (isValidUrl(configuration.apiUrl) && targetIsValid);

  const saveConfiguration = async () => {
    setSaving(true);
    setFeedback(null);

    const request: any = {
      apiUrl: configuration.apiUrl.trim(),
      targetType: configuration.targetType,
      targetId: configuration.targetId.trim(),
      enabled: configuration.enabled,
      clearAccessToken,
    };
    if (accessToken.trim()) {
      request.accessToken = accessToken.trim();
    }

    try {
      await fetchData(ONEBOT_CONFIG, { method: 'POST', data: request });
      setConfiguration(current => ({
        ...current,
        apiUrl: request.apiUrl,
        targetId: request.targetId,
        accessTokenConfigured: clearAccessToken
          ? false
          : Boolean(accessToken.trim()) || current.accessTokenConfigured,
      }));
      setAccessToken('');
      setClearAccessToken(false);
      setFeedback({ type: 'success', message: 'OneBot 配置已保存' });
    } catch (error) {
      setFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : '保存 OneBot 配置失败',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <Title>OneBot 11 新观众通知</Title>
      <Paragraph>
        当新的 IP 或 User-Agent 进入聊天时，通过 OneBot 11 向指定的 QQ 群或私聊发送通知。
      </Paragraph>

      <Form layout="vertical" style={{ maxWidth: 720 }}>
        <Form.Item label="启用 QQBot 通知">
          <Switch
            checked={configuration.enabled}
            checkedChildren="开启"
            unCheckedChildren="关闭"
            loading={loading}
            onChange={value => updateConfiguration('enabled', value)}
          />
        </Form.Item>

        <Form.Item label="OneBot HTTP 地址" required={configuration.enabled}>
          <Input
            type="url"
            value={configuration.apiUrl}
            placeholder="http://127.0.0.1:3000"
            disabled={loading}
            onChange={event => updateConfiguration('apiUrl', event.target.value)}
          />
        </Form.Item>

        <Form.Item
          label="Access Token（可选）"
          extra={
            configuration.accessTokenConfigured && !clearAccessToken
              ? '已保存 Token；留空不会修改。'
              : '未配置 Token。'
          }
        >
          <Input.Password
            value={accessToken}
            placeholder={
              configuration.accessTokenConfigured ? '留空保持现有 Token' : '请输入 Token'
            }
            disabled={loading || clearAccessToken}
            onChange={event => {
              setAccessToken(event.target.value);
              setFeedback(null);
            }}
          />
        </Form.Item>

        {configuration.accessTokenConfigured && (
          <Form.Item>
            <Checkbox
              checked={clearAccessToken}
              onChange={event => {
                setClearAccessToken(event.target.checked);
                setFeedback(null);
              }}
            >
              清除已保存的 Token
            </Checkbox>
          </Form.Item>
        )}

        <Form.Item label="发送目标">
          <Select
            value={configuration.targetType}
            disabled={loading}
            onChange={(value: OneBotTargetType) => updateConfiguration('targetType', value)}
            options={[
              { value: 'group', label: '群聊' },
              { value: 'private', label: '私聊' },
            ]}
          />
        </Form.Item>

        <Form.Item
          label={configuration.targetType === 'group' ? '群号' : 'QQ 号'}
          required={configuration.enabled}
        >
          <Input
            value={configuration.targetId}
            inputMode="numeric"
            placeholder={configuration.targetType === 'group' ? '请输入群号' : '请输入 QQ 号'}
            disabled={loading}
            onChange={event =>
              updateConfiguration('targetId', event.target.value.replace(/\D/g, ''))
            }
          />
        </Form.Item>

        <Button
          type="primary"
          loading={saving}
          disabled={loading || !configurationIsValid}
          onClick={saveConfiguration}
        >
          保存
        </Button>
      </Form>

      {feedback && (
        <Alert
          style={{ marginTop: 16, maxWidth: 720 }}
          type={feedback.type}
          message={feedback.message}
          showIcon
        />
      )}
    </section>
  );
};

const Webhooks = () => {
  const [webhooks, setWebhooks] = useState([]);
  const [isModalOpen, setIsModalOpen] = useState(false);

  function handleError(error) {
    console.error('error', error);
  }

  async function getWebhooks() {
    try {
      const result = await fetchData(WEBHOOKS);
      setWebhooks(result);
    } catch (error) {
      handleError(error);
    }
  }

  useEffect(() => {
    getWebhooks();
  }, []);

  async function handleDelete(id) {
    try {
      await fetchData(DELETE_WEBHOOK, { method: 'POST', data: { id } });
      getWebhooks();
    } catch (error) {
      handleError(error);
    }
  }

  async function handleSave(url: string, events: string[]) {
    try {
      const newHook = await fetchData(CREATE_WEBHOOK, {
        method: 'POST',
        data: { url, events },
      });
      setWebhooks(webhooks.concat(newHook));
    } catch (error) {
      handleError(error);
    }
  }

  const showCreateModal = () => {
    setIsModalOpen(true);
  };

  const handleModalSaveButton = (url, events) => {
    setIsModalOpen(false);
    handleSave(url, events);
  };

  const handleModalCancelButton = () => {
    setIsModalOpen(false);
  };

  const columns = [
    {
      title: '',
      key: 'delete',
      render: (_, record) => (
        <Space size="middle">
          <Button onClick={() => handleDelete(record.id)} icon={<DeleteOutlined />} />
        </Space>
      ),
    },
    {
      title: 'URL',
      dataIndex: 'url',
      key: 'url',
    },
    {
      title: 'Events',
      dataIndex: 'events',
      key: 'events',
      render: events => (
        <>
          {
            // eslint-disable-next-line arrow-body-style
            events.map(event => {
              return convertEventStringToTag(event);
            })
          }
        </>
      ),
    },
  ];

  return (
    <div>
      <OneBotConfigurationForm />
      <Divider />
      <Title>Webhooks</Title>
      <Paragraph>
        A webhook is a callback made to an external API in response to an event that takes place
        within Owncast. This can be used to build chat bots or sending automatic notifications that
        you&apos;ve started streaming.
      </Paragraph>
      <Paragraph>
        Read more about how to use webhooks, with examples, at{' '}
        <a
          href="https://owncast.online/docs/integrations/?source=admin"
          target="_blank"
          rel="noopener noreferrer"
        >
          our documentation
        </a>
        .
      </Paragraph>

      <Table
        rowKey={record => record.id}
        columns={columns}
        dataSource={webhooks}
        pagination={false}
      />
      <br />
      <Button type="primary" onClick={showCreateModal}>
        Create Webhook
      </Button>
      <NewWebhookModal
        open={isModalOpen}
        onOk={handleModalSaveButton}
        onCancel={handleModalCancelButton}
      />
    </div>
  );
};

Webhooks.getLayout = function getLayout(page: ReactElement) {
  return <AdminLayout page={page} />;
};

export default Webhooks;
