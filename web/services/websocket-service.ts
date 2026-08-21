import { MessageType, SocketEvent } from '../interfaces/socket-events';

export interface SocketMessage {
  type: MessageType;
  data: any;
}

export default class WebsocketService {
  websocket: WebSocket | null;

  accessToken: string;

  host: string;

  path: string;

  websocketReconnectTimer: ReturnType<typeof setTimeout> | null;

  isShutdown = false;

  backOff = 0;

  handleMessage?: (message: SocketEvent) => void;

  socketConnected?: () => void;

  socketDisconnected?: () => void;

  constructor(accessToken, path, host) {
    this.accessToken = accessToken;
    this.path = path;
    this.websocketReconnectTimer = null;
    this.websocket = null;
    this.isShutdown = false;
    this.host = host;

    this.createAndConnect = this.createAndConnect.bind(this);
    this.shutdown = this.shutdown.bind(this);

    this.createAndConnect();
  }

  createAndConnect() {
    if (!this.host) {
      return;
    }

    if (this.isShutdown) {
      return;
    }

    const url = new URL(this.host);
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = this.path;
    url.port = window.location.port === '3000' ? '8080' : window.location.port;
    url.searchParams.append('accessToken', this.accessToken);

    const ws = new WebSocket(url.toString());
    ws.onopen = () => this.onOpen(ws);
    ws.onerror = () => this.onError(ws);
    ws.onclose = () => this.onClose(ws);
    ws.onmessage = this.onMessage.bind(this);

    this.websocket = ws;
  }

  onOpen(ws: WebSocket) {
    if (ws !== this.websocket || this.isShutdown) {
      return;
    }

    if (this.websocketReconnectTimer) {
      clearTimeout(this.websocketReconnectTimer);
      this.websocketReconnectTimer = null;
    }
    this.socketConnected?.();
    this.backOff = 0;
  }

  // Closing funnels all reconnect scheduling through onClose so an error and
  // its corresponding close event cannot create two sockets.
  onError(ws: WebSocket) {
    if (ws !== this.websocket || this.isShutdown) {
      return;
    }

    handleNetworkingError();
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }

  onClose(ws: WebSocket) {
    if (ws !== this.websocket) {
      return;
    }

    this.websocket = null;
    if (this.isShutdown) {
      return;
    }

    this.socketDisconnected?.();
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.isShutdown) {
      return;
    }

    if (this.websocketReconnectTimer) {
      return;
    }
    this.websocketReconnectTimer = setTimeout(
      () => {
        this.websocketReconnectTimer = null;
        this.createAndConnect();
      },
      Math.min(this.backOff, 10_000),
    );
    this.backOff += 1000;
  }

  shutdown() {
    this.isShutdown = true;
    if (this.websocketReconnectTimer) {
      clearTimeout(this.websocketReconnectTimer);
      this.websocketReconnectTimer = null;
    }
    this.websocket?.close();
    this.websocket = null;
  }

  /*
  onMessage is fired when an inbound object comes across the websocket.
  If the message is of type `PING` we send a `PONG` back and do not
  pass it along to listeners.
  */
  onMessage(e: SocketMessage) {
    // Optimization where multiple events can be sent within a
    // single websocket message. So split them if needed.
    const messages = e.data.split('\n');
    let socketEvent: SocketEvent;

    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < messages.length; i++) {
      try {
        socketEvent = JSON.parse(messages[i]);
        if (this.handleMessage) {
          this.handleMessage(socketEvent);
        }
      } catch (err) {
        console.error(err, err.data);
        return;
      }

      if (!socketEvent.type) {
        console.error('No type provided', socketEvent);
        return;
      }

      // Send PONGs
      if (socketEvent.type === MessageType.PING) {
        this.sendPong();
        return;
      }
    }
  }

  isConnected(): boolean {
    return this.websocket?.readyState === WebSocket.OPEN;
  }

  // Outbound: Other components can pass an object to `send`.
  send(socketEvent: any): boolean {
    // Sanity check that what we're sending is a valid type.
    if (!socketEvent.type || !MessageType[socketEvent.type]) {
      console.warn(`Outbound message: Unknown socket message type: "${socketEvent.type}" sent.`);
    }

    const { websocket } = this;
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      console.warn('Outbound websocket message skipped because chat is disconnected.');
      return false;
    }

    const messageJSON = JSON.stringify(socketEvent);
    websocket.send(messageJSON);
    return true;
  }

  // Reply to a PING as a keep alive.
  sendPong() {
    const pong = { type: MessageType.PONG };
    this.send(pong);
  }
}

function handleNetworkingError() {
  console.error(
    `Chat has been disconnected and is likely not working for you. It's possible you were removed from chat. If this is a server configuration issue, visit troubleshooting steps to resolve. https://owncast.online/docs/troubleshooting/#chat-is-disabled`,
  );
}
