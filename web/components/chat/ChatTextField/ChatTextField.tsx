import { Popover } from 'antd';
import React, { FC, useEffect, useState } from 'react';
import { useRecoilValue } from 'recoil';
import sanitizeHtml from 'sanitize-html';
import Graphemer from 'graphemer';

import dynamic from 'next/dynamic';
import classNames from 'classnames';
import ContentEditable from './ContentEditable';
import WebsocketService from '../../../services/websocket-service';
import { websocketServiceAtom } from '../../stores/ClientConfigStore';
import { MessageType } from '../../../interfaces/socket-events';
import styles from './ChatTextField.module.scss';

// Lazy loaded components

// Keep the import function so we can also prefetch the chunk on idle / hover
// and avoid the cold-start delay the first time the user opens the picker.
const loadEmojiPicker = () => import('./EmojiPicker').then(mod => mod.EmojiPicker);

const EmojiPicker = dynamic(loadEmojiPicker, {
  ssr: false,
});

const SendOutlined = dynamic(() => import('@ant-design/icons/SendOutlined'), {
  ssr: false,
});

const SmileOutlined = dynamic(() => import('@ant-design/icons/SmileOutlined'), {
  ssr: false,
});

export type ChatTextFieldProps = {
  defaultText?: string;
  enabled: boolean;
  focusInput: boolean;
};

const characterLimit = 300;
const maxNodeDepth = 10;
const graphemer = new Graphemer();

const getNodeTextContent = (node, depth) => {
  let text = '';

  if (depth > maxNodeDepth) return text;
  if (node === null) return text;

  switch (node.nodeType) {
    case Node.CDATA_SECTION_NODE: // unlikely
    case Node.TEXT_NODE: {
      text = node.nodeValue;
      break;
    }
    case Node.ELEMENT_NODE: {
      switch (node.tagName.toLowerCase()) {
        case 'img': {
          text = node.getAttribute('alt') || '';
          break;
        }
        case 'br': {
          text = '\n';
          break;
        }
        case 'strong':
        case 'b': {
          /* markdown representation of bold/strong */
          text = '**';
          for (let i = 0; i < node.childNodes.length; i += 1) {
            text += getNodeTextContent(node.childNodes[i], depth + 1);
          }
          text += '**';
          break;
        }
        case 'em':
        case 'i': {
          /* markdown representation of italic/emphasis */
          text = '*';
          for (let i = 0; i < node.childNodes.length; i += 1) {
            text += getNodeTextContent(node.childNodes[i], depth + 1);
          }
          text += '*';
          break;
        }
        case 'p': {
          text = '\n';
          for (let i = 0; i < node.childNodes.length; i += 1) {
            text += getNodeTextContent(node.childNodes[i], depth + 1);
          }
          break;
        }
        case 'a':
        case 'span':
        case 'div': {
          for (let i = 0; i < node.childNodes.length; i += 1) {
            text += getNodeTextContent(node.childNodes[i], depth + 1);
          }
          break;
        }
        /* nodes which should specifically not be parsed */
        case 'script':
        case 'style': {
          break;
        }
        default: {
          text = node.textContent;
          break;
        }
      }
      break;
    }
    default:
      break;
  }
  return text;
};

const getTextContent = node => {
  const text = getNodeTextContent(node, 0)
    .replace(/^\s+/, '') /* remove leading whitespace */
    .replace(/\s+$/, '') /* remove trailing whitespace */
    .replace(/\n([^\n])/g, '  \n$1'); /* single line break to markdown break */
  return text;
};

export const ChatTextField: FC<ChatTextFieldProps> = ({ defaultText, enabled, focusInput }) => {
  const [characterCount, setCharacterCount] = useState(defaultText?.length);
  const websocketService = useRecoilValue<WebsocketService>(websocketServiceAtom);
  const [contentEditable, setContentEditable] = useState(null);
  const [customEmoji, setCustomEmoji] = useState([]);

  // Prefetch the EmojiPicker chunk after idle so first open is not a cold load.
  // Hover on the smile button also kicks it off as a backup for fast openers.
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const prefetch = () => {
      if (!cancelled) loadEmojiPicker();
    };
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(prefetch, { timeout: 2500 });
    } else {
      timeoutId = setTimeout(prefetch, 1200);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleId);
      }
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [enabled]);

  const onRootRef = el => {
    setContentEditable(el);
  };

  const getCharacterCount = () => {
    const message = getTextContent(contentEditable);
    return graphemer.countGraphemes(message);
  };

  const sendMessage = () => {
    if (!websocketService) {
      console.log('websocketService is not defined');
      return;
    }

    const message = getTextContent(contentEditable);
    const count = graphemer.countGraphemes(message);
    if (count === 0 || count > characterLimit) return;

    websocketService.send({ type: MessageType.CHAT, body: message });
    contentEditable.innerHTML = '';
  };

  const insertTextAtEnd = (textToInsert: string) => {
    contentEditable.innerHTML += textToInsert;
  };

  // Native emoji
  const onEmojiSelect = (emoji: string) => {
    insertTextAtEnd(emoji);
  };

  // Custom emoji images
  const onCustomEmojiSelect = (name: string, emoji: string) => {
    const html = `<img src="${emoji}" alt=":${name}:" title=":${name}:" class="emoji" />`;
    insertTextAtEnd(html);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)) {
      e.preventDefault();
      sendMessage();
    }
  };

  const onPaste = evt => {
    evt.preventDefault();

    const clip = evt.clipboardData;
    const { types } = clip;
    const html = types.includes('text/html') ? clip.getData('text/html') : '';
    const plain = types.includes('text/plain') ? clip.getData('text/plain') : '';

    // Use the sanitized HTML path when there's no plain text, or when the HTML
    // carries an image (e.g. a custom emoji copied from chat) that plain text
    // can't represent. Otherwise prefer plain text: clipboard HTML wraps even
    // single-line copies in block elements (<p>/<div>) plus inter-element
    // whitespace, which the text extractor turns into spurious blank lines
    // between every pasted line.
    if (html && (!plain || /<img\b/i.test(html))) {
      const sanitized = sanitizeHtml(html, {
        allowedTags: ['b', 'i', 'em', 'strong', 'a', 'br', 'p', 'img'],
        allowedAttributes: {
          img: ['class', 'alt', 'title', 'src'],
        },
        allowedClasses: {
          img: ['emoji'],
        },
        transformTags: {
          h1: 'p',
          h2: 'p',
          h3: 'p',
        },
      });

      // MDN lists this as deprecated, but it's the only way to save this paste
      // into the browser's Undo buffer. Plus it handles all the selection
      // deletion, caret positioning, etc automaticaly.
      if (sanitized) document.execCommand('insertHTML', false, sanitized);
      return;
    }

    if (!plain) return;

    // Insert as escaped text with explicit <br> line breaks. The extractor
    // turns <br> back into \n, so this avoids the doubled blank lines that
    // block-level wrappers (<p>/<div>) in clipboard HTML would produce, while
    // still rendering correctly regardless of the contentEditable's
    // white-space setting.
    const escaped = plain
      .replace(/\r\n?/g, '\n') // normalize CRLF / CR to LF
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    document.execCommand('insertHTML', false, escaped);
  };

  const handleChange = () => {
    const count = getCharacterCount();
    setCharacterCount(count);

    if (count === 0 && contentEditable.children.length === 1) {
      /* if we have a single <br> element added by the browser, remove. */
      if (contentEditable.children[0].tagName.toLowerCase() === 'br') {
        contentEditable.removeChild(contentEditable.children[0]);
      }
    }
  };

  // Focus the input when the component mounts.
  useEffect(() => {
    if (!focusInput) {
      return;
    }
    document.getElementById('chat-input-content-editable').focus({ preventScroll: true });
  }, []);

  const getCustomEmoji = async () => {
    try {
      const response = await fetch(`/api/emoji`);
      const emoji = await response.json();
      setCustomEmoji(emoji);

      emoji.forEach(e => {
        const preImg = document.createElement('link');
        preImg.href = e.url;
        preImg.rel = 'preload';
        preImg.as = 'image';
        document.head.appendChild(preImg);
      });
    } catch (e) {
      console.error('cannot fetch custom emoji', e);
    }
  };

  useEffect(() => {
    getCustomEmoji();
  }, []);

  return (
    <div id="chat-input" className={styles.root}>
      <div
        className={classNames(
          styles.inputWrap,
          characterCount > characterLimit && styles.maxCharacters,
        )}
      >
        <ContentEditable
          id="chat-input-content-editable"
          html={defaultText || ''}
          placeholder={enabled ? 'Send a message to chat' : 'Chat is disabled'}
          disabled={!enabled}
          onKeyDown={onKeyDown}
          onContentChange={handleChange}
          onPaste={onPaste}
          onRootRef={onRootRef}
          style={{ whiteSpace: 'pre-wrap', width: '100%' }}
          role="textbox"
          aria-label="Chat text input"
        />
        {enabled && (
          <div style={{ display: 'flex', paddingLeft: '5px' }}>
            <Popover
              overlayClassName="emoji-popover"
              content={
                <EmojiPicker
                  customEmoji={customEmoji}
                  onEmojiSelect={onEmojiSelect}
                  onCustomEmojiSelect={onCustomEmojiSelect}
                />
              }
              trigger="click"
              placement="topRight"
            >
              <button
                type="button"
                aria-label="Emoji picker"
                className={styles.emojiButton}
                title="Emoji picker button"
                onMouseEnter={loadEmojiPicker}
                onFocus={loadEmojiPicker}
                onTouchStart={loadEmojiPicker}
              >
                <SmileOutlined />
              </button>
            </Popover>
            <button
              type="button"
              aria-label="Send message"
              className={styles.sendButton}
              title="Send message Button"
              onClick={sendMessage}
            >
              <SendOutlined />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
