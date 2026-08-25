import { Virtuoso } from 'react-virtuoso';
import { useState, useMemo, useRef, CSSProperties, FC, useEffect, useCallback } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import {
  ConnectedClientInfoEvent,
  FediverseEvent,
  MessageType,
  NameChangeEvent,
} from '../../../interfaces/socket-events';
import styles from './ChatContainer.module.scss';
import { ChatMessage } from '../../../interfaces/chat-message.model';
import { ChatUserMessage } from '../ChatUserMessage/ChatUserMessage';
import { ChatTextField } from '../ChatTextField/ChatTextField';
import { ChatModeratorNotification } from '../ChatModeratorNotification/ChatModeratorNotification';
import { ChatSystemMessage } from '../ChatSystemMessage/ChatSystemMessage';
import { ChatJoinMessage } from '../ChatJoinMessage/ChatJoinMessage';
import { ChatPartMessage } from '../ChatPartMessage/ChatPartMessage';
import { ScrollToBotBtn } from './ScrollToBotBtn';
import { ChatActionMessage } from '../ChatActionMessage/ChatActionMessage';
import { ChatSocialMessage } from '../ChatSocialMessage/ChatSocialMessage';
import { ChatNameChangeMessage } from '../ChatNameChangeMessage/ChatNameChangeMessage';
import { User } from '../../../interfaces/user.model';
import { ComponentError } from '../../ui/ComponentError/ComponentError';
import { attachSmoothWheelScroll } from '../../../utils/smoothWheelScroll';
import {
  backgroundEmojiPrefetchAllowed,
  prefetchPriorityEmoji,
} from '../ChatTextField/emojiPrefetch';

export type ChatContainerProps = {
  messages: ChatMessage[];
  usernameToHighlight: string;
  chatUserId: string;
  isModerator: boolean;
  showInput?: boolean;
  height?: string;
  chatAvailable: boolean;
  focusInput?: boolean;
  desktop?: boolean;
};

let resizeWindowCallback: () => void;

function shouldCollapseMessages(message: ChatMessage, previous: ChatMessage): boolean {
  if (!message || !message.user) {
    return false;
  }

  if (previous.type !== MessageType.CHAT) {
    return false;
  }

  const {
    user: { id },
  } = message;
  if (id !== previous.user.id) {
    return false;
  }

  if (!previous.timestamp || !message.timestamp) {
    return false;
  }

  const maxTimestampDelta = 1000 * 40; // 40 seconds
  const lastTimestamp = new Date(previous.timestamp).getTime();
  const thisTimestamp = new Date(message.timestamp).getTime();
  if (thisTimestamp - lastTimestamp > maxTimestampDelta) {
    return false;
  }

  return true;
}

function checkIsModerator(message: ChatMessage | ConnectedClientInfoEvent) {
  const { user } = message;

  const u = new User(user);
  return u.isModerator;
}

// Collect the custom-emoji image URLs used across chat messages so they can be
// warmed in the HTTP cache before rows mount in the pre-render buffer.
function collectChatEmojiUrls(messages: ChatMessage[]): string[] {
  const emojiImgSrcPattern = /<img\b[^>]*\bsrc=["'](\/img\/emoji\/[^"']+)["']/gi;
  const urls = new Set<string>();
  messages.forEach(message => {
    const { body } = message;
    if (!body) return;
    let match = emojiImgSrcPattern.exec(body);
    while (match !== null) {
      const url = match[1];
      if (url) urls.add(url);
      match = emojiImgSrcPattern.exec(body);
    }
  });
  return Array.from(urls);
}

export const ChatContainer: FC<ChatContainerProps> = ({
  messages,
  usernameToHighlight,
  chatUserId,
  isModerator,
  showInput,
  height,
  chatAvailable: chatEnabled,
  desktop,
  focusInput = true,
}) => {
  const [showScrollToBottomButton, setShowScrollToBottomButton] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const chatContainerRef = useRef(null);
  // Whether the scroller is currently at the bottom; used to decide if new
  // messages should be counted as unread.
  const isAtBottomRef = useRef(true);
  // Tracks the last message count so we can count only newly added messages.
  const prevMessageCountRef = useRef(messages.length);
  // Dispose handle for ease-out wheel scrolling on Virtuoso's scroller element.
  const detachSmoothScroll = useRef<(() => void) | null>(null);
  const detachBottomInteractionListeners = useRef<(() => void) | null>(null);
  // The actual DOM scroller, for exact physical-bottom alignment.
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const scrollAnimationFrameRef = useRef<number | null>(null);
  const automaticScrollFrameRef = useRef<number | null>(null);
  const initialScrollTimerRef = useRef<number | null>(null);
  // Remains active while an automatic follow is in progress, including while
  // Virtuoso is measuring rows after an append. User interaction cancels it.
  const shouldFollowBottomRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  // A hidden tab can defer timers, animation frames, and layout notifications.
  // Remember whether it was at the bottom so the next visible frame can
  // perform a final correction.
  const wasAtBottomBeforeBackgroundRef = useRef(false);
  const wasBackgroundedRef = useRef(false);

  const clampScrollerToBottom = () => {
    const scroller = scrollerElRef.current;
    if (!scroller) return false;
    const { scrollHeight, clientHeight, scrollTop } = scroller;
    const bottom = Math.max(0, scrollHeight - clientHeight);
    if (Math.abs(bottom - scrollTop) < 1) return false;
    scroller.scrollTop = bottom;
    return true;
  };

  const schedulePhysicalBottomClamp = () => {
    const changed = clampScrollerToBottom();
    if (!changed && scrollAnimationFrameRef.current === null) return;
    if (scrollAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollAnimationFrameRef.current);
    }
    scrollAnimationFrameRef.current = window.requestAnimationFrame(() => {
      scrollAnimationFrameRef.current = null;
      clampScrollerToBottom();
    });
  };

  const scrollChatToBottom = ref => {
    const list = ref.current;
    if (!list) return;
    if (typeof list.scrollToIndex === 'function' && messages.length > 0) {
      list.scrollToIndex({ index: messages.length - 1, align: 'end', behavior: 'auto' });
    } else {
      list.scrollTo({ top: Infinity, left: 0, behavior: 'auto' });
    }
    setShowScrollToBottomButton(false);
    // Virtualized alignment uses estimated row heights, which at high page
    // zoom can leave several px of room below the last message. Clamp to the
    // physical maximum scroll instead — content end against scroller bottom —
    // which ignores estimates entirely and leaves no gap.
    // Clamp immediately as well as on the next frame. The immediate write is
    // important while the page is backgrounded, where requestAnimationFrame
    // may be throttled or paused.
    schedulePhysicalBottomClamp();
  };

  // Keep the latest scroller callback in a ref so listeners created once on
  // mount (initial scroll, viewport resize) never operate on a stale closure
  // that captured the first render's `messages`.
  const scrollToBottomRef = useRef(scrollChatToBottom);
  scrollToBottomRef.current = scrollChatToBottom;

  // Coalesce foreground updates into one measured frame. A hidden tab gets an
  // immediate attempt because requestAnimationFrame may be throttled there.
  const requestAutomaticBottomScroll = () => {
    if (document.visibilityState === 'hidden') {
      scrollToBottomRef.current(chatContainerRef);
      return;
    }
    if (automaticScrollFrameRef.current !== null) return;
    automaticScrollFrameRef.current = window.requestAnimationFrame(() => {
      automaticScrollFrameRef.current = null;
      if (shouldFollowBottomRef.current) {
        scrollToBottomRef.current(chatContainerRef);
      }
    });
  };

  const scrollerRef = useCallback((el: HTMLElement | Window | null) => {
    if (detachSmoothScroll.current) {
      detachSmoothScroll.current();
      detachSmoothScroll.current = null;
    }
    if (detachBottomInteractionListeners.current) {
      detachBottomInteractionListeners.current();
      detachBottomInteractionListeners.current = null;
    }
    scrollerElRef.current = el instanceof HTMLElement ? el : null;
    // Virtuoso may hand back Window in some configs; we only smooth HTMLElements.
    if (el && el instanceof HTMLElement) {
      detachSmoothScroll.current = attachSmoothWheelScroll(el, 'y');
      const cancelAutomaticFollow = () => {
        shouldFollowBottomRef.current = false;
      };
      el.addEventListener('wheel', cancelAutomaticFollow, { passive: true });
      el.addEventListener('pointerdown', cancelAutomaticFollow, { passive: true });
      el.addEventListener('touchstart', cancelAutomaticFollow, { passive: true });
      const cancelOnKeyboardScroll = (event: KeyboardEvent) => {
        if (
          ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
        ) {
          cancelAutomaticFollow();
        }
      };
      el.addEventListener('keydown', cancelOnKeyboardScroll, { passive: true });
      const handleScroll = () => {
        const { scrollTop } = el;
        if (scrollTop < lastScrollTopRef.current - 1) {
          cancelAutomaticFollow();
        }
        lastScrollTopRef.current = scrollTop;
      };
      el.addEventListener('scroll', handleScroll, { passive: true });
      detachBottomInteractionListeners.current = () => {
        el.removeEventListener('wheel', cancelAutomaticFollow);
        el.removeEventListener('pointerdown', cancelAutomaticFollow);
        el.removeEventListener('touchstart', cancelAutomaticFollow);
        el.removeEventListener('keydown', cancelOnKeyboardScroll);
        el.removeEventListener('scroll', handleScroll);
      };
      lastScrollTopRef.current = el.scrollTop;
    }
  }, []);

  useEffect(() => {
    const previousCount = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (messages.length <= previousCount) return;

    const addedMessages = messages.slice(previousCount);
    const newChatMessages = addedMessages.filter(
      message => message.type === MessageType.CHAT || message.type === MessageType.CHAT_ACTION,
    ).length;
    if (newChatMessages > 0 && !isAtBottomRef.current) {
      setUnreadCount(count => count + newChatMessages);
    }
    // Follow all appended rows when the user was at the bottom. A local
    // message also follows the existing behavior and returns to the latest
    // message even if the user was scrolled up.
    const lastMessage = messages[messages.length - 1];
    const shouldFollow = isAtBottomRef.current || lastMessage?.user?.id === chatUserId;
    if (addedMessages.length > 0) {
      shouldFollowBottomRef.current = shouldFollow;
      if (shouldFollow) {
        requestAutomaticBottomScroll();
      }
    }
  }, [messages]);

  // Warm custom-emoji images ahead of the scroll position so they decode from
  // cache when their row mounts instead of stalling paint mid-scroll. Only
  // newly added messages are scanned — messages list is append-only, so
  // re-scanning the whole history on every batch would be O(n) per update.
  const lastEmojiScanRef = useRef(0);
  useEffect(() => {
    if (!backgroundEmojiPrefetchAllowed()) return;
    const prev = lastEmojiScanRef.current;
    if (messages.length <= prev) return;
    lastEmojiScanRef.current = messages.length;
    const urls = collectChatEmojiUrls(messages.slice(prev));
    if (urls.length > 0) prefetchPriorityEmoji(urls);
  }, [messages]);

  useEffect(
    () =>
      // Clear the wheel-scroll listener when the component unmounts
      () => {
        if (scrollAnimationFrameRef.current !== null) {
          window.cancelAnimationFrame(scrollAnimationFrameRef.current);
          scrollAnimationFrameRef.current = null;
        }
        if (automaticScrollFrameRef.current !== null) {
          window.cancelAnimationFrame(automaticScrollFrameRef.current);
          automaticScrollFrameRef.current = null;
        }
        if (initialScrollTimerRef.current !== null) {
          window.clearTimeout(initialScrollTimerRef.current);
          initialScrollTimerRef.current = null;
        }
        if (detachSmoothScroll.current) {
          detachSmoothScroll.current();
          detachSmoothScroll.current = null;
        }
        if (detachBottomInteractionListeners.current) {
          detachBottomInteractionListeners.current();
          detachBottomInteractionListeners.current = null;
        }
      },
    [],
  );

  const collapsedIndexes: boolean[] = [];
  let consecutiveTally: number = 1;

  function calculateCollapsedMessages() {
    // Limits the number of messages that can be collapsed in a row.
    const maxCollapsedMessageCount = 5;
    for (let i = collapsedIndexes.length; i < messages.length; i += 1) {
      const collapse: boolean =
        i > 0 &&
        consecutiveTally < maxCollapsedMessageCount &&
        shouldCollapseMessages(messages[i], messages[i - 1]);
      collapsedIndexes.push(collapse);
      consecutiveTally = 1 + (collapse ? consecutiveTally : 0);
    }
  }

  function shouldCollapse(index: number): boolean {
    if (collapsedIndexes.length <= index) {
      calculateCollapsedMessages();
    }
    return collapsedIndexes[index];
  }

  const getFediverseMessage = (message: FediverseEvent) => <ChatSocialMessage message={message} />;

  const getUserJoinedMessage = (message: ChatMessage) => {
    const {
      user: { displayName, displayColor },
    } = message;
    const isAuthorModerator = checkIsModerator(message);
    return (
      <ChatJoinMessage
        displayName={displayName}
        userColor={displayColor}
        isAuthorModerator={isAuthorModerator}
      />
    );
  };

  const getUserPartMessage = (message: ChatMessage) => {
    const {
      user: { displayName, displayColor },
    } = message;
    const isAuthorModerator = checkIsModerator(message);
    return (
      <ChatPartMessage
        displayName={displayName}
        userColor={displayColor}
        isAuthorModerator={isAuthorModerator}
      />
    );
  };

  const getActionMessage = (message: ChatMessage) => {
    const { body } = message;
    return <ChatActionMessage body={body} />;
  };

  const getConnectedInfoMessage = (message: ConnectedClientInfoEvent) => {
    const modStatusUpdate = checkIsModerator(message);
    if (!modStatusUpdate) {
      // Important note: We can't return null or an element with zero width
      // or zero height. So to work around this we return a very small 1x1 div.
      const st: CSSProperties = { width: '1px', height: '1px' };
      return <div style={st} />;
    }

    // Alert the user that they are a moderator.
    return <ChatModeratorNotification />;
  };

  const getUserChatMessageView = (index: number, message: ChatMessage) => {
    const isAuthorModerator = checkIsModerator(message);

    return (
      <ChatUserMessage
        message={message}
        showModeratorMenu={isModerator} // Moderators have access to an additional menu
        highlightString={usernameToHighlight} // What to highlight in the message
        sentBySelf={message.user?.id === chatUserId} // The local user sent this message
        sameUserAsLast={shouldCollapse(index)}
        isAuthorModerator={isAuthorModerator}
        isAuthorBot={message.user?.isBot}
        isAuthorAuthenticated={message.user?.authenticated}
        key={message.id}
      />
    );
  };
  const getViewForMessage = (
    index: number,
    message: ChatMessage | NameChangeEvent | ConnectedClientInfoEvent | FediverseEvent,
  ) => {
    switch (message.type) {
      case MessageType.CHAT:
        return getUserChatMessageView(index, message as ChatMessage);
      case MessageType.NAME_CHANGE:
        return <ChatNameChangeMessage message={message as NameChangeEvent} />;
      case MessageType.CONNECTED_USER_INFO:
        return getConnectedInfoMessage(message as ConnectedClientInfoEvent);
      case MessageType.USER_JOINED:
        return getUserJoinedMessage(message as ChatMessage);
      case MessageType.USER_PARTED:
        return getUserPartMessage(message as ChatMessage);
      case MessageType.CHAT_ACTION:
        return getActionMessage(message as ChatMessage);
      case MessageType.SYSTEM:
        return (
          <ChatSystemMessage
            message={message as ChatMessage}
            highlightString={usernameToHighlight} // What to highlight in the message
            key={message.id}
          />
        );
      case MessageType.FEDIVERSE_ENGAGEMENT_FOLLOW:
        return getFediverseMessage(message as FediverseEvent);
      case MessageType.FEDIVERSE_ENGAGEMENT_LIKE:
        return getFediverseMessage(message as FediverseEvent);
      case MessageType.FEDIVERSE_ENGAGEMENT_REPOST:
        return getFediverseMessage(message as FediverseEvent);

      default:
        return null;
    }
  };

  // This is a hack to force a scroll to the very bottom of the chat messages
  // on initial mount of the component.
  // For https://github.com/owncast/owncast/issues/2500
  useEffect(() => {
    initialScrollTimerRef.current = window.setTimeout(() => {
      initialScrollTimerRef.current = null;
      scrollToBottomRef.current(chatContainerRef);
    }, 500);

    return () => {
      if (initialScrollTimerRef.current !== null) {
        window.clearTimeout(initialScrollTimerRef.current);
        initialScrollTimerRef.current = null;
      }
    };
  }, []);

  // A background tab may defer the layout work needed by Virtuoso. Re-run the
  // same bottom sync when it becomes visible, but only if it was at the bottom
  // before the tab was backgrounded (or already has an auto-follow pending).
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        wasBackgroundedRef.current = true;
        wasAtBottomBeforeBackgroundRef.current = isAtBottomRef.current;
        return;
      }

      if (!wasBackgroundedRef.current) return;
      wasBackgroundedRef.current = false;
      if (wasAtBottomBeforeBackgroundRef.current || shouldFollowBottomRef.current) {
        shouldFollowBottomRef.current = true;
        requestAutomaticBottomScroll();
      }
      wasAtBottomBeforeBackgroundRef.current = false;
    };

    if (document.visibilityState === 'hidden') {
      wasBackgroundedRef.current = true;
      wasAtBottomBeforeBackgroundRef.current = isAtBottomRef.current;
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Keep the message list glued to the bottom when the viewport height
  // changes (browser zoom, window resize, mobile chrome). Virtuoso keeps its
  // pixel scroll offset on layout change, so an anchored chat ends up hanging
  // above the input; re-scroll only if the user was already at the bottom.
  useEffect(() => {
    const onViewportResize = () => {
      if (isAtBottomRef.current) scrollToBottomRef.current(chatContainerRef);
    };
    window.addEventListener('resize', onViewportResize);
    const { visualViewport } = window;
    visualViewport?.addEventListener('resize', onViewportResize);
    return () => {
      window.removeEventListener('resize', onViewportResize);
      visualViewport?.removeEventListener('resize', onViewportResize);
    };
  }, []);

  const MessagesTable = useMemo(
    () => (
      <Virtuoso
        id="virtuoso"
        style={{ height }}
        className={styles.virtuoso}
        ref={chatContainerRef}
        scrollerRef={scrollerRef}
        data={messages}
        computeItemKey={(_, message) => message.id}
        // Pre-render rows above/below the viewport so fast wheel scrolling
        // doesn't show blank space while new rows mount, including tall
        // text-heavy messages.
        increaseViewportBy={800}
        itemContent={(index, message) => getViewForMessage(index, message)}
        initialTopMostItemIndex={messages.length - 1}
        // Owncast handles bottom scrolling itself so every follow goes
        // through scrollChatToBottom and its physical scroll clamp.
        followOutput={false}
        alignToBottom
        // Tolerant of virtualized measurement drift (worst at high page
        // zoom, where fractional row heights re-measure with a few px of
        // error): a too-tight threshold reports "not at bottom" while the
        // user is visually at it, popping the unread pill and counting
        // fresh messages as unread.
        atBottomThreshold={32}
        atBottomStateChange={bottom => {
          isAtBottomRef.current = bottom;
          setShowScrollToBottomButton(!bottom);
          if (bottom) {
            shouldFollowBottomRef.current = false;
            setUnreadCount(0);
          }
        }}
        totalListHeightChanged={() => {
          if (isAtBottomRef.current || shouldFollowBottomRef.current) {
            schedulePhysicalBottomClamp();
          }
        }}
      />
    ),
    [messages, usernameToHighlight, chatUserId, isModerator],
  );

  const defaultChatWidth: number = 320;
  function clampChatWidth(desired) {
    return Math.max(200, Math.min(window.innerWidth * 0.666, desired));
  }

  function startDrag(dragEvent) {
    const container = document.getElementById('chat-container');
    function move(event) {
      container.style.width = `${clampChatWidth(window.innerWidth - event.x)}px`;
    }
    function endDrag() {
      window.document.removeEventListener('mousemove', move);
      window.document.removeEventListener('mouseup', endDrag);
      window.document.removeEventListener('focusout', endDrag);
    }
    window.document.addEventListener('mousemove', move);
    window.document.addEventListener('mouseup', endDrag);
    window.document.addEventListener('focusout', endDrag);
    dragEvent.preventDefault(); // Prevent selecting the page as you resize it
  }

  // Re-clamp the chat size whenever the window resizes
  function resize() {
    const container = desktop && document.getElementById('chat-container');
    if (container) {
      const currentWidth = parseFloat(container.style.width) || defaultChatWidth;
      container.style.width = `${clampChatWidth(currentWidth)}px`;
    }
  }

  // Retrieve, clean, and attach username to newest chat message to be read out by screenreader
  function getLastMessage() {
    if (messages.length > 0 && typeof messages[messages.length - 1].body !== 'undefined') {
      const message = messages[messages.length - 1].body.replace(/(<([^>]+)>)/gi, '');
      const stringToRead = `${usernameToHighlight} said ${message}`;
      return stringToRead;
    }
    return '';
  }
  const lastMessage = getLastMessage();

  if (resizeWindowCallback) window.removeEventListener('resize', resizeWindowCallback);
  if (desktop) {
    window.addEventListener('resize', resize);
    resizeWindowCallback = resize;
  } else {
    resizeWindowCallback = null;
  }

  return (
    <ErrorBoundary
      // eslint-disable-next-line react/no-unstable-nested-components
      fallbackRender={({ error, resetErrorBoundary }) => (
        <ComponentError
          componentName="ChatContainer"
          message={error.message}
          retryFunction={resetErrorBoundary}
        />
      )}
    >
      <div
        aria-live="off"
        id="chat-container"
        className={styles.chatContainer}
        style={desktop && { width: `${defaultChatWidth}px` }}
      >
        {MessagesTable}
        {showScrollToBottomButton && (
          <ScrollToBotBtn
            count={unreadCount}
            onClick={() => {
              shouldFollowBottomRef.current = false;
              scrollChatToBottom(chatContainerRef);
              setUnreadCount(0);
            }}
          />
        )}
        {showInput && (
          <div className={styles.chatTextField}>
            <ChatTextField enabled={chatEnabled} focusInput={focusInput} />
          </div>
        )}
        {desktop && (
          <div className={styles.resizeHandle} onMouseDown={startDrag} role="presentation" />
        )}
      </div>
      <span className={styles.chatAccessibilityHidden} aria-live="polite">
        {lastMessage}
      </span>
    </ErrorBoundary>
  );
};

ChatContainer.defaultProps = {
  showInput: true,
  height: 'auto',
};
