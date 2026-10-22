import { crc32 } from 'node:zlib';

export function makeStoredZip(entries: { name: string; data: string | Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${xmlEscape(p)}</w:t></w:r></w:p>`).join('');
  return makeStoredZip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'word/document.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ]);
}

function buildPdf(objs: string[], trailerExtra = ''): Buffer {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function pdfObjects(streams: string[]): string[] {
  const n = streams.length;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${streams.map((_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${n} >>`,
  ];
  streams.forEach((_, i) =>
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 792] /Contents ${3 + n + i} 0 R /Resources << /Font << /F1 ${3 + 2 * n} 0 R >> >> >>`),
  );
  for (const s of streams) objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  return objs;
}

function wrapLines(text: string, width = 140): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > width) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function makePdf(text: string, pages = 1): Buffer {
  const shows = wrapLines(text)
    .map((l) => `(${l.replace(/[\\()]/g, '\\$&')}) Tj T*`)
    .join(' ');
  return buildPdf(pdfObjects(Array.from({ length: pages }, () => `BT /F1 12 Tf 14 TL 40 740 Td ${shows} ET`)));
}

export function makeScannedPdf(): Buffer {
  return buildPdf(pdfObjects(['0.5 g 10 10 100 100 re f']));
}

export function makeEncryptedPdf(): Buffer {
  const hex = (c: string) => c.repeat(64);
  const enc = `<< /Filter /Standard /V 1 /R 2 /O <${hex('a')}> /U <${hex('b')}> /P -4 >>`;
  const objs = pdfObjects(['BT /F1 12 Tf 20 100 Td (secret secret secret) Tj ET']);
  objs.push(enc);
  return buildPdf(objs, ` /Encrypt ${objs.length} 0 R /ID [<${'c'.repeat(32)}> <${'c'.repeat(32)}>]`);
}
