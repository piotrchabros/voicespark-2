import { convert } from 'html-to-text';
import { extractText as pdfExtractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import type { UploadMime } from './sniff';
import { extractOoxmlOdf } from './office';

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

export const HUB_EXTRACT_TIMEOUT_MS = 30_000;
export const HUB_TEXT_MAX_CHARS = 1_000_000;

export type HubExtractResult = {
  status: 'extracted' | 'empty' | 'unsupported' | 'failed';
  reason?: 'empty' | 'no_text_extraction_for_type' | 'image_not_searchable' | 'timeout' | 'corrupt';
  text?: string;
};

const HUB_OFFICE_EXT = new Set(['xlsx', 'pptx', 'odt', 'ods', 'odp']);
const HUB_PLAIN_EXT = new Set(['csv', 'txt', 'md', 'markdown']);
const HUB_NO_TEXT_EXT = new Set(['rtf', 'doc', 'xls', 'ppt']);
const HUB_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

const hubText = (raw: string): HubExtractResult => {
  const text = raw.trim();
  return text ? { status: 'extracted', text: text.slice(0, HUB_TEXT_MAX_CHARS) } : { status: 'empty', reason: 'empty' };
};

async function extractHubBody(bytes: Uint8Array, ext: string): Promise<HubExtractResult> {
  if (HUB_IMAGE_EXT.has(ext)) return { status: 'unsupported', reason: 'image_not_searchable' };
  if (HUB_NO_TEXT_EXT.has(ext)) return { status: 'unsupported', reason: 'no_text_extraction_for_type' };
  if (!bytes.length) return { status: 'empty', reason: 'empty' };
  if (ext === 'pdf') {
    const r = await extractPdf(Buffer.from(bytes));
    if ('text' in r) return hubText(r.text);
    return r.failure === 'no_text' ? { status: 'empty', reason: 'empty' } : { status: 'failed', reason: 'corrupt' };
  }
  if (ext === 'docx') {
    try {
      return hubText((await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value);
    } catch {
      return { status: 'failed', reason: 'corrupt' };
    }
  }
  if (HUB_OFFICE_EXT.has(ext)) {
    const r = await extractOoxmlOdf(bytes, ext);
    if ('text' in r) return hubText(r.text);
    return r.failure === 'empty' ? { status: 'empty', reason: 'empty' } : { status: 'failed', reason: 'corrupt' };
  }
  if (HUB_PLAIN_EXT.has(ext)) {
    try {
      return hubText(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      return { status: 'failed', reason: 'corrupt' };
    }
  }
  return { status: 'unsupported', reason: 'no_text_extraction_for_type' };
}

// Never throws. The timeout abandons the wait; the underlying parse cannot be cancelled.
export async function extractHubText(bytes: Uint8Array, extension: string, opts: { timeoutMs?: number } = {}): Promise<HubExtractResult> {
  const timeoutMs = opts.timeoutMs ?? HUB_EXTRACT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HubExtractResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'failed', reason: 'timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([extractHubBody(bytes, extension.toLowerCase()).catch((): HubExtractResult => ({ status: 'failed', reason: 'corrupt' })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
