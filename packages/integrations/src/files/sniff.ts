import { fileTypeFromBuffer } from 'file-type';

export const UPLOAD_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
} as const;
export type UploadMime = (typeof UPLOAD_MIME)[keyof typeof UPLOAD_MIME];
export type SniffReject = 'unsupported_type' | 'too_large' | 'empty';

const TEXT_EXT_MIME: Record<string, UploadMime> = { txt: UPLOAD_MIME.txt, md: UPLOAD_MIME.md, markdown: UPLOAD_MIME.md };
const NUL_SCAN_BYTES = 8 * 1024;

export async function sniffUpload(i: {
  buffer: Buffer;
  filename: string;
  maxBytes: number;
}): Promise<{ ok: true; mime: UploadMime } | { ok: false; reason: SniffReject }> {
  const { buffer, filename, maxBytes } = i;
  if (buffer.length > maxBytes) return { ok: false, reason: 'too_large' };
  if (buffer.length === 0) return { ok: false, reason: 'empty' };

  const detected = await fileTypeFromBuffer(buffer);
  if (detected) {
    if (detected.mime === UPLOAD_MIME.pdf) return { ok: true, mime: UPLOAD_MIME.pdf };
    if (detected.mime === UPLOAD_MIME.docx) return { ok: true, mime: UPLOAD_MIME.docx };
    return { ok: false, reason: 'unsupported_type' };
  }

  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  const mime = TEXT_EXT_MIME[ext];
  if (!mime) return { ok: false, reason: 'unsupported_type' };
  if (buffer.subarray(0, NUL_SCAN_BYTES).includes(0)) return { ok: false, reason: 'unsupported_type' };
  return { ok: true, mime };
}

export const HUB_ALLOWED_EXTENSIONS = [
  'pdf', 'docx', 'odt', 'doc', 'rtf', 'xlsx', 'ods', 'csv', 'xls', 'pptx',
  'odp', 'ppt', 'txt', 'md', 'markdown', 'png', 'jpg', 'jpeg', 'gif', 'webp',
] as const;
export type HubExtension = (typeof HUB_ALLOWED_EXTENSIONS)[number];
export type HubSniffResult = { ok: true; mime: string } | { ok: false; reason: 'unsupported_type' };

const OOXML = 'application/vnd.openxmlformats-officedocument';
const ODF = 'application/vnd.oasis.opendocument';
const CFB = 'application/x-cfb';

// Mime that magic-byte detection must report for each binary extension.
const HUB_BINARY_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: `${OOXML}.wordprocessingml.document`,
  xlsx: `${OOXML}.spreadsheetml.sheet`,
  pptx: `${OOXML}.presentationml.presentation`,
  odt: `${ODF}.text`,
  ods: `${ODF}.spreadsheet`,
  odp: `${ODF}.presentation`,
  doc: CFB,
  xls: CFB,
  ppt: CFB,
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const HUB_TEXT_MIME: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv' };
const SVG_HEAD = /<svg[\s>]/i;
const RTF_MAGIC = '{\\rtf';

const refuse = { ok: false, reason: 'unsupported_type' } as const;

export async function sniffHubFile(bytes: Uint8Array, extension: string): Promise<HubSniffResult> {
  const ext = extension.toLowerCase();
  if (!(HUB_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) return refuse;
  const detected = await fileTypeFromBuffer(bytes);

  const binaryMime = HUB_BINARY_MIME[ext];
  if (binaryMime) return detected?.mime === binaryMime ? { ok: true, mime: binaryMime } : refuse;

  // rtf is checked by its own magic; txt, md, markdown and csv have none, so any detected type is a mismatch.
  if (ext === 'rtf') {
    if (detected && detected.mime !== 'application/rtf') return refuse;
    return Buffer.from(bytes.subarray(0, RTF_MAGIC.length)).toString('latin1') === RTF_MAGIC ? { ok: true, mime: 'application/rtf' } : refuse;
  }
  if (detected) return refuse;
  if (bytes.subarray(0, NUL_SCAN_BYTES).includes(0)) return refuse;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse;
  }
  if (text.includes('\0') || SVG_HEAD.test(text.slice(0, 2048))) return refuse;
  return { ok: true, mime: HUB_TEXT_MIME[ext]! };
}
