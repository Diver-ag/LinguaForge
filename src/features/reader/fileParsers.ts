import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist';

// Configure pdfjs worker if in browser
if (typeof window !== 'undefined' && 'Worker' in window) {
  // Use cloudflare or unpkg cdn for worker or inline fallback
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
  } catch {
    // ignore
  }
}

export interface ParsedDocumentResult {
  title: string;
  content: string;
  rawType: 'txt' | 'epub' | 'srt' | 'vtt' | 'pdf' | 'paste';
  chapters?: { title: string; content: string }[];
}

export async function parseUploadedFile(file: File): Promise<ParsedDocumentResult> {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const baseTitle = file.name.replace(/\.[^/.]+$/, '');

  switch (extension) {
    case 'txt': {
      const text = await file.text();
      return {
        title: baseTitle,
        content: text,
        rawType: 'txt',
      };
    }

    case 'srt': {
      const text = await file.text();
      const content = parseSrtOrVtt(text);
      return {
        title: baseTitle,
        content,
        rawType: 'srt',
      };
    }

    case 'vtt': {
      const text = await file.text();
      const content = parseSrtOrVtt(text);
      return {
        title: baseTitle,
        content,
        rawType: 'vtt',
      };
    }

    case 'epub': {
      const arrayBuffer = await file.arrayBuffer();
      return await parseEpub(arrayBuffer, baseTitle);
    }

    case 'pdf': {
      const arrayBuffer = await file.arrayBuffer();
      return await parsePdf(arrayBuffer, baseTitle);
    }

    default: {
      const text = await file.text();
      return {
        title: baseTitle,
        content: text,
        rawType: 'txt',
      };
    }
  }
}

function parseSrtOrVtt(raw: string): string {
  // Remove WEBVTT header and metadata lines
  const lines = raw.split(/\r?\n/);
  const dialogueLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip WEBVTT header, NOTE lines, numeric subtitle sequence IDs, and timestamp lines (00:00:01,000 --> 00:00:04,000)
    if (/^WEBVTT/i.test(trimmed) || /^NOTE/i.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (/^\d{2}:\d{2}/.test(trimmed) && trimmed.includes('-->')) continue;

    // Strip any HTML formatting tags like <i>, <b>, <c.japanese>
    const cleanLine = trimmed.replace(/<[^>]+>/g, '').trim();
    if (cleanLine) {
      dialogueLines.push(cleanLine);
    }
  }

  return dialogueLines.join('\n');
}

async function parseEpub(buffer: ArrayBuffer, defaultTitle: string): Promise<ParsedDocumentResult> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    let title = defaultTitle;
    const chapters: { title: string; content: string }[] = [];

    // 1. Find container.xml
    const containerXml = await zip.file('META-INF/container.xml')?.async('text');
    let opfPath = 'OEBPS/content.opf';
    if (containerXml) {
      const rootfileMatch = containerXml.match(/full-path=["']([^"']+)["']/i);
      if (rootfileMatch) {
        opfPath = rootfileMatch[1];
      }
    }

    // 2. Read OPF
    const opfFile = zip.file(opfPath);
    let opfContent = '';
    const basePath = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

    if (opfFile) {
      opfContent = await opfFile.async('text');
      const titleMatch = opfContent.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
      if (titleMatch) {
        title = titleMatch[1].trim();
      }
    }

    // 3. Extract XHTML / HTML files in zip
    const textFiles = Object.keys(zip.files).filter(
      (path) => (path.endsWith('.xhtml') || path.endsWith('.html') || path.endsWith('.htm')) && !path.includes('toc.')
    );

    // Sort to keep chapter order
    textFiles.sort();

    let fullText = '';
    for (const filePath of textFiles) {
      const fileData = await zip.file(filePath)?.async('text');
      if (fileData) {
        // Extract body content and remove XML/HTML tags
        const chapterTitleMatch = fileData.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/i) || fileData.match(/<title[^>]*>([^<]+)<\/title>/i);
        const chapterTitle = chapterTitleMatch ? chapterTitleMatch[1].trim() : `Chapter ${chapters.length + 1}`;

        // Simple HTML to text converter
        const textOnly = fileData
          .replace(/<head[\s\S]*?<\/head>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();

        if (textOnly.length > 20) {
          chapters.push({ title: chapterTitle, content: textOnly });
          fullText += `${chapterTitle}\n\n${textOnly}\n\n---\n\n`;
        }
      }
    }

    return {
      title,
      content: fullText.trim() || 'No text could be extracted from EPUB.',
      rawType: 'epub',
      chapters: chapters.length > 0 ? chapters : undefined,
    };
  } catch (err: any) {
    console.error('EPUB parse error:', err);
    return {
      title: defaultTitle,
      content: `Failed to parse EPUB file: ${err.message || String(err)}`,
      rawType: 'epub',
    };
  }
}

async function parsePdf(buffer: ArrayBuffer, defaultTitle: string): Promise<ParsedDocumentResult> {
  try {
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdf = await loadingTask.promise;
    let fullText = '';

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        // @ts-expect-error item has str property
        .map((item) => item.str || '')
        .join(' ');
      fullText += `${pageText}\n\n`;
    }

    return {
      title: defaultTitle,
      content: fullText.trim(),
      rawType: 'pdf',
    };
  } catch (err: any) {
    console.error('PDF parse error:', err);
    return {
      title: defaultTitle,
      content: `Could not parse PDF content: ${err.message || String(err)}`,
      rawType: 'pdf',
    };
  }
}
