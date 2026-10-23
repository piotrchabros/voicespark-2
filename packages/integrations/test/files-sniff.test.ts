import { describe, expect, it } from 'vitest';
import { extractUpload } from '../src/files/extract';
import { HUB_ALLOWED_EXTENSIONS, sniffHubFile, sniffUpload, UPLOAD_MIME } from '../src/files/sniff';
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

describe('sniffHubFile', () => {
  const CFB = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512)]);
  const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300', 'hex');
  const GIF = Buffer.from('474946383961010001000000002c00000000010001000002024401003b', 'hex');
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.alloc(16)]);
  const OOXML_CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">';
  const ooxml = (part: string, main: string) =>
    makeStoredZip([{ name: '[Content_Types].xml', data: `${OOXML_CT}<Override PartName="/${part}" ContentType="${main}+xml"/></Types>` }, { name: part, data: '<x/>' }]);
  const XLSX = ooxml('xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main');
  const PPTX = ooxml('ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main');
  const odf = (mime: string) => makeStoredZip([{ name: 'mimetype', data: mime }, { name: 'content.xml', data: '<x/>' }]);
  const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0)]);
  const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64, 0)]);

  it('allows exactly the 20 extensions', () => {
    expect([...HUB_ALLOWED_EXTENSIONS].sort()).toEqual(
      ['pdf', 'docx', 'odt', 'doc', 'rtf', 'xlsx', 'ods', 'csv', 'xls', 'pptx', 'odp', 'ppt', 'txt', 'md', 'markdown', 'png', 'jpg', 'jpeg', 'gif', 'webp'].sort(),
    );
    expect(HUB_ALLOWED_EXTENSIONS).toHaveLength(20);
  });
  it('accepts matching magic bytes', async () => {
    const ok: [Buffer, string][] = [
      [makePdf('hello world text here'), 'pdf'],
      [makeDocx(['hi']), 'docx'],
      [XLSX, 'xlsx'],
      [PPTX, 'pptx'],
      [odf('application/vnd.oasis.opendocument.text'), 'odt'],
      [odf('application/vnd.oasis.opendocument.spreadsheet'), 'ods'],
      [odf('application/vnd.oasis.opendocument.presentation'), 'odp'],
      [PNG, 'png'],
      [JPG, 'jpg'],
      [JPG, 'jpeg'],
      [GIF, 'gif'],
      [WEBP, 'webp'],
      [buf('{\\rtf1\\ansi hello}'), 'rtf'],
      [buf('a,b\n1,2'), 'csv'],
      [buf('plain'), 'txt'],
      [buf('# md'), 'md'],
      [buf('# md'), 'markdown'],
    ];
    for (const [bytes, ext] of ok) expect(await sniffHubFile(bytes, ext), ext).toMatchObject({ ok: true });
  });
  it('is case-insensitive on the extension', async () => {
    expect(await sniffHubFile(buf('plain'), 'TXT')).toMatchObject({ ok: true });
  });
  it('doc, xls and ppt sniff as cfb', async () => {
    for (const ext of ['doc', 'xls', 'ppt']) expect(await sniffHubFile(CFB, ext), ext).toMatchObject({ ok: true, mime: 'application/x-cfb' });
  });
  it('refuses a cfb container under a modern extension', async () => {
    expect(await sniffHubFile(CFB, 'docx')).toEqual({ ok: false, reason: 'unsupported_type' });
  });
  it('txt, md and csv must be strict UTF-8 with no NUL', async () => {
    for (const ext of ['txt', 'md', 'csv']) {
      expect(await sniffHubFile(Buffer.from([0xff, 0xfe, 0xfd]), ext), ext).toEqual({ ok: false, reason: 'unsupported_type' });
      expect(await sniffHubFile(Buffer.from([0x61, 0x00, 0x62]), ext), ext).toEqual({ ok: false, reason: 'unsupported_type' });
    }
  });
  it('refuses SVG whatever it is named', async () => {
    const svg = buf('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    for (const ext of ['svg', 'txt', 'md', 'csv', 'png']) expect(await sniffHubFile(svg, ext), ext).toEqual({ ok: false, reason: 'unsupported_type' });
  });
  it('refuses a renamed executable', async () => {
    for (const ext of ['pdf', 'txt', 'png', 'docx', 'doc']) {
      expect(await sniffHubFile(EXE, ext), `exe ${ext}`).toEqual({ ok: false, reason: 'unsupported_type' });
      expect(await sniffHubFile(ELF, ext), `elf ${ext}`).toEqual({ ok: false, reason: 'unsupported_type' });
    }
  });
  it('refuses a mismatched magic number', async () => {
    expect(await sniffHubFile(PNG, 'pdf')).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(await sniffHubFile(PNG, 'jpg')).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(await sniffHubFile(makePdf('hello world text here'), 'docx')).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(await sniffHubFile(XLSX, 'pptx')).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(await sniffHubFile(PPTX, 'odp')).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(await sniffHubFile(buf('plain text'), 'pdf')).toEqual({ ok: false, reason: 'unsupported_type' });
  });
  it('refuses a disallowed extension', async () => {
    expect(await sniffHubFile(buf('plain'), 'exe')).toEqual({ ok: false, reason: 'unsupported_type' });
    expect(await sniffHubFile(buf('plain'), '')).toEqual({ ok: false, reason: 'unsupported_type' });
  });
});
