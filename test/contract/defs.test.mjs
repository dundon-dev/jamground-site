// Contract test for the shared definitions.
// Every later contract task imports from src/contract/defs.ts without re-reading either
// section, so this file is the only place the schemas above are checked against the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Ulid, Locale, localeToSegment, segmentToLocale, Slug, Timestamp, MediaPath,
  InlineText, ICONS, Icon, ExternalUrl, MediaRef, Link,
} from '../../src/contract/defs.ts';

test('Ulid — Crockford base32, 26 chars, no I/L/O/U', () => {
  assert.equal(Ulid.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success, true);
  assert.equal(Ulid.safeParse('01arz3ndektsv4rrffq69g5fav').success, false, 'lowercase rejected');
  assert.equal(Ulid.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FA').success, false, '25 chars rejected');
  assert.equal(Ulid.safeParse('IIIIIIIIIIIIIIIIIIIIIIIIII').success, false, 'excluded letter I rejected');
});

test('Locale — a strict xx-XX subset of BCP 47, not BCP 47 itself (OD-23)', () => {
  assert.equal(Locale.safeParse('en-US').success, true);
  assert.equal(Locale.safeParse('de').success, false, 'bare language subtag rejected');
  assert.equal(Locale.safeParse('es-419').success, false, 'numeric region rejected');
  assert.equal(Locale.safeParse('zh-Hans-CN').success, false, 'script subtag rejected');
  assert.equal(Locale.safeParse('EN-US').success, false, 'uppercase language rejected');
  assert.equal(Locale.safeParse('en-us').success, false, 'lowercase region rejected');
});

test('localeToSegment / segmentToLocale — mutually inverse over the Locale domain', () => {
  assert.equal(localeToSegment('en-US'), 'en-us');
  assert.equal(segmentToLocale('en-us'), 'en-US');
  for (const locale of ['en-US', 'fr-CA', 'de-DE']) {
    assert.equal(segmentToLocale(localeToSegment(locale)), locale);
  }
});

test('Slug — URL-facing, lowercase, no leading or trailing hyphen, no slash', () => {
  assert.equal(Slug.safeParse('getting-started').success, true);
  assert.equal(Slug.safeParse('home').success, true);
  assert.equal(Slug.safeParse('-slug').success, false, 'leading hyphen rejected');
  assert.equal(Slug.safeParse('slug-').success, false, 'trailing hyphen rejected');
  assert.equal(Slug.safeParse('a/b').success, false, 'nested path rejected (OD-24)');
  assert.equal(Slug.safeParse('Slug').success, false, 'uppercase rejected');
});

test('Timestamp — ISO 8601 UTC, second precision, a real instant', () => {
  assert.equal(Timestamp.safeParse('2026-02-01T00:00:00Z').success, true);
  assert.equal(Timestamp.safeParse('2026-02-01T00:00:00.000Z').success, false, 'millisecond precision rejected');
  assert.equal(Timestamp.safeParse('2026-02-01T00:00:00+00:00').success, false, 'offset form rejected');
  assert.equal(Timestamp.safeParse('2026-02-30T00:00:00Z').success, false, 'well-shaped non-instant rejected');
});

test('MediaPath — rooted at content/, lowercase-kebab, ASCII-only, one spelling per extension', () => {
  assert.equal(MediaPath.safeParse('media/hero-a1b2c3.jpg').success, true);
  assert.equal(MediaPath.safeParse('media/hero-a1b2c3.jpeg').success, false, 'jpeg is not jpg');
  assert.equal(MediaPath.safeParse('./media/hero.jpg').success, false, 'leading ./ rejected');
  assert.equal(MediaPath.safeParse('media/sub/hero.jpg').success, false, 'no subdirectories');
  assert.equal(MediaPath.safeParse('media/Hero.jpg').success, false, 'uppercase rejected');
});

test('MediaRef — alt required unless decorative:true, and the two shapes do not mix', () => {
  assert.equal(MediaRef.safeParse({ ref: 'media/a.jpg', alt: 'A team at work' }).success, true);
  assert.equal(MediaRef.safeParse({ ref: 'media/a.jpg', decorative: true }).success, true);
  assert.equal(
    MediaRef.safeParse({ ref: 'media/a.jpg', decorative: true, alt: 'x' }).success, false,
    'decorative is exclusive of alt (OD-22): empty-string alt is not how decorative is signalled',
  );
  assert.equal(MediaRef.safeParse({ ref: 'media/a.jpg' }).success, false, 'alt is required when not decorative');
  assert.equal(MediaRef.safeParse({ ref: 'media/a.jpg', alt: '' }).success, false, 'empty alt is not a real caption');
});

test('Icon — a closed enum', () => {
  for (const icon of ICONS) assert.equal(Icon.safeParse(icon).success, true, icon);
  assert.equal(Icon.safeParse('rocket').success, false, 'not a thirteenth icon');
  assert.equal(ICONS.length, 12);
});

test('ExternalUrl — https, mailto and tel only; http rejected outright', () => {
  assert.equal(ExternalUrl.safeParse('https://example.org/').success, true);
  assert.equal(ExternalUrl.safeParse('mailto:hello@example.org').success, true);
  assert.equal(ExternalUrl.safeParse('tel:+15551234567').success, true);
  assert.equal(ExternalUrl.safeParse('http://example.org/').success, false, 'plaintext rejected');
  assert.equal(ExternalUrl.safeParse('ftp://example.org/').success, false);
});

test('Link — an internal reference to a translation group (a Ulid), never an entity id', () => {
  assert.equal(Link.safeParse({ label: 'Learn more', ref: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).success, true);
  assert.equal(Link.safeParse({ label: 'Learn more', ref: 'not-a-ulid' }).success, false);
  assert.equal(Link.safeParse({ ref: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).success, false, 'label required');
});

test('InlineText — canonical marks accepted verbatim', () => {
  for (const value of [
    '**bold**',
    '_italic_',
    '`code`',
    '[label](https://example.org/)',
    'plain **bold** and _italic_ and `code` and [a link](https://example.org/)',
    '[https://example.org/](https://example.org/)', // resource-link syntax, not an autolink
  ]) {
    const result = InlineText.safeParse(value);
    assert.equal(result.success, true, `${value}: ${result.success ? '' : result.error.issues[0].message}`);
  }
});

test('InlineText — non-canonical spellings of an otherwise-permitted mark are rejected', () => {
  assert.equal(InlineText.safeParse('*bold*').success, false, 'single-star bold is emphasis, not strong');
  assert.equal(InlineText.safeParse('*italic*').success, false, 'canonical emphasis is _italic_, not *italic*');
});

test('InlineText — prohibited constructs are all rejected (11 §Canonical-InlineText)', () => {
  const prohibited = {
    image: '![alt](https://example.org/x.png)',
    strikethrough: '~~gone~~',
    autolink: '<https://example.org/>',
    'raw HTML': '<b>bold</b>',
    'hard break': 'line one  \nline two',
    'reference-style link': '[label][ref]\n\n[ref]: https://example.org/',
    'two paragraphs': 'one\n\nparagraph two',
    'a bare newline': 'one\ntwo',
  };
  for (const [name, value] of Object.entries(prohibited)) {
    assert.equal(InlineText.safeParse(value).success, false, name);
  }
});

test('InlineText — the canonical-form assertion pins escaping the same library performs', () => {
  // The value that assertion 3 authorises is exactly what unified().use(remarkStringify)
  // itself produces from the parsed AST — so a literal mark character is canonical only
  // pre-escaped exactly as remark would escape it, not left bare and not over-escaped.
  assert.equal(InlineText.safeParse('file_name_here').success, false, 'a bare literal underscore is not canonical');
  assert.equal(InlineText.safeParse('file\\_name\\_here').success, true, 'remark escapes a literal underscore');
  assert.equal(InlineText.safeParse('a * literal star').success, false, 'a bare literal star is not canonical');
  assert.equal(InlineText.safeParse('a \\* literal star').success, true, 'remark escapes a literal star');
  assert.equal(InlineText.safeParse('square [bracket]').success, false, 'an unescaped [ risks reference-link syntax');
  assert.equal(InlineText.safeParse('square \\[bracket]').success, true, 'remark escapes only the opening bracket');
});
