package controllers

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/owncast/owncast/config"
	"github.com/owncast/owncast/core/data"
	"github.com/owncast/owncast/models"
	"github.com/owncast/owncast/router/middleware"
)

// GetCustomEmojiList returns a list of emoji via the API.
func GetCustomEmojiList(w http.ResponseWriter, r *http.Request) {
	writeCustomEmojiList(w, r, data.GetEmojiList())
}

func writeCustomEmojiList(w http.ResponseWriter, r *http.Request, emojiList []models.CustomEmoji) {
	payload, err := json.Marshal(emojiList)
	if err != nil {
		InternalErrorHandler(w, err)
		return
	}
	payload = append(payload, '\n')
	etag := fmt.Sprintf("\"%x\"", sha256.Sum256(payload))

	middleware.SetCachingHeaders(w, r)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	if _, err := w.Write(payload); err != nil {
		InternalErrorHandler(w, err)
	}
}

// GetCustomEmojiImage returns a single emoji image.
func GetCustomEmojiImage(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/img/emoji/")
	r.URL.Path = path

	emojiFS := os.DirFS(config.CustomEmojiPath)
	middleware.SetCachingHeaders(w, r)
	http.FileServer(http.FS(emojiFS)).ServeHTTP(w, r)
}
