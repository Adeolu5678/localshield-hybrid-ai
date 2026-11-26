import { describe, expect, it } from 'vitest';
import {
  analyzeDocumentHeuristically,
  parseStructuredAnalysis
} from '../src/lib/analysisParser';

describe('CUAD-style adversarial legal eval suite (offline)', () => {
  it('catches uncapped / asymmetric indemnification phrased euphemistically', () => {
    const clause =
      'Customer shall defend, indemnify, and hold harmless Provider and its affiliates from any third-party claims, losses, or expenses without limitation or cap, notwithstanding Section 9.';
    const res = analyzeDocumentHeuristically(clause);
    expect(res.clauses.length).toBeGreaterThan(0);
    expect(
      res.clauses.some((c) => /indemn|liability|cap/i.test(`${c.title} ${c.category} ${c.rationale}`))
    ).toBe(true);
  });

  it('catches irrevocable perpetual AI training license disguised as service improvement', () => {
    const clause =
      'Subscriber grants Vendor a perpetual, irrevocable, worldwide, royalty-free, sublicensable license to use, reproduce, and train machine learning models on Subscriber Data to improve Vendor services.';
    const res = analyzeDocumentHeuristically(clause);
    expect(res.clauses.length).toBeGreaterThan(0);
    expect(
      res.clauses.some((c) => /ai|train|license|ip|data/i.test(`${c.title} ${c.category} ${c.rationale}`))
    ).toBe(true);
  });

  it('catches silent evergreen auto-renewal with buried notice window', () => {
    const clause =
      'This Agreement shall automatically renew for successive twelve-month periods unless either party delivers written notice of non-renewal at least sixty (60) days prior to the end of the then-current term.';
    const res = analyzeDocumentHeuristically(clause);
    expect(res.clauses.length).toBeGreaterThan(0);
    expect(
      res.clauses.some((c) => /renew|evergreen|term/i.test(`${c.title} ${c.category} ${c.rationale}`))
    ).toBe(true);
  });

  it('catches unilateral modification via URL and continued use', () => {
    const clause =
      'Provider may modify these Terms at any time by posting an updated version at https://example.com/legal/terms, and Customer’s continued use of the Platform constitutes binding acceptance thereof.';
    const res = analyzeDocumentHeuristically(clause);
    expect(res.clauses.length).toBeGreaterThan(0);
    expect(
      res.clauses.some((c) => /modif|unilateral|url|terms/i.test(`${c.title} ${c.category} ${c.rationale}`))
    ).toBe(true);
  });

  it('catches mandatory arbitration and class-action waiver', () => {
    const clause =
      'Any dispute arising out of or relating to this Agreement shall be resolved exclusively by final and binding arbitration, and Customer irrevocably waives any right to participate in a class action or jury trial.';
    const res = analyzeDocumentHeuristically(clause);
    expect(res.clauses.length).toBeGreaterThan(0);
    expect(
      res.clauses.some((c) => /arbitrat|class|waiver|dispute/i.test(`${c.title} ${c.category} ${c.rationale}`))
    ).toBe(true);
  });

  it('catches delayed breach notification phrased as commercially reasonable time', () => {
    const clause =
      'In the event of an unauthorized disclosure of Customer Data, Processor shall notify Controller within a commercially reasonable time after confirming the scope of the incident.';
    const res = analyzeDocumentHeuristically(clause);
    expect(res.clauses.length).toBeGreaterThan(0);
    expect(
      res.clauses.some((c) => /breach|notif|incident|delay/i.test(`${c.title} ${c.category} ${c.rationale}`))
    ).toBe(true);
  });

  it('catches non-compete / non-solicit restraint', () => {
    const clause =
      'During the Term and for twenty-four (24) months thereafter, Partner shall not directly or indirectly solicit any employee of Company or offer a competing product in the Territory.';
    const res = analyzeDocumentHeuristically(clause);
    expect(res.clauses.length).toBeGreaterThan(0);
    expect(
      res.clauses.some((c) => /non-compete|non-solicit|exclusiv|restraint/i.test(`${c.title} ${c.category} ${c.rationale}`))
    ).toBe(true);
  });

  it('catches liquidated damages / early termination acceleration', () => {
    const clause =
      'Upon early termination by Customer for convenience, Customer shall immediately pay 100% of all remaining fees for the unexpired portion of the Commitment Term as liquidated damages and not as a penalty.';
    const res = analyzeDocumentHeuristically(clause);
    expect(res.clauses.length).toBeGreaterThan(0);
    expect(
      res.clauses.some((c) => /liquidated|damages|terminat|fee|penalt/i.test(`${c.title} ${c.category} ${c.rationale}`))
    ).toBe(true);
  });

  it('parses structured CUAD-grade JSON output cleanly via parseStructuredAnalysis', () => {
    const mockJson = JSON.stringify({
      documentType: 'Enterprise SaaS MSA',
      overallRiskScore: 84,
      riskPosture: 'Critical',
      executiveSummary: 'Multiple high-risk CUAD traps detected.',
      clauses: [
        {
          id: 'c-1',
          title: 'Most Favored Nation (MFN) Price Parity',
          category: 'Commercial / Pricing',
          severity: 'high',
          excerpt: 'Vendor warrants that pricing shall be no less favorable than any third party.',
          rationale: 'Locks pricing across all future enterprise deals.',
          redlineProposal: 'Delete MFN clause or limit to substantially similar volume commitments.'
        }
      ],
      crossClauseFindings: [],
      complianceFlags: ['CUAD-MFN']
    });

    const parsed = parseStructuredAnalysis(mockJson, 'Sample source text');
    expect(parsed.documentType).toBe('Enterprise SaaS MSA');
    expect(parsed.overallRiskScore).toBe(84);
    expect(parsed.riskPosture).toBe('Critical');
    expect(parsed.clauses).toHaveLength(1);
    expect(parsed.clauses[0].title).toContain('Most Favored Nation');
  });
});
