import React, { FC, useEffect, useMemo, useRef, useState } from 'react';
import { createPicker } from 'picmo';
import type { Emoji } from 'emojibase';

export type EmojiPickerProps = {
  onEmojiSelect: (emoji: string) => void;
  onCustomEmojiSelect: (name: string, url: string) => void;
  customEmoji: any[];
};

type EmojiRef = { name: string; url: string };

const RECENTS_KEY = 'owncast_emoji_recents';
const MAX_RECENTS = 20;
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

function loadRecents(): EmojiRef[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

// picmo's built-in "recents" category icon (Font Awesome clock), used for the
// recents tab so it matches the picker's native iconography.
const RecentsIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 512 512"
    fill="currentColor"
    width="18"
    height="18"
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
    width="18"
    height="18"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="8" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
  </svg>
);

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
  const [recents, setRecents] = useState<EmojiRef[]>(() => loadRecents());

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

  // The set of emojis picmo should render for the active tab. Returns stable
  // references (the prop array / the memoized group array / the recents state)
  // so the picker only recreates when the visible set actually changes -- not
  // on every emoji select while on the "All" or a folder tab.
  const activeEmojis = useMemo<EmojiRef[]>(() => {
    if (activeGroup === ALL) return customEmoji as EmojiRef[];
    if (activeGroup === RECENT) return recents;
    return groups.get(activeGroup) || EMPTY;
  }, [activeGroup, customEmoji, recents, groups]);

  const addToRecents = (emoji: EmojiRef) => {
    setRecents(prev => {
      const next = [emoji, ...prev.filter(r => r.url !== emoji.url)].slice(0, MAX_RECENTS);
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  // picmo is configured to render only the custom-emoji grid (no native emoji,
  // no category tabs, no search, no recents). The category tab bar above is
  // our own. The picker is recreated when the visible set changes.
  useEffect(() => {
    ensureCryptoSubtleAvailable();

    const root = ref.current;
    root.innerHTML = '';

    const custom = activeEmojis.map(e => ({
      emoji: e.name,
      label: e.name,
      url: e.url,
    }));

    const picker = createPicker({
      rootElement: root,
      custom,
      initialCategory: 'custom',
      categories: ['custom'],
      emojiData: [] as Emoji[],
      messages: { groups: [], skinTones: [], subgroups: [] },
      showPreview: false,
      showRecents: false,
      showCategoryTabs: false,
      showSearch: false,
    });
    picker.addEventListener('emoji:select', event => {
      if (event.url) {
        onCustomEmojiSelect(event.label, event.url);
        addToRecents({ name: event.label, url: event.url });
      } else {
        onEmojiSelect(event.emoji);
      }
    });

    return () => {
      // picmo's destroy can throw if the picker failed to fully initialize.
      try {
        picker.destroy();
      } catch (e) {
        console.warn('Failed to destroy emoji picker', e);
      }
    };
    // Recreate only when the visible emoji set changes.
  }, [activeEmojis]);

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
          padding: '4px 0',
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
      <div ref={ref} />
    </div>
  );
};
