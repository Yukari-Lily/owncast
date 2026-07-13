import React, { FC, useEffect, useRef } from 'react';
import { createPicker } from 'picmo';
import type { Emoji } from 'emojibase';

export type EmojiPickerProps = {
  onEmojiSelect: (emoji: string) => void;
  onCustomEmojiSelect: (name: string, url: string) => void;
  customEmoji: any[];
};

// picmo hashes the emoji dataset with crypto.subtle.digest to detect changes.
// crypto.subtle is only exposed in secure contexts (HTTPS / localhost), so on
// plain-HTTP origins it is undefined and picmo crashes while initializing.
// Install a minimal non-cryptographic digest fallback in that case. It is only
// used for picmo's internal change detection, never for anything security
// sensitive.
function ensureCryptoSubtleAvailable() {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    return;
  }
  // FNV-1a 32-bit, spread across 32 bytes to mimic a SHA-256 digest length.
  // picmo only uses this for emoji-data change detection, never for security.
  /* eslint-disable no-bitwise */
  const digest = async (_algorithm: string, data): Promise<ArrayBuffer> => {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i += 1) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      out[i] = (h >>> ((i % 4) * 8)) & 0xff;
    }
    return out.buffer;
  };
  /* eslint-enable no-bitwise */
  const target: Crypto = typeof crypto !== 'undefined' ? crypto : (window.crypto = {} as Crypto);
  // Use defineProperty (not assignment) because `subtle` is a read-only getter
  // on Crypto.prototype and a plain assignment throws in strict mode.
  Object.defineProperty(target, 'subtle', {
    value: { digest },
    writable: true,
    configurable: true,
  });
}

export const EmojiPicker: FC<EmojiPickerProps> = ({
  onEmojiSelect,
  onCustomEmojiSelect,
  customEmoji,
}) => {
  const ref = useRef<HTMLDivElement>();

  // We only use custom emoji, so:
  //  - `categories: ['custom']` hides the built-in native-emoji tabs.
  //  - Passing empty static `emojiData` + `messages` makes picmo populate its
  //    data store from these instead of fetching the emojibase dataset from
  //    the jsDelivr CDN (which is unreliable in some regions and was the
  //    cause of slow emoji loading). Custom emojis render independently of
  //    this store, so empty native data is safe.
  // The picker is recreated when `customEmoji` changes (it is fetched
  // asynchronously) so we never render an empty custom category.
  useEffect(() => {
    ensureCryptoSubtleAvailable();

    const root = ref.current;
    root.innerHTML = '';

    const custom = customEmoji.map(emoji => ({
      emoji: emoji.name,
      label: emoji.name,
      url: emoji.url,
    }));

    const picker = createPicker({
      rootElement: root,
      custom,
      initialCategory: 'custom',
      categories: ['custom'],
      emojiData: [] as Emoji[],
      messages: { groups: [], skinTones: [], subgroups: [] },
      showPreview: false,
      showRecents: true,
    });
    picker.addEventListener('emoji:select', event => {
      if (event.url) {
        onCustomEmojiSelect(event.label, event.url);
      } else {
        onEmojiSelect(event.emoji);
      }
    });

    return () => {
      // picmo's destroy can throw if the picker failed to fully initialize
      // (e.g. a data-load error). Don't let that break React unmount.
      try {
        picker.destroy();
      } catch (e) {
        console.warn('Failed to destroy emoji picker', e);
      }
    };
  }, [customEmoji]);

  return <div ref={ref} />;
};
