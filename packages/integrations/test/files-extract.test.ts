import { describe, expect, it } from 'vitest';
import { ATTACHMENT_SKIP_FOR, extractText } from '../src/files/extract';

const buf = (s: string) => Buffer.from(s, 'utf8');

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('extractText', () => {
  it('extracts txt and md', async () => {
    expect(await extractText({ buffer: buf('hello there'), mime: 'text/plain', filename: 'a.txt' })).toEqual({ text: 'hello there' });
    expect(await extractText({ buffer: buf('# Title'), mime: 'application/octet-stream', filename: 'a.md' })).toEqual({ text: '# Title' });
  });

  it('flags invalid UTF-8 as corrupt', async () => {
    expect(await extractText({ buffer: Buffer.from([0xff, 0xfe, 0xfd]), mime: 'text/plain', filename: 'a.txt' })).toEqual({ failure: 'corrupt' });
  });

  it('converts html to text', async () => {
    const r = await extractText({ buffer: buf('<p>Hello <b>world</b></p>'), mime: 'text/html', filename: 'a.html' });
    expect(r).toEqual({ text: 'Hello world' });
  });

  it('rejects oversize, unsupported and empty input', async () => {
    expect(await extractText({ buffer: buf('x'.repeat(20)), mime: 'text/plain', filename: 'a.txt', maxBytes: 10 })).toEqual({ failure: 'too_large' });
    expect(await extractText({ buffer: buf('x'), mime: 'image/png', filename: 'a.png' })).toEqual({ failure: 'unsupported_type' });
    expect(await extractText({ buffer: buf('  \n '), mime: 'text/plain', filename: 'a.txt' })).toEqual({ failure: 'empty' });
    expect(await extractText({ buffer: Buffer.alloc(0), mime: 'text/plain', filename: 'a.txt' })).toEqual({ failure: 'empty' });
  });

  it('extracts text from a minimal pdf', async () => {
    const r = await extractText({ buffer: minimalPdf('This is a short test document for extraction'), mime: 'application/pdf', filename: 'a.pdf' });
    expect(r).toMatchObject({ text: expect.stringContaining('short test document') });
  });

  it('reports garbage pdf as corrupt', async () => {
    expect(await extractText({ buffer: buf('not a pdf at all'), mime: 'application/pdf', filename: 'a.pdf' })).toEqual({ failure: 'corrupt' });
  });

  it('reports pdf with too little text as no_text', async () => {
    expect(await extractText({ buffer: minimalPdf('hi'), mime: 'application/pdf', filename: 'a.pdf' })).toEqual({ failure: 'no_text' });
  });

  it('reports invalid docx as corrupt', async () => {
    expect(await extractText({ buffer: buf('nope'), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'a.docx' })).toEqual({ failure: 'corrupt' });
  });

  it('maps failures to attachment skips', () => {
    expect(ATTACHMENT_SKIP_FOR.unsupported_type).toBe('non_text_attachment');
    expect(ATTACHMENT_SKIP_FOR.too_large).toBe('attachment_too_large');
    expect(ATTACHMENT_SKIP_FOR.encrypted).toBe('unreadable_attachment');
  });
});
