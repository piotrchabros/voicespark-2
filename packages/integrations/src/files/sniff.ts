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
