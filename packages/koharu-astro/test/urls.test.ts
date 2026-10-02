import { describe, expect, it } from 'vitest';
import { canonicalSuiteOrigin, channelRssUrl, globalRssUrl, resolveSuiteUrl } from '../src/urls.js';
import { CHANNEL_ID, MEDIA_OBJECT_ID } from './fixtures.js';

describe('suite URLs', () => {
  it('resolves media and feed URLs against the suite origin', () => {
    expect(resolveSuiteUrl('https://tg-api.example', `/api/v1/media/${MEDIA_OBJECT_ID}`)).toBe(
      `https://tg-api.example/api/v1/media/${MEDIA_OBJECT_ID}`,
    );
    expect(globalRssUrl('https://tg-api.example')).toBe('https://tg-api.example/api/v1/rss.xml');
    expect(channelRssUrl('https://tg-api.example', CHANNEL_ID)).toBe(
      `https://tg-api.example/api/v1/channels/${CHANNEL_ID}/rss.xml`,
    );
    expect(resolveSuiteUrl('https://tg-api.example', null)).toBeNull();
  });

  it.each([
    'https://tg-api.example/',
    'https://tg-api.example/api',
    'https://user:password@tg-api.example',
    'https://tg-api.example?query=yes',
    'ftp://tg-api.example',
  ])('rejects noncanonical base URL %s', (baseUrl) => {
    expect(() => canonicalSuiteOrigin(baseUrl)).toThrow(TypeError);
  });

  it.each(['https://other.example/media', '//other.example/media', 'api/v1/messages'])(
    'rejects non-origin-relative path %s',
    (path) => {
      expect(() => resolveSuiteUrl('https://tg-api.example', path)).toThrow(TypeError);
    },
  );

  it('rejects a non-suite channel ID', () => {
    expect(() => channelRssUrl('https://tg-api.example', 'not-a-uuid')).toThrow(TypeError);
  });
});
