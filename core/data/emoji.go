package data

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
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
				singleEmoji := models.CustomEmoji{Name: fileBase, URL: emojiPath}
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
