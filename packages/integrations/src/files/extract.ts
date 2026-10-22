import { convert } from 'html-to-text';
import { extractText as pdfExtractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import type { UploadMime } from './sniff';

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export type ExtractFailure = 'unsupported_type' | 'too_large' | 'encrypted' | 'no_text' | 'corrupt' | 'empty';
export type AttachmentSkip = 'non_text_attachment' | 'attachment_too_large' | 'unreadable_attachment';

export const ATTACHMENT_SKIP_FOR: Readonly<Record<ExtractFailure, AttachmentSkip>> = {
  unsupported_type: 'non_text_attachment',
  too_large: 'attachment_too_large',
  encrypted: 'unreadable_attachment',
  no_text: 'unreadable_attachment',
  corrupt: 'unreadable_attachment',
  empty: 'unreadable_attachment',
};

type Kind = 'pdf' | 'docx' | 'txt' | 'html';

const MIME_KIND: Record<string, Kind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'txt',
  'text/x-markdown': 'txt',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
};
const EXT_KIND: Record<string, Kind> = { pdf: 'pdf', docx: 'docx', txt: 'txt', md: 'txt', markdown: 'txt', html: 'html', htm: 'html' };

function detectKind(mime: string, filename: string): Kind | null {
  const byMime = MIME_KIND[mime.split(';')[0]!.trim().toLowerCase()];
  if (byMime) return byMime;
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return EXT_KIND[ext] ?? null;
}

const MIN_CHARS_PER_PAGE = 20;

async function extractPdf(buffer: Buffer): Promise<{ text: string } | { failure: ExtractFailure }> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { totalPages, text } = await pdfExtractText(pdf, { mergePages: true });
    const merged = (Array.isArray(text) ? text.join('\n') : text).trim();
    if (merged.length === 0 || merged.length / Math.max(totalPages, 1) < MIN_CHARS_PER_PAGE) return { failure: 'no_text' };
    return { text: merged };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === 'PasswordException' || /password/i.test(e?.message ?? '')) return { failure: 'encrypted' };
    return { failure: 'corrupt' };
  }
}

export async function extractText(input: { buffer: Buffer; mime: string; filename: string; maxBytes?: number }): Promise<{ text: string } | { failure: ExtractFailure }> {
  const { buffer, mime, filename, maxBytes = ATTACHMENT_MAX_BYTES } = input;
  const kind = detectKind(mime, filename);
  if (!kind) return { failure: 'unsupported_type' };
  if (buffer.length > maxBytes) return { failure: 'too_large' };
  if (buffer.length === 0) return { failure: 'empty' };

  let text: string;
  if (kind === 'pdf') {
    const r = await extractPdf(buffer);
    if ('failure' in r) return r;
    text = r.text;
  } else if (kind === 'docx') {
    try {
      text = (await mammoth.extractRawText({ buffer })).value;
    } catch {
      return { failure: 'corrupt' };
    }
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return { failure: 'corrupt' };
    }
    if (kind === 'html') text = convert(text, { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] });
  }
  text = text.trim();
  return text ? { text } : { failure: 'empty' };
}

export type UploadRejectReason = 'unsupported_type' | 'too_large' | 'encrypted' | 'no_text' | 'corrupt' | 'empty';

export async function extractUpload(input: {
  buffer: Buffer;
  mime: UploadMime;
  filename: string;
  maxBytes: number;
}): Promise<{ text: string } | { reject: UploadRejectReason }> {
  const r = await extractText(input);
  return 'failure' in r ? { reject: r.failure } : r;
}
