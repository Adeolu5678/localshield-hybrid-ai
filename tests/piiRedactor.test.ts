import { describe, expect, it } from 'vitest';
import {
  estimateTokenCount,
  isValidLuhn,
  mergeSemanticRedactions,
  redactDocument,
  redactSensitiveData,
  restoreFromVault
} from '../src/lib/piiRedactor';

describe('redactSensitiveData', () => {
  it('masks emails, phones, SSNs, Luhn-valid cards, IBANs, IPv4, API secrets, and full addresses deterministically', () => {
    const sample = [
      'Contact jordan.vance@acmerobotics.io or +1 (512) 555-0194.',
      'SSN: 123-45-6789 | Card: 4532-8910-4412-9089 | IBAN: DE89370400440532013000.',
      'Server IP: 192.168.14.88 | Secret: sk-live-9f8a7b6c5d4e3f2a1b0c9d8e.',
      'Office: 742 Evergreen Terrace, Suite 400, Austin, TX 78701'
    ].join('\n');

    const result = redactSensitiveData(sample);

    expect(result.redactedText).not.toContain('jordan.vance@acmerobotics.io');
    expect(result.redactedText).not.toContain('123-45-6789');
    expect(result.redactedText).not.toContain('4532-8910-4412-9089');
    expect(result.redactedText).not.toContain('DE89370400440532013000');
    expect(result.redactedText).not.toContain('192.168.14.88');
    expect(result.redactedText).not.toContain('sk-live-9f8a7b6c5d4e3f2a1b0c9d8e');
    expect(result.redactedText).not.toContain('742 Evergreen Terrace');
    expect(result.redactedText).not.toContain('Suite 400');
    expect(result.redactedText).not.toContain('Austin, TX 78701');

    expect(result.redactedText).toContain('[EMAIL_1]');
    expect(result.redactedText).toContain('[PHONE_1]');
    expect(result.redactedText).toContain('[SSN_1]');
    expect(result.redactedText).toContain('[CARD_1]');
    expect(result.redactedText).toContain('[IBAN_1]');
    expect(result.redactedText).toContain('[IPV4_1]');
    expect(result.redactedText).toContain('[API_SECRET_1]');
    expect(result.redactedText).toContain('[ADDRESS_1]');
    expect(result.totalMasked).toBe(8);
    expect(restoreFromVault(result.redactedText, result.vault)).toBe(sample);
  });

  it('validates cards with Luhn checksum and ignores non-card 16-digit IDs', () => {
    expect(isValidLuhn('4532-8910-4412-9089')).toBe(true);
    expect(isValidLuhn('4532-8910-4412-9081')).toBe(false);
    expect(isValidLuhn('1234-5678-9012-3456')).toBe(false);

    const sample =
      'Valid Card: 4532-8910-4412-9089 | Order ID: 1234-5678-9012-3456 | NonLuhn: 4532-8910-4412-9081.';
    const result = redactSensitiveData(sample);

    expect(result.countsByCategory.CARD).toBe(1);
    expect(result.redactedText).toContain('[CARD_1]');
    expect(result.redactedText).toContain('1234-5678-9012-3456');
    expect(result.redactedText).toContain('4532-8910-4412-9081');
  });

  it('masks international phones (+44, +234, +1) without false-positiving on plain 10-digit IDs or timestamps', () => {
    const sample = [
      'UK Desk: +44 20 7946 0958',
      'Lagos Office: +234 803 123 4567',
      'US Support: +1 (512) 555-0194',
      'Invoice ID: 9001234567 | Unix Timestamp: 1712345678'
    ].join('\n');

    const result = redactSensitiveData(sample);

    expect(result.countsByCategory.PHONE).toBe(3);
    expect(result.redactedText).toContain('[PHONE_1]');
    expect(result.redactedText).toContain('[PHONE_2]');
    expect(result.redactedText).toContain('[PHONE_3]');
    expect(result.redactedText).not.toContain('+44 20 7946 0958');
    expect(result.redactedText).not.toContain('+234 803 123 4567');
    expect(result.redactedText).not.toContain('+1 (512) 555-0194');
    expect(result.redactedText).toContain('9001234567');
    expect(result.redactedText).toContain('1712345678');
  });

  it('masks full US-style addresses with or without ZIP code without leaking city/state/suite', () => {
    const sample =
      'HQ: 742 Evergreen Terrace, Suite 400, Austin, TX and Mail: 1200 Market Street, San Francisco, CA 94103.';
    const result = redactSensitiveData(sample);

    expect(result.countsByCategory.ADDRESS).toBe(2);
    expect(result.redactedText).toBe('HQ: [ADDRESS_1] and Mail: [ADDRESS_2].');
    expect(restoreFromVault(result.redactedText, result.vault)).toBe(sample);
  });

  it('masks AWS keys, JWT tokens, and EINs accurately', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFjbWUifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const sample = `AWS: AKIAIOSFODNN7EXAMPLE | EIN: 12-3456789 | Auth: ${jwt}`;
    const result = redactSensitiveData(sample);

    expect(result.countsByCategory.AWS_KEY).toBe(1);
    expect(result.countsByCategory.EIN).toBe(1);
    expect(result.countsByCategory.JWT).toBe(1);
    expect(result.redactedText).toBe(
      'AWS: [AWS_KEY_1] | EIN: [EIN_1] | Auth: [JWT_1]'
    );
    expect(restoreFromVault(result.redactedText, result.vault)).toBe(sample);
  });

  it('masks user-defined custom confidential terms case-insensitively and restores them from vault', () => {
    const sample =
      'Project Titan will launch in Q4. project titan budget is confidential alongside HyperNova.';
    const result = redactDocument(sample, {
      customTerms: ['Project Titan', 'HyperNova']
    });

    expect(result.countsByCategory.CUSTOM).toBe(2);
    expect(result.totalMasked).toBe(3);
    expect(result.redactedText).toBe(
      '[CUSTOM_1] will launch in Q4. [CUSTOM_1] budget is confidential alongside [CUSTOM_2].'
    );
    expect(result.vault['[CUSTOM_1]']).toBe('Project Titan');
    expect(result.vault['[CUSTOM_2]']).toBe('HyperNova');
    expect(restoreFromVault(result.redactedText, result.vault)).toBe(
      'Project Titan will launch in Q4. Project Titan budget is confidential alongside HyperNova.'
    );
  });

  it('merges Stage 0.5 semantic PII entities into the vault with consistent tokens and full restoreFromVault compatibility', () => {
    const sample =
      'Agreement between Acme Robotics Inc. and Jordan Vance regarding Project Helios (email: jordan@acme.io). Jordan Vance signed for Acme Robotics Inc.';
    const stage0 = redactSensitiveData(sample);
    const { result, entitiesAdded } = mergeSemanticRedactions(stage0, [
      { value: 'Jordan Vance', category: 'PERSON' },
      { value: 'Acme Robotics Inc.', category: 'ORG' },
      { value: 'Project Helios', category: 'CODENAME' }
    ]);

    expect(entitiesAdded).toBe(3);
    expect(result.countsByCategory.EMAIL).toBe(1);
    expect(result.countsByCategory.PERSON).toBe(1);
    expect(result.countsByCategory.ORG).toBe(1);
    expect(result.countsByCategory.CODENAME).toBe(1);
    expect(result.redactedText).not.toContain('Jordan Vance');
    expect(result.redactedText).not.toContain('Acme Robotics Inc.');
    expect(result.redactedText).not.toContain('Project Helios');
    expect(result.redactedText).toContain('[PERSON_1]');
    expect(result.redactedText).toContain('[ORG_1]');
    expect(result.redactedText).toContain('[CODENAME_1]');
    expect(result.redactedText).toContain('[EMAIL_1]');
    expect(restoreFromVault(result.redactedText, result.vault)).toBe(sample);
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
