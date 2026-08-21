export type CustomEmoji = {
  name: string;
  url: string;
  cover?: boolean;
};

export type EmojiListResult =
  | { notModified: true; etag: string | null }
  | { notModified: false; etag: string | null; emojis: CustomEmoji[] };

export async function revalidateEmojiList(
  etag?: string,
  signal?: AbortSignal,
): Promise<EmojiListResult> {
  const headers = new Headers();
  if (etag) headers.set('If-None-Match', etag);

  const response = await fetch('/api/emoji', {
    cache: 'no-cache',
    headers,
    signal,
  });

  const nextEtag = response.headers.get('ETag') || etag || null;
  if (response.status === 304) return { notModified: true, etag: nextEtag };
  if (!response.ok) throw new Error(`Unable to fetch custom emoji: ${response.status}`);

  return {
    notModified: false,
    etag: nextEtag,
    emojis: await response.json(),
  };
}
