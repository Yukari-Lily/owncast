import { NativeRenderer } from 'picmo';
import type { CustomEmoji } from 'picmo';
import type { LazyLoader } from 'picmo/dist/LazyLoader';

/**
 * Picmo lazily renders native emoji, but its default custom-emoji path resolves
 * every image URL immediately. Route custom images through Picmo's own
 * LazyLoader so a prebuilt, hidden picker keeps placeholders until an item is
 * actually visible.
 */
export class LazyCustomEmojiRenderer extends NativeRenderer {
  private readonly eagerUrls: ReadonlySet<string>;

  private readonly onResolved?: (url: string) => void;

  // Placeholder resolvers still pending, keyed by URL so a bounded lookahead
  // can resolve a window of rows without resolving the whole grid.
  private readonly pending = new Map<string, () => void>();

  constructor(eagerUrls: ReadonlySet<string>, onResolved?: (url: string) => void) {
    super();
    this.eagerUrls = eagerUrls;
    this.onResolved = onResolved;
  }

  renderCustom(emoji: CustomEmoji, lazyLoader?: LazyLoader, additionalClasses = ''): Element {
    const classNames = ['picmo__customEmoji', additionalClasses].filter(Boolean).join(' ');
    const { content, resolver } = this.renderImage(classNames, () => emoji.url);
    const element = content instanceof Element ? content : content.el;

    if (!resolver) return element;

    const resolve = () => {
      this.pending.delete(emoji.url);
      resolver();
      this.onResolved?.(emoji.url);
    };

    if (!lazyLoader || this.eagerUrls.has(emoji.url)) {
      resolve();
      return element;
    }

    this.pending.set(emoji.url, resolve);
    return lazyLoader.lazyLoad(element as HTMLElement, resolve);
  }

  /** Resolve the placeholder of every listed URL that is still pending. */
  resolveRange(urls: string[]): void {
    urls.forEach(url => {
      const resolve = this.pending.get(url);
      if (resolve) resolve();
    });
  }
}
