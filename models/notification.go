package models

// DiscordConfiguration represents the configuration for the discord
// notification service.
type DiscordConfiguration struct {
	Webhook       string `json:"webhook,omitempty"`
	GoLiveMessage string `json:"goLiveMessage,omitempty"`
	Enabled       bool   `json:"enabled"`
}

// BrowserNotificationConfiguration represents the configuration for
// browser notifications.
type BrowserNotificationConfiguration struct {
	GoLiveMessage string `json:"goLiveMessage,omitempty"`
	Enabled       bool   `json:"enabled"`
}

const (
	// OneBotTargetGroup sends notifications to a QQ group.
	OneBotTargetGroup = "group"
	// OneBotTargetPrivate sends notifications to a private QQ chat.
	OneBotTargetPrivate = "private"
)

// OneBotConfiguration represents the configuration for OneBot 11 viewer notifications.
type OneBotConfiguration struct {
	APIURL      string `json:"apiUrl"`
	AccessToken string `json:"accessToken,omitempty"`
	TargetType  string `json:"targetType"`
	TargetID    string `json:"targetId"`
	Enabled     bool   `json:"enabled"`
}
