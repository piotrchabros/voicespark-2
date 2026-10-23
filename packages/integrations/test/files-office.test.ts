import mammoth from 'mammoth';
import { describe, expect, it, vi } from 'vitest';
import { extractOoxmlOdf } from '../src/files/office';
import { extractHubText } from '../src/files/extract';
import { makeDocx, makePdf, makeScannedPdf, makeStoredZip } from './helpers/fixtures';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function makeXlsx(opts: { shared?: string[]; inline?: string[] } = {}): Buffer {
  const entries: { name: string; data: string }[] = [{ name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` }];
  if (opts.shared) {
    entries.push({ name: 'xl/sharedStrings.xml', data: `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${opts.shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>` });
  }
  const cells = [
    ...(opts.shared ?? []).map((_, i) => `<c r="A${i + 1}" t="s"><v>${i}</v></c>`),
    ...(opts.inline ?? []).map((s, i) => `<c r="B${i + 1}" t="inlineStr"><is><t>${esc(s)}</t></is></c>`),
    '<c r="C1"><v>42</v></c>',
  ].join('');
  entries.push({ name: 'xl/worksheets/sheet1.xml', data: `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cells}</row></sheetData></worksheet>` });
  return makeStoredZip(entries);
}

function makePptx(slides: string[][]): Buffer {
  return makeStoredZip([
    { name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    ...slides.map((runs, i) => ({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: `${XML}<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${runs.map((r) => `<a:p><a:r><a:t>${esc(r)}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`,
    })),
  ]);
}

function makeOdf(mime: string, paras: { tag: 'text:p' | 'text:h'; text: string }[]): Buffer {
  return makeStoredZip([
    { name: 'mimetype', data: mime },
    {
      name: 'content.xml',
      data: `${XML}<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text>${paras.map((p) => `<${p.tag}>${esc(p.text)}</${p.tag}>`).join('')}</office:text></office:body></office:document-content>`,
    },
  ]);
}

describe('extractOoxmlOdf', () => {
  it('xlsx: shared strings and inline strings', async () => {
    const r = await extractOoxmlOdf(makeXlsx({ shared: ['Alpha budget', 'Beta & Gamma'], inline: ['Inline value'] }), 'xlsx');
    expect(r).toMatchObject({ text: expect.stringContaining('Alpha budget') });
    expect('text' in r && r.text).toContain('Beta & Gamma');
    expect('text' in r && r.text).toContain('Inline value');
  });
  it('xlsx: inline strings only', async () => {
    const r = await extractOoxmlOdf(makeXlsx({ inline: ['Only inline'] }), 'xlsx');
    expect(r).toMatchObject({ text: expect.stringContaining('Only inline') });
  });
  it('pptx: a:t from every slide', async () => {
    const r = await extractOoxmlOdf(makePptx([['Slide one title'], ['Slide two body']]), 'pptx');
    expect('text' in r && r.text).toContain('Slide one title');
    expect('text' in r && r.text).toContain('Slide two body');
  });
  it.each([
    ['odt', 'application/vnd.oasis.opendocument.text'],
    ['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['odp', 'application/vnd.oasis.opendocument.presentation'],
  ])('%s: text:p and text:h from content.xml', async (ext, mime) => {
    const r = await extractOoxmlOdf(
      makeOdf(mime, [
        { tag: 'text:h', text: 'Heading here' },
        { tag: 'text:p', text: 'Paragraph here' },
      ]),
      ext,
    );
    expect('text' in r && r.text).toContain('Heading here');
    expect('text' in r && r.text).toContain('Paragraph here');
  });
  it('a zip without the expected part -> corrupt', async () => {
    const zip = makeStoredZip([{ name: 'other.txt', data: 'hello' }]);
    for (const ext of ['xlsx', 'pptx', 'odt', 'ods', 'odp']) expect(await extractOoxmlOdf(zip, ext)).toEqual({ failure: 'corrupt' });
  });
  it('not a zip -> corrupt', async () => {
    expect(await extractOoxmlOdf(Buffer.from('not a zip at all'), 'xlsx')).toEqual({ failure: 'corrupt' });
  });
  it('an empty document -> empty', async () => {
    expect(await extractOoxmlOdf(makePptx([[]]), 'pptx')).toEqual({ failure: 'empty' });
    expect(await extractOoxmlOdf(makeOdf('application/vnd.oasis.opendocument.text', []), 'odt')).toEqual({ failure: 'empty' });
    expect(await extractOoxmlOdf(makeXlsx(), 'xlsx')).toEqual({ failure: 'empty' });
  });
  it('an unsupported extension is rejected', async () => {
    expect(await extractOoxmlOdf(makePptx([['x']]), 'zip')).toEqual({ failure: 'unsupported_type' });
  });
});

describe('extractHubText', () => {
  const opts = { timeoutMs: 30000 };
  it('pdf', async () => {
    const r = await extractHubText(makePdf('Hello from a hub pdf document'), 'pdf', opts);
    expect(r.status).toBe('extracted');
    expect(r.text).toContain('Hello from a hub pdf document');
  });
  it('docx', async () => {
    const r = await extractHubText(makeDocx(['Docx paragraph one']), 'docx', opts);
    expect(r).toMatchObject({ status: 'extracted', text: expect.stringContaining('Docx paragraph one') });
  });
  it('xlsx, pptx and odt through the office extractor', async () => {
    expect(await extractHubText(makeXlsx({ shared: ['Sheet text'] }), 'xlsx', opts)).toMatchObject({ status: 'extracted', text: expect.stringContaining('Sheet text') });
    expect(await extractHubText(makePptx([['Deck text']]), 'pptx', opts)).toMatchObject({ status: 'extracted', text: expect.stringContaining('Deck text') });
    const odt = makeOdf('application/vnd.oasis.opendocument.text', [{ tag: 'text:p', text: 'Odt text' }]);
    expect(await extractHubText(odt, 'odt', opts)).toMatchObject({ status: 'extracted', text: expect.stringContaining('Odt text') });
  });
  it('csv, txt and md drop a BOM', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\n1,2', 'utf8')]);
    expect(await extractHubText(withBom, 'csv', opts)).toEqual({ status: 'extracted', text: 'a,b\n1,2' });
    expect(await extractHubText(Buffer.from('plain text'), 'txt', opts)).toEqual({ status: 'extracted', text: 'plain text' });
    expect(await extractHubText(Buffer.from('# Title'), 'md', opts)).toEqual({ status: 'extracted', text: '# Title' });
  });
  it('invalid utf-8 text -> failed / corrupt', async () => {
    expect(await extractHubText(Buffer.from([0xff, 0xfe, 0xfd]), 'txt', opts)).toEqual({ status: 'failed', reason: 'corrupt' });
  });
  it('blank text and scanned pdf -> empty', async () => {
    expect(await extractHubText(Buffer.from('  \n '), 'txt', opts)).toMatchObject({ status: 'empty' });
    expect(await extractHubText(makeScannedPdf(), 'pdf', opts)).toMatchObject({ status: 'empty' });
  });
  it('corrupt office zip -> failed / corrupt', async () => {
    expect(await extractHubText(makeStoredZip([{ name: 'x', data: 'y' }]), 'xlsx', opts)).toEqual({ status: 'failed', reason: 'corrupt' });
  });
  it('rtf, doc, xls, ppt -> unsupported / no_text_extraction_for_type', async () => {
    for (const ext of ['rtf', 'doc', 'xls', 'ppt']) {
      expect(await extractHubText(Buffer.from('x'), ext, opts)).toEqual({ status: 'unsupported', reason: 'no_text_extraction_for_type' });
    }
  });
  it('images -> unsupported / image_not_searchable', async () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
      expect(await extractHubText(Buffer.from('x'), ext, opts)).toEqual({ status: 'unsupported', reason: 'image_not_searchable' });
    }
  });
  it('a timeout -> failed / timeout', async () => {
    const spy = vi.spyOn(mammoth, 'extractRawText').mockImplementation(() => new Promise(() => {}));
    try {
      expect(await extractHubText(makeDocx(['never finishes']), 'docx', { timeoutMs: 50 })).toEqual({ status: 'failed', reason: 'timeout' });
    } finally {
      spy.mockRestore();
    }
  });
});
