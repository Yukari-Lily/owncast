package admin

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/owncast/owncast/controllers"
	"github.com/owncast/owncast/core/data"
	"github.com/owncast/owncast/models"
)

type oneBotConfigurationResponse struct {
	APIURL                string `json:"apiUrl"`
	TargetType            string `json:"targetType"`
	TargetID              string `json:"targetId"`
	Enabled               bool   `json:"enabled"`
	AccessTokenConfigured bool   `json:"accessTokenConfigured"`
}

type oneBotConfigurationRequest struct {
	AccessToken      *string `json:"accessToken,omitempty"`
	APIURL           string  `json:"apiUrl"`
	TargetType       string  `json:"targetType"`
	TargetID         string  `json:"targetId"`
	Enabled          bool    `json:"enabled"`
	ClearAccessToken bool    `json:"clearAccessToken,omitempty"`
}

// OneBotConfiguration gets or updates the OneBot 11 notification configuration.
func OneBotConfiguration(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case controllers.GET:
		config := data.GetOneBotConfig()
		controllers.WriteResponse(w, oneBotConfigurationResponse{
			APIURL:                config.APIURL,
			TargetType:            config.TargetType,
			TargetID:              config.TargetID,
			Enabled:               config.Enabled,
			AccessTokenConfigured: config.AccessToken != "",
		})
	case controllers.POST:
		setOneBotConfiguration(w, r)
	default:
		controllers.WriteSimpleResponse(w, false, r.Method+" not supported")
	}
}

func setOneBotConfiguration(w http.ResponseWriter, r *http.Request) {
	var request oneBotConfigurationRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		controllers.WriteSimpleResponse(w, false, "无法解析 OneBot 配置")
		return
	}

	request.APIURL = strings.TrimRight(strings.TrimSpace(request.APIURL), "/")
	request.TargetType = strings.TrimSpace(request.TargetType)
	request.TargetID = strings.TrimSpace(request.TargetID)

	if request.Enabled {
		parsedURL, err := url.ParseRequestURI(request.APIURL)
		if err != nil || parsedURL.Host == "" || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
			controllers.WriteSimpleResponse(w, false, "OneBot 地址必须是有效的 HTTP 或 HTTPS 地址")
			return
		}
		if request.TargetType != models.OneBotTargetGroup && request.TargetType != models.OneBotTargetPrivate {
			controllers.WriteSimpleResponse(w, false, "发送目标必须是群聊或私聊")
			return
		}
		targetID, err := strconv.ParseInt(request.TargetID, 10, 64)
		if err != nil || targetID <= 0 {
			controllers.WriteSimpleResponse(w, false, "群号或 QQ 号必须是正整数")
			return
		}
	}

	current := data.GetOneBotConfig()
	accessToken := current.AccessToken
	if request.ClearAccessToken {
		accessToken = ""
	} else if request.AccessToken != nil && strings.TrimSpace(*request.AccessToken) != "" {
		accessToken = strings.TrimSpace(*request.AccessToken)
	}

	config := models.OneBotConfiguration{
		APIURL:      request.APIURL,
		AccessToken: accessToken,
		TargetType:  request.TargetType,
		TargetID:    request.TargetID,
		Enabled:     request.Enabled,
	}
	if err := data.SetOneBotConfig(config); err != nil {
		controllers.InternalErrorHandler(w, err)
		return
	}

	controllers.WriteSimpleResponse(w, true, "OneBot 配置已保存")
}
