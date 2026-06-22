package controllers

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"

	"github.com/owncast/owncast/core/data"
	"github.com/owncast/owncast/router/middleware"
	log "github.com/sirupsen/logrus"
)

// VerifyViewerPassword handles the viewer password verification request.
func VerifyViewerPassword(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCors(w)

	if r.Method == "OPTIONS" {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method != http.MethodPost {
		WriteSimpleResponse(w, false, r.Method+" not supported")
		return
	}

	type viewerAuthRequest struct {
		Password string `json:"password"`
	}

	type viewerAuthResponse struct {
		Authenticated bool `json:"authenticated"`
	}

	decoder := json.NewDecoder(r.Body)
	var request viewerAuthRequest
	if err := decoder.Decode(&request); err != nil {
		log.Warnln("Unable to parse viewer auth request:", err)
		WriteResponse(w, viewerAuthResponse{Authenticated: false})
		return
	}

	if request.Password == "" {
		WriteResponse(w, viewerAuthResponse{Authenticated: false})
		return
	}

	// Check if viewer password is enabled
	if !data.GetViewerPasswordEnabled() {
		WriteResponse(w, viewerAuthResponse{Authenticated: true})
		return
	}

	viewerPassword := data.GetViewerPassword()
	if viewerPassword == "" {
		WriteResponse(w, viewerAuthResponse{Authenticated: false})
		return
	}

	// Constant-time comparison to prevent timing attacks
	if subtle.ConstantTimeCompare([]byte(request.Password), []byte(viewerPassword)) != 1 {
		WriteResponse(w, viewerAuthResponse{Authenticated: false})
		return
	}

	// Password is correct, set cookie
	cookieValue := data.GenerateViewerAuthCookieValue()
	http.SetCookie(w, &http.Cookie{
		Name:     data.ViewerAuthCookieName,
		Value:    cookieValue,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
		// Cookie valid for 30 days
		MaxAge: 30 * 24 * 60 * 60,
	})

	WriteResponse(w, viewerAuthResponse{Authenticated: true})
}

// CheckViewerAuth checks if the viewer has a valid auth cookie.
func CheckViewerAuth(r *http.Request) bool {
	return data.CheckViewerAuthCookie(r)
}

// GetViewerAuthStatus returns the current viewer authentication status.
func GetViewerAuthStatus(w http.ResponseWriter, r *http.Request) {
	middleware.EnableCors(w)
	w.Header().Set("Content-Type", "application/json")

	type viewerAuthStatusResponse struct {
		PasswordEnabled bool `json:"passwordEnabled"`
		Authenticated   bool `json:"authenticated"`
	}

	response := viewerAuthStatusResponse{
		PasswordEnabled: data.GetViewerPasswordEnabled(),
		Authenticated:   data.CheckViewerAuthCookie(r),
	}

	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Errorln(err)
	}
}
