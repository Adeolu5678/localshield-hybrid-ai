import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { InlineAttachment } from '../types/analysis';

export type IngestedFileKind = 'text' | 'pdf' | 'docx' | 'image';

export type IngestedFormatLabel =
  | 'PDF'
  | 'DOCX'
  | 'TXT'
  | 'MD'
  | 'POLICY'
  | 'CONTRACT'
  | 'IMAGE';

export interface IngestedDocumentMeta {
  fileName: string;
  extension: string;
  format: IngestedFormatLabel;
  sizeBytes: number;
  pageCount?: number;
  charCount?: number;
}

export interface IngestedFileResult {
  kind: IngestedFileKind;
  meta: IngestedDocumentMeta;
  text?: string;
  originalBuffer?: ArrayBuffer;
  attachment?: InlineAttachment;
}

export const ACCEPTED_FILE_EXTENSIONS =
  '.pdf,.docx,.txt,.md,.policy,.contract,.png,.jpg,.jpeg,.webp';

const TEXT_EXTENSIONS: Record<string, IngestedFormatLabel> = {
  txt: 'TXT',
  md: 'MD',
  policy: 'POLICY',
  contract: 'CONTRACT'
};

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
};

function getFileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx === -1 || idx === fileName.length - 1) return '';
  return fileName.slice(idx + 1).toLowerCase();
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer();
  }
  return new Response(file).arrayBuffer();
}

async function readFileAsText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }
  const buffer = await readFileAsArrayBuffer(file);
  return new TextDecoder('utf-8').decode(buffer);
}

async function extractPdfTextLocally(
  arrayBuffer: ArrayBuffer
): Promise<{ text: string; pageCount: number }> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer)
  });
  const pdf = await loadingTask.promise;
  const pageTexts: string[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    let pageText = '';
    for (const item of content.items) {
      if (!('str' in item) || typeof item.str !== 'string') continue;
      const str = item.str;
      if (str.length === 0) continue;
      pageText += str;
      pageText += 'hasEOL' in item && item.hasEOL ? '\n' : ' ';
    }
    pageTexts.push(pageText.replace(/[ \t]{2,}/g, ' ').trim());
  }

  return {
    text: pageTexts.filter(Boolean).join('\n\n'),
    pageCount: pdf.numPages
  };
}

async function extractDocxTextLocally(
  arrayBuffer: ArrayBuffer
): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.replace(/\r\n/g, '\n').trim();
}

/**
 * 100% client-side document & image ingestor. Zero bytes leave the browser.
 * Supports .pdf, .docx, .txt, .md, .policy, .contract, and scanned images
 * (.png, .jpg, .jpeg, .webp) converted to InlineAttachment objects.
 */
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

export async function ingestUploadedFile(
  file: File
): Promise<IngestedFileResult> {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File "${file.name}" exceeds the 25 MB client-side limit (${(file.size / (1024 * 1024)).toFixed(1)} MB).`
    );
  }
  const ext = getFileExtension(file.name);
  const mime = (file.type || '').toLowerCase();

  // 1. Scanned images / screenshots -> InlineAttachment
  if (ext in IMAGE_MIME_BY_EXT || mime.startsWith('image/')) {
    const resolvedMime =
      IMAGE_MIME_BY_EXT[ext] ??
      (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp'
        ? mime
        : '');

    if (!resolvedMime) {
      throw new Error(
        `Unsupported image format "${file.name}". Allowed image types: .png, .jpg, .jpeg, .webp.`
      );
    }

    const buffer = await readFileAsArrayBuffer(file);
    const base64Data = arrayBufferToBase64(buffer);

    return {
      kind: 'image',
      meta: {
        fileName: file.name,
        extension: ext || 'png',
        format: 'IMAGE',
        sizeBytes: file.size
      },
      attachment: {
        mimeType: resolvedMime,
        data: base64Data,
        name: file.name
      }
    };
  }

  // 2. PDF -> local pdfjs-dist extraction with bundled worker
  if (ext === 'pdf' || mime === 'application/pdf') {
    const buffer = await readFileAsArrayBuffer(file);
    const { text, pageCount } = await extractPdfTextLocally(buffer);
    if (text.trim().length === 0) {
      throw new Error(
        `No selectable text found in "${file.name}" (it may be a scanned/image-only PDF). Please upload a screenshot or image (.png/.jpg) for multimodal OCR.`
      );
    }
    return {
      kind: 'pdf',
      meta: {
        fileName: file.name,
        extension: ext || 'pdf',
        format: 'PDF',
        sizeBytes: file.size,
        pageCount,
        charCount: text.length
      },
      text,
      originalBuffer: buffer
    };
  }

  // 3. DOCX -> local mammoth extraction
  if (
    ext === 'docx' ||
    mime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const buffer = await readFileAsArrayBuffer(file);
    const text = await extractDocxTextLocally(buffer);
    return {
      kind: 'docx',
      meta: {
        fileName: file.name,
        extension: ext || 'docx',
        format: 'DOCX',
        sizeBytes: file.size,
        charCount: text.length
      },
      text,
      originalBuffer: buffer
    };
  }

  // 4. Plain text / markdown / policy / contract
  if (ext in TEXT_EXTENSIONS || mime.startsWith('text/')) {
    const format: IngestedFormatLabel = TEXT_EXTENSIONS[ext] ?? 'TXT';
    const raw = await readFileAsText(file);
    const text = raw.replace(/\r\n/g, '\n');
    return {
      kind: 'text',
      meta: {
        fileName: file.name,
        extension: ext || 'txt',
        format,
        sizeBytes: file.size,
        charCount: text.length
      },
      text
    };
  }

  throw new Error(
    `Unsupported file type "${file.name}". Supported formats: .pdf, .docx, .txt, .md, .policy, .contract, .png, .jpg, .jpeg, .webp.`
  );
}
