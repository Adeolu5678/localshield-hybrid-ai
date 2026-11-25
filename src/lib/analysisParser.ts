import type {
  ClauseSeverity,
  CrossClauseFinding,
  DocumentAnalysisResult,
  RiskClause
} from '../types/analysis';

const VALID_SEVERITIES: ReadonlySet<ClauseSeverity> = new Set([
  'critical',
  'high',
  'medium',
  'low'
]);

function normalizeSeverity(value: unknown): ClauseSeverity {
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim() as ClauseSeverity;
    if (VALID_SEVERITIES.has(lower)) {
      return lower;
    }
  }
  return 'medium';
}

function deriveRiskPosture(
  score: number
): DocumentAnalysisResult['riskPosture'] {
  if (score >= 75) return 'Critical';
  if (score >= 50) return 'Elevated';
  if (score >= 25) return 'Moderate';
  return 'Low';
}

function clampScore(value: unknown, clauses: RiskClause[]): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  if (clauses.length === 0) return 15;
  const weights: Record<ClauseSeverity, number> = {
    critical: 28,
    high: 18,
    medium: 10,
    low: 4
  };
  const sum = clauses.reduce((acc, c) => acc + weights[c.severity], 0);
  return Math.min(98, Math.max(12, sum));
}

function stripCodeFences(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1).trim();
  }
  return raw.trim();
}

function asNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function normalizeClauses(rawClauses: unknown): RiskClause[] {
  if (!Array.isArray(rawClauses)) return [];
  return rawClauses.map((item, idx) => {
    const record =
      typeof item === 'object' && item !== null
        ? (item as Record<string, unknown>)
        : {};
    return {
      id: asNonEmptyString(record.id, `clause-${idx + 1}`),
      title: asNonEmptyString(record.title, `Flagged Clause ${idx + 1}`),
      category: asNonEmptyString(record.category, 'General Risk'),
      severity: normalizeSeverity(record.severity),
      excerpt: asNonEmptyString(record.excerpt, 'Excerpt not provided.'),
      rationale: asNonEmptyString(
        record.rationale,
        'Requires legal or security review.'
      ),
      redlineProposal: asNonEmptyString(
        record.redlineProposal,
        'Add mutual cap, notice period, and explicit consent guardrails.'
      )
    };
  });
}

function normalizeCrossFindings(rawFindings: unknown): CrossClauseFinding[] {
  if (!Array.isArray(rawFindings)) return [];
  return rawFindings.map((item, idx) => {
    const record =
      typeof item === 'object' && item !== null
        ? (item as Record<string, unknown>)
        : {};
    const involved = Array.isArray(record.involvedClauses)
      ? record.involvedClauses.filter(
          (v): v is string => typeof v === 'string' && v.trim().length > 0
        )
      : [];
    return {
      id: asNonEmptyString(record.id, `cross-${idx + 1}`),
      title: asNonEmptyString(record.title, `Cross-Clause Interaction ${idx + 1}`),
      involvedClauses: involved,
      impact: asNonEmptyString(record.impact, 'Potential compound obligation.'),
      negotiationMove: asNonEmptyString(
        record.negotiationMove,
        'Align definitions and liability caps across sections.'
      )
    };
  });
}

/**
 * Parses model output (raw JSON or markdown-fenced JSON from Gemini Nano / Cloud)
 * into a strongly typed DocumentAnalysisResult.
 */
export function parseStructuredAnalysis(
  rawText: string,
  fallbackDocumentText?: string
): DocumentAnalysisResult {
  const cleaned = stripCodeFences(rawText);
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const clauses = normalizeClauses(parsed.clauses);
    const overallRiskScore = clampScore(parsed.overallRiskScore, clauses);
    const complianceFlags = Array.isArray(parsed.complianceFlags)
      ? parsed.complianceFlags.filter(
          (f): f is string => typeof f === 'string' && f.trim().length > 0
        )
      : [];

    const postureInput =
      typeof parsed.riskPosture === 'string' ? parsed.riskPosture.trim() : '';
    const validPostures = new Set(['Critical', 'Elevated', 'Moderate', 'Low']);
    const riskPosture = validPostures.has(postureInput)
      ? (postureInput as DocumentAnalysisResult['riskPosture'])
      : deriveRiskPosture(overallRiskScore);

    return {
      documentType: asNonEmptyString(parsed.documentType, 'Legal / Policy Document'),
      overallRiskScore,
      riskPosture,
      executiveSummary: asNonEmptyString(
        parsed.executiveSummary,
        'Structured risk extraction completed.'
      ),
      clauses,
      crossClauseFindings: normalizeCrossFindings(parsed.crossClauseFindings),
      complianceFlags
    };
  } catch {
    if (fallbackDocumentText) {
      return analyzeDocumentHeuristically(fallbackDocumentText);
    }
    throw new Error('Model returned unparseable structured analysis JSON.');
  }
}

interface HeuristicRule {
  id: string;
  title: string;
  category: string;
  severity: ClauseSeverity;
  pattern: RegExp;
  rationale: string;
  redlineProposal: string;
  complianceFlag?: string;
}

const HEURISTIC_RULES: HeuristicRule[] = [
  {
    id: 'h-liability',
    title: 'Uncapped or Asymmetric Indemnification / Liability',
    category: 'Liability',
    severity: 'critical',
    pattern:
      /(unlimited liability|shall indemnify.{0,80}without limit|in no event shall vendor.{0,80}exceed \$?100|cap of \$?100|solely liable for all)/i,
    rationale:
      'Asymmetric liability caps or uncapped customer indemnity expose your organization to catastrophic financial loss while capping vendor accountability.',
    redlineProposal:
      'Replace with a mutual liability cap equal to 12 months of fees paid, and make indemnification mutual for third-party IP and data-breach claims.',
    complianceFlag: 'SOC 2 / Enterprise Procurement Red Flag'
  },
  {
    id: 'h-ai-training',
    title: 'Broad License to Train AI Models on Customer Data',
    category: 'Data Privacy & AI',
    severity: 'critical',
    pattern:
      /(irrevocable.{0,50}license|train(?:ing)? (?:our |its )?(?:ai|machine learning|models)|perpetual.{0,50}royalty-free.{0,50}(?:use|process|analyze))/i,
    rationale:
      'Grants the vendor perpetual or AI-training rights over confidential prompts, documents, or user telemetry.',
    redlineProposal:
      'Insert explicit Zero Data Retention / No Model Training clause prohibiting use of Customer Data to train or fine-tune foundation models.',
    complianceFlag: 'GDPR Art. 5 / Enterprise AI Governance'
  },
  {
    id: 'h-auto-renew',
    title: 'Silent Auto-Renewal with Narrow Opt-Out Window',
    category: 'Auto-Renewal',
    severity: 'high',
    pattern:
      /(automatically renew|auto-renew|90 days.{0,30}written notice|60 days.{0,30}prior to expiration)/i,
    rationale:
      'Long advance cancellation windows (60–90 days) combined with automatic annual lock-in frequently trigger unintended renewals and price uplifts.',
    redlineProposal:
      'Require 30-day advance written renewal notice from Vendor and allow non-renewal notice up to 15 days before term end without price escalation.',
    complianceFlag: 'Procurement Renewal Control'
  },
  {
    id: 'h-arbitration',
    title: 'Mandatory Binding Arbitration & Class Action Waiver',
    category: 'Dispute Resolution',
    severity: 'high',
    pattern:
      /(binding arbitration|waive.{0,40}class action|jury trial|exclusive venue)/i,
    rationale:
      'Forces disputes into private arbitration with waived class remedies and potentially inconvenient jurisdiction.',
    redlineProposal:
      'Carve out injunctive relief for IP/confidentiality breaches and allow mutual court jurisdiction in neutral venue.',
    complianceFlag: 'Consumer / Commercial Litigation Risk'
  },
  {
    id: 'h-unilateral-change',
    title: 'Unilateral Terms Modification Without Prior Notice',
    category: 'Governance',
    severity: 'medium',
    pattern:
      /(modify these terms at any time|sole discretion without notice|continued use constitutes acceptance)/i,
    rationale:
      'Permits the counterparty to alter pricing, SLAs, or data-sharing rules unilaterally without affirmative consent.',
    redlineProposal:
      'Require 30 days advance written notice for material changes plus a penalty-free termination right with pro-rata refund.',
    complianceFlag: 'GDPR Transparency / Contract Stability'
  },
  {
    id: 'h-breach-notice',
    title: 'Delayed Security Breach Notification',
    category: 'Security & Compliance',
    severity: 'high',
    pattern:
      /(commercially reasonable efforts.{0,40}notify|within 30 days of confirming|no obligation to notify)/i,
    rationale:
      'A 30-day or vague breach notice window conflicts with GDPR 72-hour regulatory reporting timelines.',
    redlineProposal:
      'Mandate written security incident notification within 24–48 hours of discovery with forensic cooperation.',
    complianceFlag: 'GDPR Art. 33 (72h Breach Notice)'
  }
];

function extractSentenceExcerpt(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('.', index) + 1);
  const nextPeriod = text.indexOf('.', index);
  const end = nextPeriod === -1 ? Math.min(text.length, index + 220) : nextPeriod + 1;
  return text.slice(start, end).trim().slice(0, 260);
}

/**
 * Deterministic local heuristic analyzer used when offline without Gemini Nano
 * or as a baseline comparison layer. Zero outbound network calls.
 */
export function analyzeDocumentHeuristically(
  redactedText: string
): DocumentAnalysisResult {
  const clauses: RiskClause[] = [];
  const complianceSet = new Set<string>();

  for (const rule of HEURISTIC_RULES) {
    const match = rule.pattern.exec(redactedText);
    if (match) {
      const excerpt = extractSentenceExcerpt(redactedText, match.index);
      const prefixWindow = redactedText
        .slice(Math.max(0, match.index - 40), match.index)
        .toLowerCase();
      if (
        rule.id === 'h-ai-training' &&
        /\b(?:never|not|shall not|prohibited from|no)\b/.test(prefixWindow)
      ) {
        continue;
      }
      clauses.push({
        id: rule.id,
        title: rule.title,
        category: rule.category,
        severity: rule.severity,
        excerpt,
        rationale: rule.rationale,
        redlineProposal: rule.redlineProposal
      });
      if (rule.complianceFlag) {
        complianceSet.add(rule.complianceFlag);
      }
    }
  }

  const crossClauseFindings: CrossClauseFinding[] = [];
  const hasLiability = clauses.some((c) => c.id === 'h-liability');
  const hasAiTraining = clauses.some((c) => c.id === 'h-ai-training');
  const hasBreach = clauses.some((c) => c.id === 'h-breach-notice');

  if (hasLiability && hasAiTraining) {
    crossClauseFindings.push({
      id: 'cross-ai-liability',
      title: 'Compound Exposure: AI Training License + Asymmetric Liability Cap',
      involvedClauses: ['h-ai-training', 'h-liability'],
      impact:
        'Vendor gains broad model-training rights over ingested content while capping its liability if confidential data leaks.',
      negotiationMove:
        'Carve out confidentiality, privacy, and IP breaches from the liability cap AND strike the model-training license.'
    });
  }
  if (hasBreach && hasAiTraining) {
    crossClauseFindings.push({
      id: 'cross-gdpr-gap',
      title: 'Regulatory Conflict: Delayed Breach Notice vs. Broad Data Processing',
      involvedClauses: ['h-breach-notice', 'h-ai-training'],
      impact:
        'Delayed breach notification makes GDPR 72-hour compliance impossible if processed data is compromised.',
      negotiationMove:
        'Bind vendor to 48-hour incident notification and require a signed DPA.'
    });
  }

  const overallRiskScore = clampScore(undefined, clauses);
  const documentType = /privacy policy/i.test(redactedText)
    ? 'Privacy Policy'
    : /data processing/i.test(redactedText)
      ? 'Data Processing Addendum (DPA)'
      : 'Master Services Agreement / Contract';

  return {
    documentType,
    overallRiskScore,
    riskPosture: deriveRiskPosture(overallRiskScore),
    executiveSummary:
      clauses.length > 0
        ? `Detected ${clauses.length} high-signal risk clause(s) locally with zero outbound data leakage. ${
            crossClauseFindings.length > 0
              ? `Identified ${crossClauseFindings.length} cross-clause compound risk(s).`
              : 'Review redline counter-proposals before execution.'
          }`
        : 'No common high-severity trap patterns detected by local heuristic scan; run deep AI review for nuanced obligations.',
    clauses,
    crossClauseFindings,
    complianceFlags: Array.from(complianceSet)
  };
}
