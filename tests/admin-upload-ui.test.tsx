import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileDropzone } from '../components/admin/upload-panel-parts';
import {
  ACCEPTED_UPLOAD_EXTENSIONS,
  UPLOAD_DROPZONE_ACCEPT,
  UPLOAD_MEDIA_ROUTES,
} from '../lib/admin/upload-contract';

test('the dropzone accept map mirrors the server media routes exactly', () => {
  assert.deepEqual(Object.keys(UPLOAD_DROPZONE_ACCEPT).sort(), Object.keys(UPLOAD_MEDIA_ROUTES).sort());
  for (const [mime, extensions] of Object.entries(UPLOAD_DROPZONE_ACCEPT)) {
    assert.deepEqual(extensions, UPLOAD_MEDIA_ROUTES[mime].acceptedExtensions.map((extension) => `.${extension}`));
  }
  assert.deepEqual(
    Object.values(UPLOAD_DROPZONE_ACCEPT).flat().sort(),
    ACCEPTED_UPLOAD_EXTENSIONS.map((extension) => `.${extension}`).sort(),
  );
});

test('react-dropzone renders a multi-file picker behind one accessible button', () => {
  const html = renderToStaticMarkup(<FileDropzone onFiles={() => {}} />);
  const input = /<input [^>]*>/.exec(html)?.[0] ?? '';
  assert.match(input, /type="file"/);
  assert.match(input, /multiple=""/);
  assert.match(input, /tabindex="-1"/, 'hidden input is not a second tab stop');
  assert.match(input, /aria-label="Choose source files to upload"/);
  for (const extension of ACCEPTED_UPLOAD_EXTENSIONS) {
    assert.ok(input.includes(`.${extension}`), `accept includes .${extension}`);
  }
  // The keyboard-reachable control is a real button, as before the migration.
  assert.match(html, /<button type="button"[^>]*>Browse files<\/button>/);
  // The drop zone itself is not focusable (noKeyboard) and not a nested control.
  const root = /^<div [^>]*>/.exec(html)?.[0] ?? '';
  assert.match(root, /role="presentation"/);
  assert.doesNotMatch(root, /tabindex/);
  assert.match(html, /Drop source files here/);
});
