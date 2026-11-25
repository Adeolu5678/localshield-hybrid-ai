import { describe, expect, it } from 'vitest';
import {
  analyzeDocumentHeuristically,
  parseStructuredAnalysis
} from '../src/lib/analysisParser';
import { SAMPLE_DOCUMENTS } from '../src/data/sampleDocuments';

describe('parseStructuredAnalysis', () => {
  it('parses markdown-fenced JSON returned by on-device Gemini Nano', () => {
    const raw = `Here is the structured risk brief:
\`\`\`json
{
  "documentType": "SaaS MSA",
  "overallRiskScore": 84,
  "riskPosture": "Critical",
  "executiveSummary": "Severe liability asymmetry and model-training grant.",
  "clauses": [
    {
      "id": "c-1",
      "title": "Liability Cap $100",
      "category": "Liability",
      "severity": "CRITICAL",
      "excerpt": "In no event shall Vendor's aggregate liability exceed $100 USD.",
      "rationale": "Caps vendor damages well below contract value.",
      "redlineProposal": "Increase cap to 12 months fees."
    }
  ],
  "crossClauseFindings": [],
  "complianceFlags": ["SOC 2 Gap"]
}
\`\`\`
Done.`;

    const parsed = parseStructuredAnalysis(raw);
    expect(parsed.documentType).toBe('SaaS MSA');
    expect(parsed.overallRiskScore).toBe(84);
    expect(parsed.riskPosture).toBe('Critical');
    expect(parsed.clauses).toHaveLength(1);
    expect(parsed.clauses[0].severity).toBe('critical');
    expect(parsed.complianceFlags).toEqual(['SOC 2 Gap']);
  });

  it('falls back to deterministic heuristic analysis when model returns invalid JSON and fallback text is provided', () => {
    const parsed = parseStructuredAnalysis(
      'Not valid JSON output from small model',
      SAMPLE_DOCUMENTS[0].content
    );
    expect(parsed.clauses.length).toBeGreaterThanOrEqual(4);
    expect(parsed.overallRiskScore).toBeGreaterThanOrEqual(75);
    expect(parsed.riskPosture).toBe('Critical');
  });

  it('identifies clean DPA baseline with low score', () => {
    const clean = analyzeDocumentHeuristically(SAMPLE_DOCUMENTS[2].content);
    expect(clean.clauses).toHaveLength(0);
    expect(clean.riskPosture).toBe('Low');
    expect(clean.overallRiskScore).toBeLessThan(25);
  });
});
