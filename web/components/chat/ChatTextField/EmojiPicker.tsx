import React, { FC, useEffect, useRef } from 'react';
import { createPicker } from 'picmo';
import type { Emoji } from 'emojibase';

export type EmojiPickerProps = {
  onEmojiSelect: (emoji: string) => void;
  onCustomEmojiSelect: (name: string, url: string) => void;
  customEmoji: any[];
};

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
      picker.destroy();
    };
  }, [customEmoji]);

  return <div ref={ref} />;
};
