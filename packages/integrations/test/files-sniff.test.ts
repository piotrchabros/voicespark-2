import { describe, expect, it } from 'vitest';
import { extractUpload } from '../src/files/extract';
import { sniffUpload, UPLOAD_MIME } from '../src/files/sniff';
import { makeDocx, makeEncryptedPdf, makePdf, makeScannedPdf, makeStoredZip } from './helpers/fixtures';

const MAX = 1024 * 1024;
const buf = (s: string) => Buffer.from(s, 'utf8');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

describe('sniffUpload', () => {
  it('accepts pdf', async () => {
    expect(await sniffUpload({ buffer: makePdf('hello world text here'), filename: 'a.pdf', maxBytes: MAX })).toEqual({ ok: true, mime: UPLOAD_MIME.pdf });
  });
  it('accepts docx', async () => {
    expect(await sniffUpload({ buffer: makeDocx(['hi']), filename: 'a.docx', maxBytes: MAX })).toEqual({ ok: true, mime: UPLOAD_MIME.docx });
  });
  it('accepts txt and md by extension', async () => {
    expect(await sniffUpload({ buffer: buf('plain'), filename: 'a.txt', maxBytes: MAX })).toEqual({ ok: true, mime: UPLOAD_MIME.txt });
    expect(await sniffUpload({ buffer: buf('# md'), filename: 'a.md', maxBytes: MAX })).toEqual({ ok: true, mime: UPLOAD_MIME.md });
    expect(await sniffUpload({ buffer: buf('# md'), filename: 'a.markdown', maxBytes: MAX })).toEqual({ ok: true, mime: UPLOAD_MIME.md });
  });
  it('rejects png even when named .txt', async () => {
    expect(await sniffUpload({ buffer: PNG, filename: 'a.txt', maxBytes: MAX })).toEqual({ ok: false, reason: 'unsupported_type' });
  });
  it('rejects a zip that is not a docx', async () => {
    const zip = makeStoredZip([{ name: 'a.txt', data: 'hello' }]);
    expect(await sniffUpload({ buffer: zip, filename: 'a.docx', maxBytes: MAX })).toEqual({ ok: false, reason: 'unsupported_type' });
  });
  it('rejects unknown extension', async () => {
    expect(await sniffUpload({ buffer: buf('plain'), filename: 'a.csv', maxBytes: MAX })).toEqual({ ok: false, reason: 'unsupported_type' });
  });
  it('rejects oversize and empty', async () => {
    expect(await sniffUpload({ buffer: buf('abcdef'), filename: 'a.txt', maxBytes: 3 })).toEqual({ ok: false, reason: 'too_large' });
    expect(await sniffUpload({ buffer: Buffer.alloc(0), filename: 'a.txt', maxBytes: MAX })).toEqual({ ok: false, reason: 'empty' });
  });
  it('rejects binary .txt (NUL byte)', async () => {
    expect(await sniffUpload({ buffer: Buffer.from([0x61, 0x00, 0x62]), filename: 'a.txt', maxBytes: MAX })).toEqual({ ok: false, reason: 'unsupported_type' });
  });
});

describe('extractUpload', () => {
  const base = { maxBytes: MAX };
  it('extracts txt and md', async () => {
    expect(await extractUpload({ ...base, buffer: buf('hello there'), mime: UPLOAD_MIME.txt, filename: 'a.txt' })).toEqual({ text: 'hello there' });
    expect(await extractUpload({ ...base, buffer: buf('# Title'), mime: UPLOAD_MIME.md, filename: 'a.md' })).toEqual({ text: '# Title' });
  });
  it('extracts docx text', async () => {
    const r = await extractUpload({ ...base, buffer: makeDocx(['First paragraph', 'Second paragraph']), mime: UPLOAD_MIME.docx, filename: 'a.docx' });
    expect(r).toMatchObject({ text: expect.stringContaining('First paragraph') });
  });
  it('extracts pdf text', async () => {
    const r = await extractUpload({ ...base, buffer: makePdf('Hello from a real pdf document'), mime: UPLOAD_MIME.pdf, filename: 'a.pdf' });
    expect(r).toMatchObject({ text: expect.stringContaining('Hello from a real pdf document') });
  });
  it('scanned pdf -> no_text', async () => {
    expect(await extractUpload({ ...base, buffer: makeScannedPdf(), mime: UPLOAD_MIME.pdf, filename: 'a.pdf' })).toEqual({ reject: 'no_text' });
  });
  it('encrypted pdf -> encrypted', async () => {
    expect(await extractUpload({ ...base, buffer: makeEncryptedPdf(), mime: UPLOAD_MIME.pdf, filename: 'a.pdf' })).toEqual({ reject: 'encrypted' });
  });
  it('invalid utf-8 -> corrupt', async () => {
    expect(await extractUpload({ ...base, buffer: Buffer.from([0xff, 0xfe, 0xfd]), mime: UPLOAD_MIME.txt, filename: 'a.txt' })).toEqual({ reject: 'corrupt' });
  });
});
