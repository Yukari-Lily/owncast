package onebot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	useragent "github.com/mssola/user_agent"
	"github.com/owncast/owncast/core/data"
	"github.com/owncast/owncast/geoip"
	"github.com/owncast/owncast/models"
)

const (
	requestTimeout  = 10 * time.Second
	maxResponseSize = 1024 * 1024
	maxFallbackUA   = 256
)

type viewerKey struct {
	ip        string
	userAgent string
}

type messageSegment struct {
	Type string             `json:"type"`
	Data messageSegmentData `json:"data"`
}

type messageSegmentData struct {
	Text string `json:"text"`
}

type sendMessageRequest struct {
	GroupID int64            `json:"group_id,omitempty"`
	UserID  int64            `json:"user_id,omitempty"`
	Message []messageSegment `json:"message"`
}

type sendMessageResponse struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Wording string `json:"wording"`
	RetCode int    `json:"retcode"`
}

var notifiedViewers sync.Map

// SendViewerJoinedNotification sends a notification once for each unique IP and raw User-Agent pair.
func SendViewerJoinedNotification(username, ipAddress, rawUserAgent string, geo *geoip.GeoDetails) error {
	config := data.GetOneBotConfig()
	if !config.Enabled {
		return nil
	}

	key := viewerKey{ip: ipAddress, userAgent: rawUserAgent}
	if _, loaded := notifiedViewers.LoadOrStore(key, struct{}{}); loaded {
		return nil
	}

	if err := send(config, formatViewerMessage(username, ipAddress, rawUserAgent, geo)); err != nil {
		notifiedViewers.Delete(key)
		return err
	}

	return nil
}

func send(config models.OneBotConfiguration, text string) error {
	targetID, err := strconv.ParseInt(config.TargetID, 10, 64)
	if err != nil || targetID <= 0 {
		return fmt.Errorf("invalid OneBot target ID")
	}

	payload := sendMessageRequest{
		Message: []messageSegment{{
			Type: "text",
			Data: messageSegmentData{Text: text},
		}},
	}

	var action string
	switch config.TargetType {
	case models.OneBotTargetGroup:
		action = "send_group_msg"
		payload.GroupID = targetID
	case models.OneBotTargetPrivate:
		action = "send_private_msg"
		payload.UserID = targetID
	default:
		return fmt.Errorf("invalid OneBot target type")
	}

	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal OneBot message: %w", err)
	}

	requestURL := strings.TrimRight(config.APIURL, "/") + "/" + action
	req, err := http.NewRequest(http.MethodPost, requestURL, bytes.NewReader(jsonPayload))
	if err != nil {
		return fmt.Errorf("create OneBot request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if config.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+config.AccessToken)
	}

	client := &http.Client{Timeout: requestTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("send OneBot request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("OneBot returned HTTP status %d", resp.StatusCode)
	}

	var result sendMessageResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseSize)).Decode(&result); err != nil {
		return fmt.Errorf("decode OneBot response: %w", err)
	}
	if result.Status != "ok" || result.RetCode != 0 {
		detail := result.Wording
		if detail == "" {
			detail = result.Message
		}
		return fmt.Errorf("OneBot rejected message: retcode %d: %s", result.RetCode, detail)
	}

	return nil
}

func formatViewerMessage(username, ipAddress, rawUserAgent string, geo *geoip.GeoDetails) string {
	username = strings.TrimSpace(username)
	if username == "" {
		username = "未知"
	}

	location := "未知"
	if geo != nil {
		parts := make([]string, 0, 2)
		if geo.CountryCode != "" {
			parts = append(parts, geo.CountryCode)
		}
		if geo.RegionName != "" && geo.RegionName != "Unknown" {
			parts = append(parts, geo.RegionName)
		}
		if len(parts) > 0 {
			location = strings.Join(parts, "-")
		}
	}

	return fmt.Sprintf("新观众喵！\n%s\n%s\n%s\n%s", username, location, ipAddress, formatUserAgent(rawUserAgent))
}

func formatUserAgent(rawUserAgent string) string {
	parsed := useragent.New(rawUserAgent)
	browserName, browserVersion := parsed.Browser()
	operatingSystem := parsed.OS()
	if operatingSystem == "Windows 10" {
		operatingSystem = "Win 10/11"
	}

	if operatingSystem != "" && browserName != "" {
		if separator := strings.IndexByte(browserVersion, '.'); separator >= 0 {
			browserVersion = browserVersion[:separator]
		}
		browser := strings.TrimSpace(browserName + " " + browserVersion)
		return operatingSystem + " - " + browser
	}

	fallback := strings.Join(strings.Fields(rawUserAgent), " ")
	if fallback == "" {
		return "未知"
	}
	if utf8.RuneCountInString(fallback) > maxFallbackUA {
		fallback = string([]rune(fallback)[:maxFallbackUA])
	}
	return fallback
}
