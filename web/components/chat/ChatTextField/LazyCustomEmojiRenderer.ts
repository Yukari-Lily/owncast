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

  private readonly pendingResolvers = new Set<() => void>();

  constructor(eagerUrls: ReadonlySet<string> = new Set()) {
    super();
    this.eagerUrls = eagerUrls;
  }

  renderCustom(emoji: CustomEmoji, lazyLoader?: LazyLoader, additionalClasses = ''): Element {
    const classNames = ['picmo__customEmoji', additionalClasses].filter(Boolean).join(' ');
    const { content, resolver } = this.renderImage(classNames, () => emoji.url);
    const element = content instanceof Element ? content : content.el;

    if (!resolver) return element;

    let resolved = false;
    const resolve = () => {
      if (resolved) return;
      resolved = true;
      this.pendingResolvers.delete(resolve);
      resolver();
    };

    if (!lazyLoader || this.eagerUrls.has(emoji.url)) {
      resolve();
      return element;
    }

    this.pendingResolvers.add(resolve);
    return lazyLoader.lazyLoad(element as HTMLElement, resolve);
  }

  resolveAll(): void {
    Array.from(this.pendingResolvers).forEach(resolve => resolve());
  }
}
