import { describe, expect, it } from 'vitest';
import { redactDocument, restoreFromVault } from '../src/lib/piiRedactor';
import {
  compileRedlinedDocument,
  computeWordDiff
} from '../src/lib/redlineDiff';
import type { RiskClause } from '../src/types/analysis';

describe('redlineDiff', () => {
  it('computes deterministic word-level diff segments with equal, delete, and insert', () => {
    const original =
      'Vendor liability shall not exceed $500 under any circumstances.';
    const revised =
      'Vendor liability shall not exceed 12 months of fees under this agreement.';

    const segments = computeWordDiff(original, revised);

    expect(segments.some((s) => s.kind === 'equal')).toBe(true);
    expect(segments.some((s) => s.kind === 'delete' && s.text.includes('$500'))).toBe(
      true
    );
    expect(
      segments.some((s) => s.kind === 'insert' && s.text.includes('12 months'))
    ).toBe(true);

    const reconstructedOriginal = segments
      .filter((s) => s.kind !== 'insert')
      .map((s) => s.text)
      .join('');
    const reconstructedRevised = segments
      .filter((s) => s.kind !== 'delete')
      .map((s) => s.text)
      .join('');

    expect(reconstructedOriginal).toBe(original);
    expect(reconstructedRevised).toBe(revised);
  });

  it('compiles accepted, custom-edited, rejected, and pending clause redlines accurately', () => {
    const source = [
      '1. Liability. Vendor liability is capped at $100.',
      '2. AI Training. Vendor may train AI models on all Customer Data.',
      '3. Renewal. Agreement auto-renews for 36 months.'
    ].join('\n');

    const clauses: RiskClause[] = [
      {
        id: 'c1',
        title: 'Liability Cap',
        category: 'Liability',
        severity: 'critical',
        excerpt: 'Vendor liability is capped at $100.',
        rationale: 'Too low.',
        redlineProposal: 'Vendor liability is capped at 12 months of fees.'
      },
      {
        id: 'c2',
        title: 'AI Training Rights',
        category: 'AI / Data',
        severity: 'high',
        excerpt: 'Vendor may train AI models on all Customer Data.',
        rationale: 'Exposes confidential data.',
        redlineProposal: 'Vendor shall not train AI models on Customer Data.'
      },
      {
        id: 'c3',
        title: 'Auto-Renewal',
        category: 'Renewal',
        severity: 'medium',
        excerpt: 'Agreement auto-renews for 36 months.',
        rationale: 'Long lock-in.',
        redlineProposal: 'Agreement renews only upon mutual written consent.'
      }
    ];

    const compiled = compileRedlinedDocument(source, clauses, {
      c1: { status: 'accepted' },
      c2: {
        status: 'accepted',
        customRedline: 'Vendor is strictly prohibited from training any ML models on Customer Data.'
      },
      c3: { status: 'rejected' }
    });

    expect(compiled.appliedCount).toBe(2);
    expect(compiled.rejectedCount).toBe(1);
    expect(compiled.pendingCount).toBe(0);
    expect(compiled.appliedClauseIds).toEqual(['c1', 'c2']);
    expect(compiled.unmatchedClauseIds).toEqual([]);
    expect(compiled.compiledText).toContain(
      'Vendor liability is capped at 12 months of fees.'
    );
    expect(compiled.compiledText).toContain(
      'Vendor is strictly prohibited from training any ML models on Customer Data.'
    );
    // Rejected clause remains untouched
    expect(compiled.compiledText).toContain(
      'Agreement auto-renews for 36 months.'
    );
  });

  it('supports local-only restoreFromVault() round-trip on compiled redlined exports', () => {
    const rawDoc =
      'Notice for Project Helios shall be sent to legal@acme.com. Vendor liability is capped at $100.';
    const redaction = redactDocument(rawDoc, {
      customTerms: ['Project Helios']
    });

    expect(redaction.redactedText).toContain('[CUSTOM_1]');
    expect(redaction.redactedText).toContain('[EMAIL_1]');
    expect(redaction.redactedText).not.toContain('Project Helios');
    expect(redaction.redactedText).not.toContain('legal@acme.com');

    const clauses: RiskClause[] = [
      {
        id: 'c1',
        title: 'Liability Cap',
        category: 'Liability',
        severity: 'critical',
        excerpt: 'Vendor liability is capped at $100.',
        rationale: 'Insufficient cap.',
        redlineProposal: 'Vendor liability is capped at 12 months of fees.'
      }
    ];

    const compiled = compileRedlinedDocument(redaction.redactedText, clauses, {
      c1: { status: 'accepted' }
    });

    expect(compiled.compiledText).toContain('[CUSTOM_1]');
    expect(compiled.compiledText).toContain(
      'Vendor liability is capped at 12 months of fees.'
    );

    const restored = restoreFromVault(compiled.compiledText, redaction.vault);
    expect(restored).toBe(
      'Notice for Project Helios shall be sent to legal@acme.com. Vendor liability is capped at 12 months of fees.'
    );
  });
});
