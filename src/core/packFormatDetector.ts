import JSZip from 'jszip';
import {
  detectTabularDelimiter,
  stripUtf8Bom,
  type TabularDelimiter,
} from './packCsvParser';

export type DetectedContentFormat =
  | 'json'
  | 'jsonl'
  | 'csv'
  | 'tsv'
  | 'html'
  | 'empty'
  | 'unknown';

export type PackContainerFormat = 'none' | 'gzip' | 'zip';

export interface PackErrorContext {
  packTitle: string;
  filePath: string;
  httpStatus?: number;
  detectedFormat?: string;
  reason: string;
}

export class PackLoadError extends Error {
  readonly packTitle: string;
  readonly filePath: string;
  readonly httpStatus?: number;
  readonly detectedFormat?: string;
  readonly reason: string;

  constructor(ctx: PackErrorContext) {
    super(formatPackError(ctx));
    this.name = 'PackLoadError';
    this.packTitle = ctx.packTitle;
    this.filePath = ctx.filePath;
    this.httpStatus = ctx.httpStatus;
    this.detectedFormat = ctx.detectedFormat;
    this.reason = ctx.reason;
  }
}

export function formatPackError(ctx: PackErrorContext): string {
  const parts: string[] = [`${ctx.packTitle} (${ctx.filePath})`];
  if (ctx.httpStatus !== undefined) {
    parts.push(`HTTP ${ctx.httpStatus}`);
  }
  if (ctx.detectedFormat) {
    parts.push(`detected ${ctx.detectedFormat}`);
  }
  return `${parts.join(' · ')}: ${ctx.reason}`;
}

export function formatDetectedLabel(format: DetectedContentFormat): string {
  switch (format) {
    case 'json':
      return 'JSON';
    case 'jsonl':
      return 'JSONL';
    case 'csv':
      return 'CSV';
    case 'tsv':
      return 'TSV';
    case 'html':
      return 'HTML';
    case 'empty':
      return 'Empty';
    default:
      return 'Unknown';
  }
}

export function inferExpectedFormatFromPath(
  filePath: string,
  declaredFormat?: string
): 'JSON' | 'JSONL' | 'CSV' | 'TSV' | null {
  const clean = (filePath || '').toLowerCase().split('?')[0];
  const withoutCompression = clean.replace(/\.(gz|zip)$/i, '');
  if (withoutCompression.endsWith('.jsonl') || withoutCompression.endsWith('.ndjson')) {
    return 'JSONL';
  }
  if (withoutCompression.endsWith('.json')) return 'JSON';
  if (withoutCompression.endsWith('.csv')) return 'CSV';
  if (withoutCompression.endsWith('.tsv')) return 'TSV';

  if (declaredFormat === 'json' || declaredFormat === 'json.gz' || declaredFormat === 'v2') {
    return 'JSON';
  }
  if (declaredFormat === 'csv') return 'CSV';
  if (declaredFormat === 'tsv') return 'TSV';
  return null;
}

export function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function isZipBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}

export async function decompressGzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Gzip decompression (DecompressionStream) is not supported in this environment.');
  }
  const sliced = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([sliced]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

export async function decompressGzipBytesToText(bytes: Uint8Array): Promise<string> {
  const raw = await decompressGzipBytes(bytes);
  return stripUtf8BomBytesAndDecode(raw);
}

export function stripUtf8BomBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3);
  }
  return bytes;
}

export function stripUtf8BomBytesAndDecode(bytes: Uint8Array): string {
  const stripped = stripUtf8BomBytes(bytes);
  return stripUtf8Bom(new TextDecoder('utf-8').decode(stripped));
}

function getFirstNonEmptyLines(text: string, count = 4): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < text.length && lines.length < count) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, '').trim();
    if (line.length > 0) {
      lines.push(line);
    }
    start = end + 1;
  }
  return lines;
}

export function looksLikeHtmlContent(trimmedText: string): boolean {
  if (!trimmedText.startsWith('<')) return false;
  const head = trimmedText.slice(0, 4096).toLowerCase();
  if (
    /^<!doctype\s+html\b/.test(head) ||
    /^<html[\s>]/.test(head) ||
    /^<head[\s>]/.test(head) ||
    /^<body[\s>]/.test(head) ||
    /^<title[\s>]/.test(head) ||
    /^<meta[\s>]/.test(head)
  ) {
    return true;
  }
  return /<\/(?:html|head|body|title|script|div)\s*>/.test(head);
}

export function detectTextContentFormat(rawText: string): {
  format: DetectedContentFormat;
  delimiter?: TabularDelimiter;
} {
  const clean = stripUtf8Bom(rawText);
  const trimmed = clean.trim();
  if (!trimmed) {
    return { format: 'empty' };
  }

  // 1. HTML (SPA fallback page for missing file)
  if (looksLikeHtmlContent(trimmed)) {
    return { format: 'html' };
  }

  // 2. JSON or JSONL
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const firstLines = getFirstNonEmptyLines(trimmed, 3);
    if (trimmed.startsWith('{') && firstLines.length >= 2) {
      const l1 = firstLines[0];
      const l2 = firstLines[1];
      if (l1.endsWith('}') && (l2.startsWith('{') || l2.startsWith('['))) {
        try {
          const p1 = JSON.parse(l1);
          const p2 = JSON.parse(l2);
          if (p1 && typeof p1 === 'object' && p2 && typeof p2 === 'object') {
            return { format: 'jsonl' };
          }
        } catch {
          // Not JSONL lines; treat as JSON
        }
      }
    }
    return { format: 'json' };
  }

  // 3. Delimited CSV/TSV based on first line delimiters (comma, tab, semicolon)
  const firstLines = getFirstNonEmptyLines(trimmed, 5);
  const firstLine = firstLines[0] || '';
  if (firstLine.includes(',') || firstLine.includes('\t') || firstLine.includes(';')) {
    const delim = detectTabularDelimiter(trimmed);
    return {
      format: delim === '\t' ? 'tsv' : 'csv',
      delimiter: delim,
    };
  }

  // 4. Multi-line single-column text/CSV (e.g. `word\nの\nに\n勉強`)
  if (firstLines.length >= 2 && !trimmed.includes('\u0000')) {
    return { format: 'csv', delimiter: ',' };
  }

  return { format: 'unknown' };
}

export interface ContentDetectionResult {
  format: DetectedContentFormat;
  detectedLabel: string;
  container: PackContainerFormat;
  innerFileName?: string;
  text: string;
  sizeBytes: number;
  delimiter?: TabularDelimiter;
  mismatchWarning?: string;
}

function getShortFileName(filePath: string): string {
  const clean = (filePath || '').split('?')[0];
  return clean.split('/').pop() || clean || 'pack';
}

export async function detectAndDecodePackContent(
  data: Uint8Array | ArrayBuffer | string,
  opts: {
    packTitle: string;
    filePath: string;
    httpStatus?: number;
    declaredFormat?: string;
  }
): Promise<ContentDetectionResult> {
  let container: PackContainerFormat = 'none';
  let innerFileName: string | undefined;
  let sizeBytes = 0;
  let text = '';

  if (typeof data === 'string') {
    text = stripUtf8Bom(data);
    sizeBytes = new TextEncoder().encode(data).byteLength;
  } else {
    let bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    sizeBytes = bytes.byteLength;

    // 1. Gzip magic bytes (1f 8b)
    if (isGzipBytes(bytes)) {
      container = 'gzip';
      try {
        bytes = await decompressGzipBytes(bytes);
      } catch (err: any) {
        throw new PackLoadError({
          packTitle: opts.packTitle,
          filePath: opts.filePath,
          httpStatus: opts.httpStatus,
          detectedFormat: 'GZIP',
          reason: err?.message || 'Failed to decompress gzip data.',
        });
      }
    }

    // 2. Zip magic bytes (PK)
    if (isZipBytes(bytes)) {
      container = 'zip';
      let zip: JSZip;
      try {
        zip = await JSZip.loadAsync(bytes);
      } catch (err: any) {
        throw new PackLoadError({
          packTitle: opts.packTitle,
          filePath: opts.filePath,
          httpStatus: opts.httpStatus,
          detectedFormat: 'ZIP',
          reason: err?.message || 'Invalid ZIP archive.',
        });
      }

      const entries = Object.values(zip.files).filter((f) => {
        if (f.dir) return false;
        const base = f.name.split('/').pop() || '';
        if (f.name.startsWith('__MACOSX/') || base.startsWith('._') || !base) return false;
        return true;
      });

      if (entries.length === 0) {
        throw new PackLoadError({
          packTitle: opts.packTitle,
          filePath: opts.filePath,
          httpStatus: opts.httpStatus,
          detectedFormat: 'ZIP (empty)',
          reason: 'ZIP archive contains no data files.',
        });
      }

      const dataEntries =
        entries.length === 1
          ? entries
          : entries.filter((e) => /\.(json|jsonl|ndjson|csv|tsv|txt|gz)$/i.test(e.name));
      const targetEntry = dataEntries[0] || entries[0];
      innerFileName = targetEntry.name;

      let innerBytes = await targetEntry.async('uint8array');
      if (isGzipBytes(innerBytes)) {
        innerBytes = await decompressGzipBytes(innerBytes);
      }
      text = stripUtf8BomBytesAndDecode(innerBytes);
    } else {
      text = stripUtf8BomBytesAndDecode(bytes);
    }
  }

  const { format, delimiter } = detectTextContentFormat(text);
  const detectedLabel = formatDetectedLabel(format);

  if (format === 'html') {
    throw new PackLoadError({
      packTitle: opts.packTitle,
      filePath: opts.filePath,
      httpStatus: opts.httpStatus,
      detectedFormat: 'HTML',
      reason: `File not found on server: ${opts.filePath}`,
    });
  }

  if (format === 'empty') {
    throw new PackLoadError({
      packTitle: opts.packTitle,
      filePath: opts.filePath,
      httpStatus: opts.httpStatus,
      detectedFormat: 'Empty',
      reason: 'Pack file is empty.',
    });
  }

  const expectedLabel = inferExpectedFormatFromPath(
    innerFileName || opts.filePath,
    opts.declaredFormat
  );
  let mismatchWarning: string | undefined;
  if (expectedLabel && detectedLabel !== 'Unknown') {
    const isCompatibleJsonl = expectedLabel === 'JSON' && format === 'jsonl';
    if (!isCompatibleJsonl && expectedLabel !== detectedLabel) {
      mismatchWarning = `${opts.packTitle} (${getShortFileName(
        opts.filePath
      )}): detected ${detectedLabel}, expected ${expectedLabel}`;
    }
  }

  return {
    format,
    detectedLabel,
    container,
    innerFileName,
    text,
    sizeBytes,
    delimiter,
    mismatchWarning,
  };
}
