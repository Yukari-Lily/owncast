import React, { FC, useEffect, useMemo, useRef, useState } from 'react';
import { createPicker } from 'picmo';
import type { Emoji } from 'emojibase';

export type EmojiPickerProps = {
  onEmojiSelect: (emoji: string) => void;
  onCustomEmojiSelect: (name: string, url: string) => void;
  customEmoji: any[];
};

type EmojiRef = { name: string; url: string };

const MAX_RECENTS = 5;
const ALL = '__all__';
const RECENT = '__recent__';
const EMPTY: EmojiRef[] = [];

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
    const h = Array.from(bytes).reduce((acc, b) => Math.imul(acc ^ b, 0x01000193), 0x811c9dc5);
    const out = new Uint8Array(Array.from({ length: 32 }, (_, i) => (h >>> ((i % 4) * 8)) & 0xff));
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

// Custom emoji are served from /img/emoji/<folder>/<file>; group by folder.
function folderOf(url: string): string {
  const m = String(url).match(/\/img\/emoji\/([^/]+)/);
  return m ? m[1] : '其他';
}

// picmo's built-in "recents" category icon (Font Awesome clock), used for the
// recents tab so it matches the picker's native iconography.
const RecentsIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 512 512"
    fill="currentColor"
    width="20"
    height="20"
    aria-hidden="true"
  >
    <path d="M256 512C114.6 512 0 397.4 0 256C0 114.6 114.6 0 256 0C397.4 0 512 114.6 512 256C512 397.4 397.4 512 256 512zM232 256C232 264 236 271.5 242.7 275.1L338.7 339.1C349.7 347.3 364.6 344.3 371.1 333.3C379.3 322.3 376.3 307.4 365.3 300L280 243.2V120C280 106.7 269.3 96 255.1 96C242.7 96 231.1 106.7 231.1 120L232 256z" />
  </svg>
);

// A 2x2 grid icon for the "all" tab (browse the full emoji grid).
const AllIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    width="20"
    height="20"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="8" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
  </svg>
);

// SVG markup strings for the category-name headers under the "所有" tab. They
// match the RecentsIcon / AllIcon tab icons above (used via innerHTML when
// rewriting picmo's headers, see customizeCategoryHeader).
const RECENTS_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="currentColor" width="18" height="18" aria-hidden="true"><path d="M256 512C114.6 512 0 397.4 0 256C0 114.6 114.6 0 256 0C397.4 0 512 114.6 512 256C512 397.4 397.4 512 256 512zM232 256C232 264 236 271.5 242.7 275.1L338.7 339.1C349.7 347.3 364.6 344.3 371.1 333.3C379.3 322.3 376.3 307.4 365.3 300L280 243.2V120C280 106.7 269.3 96 255.1 96C242.7 96 231.1 106.7 231.1 120L232 256z" /></svg>';
const ALL_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>';

// Under the "所有" tab, swap picmo's default category-name icon + label for our
// own so the two sections match the tab icons. Only touches the icon element
// and the label text node, leaving anything else (e.g. a clear button) intact.
function customizeCategoryHeader(h3: Element | null, iconSvg: string, label: string) {
  if (!h3) return;
  const icon = h3.querySelector('[data-icon]');
  if (icon) {
    const tmp = document.createElement('div');
    tmp.innerHTML = iconSvg;
    const newIcon = tmp.firstElementChild;
    if (newIcon) {
      icon.replaceWith(newIcon);
    }
  }
  Array.from(h3.childNodes).forEach(node => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.trim()) {
      h3.replaceChild(document.createTextNode(label), node);
    }
  });
}

function renderTabInner(tab: { thumb?: string; icon?: React.ReactNode; label: string }) {
  if (tab.thumb) {
    return (
      <img
        src={tab.thumb}
        alt={tab.label}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />
    );
  }
  if (tab.icon) {
    return tab.icon;
  }
  return <span style={{ fontSize: '9px' }}>{tab.label.slice(0, 2)}</span>;
}

export const EmojiPicker: FC<EmojiPickerProps> = ({
  onEmojiSelect,
  onCustomEmojiSelect,
  customEmoji,
}) => {
  const ref = useRef<HTMLDivElement>();
  const [activeGroup, setActiveGroup] = useState<string>(ALL);

  // Group custom emoji by their emoji folder (derived from the URL path).
  // A Map preserves insertion order, which matches the server's WalkDir order
  // (the user numbers folders 00, 01, 02... to control tab order).
  const groups = useMemo(() => {
    const map = new Map<string, EmojiRef[]>();
    customEmoji.forEach(e => {
      const folder = folderOf(e.url);
      let arr = map.get(folder);
      if (!arr) {
        arr = [];
        map.set(folder, arr);
      }
      arr.push({ name: e.name, url: e.url });
    });
    return map;
  }, [customEmoji]);

  const folderNames = useMemo(() => Array.from(groups.keys()), [groups]);

  // The custom emojis to hand to picmo for the active tab. For the "最近" tab we
  // pass none (picmo's built-in recents category is shown instead). Returns
  // stable references so the picker only recreates when the tab or the data
  // actually changes -- not on every emoji select.
  const activeEmojis = useMemo<EmojiRef[]>(() => {
    if (activeGroup === RECENT) return EMPTY;
    if (activeGroup === ALL) return customEmoji as EmojiRef[];
    return groups.get(activeGroup) || EMPTY;
  }, [activeGroup, customEmoji, groups]);

  // picmo is configured per tab:
  //  - "最近": show only picmo's recents category (initialCategory 'recents').
  //  - "所有": show recents (top) + all custom, default scrolled to custom so
  //    scrolling up reveals the recents. recents only live here, not in folders.
  //  - folder: show only that folder's custom emojis (no recents).
  // The picker is recreated when the tab or the visible set changes. recents
  // are managed by picmo itself (maxRecents, persisted in localStorage).
  useEffect(() => {
    ensureCryptoSubtleAvailable();

    const root = ref.current;
    root.innerHTML = '';

    const custom = activeEmojis.map(e => ({
      emoji: e.name,
      label: e.name,
      url: e.url,
    }));

    const isRecent = activeGroup === RECENT;
    const isAll = activeGroup === ALL;

    let categories: ('recents' | 'custom')[];
    if (isRecent) {
      categories = ['recents'];
    } else if (isAll) {
      categories = ['recents', 'custom'];
    } else {
      categories = ['custom'];
    }

    const picker = createPicker({
      rootElement: root,
      custom,
      initialCategory: isRecent ? 'recents' : 'custom',
      categories,
      maxRecents: MAX_RECENTS,
      emojiData: [] as Emoji[],
      messages: { groups: [], skinTones: [], subgroups: [] },
      showPreview: false,
      showRecents: isRecent || isAll,
      showCategoryTabs: false,
      showSearch: false,
    });
    picker.addEventListener('emoji:select', event => {
      if (event.url) {
        onCustomEmojiSelect(event.label, event.url);
      } else {
        onEmojiSelect(event.emoji);
      }
    });

    // Under the "所有" tab, relabel the two category headers (recents / all) to
    // match the tab icons. Other tabs hide the single header via CSS.
    if (isAll) {
      picker.addEventListener('data:ready', () => {
        customizeCategoryHeader(
          root.querySelector('.picmo__categoryName[data-category="recents"]'),
          RECENTS_ICON_SVG,
          'Recent',
        );
        customizeCategoryHeader(
          root.querySelector('.picmo__categoryName[data-category="custom"]'),
          ALL_ICON_SVG,
          'All',
        );
      });
    }

    return () => {
      // picmo's destroy can throw if the picker failed to fully initialize.
      try {
        picker.destroy();
      } catch (e) {
        console.warn('Failed to destroy emoji picker', e);
      }
    };
    // Recreate only when the tab or the visible emoji set changes.
  }, [activeEmojis, activeGroup]);

  // Tab list: [最近] [所有] [<folder>...]. "最近" uses a clock icon, "所有"
  // uses a grid icon, and each folder tab uses its first emoji as a thumbnail.
  const tabs = useMemo<
    Array<{ key: string; label: string; thumb?: string; icon?: React.ReactNode }>
  >(() => {
    const folderTabs = folderNames.map(f => ({
      key: f,
      label: f,
      thumb: groups.get(f)?.[0]?.url,
    }));
    return [
      { key: RECENT, label: '最近', icon: <RecentsIcon /> },
      { key: ALL, label: '所有', icon: <AllIcon /> },
      ...folderTabs,
    ];
  }, [folderNames, groups]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        className="emoji-tabs"
        style={{
          display: 'flex',
          gap: '4px',
          overflowX: 'auto',
          padding: '0.5em',
        }}
      >
        {tabs.map(t => {
          const active = activeGroup === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveGroup(t.key)}
              title={t.label}
              className={`emoji-tab${active ? ' emoji-tab-active' : ''}`}
              style={{
                flex: '0 0 auto',
                width: '28px',
                height: '28px',
                padding: '0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: `2px solid ${active ? 'var(--accent-color, #4f46e5)' : 'transparent'}`,
                borderRadius: '5px',
                background: 'transparent',
                cursor: 'pointer',
                overflow: 'hidden',
              }}
            >
              {renderTabInner(t)}
            </button>
          );
        })}
      </div>
      <div ref={ref} className={activeGroup === ALL ? undefined : 'emoji-single-category'} />
    </div>
  );
};
