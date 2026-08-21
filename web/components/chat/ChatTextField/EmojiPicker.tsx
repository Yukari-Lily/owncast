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
import { LazyCustomEmojiRenderer } from './LazyCustomEmojiRenderer';
import {
  backgroundEmojiPrefetchAllowed,
  prefetchPriorityEmoji,
  startAdaptiveEmojiPrefetch,
} from './emojiPrefetch';

export type EmojiPickerProps = {
  onEmojiSelect: (emoji: string) => void;
  onCustomEmojiSelect: (name: string, url: string) => void;
  customEmoji: any[];
  /** When false, hide picmo hosts (cache kept) so the close animation stays smooth. */
  open?: boolean;
};

type EmojiRef = { name: string; url: string; cover?: boolean };

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
const ALL_INITIAL_IMAGE_COUNT = 48;

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

// Folder names often carry a numeric sort prefix used only to order the tabs
// ("09" in "09梦限大"). Keep the raw folder as the grouping key, but drop the
// prefix from the label shown on the tab. Pure-numeric names (e.g. "0001")
// are left untouched.
function folderLabel(folder: string): string {
  return folder.replace(/^\d+\s*(?=\D)/, '');
}

// Tab thumbnail: prefer the folder's cover file (marked by the server, either
// *_cover* like dy01_05_cover.png or a plain cover.png). Falls back to the
// first emoji in the folder.
function tabThumbUrl(emojis: EmojiRef[] | undefined): string | undefined {
  if (!emojis?.length) return undefined;
  const cover = emojis.find(e => e.cover);
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
      arr.push({ name: e.name, url: e.url, cover: e.cover });
    });
    return map;
  }, [customEmoji]);

  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const folderNames = useMemo(() => Array.from(groups.keys()), [groups]);

  const emojisFor = useCallback((key: string): EmojiRef[] => {
    const list =
      key === ALL
        ? (customEmojiRef.current as EmojiRef[]) || EMPTY
        : groupsRef.current.get(key) || EMPTY;
    // Numbered cover files (e.g. 02_cover.png) double as the tab thumbnail
    // AND a regular emoji at their sort position, so keep them in the grid.
    // Only a bare cover file (cover.png with no sort number) stays tab-only.
    const isBareCover = (e: EmojiRef) => /\/cover(?:\.[^.]+)?$/.test(e.url);
    return list.filter(e => !isBareCover(e));
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
      // Keep background-created hosts hidden until their tab is selected.
      host.hidden = true;
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
      const eagerUrls =
        isAll && backgroundEmojiPrefetchAllowed()
          ? new Set(list.slice(0, ALL_INITIAL_IMAGE_COUNT).map(emoji => emoji.url))
          : new Set<string>();
      const picker = createPicker({
        rootElement: host,
        theme: 'dark',
        animate: false,
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
        renderer: new LazyCustomEmojiRenderer(eagerUrls),
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
        const detachSmoothScroll = attachSmoothWheelScroll(area, 'y');
        if (!isAll) {
          entry.detachScroll = detachSmoothScroll;
          return;
        }

        let animationFrame: number | undefined;
        const prefetchAdjacentRows = () => {
          animationFrame = undefined;
          if (!backgroundEmojiPrefetchAllowed()) return;
          const visibleCount = ALL_INITIAL_IMAGE_COUNT;
          const maxStart = Math.max(0, list.length - visibleCount);
          const scrollRange = Math.max(1, area.scrollHeight - area.clientHeight);
          const currentStart = Math.round((area.scrollTop / scrollRange) * maxStart);
          const adjacentStart = Math.max(0, currentStart - visibleCount);
          const adjacentEnd = Math.min(list.length, currentStart + visibleCount * 2);
          prefetchPriorityEmoji(
            list.slice(adjacentStart, adjacentEnd).map(emoji => emoji.url),
            2,
          );
        };
        const handleScroll = () => {
          if (animationFrame === undefined) {
            animationFrame = window.requestAnimationFrame(prefetchAdjacentRows);
          }
        };
        area.addEventListener('scroll', handleScroll, { passive: true });
        entry.detachScroll = () => {
          detachSmoothScroll();
          area.removeEventListener('scroll', handleScroll);
          if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
        };
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
        // Cached hosts that already finished data:ready are shown immediately.
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
    if (!customEmoji?.length) {
      activeGroupRef.current = ALL;
      setActiveGroup(ALL);
      return;
    }
    const nextGroup =
      activeGroupRef.current === ALL || groupsRef.current.has(activeGroupRef.current)
        ? activeGroupRef.current
        : ALL;
    if (nextGroup !== activeGroupRef.current) {
      activeGroupRef.current = nextGroup;
      setActiveGroup(nextGroup);
    }
    if (openRef.current) {
      showTab(nextGroup);
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

  // Prebuild the default ALL grid while closed. The custom renderer keeps all
  // but the first visible page as placeholders, so creating the picker does not
  // turn into hundreds of image requests.
  useEffect(() => {
    if (!customEmoji?.length || typeof window === 'undefined') return undefined;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      ensurePicker(ALL);
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
  }, [customEmoji, ensurePicker]);

  // Warm only what is needed for an instant first paint: every folder cover
  // and the first 48 ALL entries. Remaining images are handled by Picmo's
  // IntersectionObserver and the playback-aware background queue below.
  useEffect(() => {
    if (!customEmoji?.length || !backgroundEmojiPrefetchAllowed()) return;
    const coverUrls = Array.from(groups.values())
      .map(tabThumbUrl)
      .filter((url): url is string => Boolean(url));
    const initialUrls = emojisFor(ALL)
      .slice(0, ALL_INITIAL_IMAGE_COUNT)
      .map(emoji => emoji.url);
    prefetchPriorityEmoji([...coverUrls, ...initialUrls]);
  }, [customEmoji, groups, emojisFor]);

  useEffect(() => {
    if (!customEmoji?.length) return undefined;
    return startAdaptiveEmojiPrefetch(emojisFor(ALL).map(emoji => emoji.url));
  }, [customEmoji, emojisFor]);

  // Tab list: [ALL] [<folder>...]. "ALL" uses a grid icon; each folder tab
  // uses *_cover* if present, otherwise the first emoji in that folder.
  const tabs = useMemo<
    Array<{ key: string; label: string; thumb?: string; icon?: React.ReactNode }>
  >(() => {
    const folderTabs = folderNames.map(f => ({
      key: f,
      label: folderLabel(f),
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

  // Prefetch a tab's picmo instance + image URLs on hover/focus so the click
  // is usually a pure show. Works while open or closed (cache survives close).
  const prewarmTab = useCallback(
    (key: string) => {
      if (!backgroundEmojiPrefetchAllowed()) return;
      if (!cacheRef.current.has(key)) {
        prefetchPriorityEmoji(emojisFor(key).map(emoji => emoji.url));
      }
      ensurePicker(key);
    },
    [emojisFor, ensurePicker],
  );

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
