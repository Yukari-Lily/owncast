package chat

import (
	"bytes"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	log "github.com/sirupsen/logrus"

	"github.com/gorilla/websocket"
	"github.com/owncast/owncast/config"
	"github.com/owncast/owncast/core/chat/events"
	"github.com/owncast/owncast/core/user"
	"github.com/owncast/owncast/geoip"
)

// Client represents a single chat client.
type Client struct {
	ConnectedAt time.Time `json:"connectedAt"`
	conn        *websocket.Conn
	User        *user.User `json:"user"`
	server      *Server
	Geo         *geoip.GeoDetails `json:"geo"`
	// Buffered channel of outbound messages.
	send         chan []byte
	accessToken  string
	IPAddress    string `json:"-"`
	UserAgent    string `json:"userAgent"`
	MessageCount int    `json:"messageCount"`
	Id           uint   `json:"-"`
	mu           sync.RWMutex
}

type chatClientEvent struct {
	client *Client
	data   []byte
}

const (
	// Time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer.
	pongWait = 60 * time.Second

	// Send pings to peer with this period. Must be less than pongWait.
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size allowed from peer.
	// Larger messages get thrown away.
	// Messages > *2 the socket gets closed.
	maxMessageSize = config.MaxSocketPayloadSize
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,

	// Override default origin check to allow all clients, even those that
	// do not match our server.
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

var (
	newline = []byte{'\n'}
	space   = []byte{' '}
)

func (c *Client) sendConnectedClientInfo() {
	payload := events.ConnectedClientInfo{
		Event: events.Event{
			Type: events.ConnectedUserInfo,
		},
		User: c.User,
	}

	payload.SetDefaults()
	c.sendPayload(payload)
}

func (c *Client) readPump() {
	defer func() {
		c.close()
	}()

	// If somebody is sending 2x the max message size they're likely a bad actor
	// and should be disconnected. Below we throw away messages > max size.
	c.conn.SetReadLimit(maxMessageSize * 2)

	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error { _ = c.conn.SetReadDeadline(time.Now().Add(pongWait)); return nil })
	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				c.close()
			}
			break
		}

		// Throw away messages greater than max message size.
		if len(message) > maxMessageSize {
			c.sendAction("Sorry, that message exceeded the maximum size and can't be delivered.")
			continue
		}

		message = bytes.TrimSpace(bytes.ReplaceAll(message, newline, space))
		c.handleEvent(message)
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// The server closed the channel.
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			if _, err := w.Write(message); err != nil {
				log.Debugln(err)
			}

			// Optimization: Send multiple events in a single websocket message.
			// Add queued chat messages to the current websocket message.
			c.mu.RLock()
			n := len(c.send)
			for i := 0; i < n; i++ {
				_, _ = w.Write(newline)
				_, _ = w.Write(<-c.send)
			}
			c.mu.RUnlock()

			if err := w.Close(); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) handleEvent(data []byte) {
	c.server.inbound <- chatClientEvent{data: data, client: c}
}

func (c *Client) close() {
	log.Traceln("client closed:", c.User.DisplayName, c.Id, c.IPAddress)

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.send != nil {
		_ = c.conn.Close()
		c.server.unregister <- c.Id
		close(c.send)
		c.send = nil
	}
}


func (c *Client) sendPayload(payload interface{}) {
	var data []byte
	data, err := json.Marshal(payload)
	if err != nil {
		log.Errorln(err)
		return
	}

	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.send != nil {
		c.send <- data
	}
}

func (c *Client) sendAction(message string) {
	clientMessage := events.ActionEvent{
		MessageEvent: events.MessageEvent{
			Body: message,
		},
	}
	clientMessage.SetDefaults()
	clientMessage.RenderBody()
	c.sendPayload(clientMessage.GetBroadcastPayload())
}
