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

  constructor(eagerUrls: ReadonlySet<string> = new Set()) {
    super();
    this.eagerUrls = eagerUrls;
  }

  renderCustom(emoji: CustomEmoji, lazyLoader?: LazyLoader, additionalClasses = ''): Element {
    const classNames = ['picmo__customEmoji', additionalClasses].filter(Boolean).join(' ');
    const { content, resolver } = this.renderImage(classNames, () => emoji.url);
    const element = content instanceof Element ? content : content.el;

    if (!resolver) return element;

    if (!lazyLoader || this.eagerUrls.has(emoji.url)) {
      resolver();
      return element;
    }

    return lazyLoader.lazyLoad(element as HTMLElement, resolver);
  }
}
