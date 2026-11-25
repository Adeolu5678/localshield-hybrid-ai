import { describe, expect, it } from 'vitest';
import {
  estimateTokenCount,
  redactSensitiveData,
  restoreFromVault
} from '../src/lib/piiRedactor';

describe('redactSensitiveData', () => {
  it('masks emails, phones, SSNs, cards, IBANs, IPv4, API secrets, and addresses deterministically', () => {
    const sample = [
      'Contact jordan.vance@acmerobotics.io or +1 (512) 555-0194.',
      'SSN: 123-45-6789 | Card: 4532-8910-4412-9081 | IBAN: DE89370400440532013000.',
      'Server IP: 192.168.14.88 | Secret: sk-live-9f8a7b6c5d4e3f2a1b0c9d8e.',
      'Office: 742 Evergreen Terrace Street'
    ].join('\n');

    const result = redactSensitiveData(sample);

    expect(result.redactedText).not.toContain('jordan.vance@acmerobotics.io');
    expect(result.redactedText).not.toContain('123-45-6789');
    expect(result.redactedText).not.toContain('4532-8910-4412-9081');
    expect(result.redactedText).not.toContain('DE89370400440532013000');
    expect(result.redactedText).not.toContain('192.168.14.88');
    expect(result.redactedText).not.toContain('sk-live-9f8a7b6c5d4e3f2a1b0c9d8e');
    expect(result.redactedText).not.toContain('742 Evergreen Terrace Street');

    expect(result.redactedText).toContain('[EMAIL_1]');
    expect(result.redactedText).toContain('[PHONE_1]');
    expect(result.redactedText).toContain('[SSN_1]');
    expect(result.redactedText).toContain('[CARD_1]');
    expect(result.redactedText).toContain('[IBAN_1]');
    expect(result.redactedText).toContain('[IPV4_1]');
    expect(result.redactedText).toContain('[API_SECRET_1]');
    expect(result.redactedText).toContain('[ADDRESS_1]');
    expect(result.totalMasked).toBe(8);
  });

  it('reuses the same token for repeated identical PII values and restores cleanly via vault', () => {
    const sample =
      'Primary: alice@example.com; Backup: alice@example.com; Secondary: bob@example.com.';
    const result = redactSensitiveData(sample);

    expect(result.countsByCategory.EMAIL).toBe(2);
    expect(result.totalMasked).toBe(3);
    expect(result.redactedText).toBe(
      'Primary: [EMAIL_1]; Backup: [EMAIL_1]; Secondary: [EMAIL_2].'
    );
    expect(restoreFromVault(result.redactedText, result.vault)).toBe(sample);
  });

  it('estimates token count deterministically', () => {
    expect(estimateTokenCount('')).toBe(0);
    expect(estimateTokenCount('abcd')).toBe(1);
    expect(estimateTokenCount('abcdefgh')).toBe(2);
  });
});
