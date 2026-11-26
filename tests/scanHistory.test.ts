import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearScanHistory,
  deleteScanRecord,
  listScanRecords,
  MAX_HISTORY_RECORDS,
  saveScanRecord,
  type ScanHistoryRecord
} from '../src/lib/scanHistory';

function makeRecord(
  overrides: Partial<ScanHistoryRecord> & { id: string; savedAt: string }
): ScanHistoryRecord {
  return {
    title: 'Sample MSA Review',
    riskScore: 72,
    riskLabel: 'Elevated',
    routeLabel: 'ON-DEVICE',
    piiCount: 3,
    clauseCount: 1,
    redactedText: 'Agreement between [EMAIL_1] and Vendor Corp.',
    reportSummary: 'High liability cap asymmetry detected for [EMAIL_1].',
    clauses: [
      {
        id: 'clause-1',
        title: 'Unlimited Indemnification',
        category: 'Liability',
        severity: 'high',
        excerpt: 'Customer shall indemnify Vendor without cap.',
        rationale: 'Uncapped indemnity creates open-ended financial exposure.',
        redlineProposal: 'Cap total indemnification liability at 12 months fees.'
      }
    ],
    ...overrides
  };
}

describe('scanHistory (local-only redacted storage)', () => {
  beforeEach(async () => {
    await clearScanHistory();
  });

  it('saves records and lists them newest-first', async () => {
    await saveScanRecord(
      makeRecord({
        id: 'scan-old',
        title: 'Older NDA',
        savedAt: '2026-10-01T10:00:00.000Z',
        riskScore: 35,
        riskLabel: 'Moderate'
      })
    );
    await saveScanRecord(
      makeRecord({
        id: 'scan-newest',
        title: 'Newest DPA',
        savedAt: '2026-10-03T12:00:00.000Z',
        riskScore: 88,
        riskLabel: 'Critical'
      })
    );
    await saveScanRecord(
      makeRecord({
        id: 'scan-middle',
        title: 'Middle SaaS Terms',
        savedAt: '2026-10-02T11:00:00.000Z',
        riskScore: 60,
        riskLabel: 'Elevated'
      })
    );

    const listed = await listScanRecords();
    expect(listed.map((r) => r.id)).toEqual([
      'scan-newest',
      'scan-middle',
      'scan-old'
    ]);
    expect(listed[0].title).toBe('Newest DPA');
    expect(listed[0].riskScore).toBe(88);
  });

  it('enforces the maximum cap of 25 entries by evicting oldest records', async () => {
    const totalToInsert = MAX_HISTORY_RECORDS + 5;
    for (let i = 0; i < totalToInsert; i++) {
      const ts = new Date(Date.UTC(2026, 9, 1, 0, i, 0)).toISOString();
      await saveScanRecord(
        makeRecord({
          id: `scan-${i}`,
          title: `Scan #${i}`,
          savedAt: ts
        })
      );
    }

    const listed = await listScanRecords();
    expect(listed).toHaveLength(MAX_HISTORY_RECORDS);
    expect(listed[0].id).toBe(`scan-${totalToInsert - 1}`);
    expect(listed[listed.length - 1].id).toBe('scan-5');
    expect(listed.some((r) => r.id === 'scan-0')).toBe(false);
    expect(listed.some((r) => r.id === 'scan-4')).toBe(false);
  });

  it('deletes a single entry and clears all history cleanly', async () => {
    await saveScanRecord(
      makeRecord({ id: 'scan-a', savedAt: '2026-10-01T10:00:00.000Z' })
    );
    await saveScanRecord(
      makeRecord({ id: 'scan-b', savedAt: '2026-10-02T10:00:00.000Z' })
    );

    await deleteScanRecord('scan-a');
    let listed = await listScanRecords();
    expect(listed.map((r) => r.id)).toEqual(['scan-b']);

    await clearScanHistory();
    listed = await listScanRecords();
    expect(listed).toEqual([]);
  });

  it('never persists raw unredacted PII even if accidentally passed in', async () => {
    const rawEmail = 'founder@secret-startup.io';
    const rawSsn = '123-45-6789';
    const rawPhone = '+1 (415) 555-0199';

    const saved = await saveScanRecord(
      makeRecord({
        id: 'scan-pii-guard',
        title: `Contract for ${rawEmail}`,
        savedAt: '2026-10-05T15:00:00.000Z',
        redactedText: `Signer ${rawEmail}, SSN ${rawSsn}, phone ${rawPhone}.`,
        reportSummary: `Contact ${rawEmail} exposed SSN ${rawSsn}.`,
        clauses: [
          {
            id: 'c1',
            title: `Notice to ${rawEmail}`,
            category: 'Privacy',
            severity: 'critical',
            excerpt: `Send notices to ${rawEmail} or ${rawPhone}`,
            rationale: `Contains raw SSN ${rawSsn}`,
            redlineProposal: `Remove ${rawSsn} from public schedules.`
          }
        ]
      })
    );

    const listed = await listScanRecords();
    const persisted = JSON.stringify(listed);

    expect(saved.id).toBe('scan-pii-guard');
    expect(persisted).not.toContain(rawEmail);
    expect(persisted).not.toContain(rawSsn);
    expect(persisted).not.toContain(rawPhone);
    expect(persisted).toContain('[EMAIL_1]');
    expect(persisted).toContain('[SSN_1]');
  });
});
