import { describe, expect, it } from 'vitest';
import {
  arrayBufferToBase64,
  ingestUploadedFile
} from '../src/lib/documentIngestor';

describe('documentIngestor (100% offline)', () => {
  it('ingests plain text / markdown / policy / contract files with char count metadata', async () => {
    const content = 'Section 1. Confidentiality\r\nAll data remains private.';
    const file = new File([content], 'vendor-sla.contract', {
      type: 'text/plain'
    });

    const result = await ingestUploadedFile(file);

    expect(result.kind).toBe('text');
    expect(result.meta.fileName).toBe('vendor-sla.contract');
    expect(result.meta.format).toBe('CONTRACT');
    expect(result.text).toBe('Section 1. Confidentiality\nAll data remains private.');
    expect(result.meta.charCount).toBe(result.text?.length);
    expect(result.attachment).toBeUndefined();
  });

  it('converts image uploads (.png/.jpg/.webp) to base64 InlineAttachment objects', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = new File([bytes], 'scanned-page-1.png', {
      type: 'image/png'
    });

    const result = await ingestUploadedFile(file);

    expect(result.kind).toBe('image');
    expect(result.meta.format).toBe('IMAGE');
    expect(result.meta.fileName).toBe('scanned-page-1.png');
    expect(result.attachment).toEqual({
      mimeType: 'image/png',
      data: arrayBufferToBase64(bytes.buffer),
      name: 'scanned-page-1.png'
    });
    expect(result.text).toBeUndefined();
  });

  it('rejects unsupported file formats with a clear error message', async () => {
    const file = new File(['MZ\x90\x00'], 'archive.zip', {
      type: 'application/zip'
    });

    await expect(ingestUploadedFile(file)).rejects.toThrow(
      /Unsupported file type "archive\.zip"/
    );
  });
});
