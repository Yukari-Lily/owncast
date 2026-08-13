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
	emojiCacheMu      sync.Mutex
	emojiCacheData    = make([]models.CustomEmoji, 0)
	emojiCacheModTime time.Time
)

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

// UpdateEmojiList will update the cache (if required) and
// return the modifiation time.
func UpdateEmojiList(force bool) (time.Time, error) {
	var modTime time.Time

	emojiPathInfo, err := os.Stat(config.CustomEmojiPath)
	if err != nil {
		return modTime, err
	}

	modTime = emojiPathInfo.ModTime()

	if modTime.After(emojiCacheModTime) || force {
		emojiCacheMu.Lock()
		defer emojiCacheMu.Unlock()

		// double-check that another thread didn't update this while waiting.
		if modTime.After(emojiCacheModTime) || force {
			emojiCacheModTime = modTime
			if force {
				emojiCacheModTime = time.Now()
			}

			emojiFS := os.DirFS(config.CustomEmojiPath)
			if emojiFS == nil {
				return modTime, fmt.Errorf("unable to open custom emoji directory")
			}

			emojiCacheData = make([]models.CustomEmoji, 0)

			walkFunction := func(path string, d os.DirEntry, err error) error {
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
				emojiCacheData = append(emojiCacheData, singleEmoji)
				return nil
			}

			if err := fs.WalkDir(emojiFS, ".", walkFunction); err != nil {
				log.Errorln("unable to fetch emojis: " + err.Error())
			}
		}
	}

	return modTime, nil
}

// GetEmojiList returns a list of custom emoji from the emoji directory.
func GetEmojiList() []models.CustomEmoji {
	_, err := UpdateEmojiList(false)
	if err != nil {
		return nil
	}

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
