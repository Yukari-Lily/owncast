package data

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/owncast/owncast/config"
	"github.com/owncast/owncast/models"
	"github.com/owncast/owncast/static"
	"github.com/owncast/owncast/utils"
	"github.com/pkg/errors"
	log "github.com/sirupsen/logrus"
)

var (
	emojiCacheMu       sync.Mutex
	emojiCacheData     = make([]models.CustomEmoji, 0)
	emojiCacheModTime  time.Time
	emojiCacheLastScan time.Time
)

const emojiCacheScanInterval = 5 * time.Second

// normalizeEmojiName strips a leading numeric sort prefix used only to order
// emoji in the picker, so it doesn't leak into the shortcode:
// "01 阿拉蕾呜哇" -> "阿拉蕾呜哇". Ordering is preserved because the number
// stays in the file path/URL that drives WalkDir order. Pure-numeric ASCII
// names like "0001" (no separator) are left untouched. "_cover" is dropped as
// before so *_cover* files still share the shortcode of their base name.
func normalizeEmojiName(fileBase string) string {
	fileBase = strings.TrimSuffix(fileBase, "_cover")
	if i := strings.IndexByte(fileBase, ' '); i > 0 {
		if _, err := strconv.Atoi(fileBase[:i]); err == nil {
			fileBase = fileBase[i+1:]
		}
	}
	return fileBase
}

func emojiTreeModTime() (time.Time, error) {
	var newest time.Time
	err := fs.WalkDir(os.DirFS(config.CustomEmojiPath), ".", func(_ string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.ModTime().After(newest) {
			newest = info.ModTime()
		}
		return nil
	})
	if err != nil {
		return time.Time{}, fmt.Errorf("unable to inspect custom emoji directory: %w", err)
	}
	return newest, nil
}

// UpdateEmojiList will update the cache (if required) and
// return the modifiation time.
func UpdateEmojiList(force bool) (time.Time, error) {
	emojiCacheMu.Lock()
	defer emojiCacheMu.Unlock()
	if !force && !emojiCacheLastScan.IsZero() && time.Since(emojiCacheLastScan) < emojiCacheScanInterval {
		return emojiCacheModTime, nil
	}

	modTime, err := emojiTreeModTime()
	if err != nil {
		return emojiCacheModTime, err
	}
	scanTime := time.Now()

	if !modTime.After(emojiCacheModTime) && !force {
		emojiCacheLastScan = scanTime
		return emojiCacheModTime, nil
	}

	nextModTime := modTime
	if force {
		if now := time.Now(); now.After(nextModTime) {
			nextModTime = now
		}
		if !nextModTime.After(emojiCacheModTime) {
			nextModTime = emojiCacheModTime.Add(time.Nanosecond)
		}
	}

	emojiFS := os.DirFS(config.CustomEmojiPath)

	nextEmojiData := make([]models.CustomEmoji, 0)

	walkFunction := func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d == nil || d.IsDir() {
			return nil
		}

		emojiPath := filepath.Join(config.EmojiDir, path)
		fileName := d.Name()
		fileBase := fileName[:len(fileName)-len(filepath.Ext(fileName))]

		name := normalizeEmojiName(fileBase)
		// Prefix the shortcode with the folder name so emojis that share
		// a base name in different tabs (folders) stay distinct after
		// sending: 09梦限大/阿拉蕾呜哇.png -> :09梦限大-阿拉蕾呜哇:.
		// Root-level emojis (admin uploads) keep their plain name.
		if folder := filepath.Dir(path); folder != "." {
			name = folder + "-" + name
		}

		singleEmoji := models.CustomEmoji{
			Name:  name,
			URL:   emojiPath,
			Cover: strings.HasSuffix(fileBase, "_cover") || fileBase == "cover",
		}
		nextEmojiData = append(nextEmojiData, singleEmoji)
		return nil
	}

	if err := fs.WalkDir(emojiFS, ".", walkFunction); err != nil {
		return emojiCacheModTime, fmt.Errorf("unable to fetch emojis: %w", err)
	}
	emojiCacheLastScan = scanTime
	emojiCacheData = nextEmojiData
	emojiCacheModTime = nextModTime
	modTime = nextModTime

	return modTime, nil
}

// GetEmojiList returns a list of custom emoji from the emoji directory.
func GetEmojiList() []models.CustomEmoji {
	// A transient scan failure should not replace a previously valid API
	// response with null. Keep serving the last complete snapshot and retry on
	// the next scan.
	_, _ = UpdateEmojiList(false)

	// Lock to make sure this doesn't get updated in the middle of reading
	emojiCacheMu.Lock()
	defer emojiCacheMu.Unlock()

	// return a copy of cache data, ensures underlying slice isn't affected
	// by future update
	emojiData := make([]models.CustomEmoji, len(emojiCacheData))
	copy(emojiData, emojiCacheData)

	return emojiData
}

// SetupEmojiDirectory ensures the custom emoji directory exists and merges in
// any built-in emojis that are not already on disk. Existing files are never
// overwritten so user uploads and customizations are preserved; only missing
// paths from the embedded set are copied. This lets image rebuilds that add
// new packs show up under an already-populated data/emoji volume.
func SetupEmojiDirectory() (err error) {
	if err = os.MkdirAll(config.CustomEmojiPath, 0o750); err != nil {
		return fmt.Errorf("unable to create custom emoji directory: %w", err)
	}

	staticFS := static.GetEmoji()

	walkFunction := func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == "." {
			return nil
		}
		if d.Name() == "LICENSE.md" {
			return nil
		}

		emojiPath := filepath.Join(config.CustomEmojiPath, path)

		if d.IsDir() {
			if mkErr := os.MkdirAll(emojiPath, 0o700); mkErr != nil {
				return errors.Wrap(mkErr, "unable to create emoji directory, check permissions?: "+path)
			}
			return nil
		}

		// Skip files the user (or a previous setup) already has.
		if utils.DoesFileExists(emojiPath) {
			return nil
		}

		if mkErr := os.MkdirAll(filepath.Dir(emojiPath), 0o700); mkErr != nil {
			return errors.Wrap(mkErr, "unable to create emoji parent directory: "+path)
		}

		memFile, staticOpenErr := staticFS.Open(path)
		if staticOpenErr != nil {
			return errors.Wrap(staticOpenErr, "unable to open emoji file from embedded filesystem")
		}
		defer memFile.Close()

		// nolint:gosec
		diskFile, createErr := os.Create(emojiPath)
		if createErr != nil {
			return fmt.Errorf("unable to create custom emoji file on disk: %w", createErr)
		}

		if _, copyErr := io.Copy(diskFile, memFile); copyErr != nil {
			_ = diskFile.Close()
			_ = os.Remove(emojiPath)
			return fmt.Errorf("unable to copy built-in emoji file to disk: %w", copyErr)
		}

		if closeErr := diskFile.Close(); closeErr != nil {
			_ = os.Remove(emojiPath)
			return fmt.Errorf("unable to close custom emoji file on disk: %w", closeErr)
		}

		return nil
	}

	if err := fs.WalkDir(staticFS, ".", walkFunction); err != nil {
		log.Errorln("unable to fetch emojis: " + err.Error())
		return errors.Wrap(err, "unable to fetch embedded emoji files")
	}

	return nil
}
