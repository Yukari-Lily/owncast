import React, {
  FC,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPicker } from 'picmo';
import type { Emoji } from 'emojibase';
import { attachSmoothWheelScroll } from '../../../utils/smoothWheelScroll';

export type EmojiPickerProps = {
  onEmojiSelect: (emoji: string) => void;
  onCustomEmojiSelect: (name: string, url: string) => void;
  customEmoji: any[];
  /** When false, hide picmo hosts (cache kept) so the close animation stays smooth. */
  open?: boolean;
};

type EmojiRef = { name: string; url: string };

type PickerEntry = {
  host: HTMLDivElement;
  // picmo's createPicker return type is not exported cleanly; keep loose.
  picker: {
    destroy: () => void;
    addEventListener: (type: string, fn: (...args: any[]) => void) => void;
  };
  detachScroll?: () => void;
  /** Clears the data:ready fallback timer so a closed host never reveals. */
  cancelReveal?: () => void;
};

const MAX_RECENTS = 10;
const ALL = '__all__';
const EMPTY: EmojiRef[] = [];
// Idle-prewarm at most this many non-ALL folders beyond the active tab.
const IDLE_PREWARM_LIMIT = 2;

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
  // FNV-1a 32-bit, padded across 32 bytes to mimic a SHA-256 digest length.
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

// Tab thumbnail: prefer a file whose basename ends with _cover (e.g.
// dy01_05_cover.png). Falls back to the first emoji in the folder.
function tabThumbUrl(emojis: EmojiRef[] | undefined): string | undefined {
  if (!emojis?.length) return undefined;
  const cover = emojis.find(e => {
    const m = String(e.url).match(/\/([^/]+)\.[^./]+$/);
    if (!m) return false;
    return m[1].endsWith('_cover');
  });
  return (cover || emojis[0]).url;
}

// A 2x2 grid icon for the "all" tab (browse the full emoji grid).
const AllIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    width="22"
    height="22"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="8" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
  </svg>
);

// SVG markup for the category-name headers under the "ALL" tab, used via
// innerHTML when rewriting picmo's headers (see customizeCategoryHeader).
// ALL_ICON_SVG matches the AllIcon tab icon above.
const RECENTS_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="currentColor" width="14" height="14" aria-hidden="true"><path d="M256 512C114.6 512 0 397.4 0 256C0 114.6 114.6 0 256 0C397.4 0 512 114.6 512 256C512 397.4 397.4 512 256 512zM232 256C232 264 236 271.5 242.7 275.1L338.7 339.1C349.7 347.3 364.6 344.3 371.1 333.3C379.3 322.3 376.3 307.4 365.3 300L280 243.2V120C280 106.7 269.3 96 255.1 96C242.7 96 231.1 106.7 231.1 120L232 256z" /></svg>';
const ALL_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>';

// Under the "ALL" tab, swap picmo's default category-name icon + label for our
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

// picmo's recents container dedupes its `emojis` array by *reference*
// (!== e) inside addOrUpdate. But a custom emoji clicked from the "custom"
// category is a different object reference than the same emoji loaded into
// recents from localStorage, so the dedup silently fails and leaves a
// duplicate. The subsequent slice(0, maxRecents) then drops the oldest entry
// from the `emojis` array while its DOM button stays put -- clicking that
// orphaned button finds no match in picmo's event lookup, so emoji:select
// never fires and the last (maxRecents-th) recent can't be sent.
//
// Workaround: remove the same-name entry from `emojis` by name *before*
// picmo's addOrUpdate runs, so picmo's reference-based dedup has nothing to
// miss; picmo then re-inserts e (fresh data) at the front. Patched once on
// the recents container's prototype. The WeakSet tracks which prototype
// classes we've already patched (avoids both re-patching and a dangling-
// underscore property on picmo's object). Guarded + try/catch so a future
// picmo with different internals just skips the patch instead of breaking.
const patchedRecentsContainers = new WeakSet();
function patchPicmoRecentsDedup(picker) {
  try {
    const recentsCategory = picker?.emojiArea?.emojiCategories?.find(
      c => c?.category?.key === 'recents',
    );
    const RecentsContainer = recentsCategory?.emojiContainer?.constructor;
    if (!RecentsContainer || patchedRecentsContainers.has(RecentsContainer)) {
      return;
    }
    const originalAddOrUpdate = RecentsContainer.prototype.addOrUpdate;
    RecentsContainer.prototype.addOrUpdate = async function addOrUpdate(e) {
      this.emojis = this.emojis.filter(emoji => emoji.emoji !== e.emoji);
      return originalAddOrUpdate.call(this, e);
    };
    patchedRecentsContainers.add(RecentsContainer);
  } catch {
    /* picmo internals changed -- skip the patch */
  }
}

const TAB_SIZE = 36;

function renderTabInner(tab: { thumb?: string; icon?: React.ReactNode; label: string }) {
  if (tab.thumb) {
    return (
      <img
        src={tab.thumb}
        alt={tab.label}
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />
    );
  }
  if (tab.icon) {
    return tab.icon;
  }
  return <span style={{ fontSize: '10px' }}>{tab.label.slice(0, 2)}</span>;
}

function destroyEntry(entry: PickerEntry) {
  if (entry.cancelReveal) {
    try {
      entry.cancelReveal();
    } catch {
      /* ignore */
    }
  }
  if (entry.detachScroll) {
    try {
      entry.detachScroll();
    } catch {
      /* ignore */
    }
  }
  try {
    entry.picker.destroy();
  } catch (e) {
    console.warn('Failed to destroy emoji picker', e);
  }
  entry.host.remove();
}

export const EmojiPicker: FC<EmojiPickerProps> = ({
  onEmojiSelect,
  onCustomEmojiSelect,
  customEmoji,
  open = true,
}) => {
  // Stable mount point that holds one host div per tab (hidden until shown).
  const hostsRootRef = useRef<HTMLDivElement>(null);
  // Live picmo instances keyed by tab (ALL or folder name). Switching tabs
  // only toggles host visibility; createPicker runs at most once per key until
  // data changes, the component unmounts, or a folder select invalidates ALL
  // (stale recents). Closing the popover only hides hosts — cache stays warm
  // so reopen is instant.
  const cacheRef = useRef<Map<string, PickerEntry>>(new Map());
  // Latest callbacks / data so create handlers do not stale-close over props.
  const onEmojiSelectRef = useRef(onEmojiSelect);
  const onCustomEmojiSelectRef = useRef(onCustomEmojiSelect);
  const customEmojiRef = useRef(customEmoji);
  onEmojiSelectRef.current = onEmojiSelect;
  onCustomEmojiSelectRef.current = onCustomEmojiSelect;
  customEmojiRef.current = customEmoji;

  const [activeGroup, setActiveGroup] = useState<string>(ALL);
  const activeGroupRef = useRef(activeGroup);
  activeGroupRef.current = activeGroup;
  const openRef = useRef(open);
  openRef.current = open;

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

  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const folderNames = useMemo(() => Array.from(groups.keys()), [groups]);

  const emojisFor = useCallback((key: string): EmojiRef[] => {
    if (key === ALL) return (customEmojiRef.current as EmojiRef[]) || EMPTY;
    return groupsRef.current.get(key) || EMPTY;
  }, []);

  // Build (or return cached) picmo picker for a tab key. Host stays hidden;
  // caller is responsible for showing the active one. Allowed while the
  // popover is closed so idle prewarm can finish before the next open.
  const ensurePicker = useCallback(
    (key: string): PickerEntry | null => {
      // Never build against an empty list (initial [] before /api/emoji returns).
      if (!customEmojiRef.current?.length) return null;

      const existing = cacheRef.current.get(key);
      if (existing) return existing;

      const root = hostsRootRef.current;
      if (!root) return null;

      ensureCryptoSubtleAvailable();

      const host = document.createElement('div');
      // Start hidden so prewarm / background creates do not flash content.
      host.hidden = true;
      // Fade in after data:ready so the first paint is not an empty box.
      host.style.opacity = '0';
      host.style.transition = 'opacity 80ms ease-out';
      host.dataset.emojiTab = key;
      if (key !== ALL) {
        host.classList.add('emoji-single-category');
      }
      root.appendChild(host);

      const list = emojisFor(key);
      const custom = list.map(e => ({
        emoji: e.name,
        label: e.name,
        url: e.url,
        // picmo dedupes recents by `hexcode`; custom emojis have none, so without
        // this every select wipes the recents (all undefined === undefined). Use
        // the URL as a stable unique key.
        hexcode: e.url,
      }));

      const isAll = key === ALL;
      const picker = createPicker({
        rootElement: host,
        custom,
        initialCategory: 'custom',
        categories: isAll ? ['recents', 'custom'] : ['custom'],
        maxRecents: MAX_RECENTS,
        emojiData: [] as Emoji[],
        messages: { groups: [], skinTones: [], subgroups: [] },
        showPreview: false,
        showRecents: isAll,
        showCategoryTabs: false,
        showSearch: false,
      });

      const entry: PickerEntry = { host, picker };

      picker.addEventListener('emoji:select', event => {
        // This handler fires before picmo runs its own recents addOrUpdate, so
        // patching here fixes the dedup bug from the very first select.
        patchPicmoRecentsDedup(picker);
        if (event.url) {
          onCustomEmojiSelectRef.current(event.label, event.url);
        } else {
          onEmojiSelectRef.current(event.emoji);
        }
        // Recents live only on the ALL picker. A select from a folder tab updates
        // shared storage but not a already-mounted ALL instance — drop it so the
        // next visit to ALL rebuilds with fresh recents. Rebuild on idle so the
        // next open / tab switch is warm again.
        if (key !== ALL) {
          const allEntry = cacheRef.current.get(ALL);
          if (allEntry) {
            destroyEntry(allEntry);
            cacheRef.current.delete(ALL);
          }
          const rebuildAll = () => {
            if (!customEmojiRef.current?.length) return;
            ensurePicker(ALL);
          };
          // Match other idle schedules in this file: bare setTimeout in the
          // fallback. After `'requestIdleCallback' in window` is false, TS can
          // narrow window oddly so window.setTimeout fails typecheck.
          if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
            window.requestIdleCallback(rebuildAll, { timeout: 2000 });
          } else {
            setTimeout(rebuildAll, 100);
          }
        }
      });

      const attachEmojiAreaScroll = () => {
        const area = host.querySelector('.picmo__emojiArea, .emojiArea') as HTMLElement | null;
        if (!area || entry.detachScroll) return;
        entry.detachScroll = attachSmoothWheelScroll(area, 'y');
      };

      let revealed = false;
      const reveal = () => {
        if (revealed) return;
        revealed = true;
        if (entry.cancelReveal) {
          entry.cancelReveal();
          entry.cancelReveal = undefined;
        }
        host.style.opacity = '1';
        attachEmojiAreaScroll();
      };

      picker.addEventListener('data:ready', () => {
        if (isAll) {
          customizeCategoryHeader(
            host.querySelector('.picmo__categoryName[data-category="recents"]'),
            RECENTS_ICON_SVG,
            'Recent',
          );
          customizeCategoryHeader(
            host.querySelector('.picmo__categoryName[data-category="custom"]'),
            ALL_ICON_SVG,
            'All',
          );
        }
        reveal();
      });
      // data:ready may have already fired for a fast/sync init; try once now too.
      if (
        host.querySelector('.picmo__emojiArea, .emojiArea, .picmo__picker:not(.picmo__skeleton)')
      ) {
        reveal();
      } else {
        // Fallback: if data:ready never fires, do not leave the host invisible.
        const tid = window.setTimeout(reveal, 400);
        entry.cancelReveal = () => window.clearTimeout(tid);
      }

      cacheRef.current.set(key, entry);
      return entry;
    },
    [emojisFor],
  );

  const showTab = useCallback(
    (key: string) => {
      if (!openRef.current) return;
      const entry = ensurePicker(key);
      cacheRef.current.forEach((e, k) => {
        e.host.hidden = k !== key;
      });
      if (entry) {
        entry.host.hidden = false;
        // Cached hosts that already finished data:ready stay at opacity 1. Fresh
        // creates keep opacity 0 until their own reveal() so we still fade in.
        if (
          entry.host.querySelector(
            '.picmo__emojiArea, .emojiArea, .picmo__picker:not(.picmo__skeleton)',
          )
        ) {
          entry.host.style.opacity = '1';
        }
      }
    },
    [ensurePicker],
  );

  // Open / close: hide hosts only — keep the per-tab cache warm so reopen is
  // instant. Freeze the shell's pixel size on close so the tab strip
  // (width:0; min-width:100%) does not collapse mid-hide animation.
  // Showing the active tab is handled by the activeGroup effect below (also
  // re-runs when open flips true).
  useLayoutEffect(() => {
    const hostsRoot = hostsRootRef.current;
    const shell = hostsRoot?.parentElement as HTMLElement | null;
    if (open) {
      if (hostsRoot) hostsRoot.style.display = '';
      // Clear close-time size freeze so fit-content tracks picmo again.
      if (shell) {
        shell.style.width = '';
        shell.style.height = '';
        shell.style.minWidth = '';
        shell.style.minHeight = '';
      }
      return;
    }
    // Capture full open size before hiding hosts (they drive fit-content).
    if (shell) {
      const box = shell.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        shell.style.width = `${Math.ceil(box.width)}px`;
        shell.style.height = `${Math.ceil(box.height)}px`;
        shell.style.minWidth = shell.style.width;
        shell.style.minHeight = shell.style.height;
      }
    }
    if (hostsRoot) hostsRoot.style.display = 'none';
    // Keep cache + hosts mounted. Pending reveal timers are fine: opacity 1
    // while hidden is harmless and avoids stuck opacity-0 after cancel.
  }, [open]);

  // Tab switch / reopen: pure show/hide of cached hosts (or create on demand).
  useLayoutEffect(() => {
    if (!open) return;
    showTab(activeGroup);
  }, [activeGroup, open, showTab]);

  // When the server emoji list changes, drop every cached picker so we do not
  // keep stale custom sets. Pure tab switches never hit this path.
  const prevCustomEmojiRef = useRef(customEmoji);
  useEffect(() => {
    if (prevCustomEmojiRef.current === customEmoji) return;
    prevCustomEmojiRef.current = customEmoji;
    cacheRef.current.forEach(destroyEntry);
    cacheRef.current.clear();
    if (!customEmoji?.length) return;
    if (openRef.current) {
      showTab(activeGroupRef.current);
    } else {
      // Rebuild ALL in the background so the next open is still warm.
      ensurePicker(ALL);
    }
  }, [customEmoji, showTab, ensurePicker]);

  // Destroy all cached pickers when the component unmounts.
  useEffect(
    () => () => {
      cacheRef.current.forEach(destroyEntry);
      cacheRef.current.clear();
    },
    [],
  );

  // Once emoji data is ready, idle-prewarm the default ALL tab (and a couple of
  // nearby folders). Safe while closed — ensurePicker no longer requires open.
  useEffect(() => {
    if (!customEmoji?.length || typeof window === 'undefined') return undefined;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      ensurePicker(ALL);
      if (cancelled) return;
      const keys = folderNames.filter(k => !cacheRef.current.has(k));
      const activeIdx = folderNames.indexOf(
        activeGroupRef.current === ALL ? folderNames[0] : activeGroupRef.current,
      );
      const ordered = keys.slice().sort((a, b) => {
        const da = Math.abs(folderNames.indexOf(a) - activeIdx);
        const db = Math.abs(folderNames.indexOf(b) - activeIdx);
        return da - db;
      });
      ordered.slice(0, IDLE_PREWARM_LIMIT).forEach(k => {
        if (!cancelled) {
          emojisFor(k).forEach(e => {
            if (!e.url) return;
            const img = new Image();
            img.src = e.url;
          });
          ensurePicker(k);
        }
      });
    };
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if ('requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(run, { timeout: 2500 });
    } else {
      timeoutId = setTimeout(run, 400);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleId);
      }
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [customEmoji, folderNames, ensurePicker, emojisFor]);

  // Tab list: [ALL] [<folder>...]. "ALL" uses a grid icon; each folder tab
  // uses *_cover* if present, otherwise the first emoji in that folder.
  const tabs = useMemo<
    Array<{ key: string; label: string; thumb?: string; icon?: React.ReactNode }>
  >(() => {
    const folderTabs = folderNames.map(f => ({
      key: f,
      label: f,
      thumb: tabThumbUrl(groups.get(f)),
    }));
    return [{ key: ALL, label: 'ALL', icon: <AllIcon /> }, ...folderTabs];
  }, [folderNames, groups]);

  const tabsRef = useRef<HTMLDivElement>(null);

  // Horizontal ease-out wheel scroll on the tab strip (shared helper).
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return undefined;
    return attachSmoothWheelScroll(el, 'x');
  }, []);

  // Warm tab thumbnails so the strip doesn't paint empty boxes on first open.
  useEffect(() => {
    tabs.forEach(t => {
      if (!t.thumb) return;
      const img = new Image();
      img.src = t.thumb;
    });
  }, [tabs]);

  // Prefetch a tab's picmo instance + image URLs on hover/focus so the click
  // is usually a pure show. Works while open or closed (cache survives close).
  const prewarmTab = useCallback(
    (key: string) => {
      if (cacheRef.current.has(key)) return;
      // Warm images first so they are in HTTP cache when picmo mounts them.
      emojisFor(key).forEach(e => {
        if (!e.url) return;
        const img = new Image();
        img.src = e.url;
      });
      ensurePicker(key);
    },
    [emojisFor, ensurePicker],
  );

  // While open, idle-prewarm a couple of nearby folders as the user moves around
  // the tab strip (mount-time prewarm already covers ALL + initial neighbors).
  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      const keys = folderNames.filter(k => k !== activeGroup && !cacheRef.current.has(k));
      // Prefer neighbors of the active folder in tab order.
      const activeIdx = folderNames.indexOf(activeGroup === ALL ? folderNames[0] : activeGroup);
      const ordered = keys.slice().sort((a, b) => {
        const da = Math.abs(folderNames.indexOf(a) - activeIdx);
        const db = Math.abs(folderNames.indexOf(b) - activeIdx);
        return da - db;
      });
      ordered.slice(0, IDLE_PREWARM_LIMIT).forEach(k => {
        if (!cancelled) prewarmTab(k);
      });
    };
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if ('requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(run, { timeout: 3000 });
    } else {
      timeoutId = setTimeout(run, 800);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleId);
      }
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [open, activeGroup, folderNames, prewarmTab]);

  // Root is width:fit-content so its size is driven by the picmo child
  // (--picker-width, which custom CSS may enlarge). The tab strip uses the
  // width:0 + min-width:100% trick so it fills that width and scrolls instead
  // of contributing its long content width to the parent (which previously
  // stretched the popover across the whole chat).
  return (
    <div
      className="emoji-picker-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: 'fit-content',
        maxWidth: 'calc(100vw - 1.5rem)',
      }}
    >
      <div
        ref={tabsRef}
        className="emoji-tabs"
        style={{
          display: 'flex',
          gap: '6px',
          overflowX: 'auto',
          padding: '0.55em 0.6em',
          // Do not contribute intrinsic width; fill the picmo-sized parent.
          width: 0,
          minWidth: '100%',
          boxSizing: 'border-box',
          flexShrink: 0,
        }}
      >
        {tabs.map(t => {
          const active = activeGroup === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveGroup(t.key)}
              onMouseEnter={() => prewarmTab(t.key)}
              onFocus={() => prewarmTab(t.key)}
              onTouchStart={() => prewarmTab(t.key)}
              title={t.label}
              className={`emoji-tab${active ? ' emoji-tab-active' : ''}`}
              style={{
                flex: '0 0 auto',
                width: TAB_SIZE,
                height: TAB_SIZE,
                padding: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: `2px solid ${active ? 'var(--accent-color, #4f46e5)' : 'transparent'}`,
                borderRadius: '7px',
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
      {/* Hosts for cached picmo instances (one child host per visited tab). */}
      <div ref={hostsRootRef} className="emoji-picker-hosts" />
    </div>
  );
};
