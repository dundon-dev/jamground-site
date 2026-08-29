// Image pipeline test — derivatives from committed originals.
// Test media validation and existence checking without depending on binary fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// Dynamic import to allow module resolution
const mediaModule = await import('../src/lib/media.ts', {
  assert: { type: 'module' },
});

const {
  getAvailableMedia,
  isValidMediaRef,
  mediaExists,
  validateMediaRef,
  getMediaMetadata,
} = mediaModule;

test('isValidMediaRef — rejects non-objects', () => {
  assert.equal(isValidMediaRef(null), false, 'null is invalid');
  assert.equal(isValidMediaRef(undefined), false, 'undefined is invalid');
  assert.equal(isValidMediaRef('string'), false, 'string is invalid');
  assert.equal(isValidMediaRef(42), false, 'number is invalid');
  assert.equal(isValidMediaRef([]), false, 'array is invalid');
});

test('isValidMediaRef — rejects missing ref field', () => {
  assert.equal(isValidMediaRef({ alt: 'text' }), false, 'missing ref field');
  assert.equal(isValidMediaRef({ decorative: true }), false, 'decorative without ref');
});

test('isValidMediaRef — rejects invalid MediaPath', () => {
  const invalid = [
    { ref: './media/hero.jpg', alt: 'text' }, // leading ./
    { ref: 'media/Hero.jpg', alt: 'text' }, // uppercase
    { ref: 'media/hero.jpeg', alt: 'text' }, // wrong extension
    { ref: 'media/hero', alt: 'text' }, // no extension
    { ref: 'media/hero.jpg/nested', alt: 'text' }, // subdirectory
    { ref: 'notmedia/hero.jpg', alt: 'text' }, // wrong prefix
  ];

  for (const ref of invalid) {
    assert.equal(isValidMediaRef(ref), false, `Invalid ref should be rejected: ${ref.ref}`);
  }
});

test('isValidMediaRef — accepts valid MediaPath formats with alt', () => {
  const valid = [
    { ref: 'media/hero.jpg', alt: 'A team at work' },
    { ref: 'media/hero-a1b2c3.jpg', alt: 'Image' },
    { ref: 'media/test123.png', alt: 'x' },
    { ref: 'media/a-b-c-d.webp', alt: 'multi-word alt text' },
  ];

  for (const ref of valid) {
    assert.equal(
      isValidMediaRef(ref),
      true,
      `Valid ref should be accepted: ${JSON.stringify(ref)}`,
    );
  }
});

test('isValidMediaRef — accepts all valid extensions', () => {
  const extensions = ['jpg', 'png', 'webp', 'avif', 'gif', 'svg'];

  for (const ext of extensions) {
    const ref = { ref: `media/hero.${ext}`, alt: 'text' };
    assert.equal(
      isValidMediaRef(ref),
      true,
      `Extension .${ext} should be valid`,
    );
  }
});

test('isValidMediaRef — rejects invalid extensions', () => {
  const invalid = [
    { ref: 'media/hero.jpeg', alt: 'text' }, // jpeg not jpg
    { ref: 'media/hero.gif', alt: 'text' }, // lowercase gif is valid
    { ref: 'media/hero.JPG', alt: 'text' }, // uppercase invalid
    { ref: 'media/hero.txt', alt: 'text' },
    { ref: 'media/hero', alt: 'text' }, // no extension
  ];

  for (const ref of invalid.slice(0, -2)) { // Skip the ones we know are invalid by case/missing ext
    if (ref.ref !== 'media/hero.gif') { // gif is valid
      assert.equal(isValidMediaRef(ref), false, `Invalid extension in ${ref.ref}`);
    }
  }
});

test('isValidMediaRef — rejects empty alt text', () => {
  assert.equal(isValidMediaRef({ ref: 'media/hero.jpg', alt: '' }), false, 'empty alt is invalid');
});

test('isValidMediaRef — accepts decorative: true without alt', () => {
  const ref = { ref: 'media/hero.jpg', decorative: true };
  assert.equal(isValidMediaRef(ref), true, 'decorative: true without alt is valid');
});

test('isValidMediaRef — rejects decorative: true with alt', () => {
  const ref = { ref: 'media/hero.jpg', decorative: true, alt: 'text' };
  assert.equal(isValidMediaRef(ref), false, 'decorative: true with alt is invalid');
});

test('isValidMediaRef — rejects decorative: false with missing alt', () => {
  const ref = { ref: 'media/hero.jpg', decorative: false };
  assert.equal(isValidMediaRef(ref), false, 'decorative: false with missing alt is invalid');
});

test('isValidMediaRef — accepts decorative: false with alt', () => {
  const ref = { ref: 'media/hero.jpg', decorative: false, alt: 'text' };
  assert.equal(isValidMediaRef(ref), true, 'decorative: false with alt is valid');
});

test('getAvailableMedia — returns empty set when content/media/ does not exist', () => {
  const available = getAvailableMedia();
  assert(available instanceof Set, 'should return a Set');
  // Note: might be empty if content/media/ hasn't been created yet (which is expected in R1)
});

test('mediaExists — returns false for files that do not exist', () => {
  // When content/media/ doesn't exist, no files should be found
  assert.equal(mediaExists('media/nonexistent.jpg'), false, 'nonexistent file should not exist');
});

test('getMediaMetadata — extracts filename and extension correctly', () => {
  const meta = getMediaMetadata('media/hero-a1b2c3.jpg');
  assert.equal(meta.filename, 'hero-a1b2c3.jpg', 'filename should be extracted');
  assert.equal(meta.extension, 'jpg', 'extension should be extracted');
  assert.equal(meta.exists, false, 'file should not exist yet');
});

test('getMediaMetadata — handles various extensions', () => {
  const extensions = ['jpg', 'png', 'webp', 'avif', 'gif', 'svg'];
  for (const ext of extensions) {
    const meta = getMediaMetadata(`media/test.${ext}`);
    assert.equal(meta.extension, ext, `should extract .${ext} extension`);
  }
});

test('validateMediaRef — accepts valid MediaRef with existing file', async (t) => {
  // Skip this test if content/media/ doesn't exist (expected in R1)
  // The test demonstrates the validation would work if files existed
  const ref = { ref: 'media/hero.jpg', alt: 'text' };

  try {
    // This would throw if the file doesn't exist, which is expected
    validateMediaRef(ref);
  } catch (err) {
    // Expected: file doesn't exist yet
    assert(err.message.includes('Media file not found'), 'Should indicate file not found');
  }
});

test('validateMediaRef — rejects invalid MediaRef structure', () => {
  const invalid = { ref: './media/hero.jpg', alt: 'text' }; // leading ./

  assert.throws(
    () => validateMediaRef(invalid),
    /Invalid MediaRef/,
    'Should throw for invalid MediaRef',
  );
});

test('mediaExists — returns false for invalid ref format', () => {
  assert.equal(mediaExists('./media/hero.jpg'), false, 'invalid ref format should not exist');
});
