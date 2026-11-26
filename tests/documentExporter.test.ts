import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  buildEditedFilename,
  exportEditedDocument
} from '../src/lib/documentExporter';

describe('documentExporter', () => {
  it('builds edited filenames preserving original extension or falling back to .md', () => {
    expect(buildEditedFilename('Vendor MSA.docx')).toBe(
      'Vendor MSA - Edited.docx'
    );
    expect(buildEditedFilename('Privacy.policy')).toBe(
      'Privacy - Edited.policy'
    );
    expect(buildEditedFilename(undefined)).toBe(
      'LegalEase Contract - Edited.md'
    );
    expect(buildEditedFilename('')).toBe('LegalEase Contract - Edited.md');
  });

  it('exports .txt preserving text/plain mimeType and filename', async () => {
    const result = await exportEditedDocument({
      originalFilename: 'Service Terms.txt',
      compiledText: 'Updated liability cap is 12 months of fees.',
      replacements: []
    });

    expect(result.filename).toBe('Service Terms - Edited.txt');
    expect(result.mimeType).toBe('text/plain;charset=utf-8');
    expect(await result.blob.text()).toBe(
      'Updated liability cap is 12 months of fees.'
    );
  });

  it('patches word/document.xml inside a .docx archive and appends unreplaced addenda', async () => {
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body><w:p><w:r><w:t>Vendor liability is unlimited.</w:t></w:r></w:p><w:sectPr/></w:body>' +
        '</w:document>'
    );
    const originalBuffer = await zip.generateAsync({ type: 'arraybuffer' });

    const result = await exportEditedDocument({
      originalFilename: 'Vendor MSA.docx',
      originalBuffer,
      compiledText: 'Vendor liability is capped at 12 months.',
      replacements: [
        {
          original: 'Vendor liability is unlimited.',
          replacement: 'Vendor liability is capped at 12 months.'
        },
        {
          original: 'Non-existent clause in XML',
          replacement: 'Mutual indemnification applies.'
        }
      ]
    });

    expect(result.filename).toBe('Vendor MSA - Edited.docx');
    expect(result.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    const outZip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const patchedXml = await outZip.file('word/document.xml')?.async('string');
    expect(patchedXml).toBeDefined();
    expect(patchedXml).toContain('Vendor liability is capped at 12 months.');
    expect(patchedXml).not.toContain('Vendor liability is unlimited.');
    expect(patchedXml).toContain('Mutual indemnification applies.');
  });

  it('generates a real PDF starting with %PDF-', async () => {
    const result = await exportEditedDocument({
      originalFilename: 'NDA.pdf',
      compiledText: 'Section 1. Confidentiality\n\nMutual NDA terms apply.',
      replacements: []
    });

    expect(result.filename).toBe('NDA - Edited.pdf');
    expect(result.mimeType).toBe('application/pdf');
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const header = new TextDecoder('ascii').decode(bytes.slice(0, 5));
    expect(header).toBe('%PDF-');
  });
});
