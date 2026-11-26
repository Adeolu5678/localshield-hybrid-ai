import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface TextReplacement {
  original: string;
  replacement: string;
}

export interface ExportEditedDocumentOptions {
  originalFilename?: string;
  originalBuffer?: ArrayBuffer;
  compiledText: string;
  replacements: TextReplacement[];
}

export interface ExportedDocumentResult {
  blob: Blob;
  filename: string;
  mimeType: string;
}

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';

function extractExtension(filename?: string): string {
  if (!filename) return '';
  const trimmed = filename.trim();
  const dotIdx = trimmed.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === trimmed.length - 1) return '';
  return trimmed.slice(dotIdx + 1).toLowerCase();
}

export function buildEditedFilename(
  originalFilename?: string,
  fallbackExt = 'md'
): string {
  const cleanExt = fallbackExt.replace(/^\./, '').toLowerCase() || 'md';
  if (!originalFilename || !originalFilename.trim()) {
    return `LegalEase Contract - Edited.${cleanExt}`;
  }

  const trimmed = originalFilename.trim();
  const dotIdx = trimmed.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === trimmed.length - 1) {
    return `${trimmed} - Edited.${cleanExt}`;
  }

  const baseName = trimmed.slice(0, dotIdx);
  const ext = trimmed.slice(dotIdx + 1).toLowerCase();
  return `${baseName} - Edited.${ext}`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildDocxParagraphXml(text: string): string {
  const escaped = escapeXml(text);
  return `<w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`;
}

async function exportDocx(
  originalBuffer: ArrayBuffer,
  replacements: TextReplacement[]
): Promise<Blob> {
  const zip = await JSZip.loadAsync(originalBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('Invalid .docx archive: missing word/document.xml');
  }

  let xml = await docFile.async('string');
  const unreplaced: TextReplacement[] = [];

  for (const item of replacements) {
    if (!item.original || !item.replacement) continue;
    const escapedOriginal = escapeXml(item.original);
    const escapedReplacement = escapeXml(item.replacement);

    if (xml.includes(escapedOriginal)) {
      xml = xml.split(escapedOriginal).join(escapedReplacement);
    } else {
      unreplaced.push(item);
    }
  }

  if (unreplaced.length > 0) {
    const addendumParagraphs = [
      buildDocxParagraphXml(''),
      buildDocxParagraphXml('--- LegalEase Accepted Redlines ---'),
      ...unreplaced.map((item) =>
        buildDocxParagraphXml(`[Accepted Revision]: ${item.replacement}`)
      )
    ].join('');

    const sectPrIdx = xml.lastIndexOf('<w:sectPr');
    if (sectPrIdx !== -1) {
      xml =
        xml.slice(0, sectPrIdx) +
        addendumParagraphs +
        xml.slice(sectPrIdx);
    } else {
      const bodyEndIdx = xml.lastIndexOf('</w:body>');
      if (bodyEndIdx !== -1) {
        xml =
          xml.slice(0, bodyEndIdx) +
          addendumParagraphs +
          xml.slice(bodyEndIdx);
      }
    }
  }

  zip.file('word/document.xml', xml);
  return zip.generateAsync({
    type: 'blob',
    mimeType: DOCX_MIME
  });
}

function wrapLine(
  line: string,
  maxWidth: number,
  measureWidth: (text: string) => number
): string[] {
  if (line.length === 0) return [''];
  const words = line.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureWidth(candidate) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function exportPdf(compiledText: string): Promise<Blob> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 50;
  const fontSize = 10.5;
  const lineHeight = 14;
  const maxWidth = pageWidth - margin * 2;

  const rawLines = compiledText.replace(/\r\n/g, '\n').split('\n');
  const wrappedLines: string[] = [];
  for (const rawLine of rawLines) {
    const safeLine = rawLine.replace(/[^\x20-\x7E]/g, ' ');
    wrappedLines.push(
      ...wrapLine(safeLine, maxWidth, (t) => font.widthOfTextAtSize(t, fontSize))
    );
  }

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  for (const line of wrappedLines) {
    if (y < margin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
    if (line.length > 0) {
      page.drawText(line, {
        x: margin,
        y,
        size: fontSize,
        font,
        color: rgb(0.1, 0.1, 0.1)
      });
    }
    y -= lineHeight;
  }

  const pdfBytes = await pdfDoc.save();
  return new Blob([new Uint8Array(pdfBytes)], { type: PDF_MIME });
}

export async function exportEditedDocument(
  options: ExportEditedDocumentOptions
): Promise<ExportedDocumentResult> {
  const ext = extractExtension(options.originalFilename) || 'md';
  const filename = buildEditedFilename(options.originalFilename, ext);

  if (ext === 'docx' && options.originalBuffer) {
    const blob = await exportDocx(
      options.originalBuffer,
      options.replacements
    );
    return {
      blob,
      filename,
      mimeType: DOCX_MIME
    };
  }

  if (ext === 'pdf') {
    const blob = await exportPdf(options.compiledText);
    return {
      blob,
      filename,
      mimeType: PDF_MIME
    };
  }

  const mimeType =
    ext === 'md'
      ? 'text/markdown;charset=utf-8'
      : 'text/plain;charset=utf-8';
  const blob = new Blob([options.compiledText], { type: mimeType });
  return {
    blob,
    filename,
    mimeType
  };
}
