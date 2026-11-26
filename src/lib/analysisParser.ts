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

function clampScore(
  value: unknown,
  clauses: RiskClause[],
  crossClauseCount = 0
): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  if (clauses.length === 0 && crossClauseCount === 0) return 15;
  const weights: Record<ClauseSeverity, number> = {
    critical: 28,
    high: 18,
    medium: 10,
    low: 4
  };
  const sum =
    clauses.reduce((acc, c) => acc + weights[c.severity], 0) +
    crossClauseCount * 12;
  return Math.min(98, Math.max(12, sum));
}

function stripCodeFences(raw: string): string {
  const matches = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    if (last && last[1]) {
      return last[1].trim();
    }
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
  const seen = new Set<string>();
  const results: RiskClause[] = [];
  rawClauses.forEach((item, idx) => {
    const record =
      typeof item === 'object' && item !== null
        ? (item as Record<string, unknown>)
        : {};
    const title = asNonEmptyString(record.title, `Flagged Clause ${idx + 1}`);
    const excerpt = asNonEmptyString(record.excerpt, 'Excerpt not provided.');
    const dedupeKey = `${title.toLowerCase().replace(/\s+/g, ' ')}::${excerpt.toLowerCase().replace(/\s+/g, ' ').slice(0, 64)}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    results.push({
      id: asNonEmptyString(record.id, `clause-${idx + 1}`),
      title,
      category: asNonEmptyString(record.category, 'General Risk'),
      severity: normalizeSeverity(record.severity),
      excerpt,
      rationale: asNonEmptyString(
        record.rationale,
        'Requires legal or security review.'
      ),
      redlineProposal: asNonEmptyString(
        record.redlineProposal,
        'Add mutual cap, notice period, and explicit consent guardrails.'
      )
    });
  });
  return results;
}

function isExcerptGrounded(excerpt: string, sourceText: string): boolean {
  const normSource = sourceText.toLowerCase().replace(/\s+/g, ' ');
  const normExcerpt = excerpt.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normExcerpt.length < 12) return true;
  if (normSource.includes(normExcerpt)) return true;
  // Check if at least a 24-char core window of the excerpt appears verbatim
  const probe = normExcerpt.slice(0, Math.min(24, normExcerpt.length));
  return normSource.includes(probe);
}

function groundClausesAgainstDocument(
  clauses: RiskClause[],
  sourceText?: string
): RiskClause[] {
  if (!sourceText || sourceText.trim().length < 20) return clauses;
  return clauses.map((clause) => {
    if (
      clause.excerpt === 'Excerpt not provided.' ||
      isExcerptGrounded(clause.excerpt, sourceText)
    ) {
      return clause;
    }
    return {
      ...clause,
      rationale: `${clause.rationale} [Verification note: quoted excerpt did not match verbatim source text; verify exact section wording.]`
    };
  });
}

function normalizeCrossFindings(rawFindings: unknown): CrossClauseFinding[] {
  if (!Array.isArray(rawFindings)) return [];
  const seen = new Set<string>();
  const results: CrossClauseFinding[] = [];
  rawFindings.forEach((item, idx) => {
    const record =
      typeof item === 'object' && item !== null
        ? (item as Record<string, unknown>)
        : {};
    const title = asNonEmptyString(
      record.title,
      `Cross-Clause Interaction ${idx + 1}`
    );
    const key = title.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return;
    seen.add(key);
    const involved = Array.isArray(record.involvedClauses)
      ? record.involvedClauses.filter(
          (v): v is string => typeof v === 'string' && v.trim().length > 0
        )
      : [];
    results.push({
      id: asNonEmptyString(record.id, `cross-${idx + 1}`),
      title,
      involvedClauses: involved,
      impact: asNonEmptyString(record.impact, 'Potential compound obligation.'),
      negotiationMove: asNonEmptyString(
        record.negotiationMove,
        'Align definitions and liability caps across sections.'
      )
    });
  });
  return results;
}

export type FlaggedClause = RiskClause;

/**
 * Safely extracts any complete `{ ... }` clause objects already streamed
 * inside the `"clauses"` array of a partial JSON response.
 */
export function extractPartialClausesFromStream(rawText: string): FlaggedClause[] {
  if (!rawText) return [];
  // Locate "clauses" only at top-level JSON depth 1
  let clausesKeyIdx = -1;
  let scanInString = false;
  let scanEscape = false;
  let scanDepth = 0;
  for (let i = 0; i < rawText.length; i += 1) {
    const ch = rawText[i];
    if (scanEscape) {
      scanEscape = false;
      continue;
    }
    if (ch === '\\' && scanInString) {
      scanEscape = true;
      continue;
    }
    if (ch === '"') {
      if (!scanInString && scanDepth === 1 && rawText.startsWith('"clauses"', i)) {
        clausesKeyIdx = i;
        break;
      }
      scanInString = !scanInString;
      continue;
    }
    if (scanInString) continue;
    if (ch === '{') scanDepth += 1;
    else if (ch === '}') scanDepth = Math.max(0, scanDepth - 1);
  }
  if (clausesKeyIdx === -1) return [];
  const arrayStart = rawText.indexOf('[', clausesKeyIdx);
  if (arrayStart === -1) return [];

  const rawObjects: unknown[] = [];
  let inString = false;
  let escapeNext = false;
  let depth = 0;
  let objStart = -1;

  for (let i = arrayStart + 1; i < rawText.length; i++) {
    const ch = rawText[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) {
        objStart = i;
      }
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && objStart !== -1) {
          const slice = rawText.slice(objStart, i + 1);
          try {
            const parsed = JSON.parse(slice);
            if (typeof parsed === 'object' && parsed !== null) {
              rawObjects.push(parsed);
            }
          } catch {
            // Incomplete or malformed object; skip safely.
          }
          objStart = -1;
        }
      }
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }

  return normalizeClauses(rawObjects);
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
    const clauses = groundClausesAgainstDocument(
      normalizeClauses(parsed.clauses),
      fallbackDocumentText
    );
    const crossClauseFindings = Array.isArray(parsed.crossClauseFindings)
      ? parsed.crossClauseFindings
      : [];
    const overallRiskScore = clampScore(
      parsed.overallRiskScore,
      clauses,
      crossClauseFindings.length
    );
    const complianceFlags = Array.isArray(parsed.complianceFlags)
      ? parsed.complianceFlags.filter(
          (f): f is string => typeof f === 'string' && f.trim().length > 0
        )
      : [];

    const riskPosture = deriveRiskPosture(overallRiskScore);

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
    const partialClauses = extractPartialClausesFromStream(rawText);
    if (partialClauses.length > 0) {
      const overallRiskScore = clampScore(undefined, partialClauses);
      return {
        documentType: 'Legal / Policy Document',
        overallRiskScore,
        riskPosture: deriveRiskPosture(overallRiskScore),
        executiveSummary: `Extracted ${partialClauses.length} partial clause${partialClauses.length === 1 ? '' : 's'} from truncated model output.`,
        clauses: partialClauses,
        crossClauseFindings: [],
        complianceFlags: []
      };
    }
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
      /(unlimited liability|shall indemnify.{0,80}without limit|in no event shall vendor.{0,80}exceed \$?(?:0|100|500|1,?000)|cap of \$?(?:0|100|500|1,?000)|(?:one \(1\)|1)[- ]month.{0,40}fees?|solely liable for all|aggregate liability shall not exceed)/i,
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
      /(automatically renew|auto-renew|evergreen|automatically extend|(?:30|45|60|90) days.{0,30}written notice|(?:30|45|60|90) days.{0,30}prior to expiration)/i,
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
      /(commercially reasonable (?:efforts|time).{0,40}notify|notify.{0,40}commercially reasonable time|within 30 days of confirming|no obligation to notify)/i,
    rationale:
      'A 30-day or vague breach notice window conflicts with GDPR 72-hour regulatory reporting timelines.',
    redlineProposal:
      'Mandate written security incident notification within 24–48 hours of discovery with forensic cooperation.',
    complianceFlag: 'GDPR Art. 33 (72h Breach Notice)'
  },
  {
    id: 'h-non-compete',
    title: 'Broad Non-Compete / Exclusivity Restriction',
    category: 'Exclusivity & Restrictive Covenants',
    severity: 'high',
    pattern: /(non-compete|noncompete|covenant not to compete|solicit any employee|competing product)/i,
    rationale:
      'Restrictive non-compete or exclusivity covenants can block future commercial partnerships or product lines.',
    redlineProposal:
      'Narrow scope to direct use of counterparty confidential information or remove non-compete entirely.',
    complianceFlag: 'Antitrust / Commercial Freedom'
  },
  {
    id: 'h-uncapped-indemnity',
    title: 'Uncapped / Asymmetric Indemnification',
    category: 'Indemnification & Liability',
    severity: 'critical',
    pattern:
      /(?:indemnify|hold harmless).{0,120}(?:without limitation|without cap|no cap|uncapped)/i,
    rationale:
      'Uncapped indemnification exposes the party to unlimited financial liability for third-party claims.',
    redlineProposal:
      'Make indemnification mutual and subject to the overall Agreement liability cap.',
    complianceFlag: 'CUAD Uncapped Indemnity'
  },
  {
    id: 'h-liquidated-damages',
    title: 'Liquidated Damages / Fee Acceleration',
    category: 'Termination & Financial Penalties',
    severity: 'high',
    pattern:
      /(liquidated damages|100% of all remaining fees|unexpired portion of the commitment)/i,
    rationale:
      'Accelerated fee or liquidated damages clauses impose disproportionate penalties upon early termination.',
    redlineProposal:
      'Replace full fee acceleration with a pro-rata wind-down fee or termination for convenience with 30 days notice.',
    complianceFlag: 'CUAD Liquidated Damages'
  },
  {
    id: 'h-mfn',
    title: 'Most Favored Nation (MFN) Pricing Covenant',
    category: 'Pricing & Commercial',
    severity: 'high',
    pattern:
      /(most[- ]favored[- ]nation|most favored customer|at least as favorable as those offered to any other|more favorable pricing.{0,60}extend)/i,
    rationale:
      'MFN clauses restrict pricing flexibility and can trigger retroactive discounts across your entire customer base.',
    redlineProposal:
      'Remove MFN obligations or limit to prospective volume-matched enterprise tiers with explicit carve-outs.',
    complianceFlag: 'CUAD Most Favored Nation'
  },
  {
    id: 'h-anti-assignment',
    title: 'Restrictive Change-of-Control / Anti-Assignment',
    category: 'Governance & M&A',
    severity: 'high',
    pattern:
      /((?:may not|shall not|prohibited from) assign.{0,80}(?:change of control|merger|acquisition)|change of control.{0,60}(?:deemed|constitute).{0,40}assignment|transfer of more than 50%|freely assign to any acquirer)/i,
    rationale:
      'Blocks M&A exits, corporate reorganizations, or financing events by requiring counterparty consent or triggering termination.',
    redlineProposal:
      'Permit assignment without consent to affiliates or in connection with a merger, acquisition, or sale of substantially all assets.',
    complianceFlag: 'CUAD Change of Control / Anti-Assignment'
  },
  {
    id: 'h-unilateral-audit',
    title: 'Unilateral Audit Rights at Customer Expense',
    category: 'Audit & Compliance',
    severity: 'medium',
    pattern:
      /(?:audit|inspect).{0,100}(?:at any time|without prior notice|without advance notice|sole expense|at (?:customer's|licensee's) expense|24 hours' demand)/i,
    rationale:
      'Allows disruptive, unannounced on-site or remote audits while shifting the full financial burden onto the audited party.',
    redlineProposal:
      'Limit audits to once annually upon 30 days advance written notice during normal business hours, or accept SOC 2 Type II reports.',
    complianceFlag: 'CUAD Audit Rights'
  },
  {
    id: 'h-moral-rights',
    title: 'Irrevocable Waiver of Moral Rights',
    category: 'Intellectual Property',
    severity: 'medium',
    pattern: /(waives?.{0,40}moral rights|droit moral)/i,
    rationale:
      'Irrevocably surrenders attribution and integrity rights over authored deliverables or custom code.',
    redlineProposal:
      'Retain attribution rights for pre-existing materials and limit moral rights waivers strictly to commissioned work-for-hire deliverables.',
    complianceFlag: 'CUAD Moral Rights Waiver'
  }
];

function extractSentenceExcerpt(text: string, index: number): string {
  let start = 0;
  const before = text.slice(0, index);
  const boundaryRe =
    /(?:(?<!\b(?:Inc|Corp|Ltd|LLC|U\.S|Art|Sec|No|Vol|Dr|Mr|Ms|St))\.\s+(?=[A-Z])|\n)/g;
  let m: RegExpExecArray | null;
  while ((m = boundaryRe.exec(before)) !== null) {
    start = m.index + m[0].length;
  }

  const after = text.slice(index);
  const endMatch = after.match(
    /(?:(?<!\b(?:Inc|Corp|Ltd|LLC|U\.S|Art|Sec|No|Vol|Dr|Mr|Ms|St))\.\s+(?=[A-Z])|\n)/
  );
  const end =
    endMatch && typeof endMatch.index === 'number'
      ? index + endMatch.index + (endMatch[0].startsWith('.') ? 1 : 0)
      : Math.min(text.length, index + 220);

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
    const flags = rule.pattern.flags.includes('g')
      ? rule.pattern.flags
      : `${rule.pattern.flags}g`;
    const pattern = new RegExp(rule.pattern.source, flags);
    let match: RegExpExecArray | null;
    let ruleMatches = 0;

    while (
      (match = pattern.exec(redactedText)) !== null &&
      ruleMatches < 3
    ) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      const excerpt = extractSentenceExcerpt(redactedText, match.index);
      const excerptLower = excerpt.toLowerCase();
      const prefixWindow = redactedText
        .slice(Math.max(0, match.index - 40), match.index)
        .toLowerCase();
      if (
        rule.id === 'h-ai-training' &&
        (/\b(?:never|not|shall not|prohibited from|no)\b/.test(prefixWindow) ||
          /unless.{0,30}opts? in|zero[- ]data[- ]retention/.test(excerptLower))
      ) {
        continue;
      }
      if (
        rule.id === 'h-liability' &&
        /\bmutual\b/.test(excerptLower) &&
        /\b(?:12|twelve)\s*months?\b/.test(excerptLower) &&
        !/without limitation|\$?100\b/.test(excerptLower)
      ) {
        continue;
      }
      if (
        rule.id === 'h-breach-notice' &&
        /\b(?:24|48|72)\s*hours?\b/.test(excerptLower) &&
        !/\b30\s*days?\b/.test(excerptLower)
      ) {
        continue;
      }
      if (
        rule.id === 'h-arbitration' &&
        /\bopt[- ]out\b/.test(excerptLower)
      ) {
        continue;
      }
      if (
        rule.id === 'h-anti-assignment' &&
        /\bmay assign\b/.test(excerptLower) &&
        /\bwithout consent\b/.test(excerptLower)
      ) {
        continue;
      }
      if (
        rule.id === 'h-unilateral-audit' &&
        /\b(?:mutually scheduled|30 days' advance)\b/.test(excerptLower)
      ) {
        continue;
      }
      if (
        rule.id === 'h-uncapped-indemnity' &&
        /\b(?:capped|subject to the liability cap)\b/.test(excerptLower)
      ) {
        continue;
      }
      if (
        rule.id === 'h-liquidated-damages' &&
        /\b(?:shall not be subject to|no)\s+liquidated damages\b/.test(
          excerptLower
        )
      ) {
        continue;
      }
      if (
        rule.id === 'h-mfn' &&
        /\b(?:no|not)\s+(?:most[- ]favored|mfn)\b/.test(excerptLower)
      ) {
        continue;
      }
      if (
        rule.id === 'h-non-compete' &&
        /\b(?:no|not|shall not)\s+(?:non[- ]compete|non[- ]solicit)\b/.test(
          excerptLower
        )
      ) {
        continue;
      }
      if (
        rule.id === 'h-moral-rights' &&
        /\b(?:retains?|preserves?)\s+moral rights\b/.test(excerptLower)
      ) {
        continue;
      }
      clauses.push({
        id: ruleMatches === 0 ? rule.id : `${rule.id}-${ruleMatches + 1}`,
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
      ruleMatches += 1;
    }
  }

  const crossClauseFindings: CrossClauseFinding[] = [];
  const hasLiability = clauses.some((c) => c.id.startsWith('h-liability'));
  const hasAiTraining = clauses.some((c) => c.id.startsWith('h-ai-training'));
  const hasBreach = clauses.some((c) => c.id.startsWith('h-breach-notice'));
  const hasUnilateralChange = clauses.some((c) =>
    c.id.startsWith('h-unilateral-change')
  );
  const hasArbitration = clauses.some((c) => c.id.startsWith('h-arbitration'));

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
  if (hasUnilateralChange && hasArbitration) {
    crossClauseFindings.push({
      id: 'cross-unilateral-arbitration',
      title: 'Compound Trap: Unilateral Terms Modification + Mandatory Arbitration',
      involvedClauses: ['h-unilateral-change', 'h-arbitration'],
      impact:
        'Vendor can unilaterally rewrite commercial or privacy terms while forcing any resulting dispute into private binding arbitration with waived class remedies.',
      negotiationMove:
        'Require 30-day advance written notice with termination rights for material changes AND carve out injunctive/IP relief from arbitration.'
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
