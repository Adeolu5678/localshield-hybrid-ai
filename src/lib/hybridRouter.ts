import type {
  InferenceSource,
  Part,
  StartChatParams,
  UsageMetadata
} from 'firebase/ai';
import {
  analyzeDocumentHeuristically,
  parseStructuredAnalysis
} from './analysisParser';
import {
  buildMultimodalContentParts,
  type ModelSchemaKey
} from './firebaseClient';
import {
  estimateTokenCount,
  mergeSemanticRedactions,
  redactSensitiveData
} from './piiRedactor';
import type {
  ChromeNanoAvailability,
  ClauseNegotiationMessage,
  ClauseSeverity,
  CloudDegradationInfo,
  CloudErrorKind,
  DocumentAnalysisResult,
  DocumentChunkInfo,
  HybridDelta,
  HybridExecutionReport,
  HybridPolicyMode,
  InlineAttachment,
  PipelineStage,
  RiskClause,
  RunTelemetry,
  SemanticPiiEntity,
  SemanticPiiReport,
  TelemetryBadgeKind
} from '../types/analysis';

export interface HybridModelResponse {
  text: () => string;
  inferenceSource?: InferenceSource | 'on_device' | 'in_cloud';
  usageMetadata?: UsageMetadata;
}

export interface HybridStreamResult {
  stream: AsyncIterable<{ text: () => string }>;
  response: Promise<HybridModelResponse>;
}

export interface HybridChatSession {
  sendMessage: (
    request: string | Array<string | Part>,
    options?: { signal?: AbortSignal }
  ) => Promise<{ response: HybridModelResponse }>;
  sendMessageStream?: (
    request: string | Array<string | Part>,
    options?: { signal?: AbortSignal }
  ) => Promise<HybridStreamResult>;
}

export interface HybridModelRunner {
  generateContent: (
    request: string | Array<string | Part>,
    options?: { signal?: AbortSignal }
  ) => Promise<{ response: HybridModelResponse }>;
  generateContentStream?: (
    request: string | Array<string | Part>,
    options?: { signal?: AbortSignal }
  ) => Promise<HybridStreamResult>;
  countTokens?: (
    request: string | Array<string | Part>
  ) => Promise<{ totalTokens: number }>;
  startChat?: (params?: StartChatParams) => HybridChatSession;
  initializeDeviceModel?: (
    onDownloadProgress?: (progressValue: number) => void
  ) => Promise<void>;
}

export type ModelFactory = (
  mode: HybridPolicyMode,
  schemaKey?: ModelSchemaKey
) => HybridModelRunner;

export interface RouterOptions {
  policyMode: HybridPolicyMode;
  runCloudEscalation: boolean;
  isOnline: boolean;
  chromeNanoAvailability: ChromeNanoAvailability;
  useSimulatedSandbox: boolean;
  cloudModelName: string;
  modelFactory?: ModelFactory;
  now?: () => number;
  customTerms?: string[];
  enableSemanticPii?: boolean;
  inlineAttachments?: InlineAttachment[];
  maxCharsPerChunk?: number;
  maxChunks?: number;
  bypassCache?: boolean;
  signal?: AbortSignal;
  onStreamChunk?: (chunkText: string, stage: PipelineStage) => void;
  onStageChange?: (stage: PipelineStage) => void;
}

export interface ChunkedDocument {
  chunks: string[];
  chunkCount: number;
  estimatedTokens: number;
  wasChunked: boolean;
  wasTruncated: boolean;
}

interface ChromeLanguageModelGlobal {
  availability?: (options?: unknown) => Promise<string>;
}

const DEFAULT_TRIAGE_CHUNK_CHARS = 10000;
const DEFAULT_MAX_CHUNKS = 4;
const DEFAULT_CHUNK_OVERLAP_CHARS = 300;
const MAX_HYBRID_CACHE_ENTRIES = 20;

const hybridAnalysisCache = new Map<string, HybridExecutionReport>();

export function clearHybridAnalysisCache(): void {
  hybridAnalysisCache.clear();
}

function hashCacheKey(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}-${input.length}`;
}
const SEVERITY_RANK: Record<ClauseSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

function createAbortError(message = 'Operation aborted by caller.'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Probes Chrome's built-in Prompt API (window.LanguageModel) without throwing
 * in non-Chrome browsers or Node test environments.
 */
export async function probeChromeNanoAvailability(
  globalObj: unknown = typeof globalThis !== 'undefined' ? globalThis : undefined
): Promise<ChromeNanoAvailability> {
  try {
    const lm = (globalObj as { LanguageModel?: ChromeLanguageModelGlobal } | undefined)
      ?.LanguageModel;
    if (!lm || typeof lm.availability !== 'function') {
      return 'unsupported';
    }
    const status = await lm.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }]
    });
    if (
      status === 'available' ||
      status === 'downloadable' ||
      status === 'downloading' ||
      status === 'unavailable'
    ) {
      return status;
    }
    return 'unavailable';
  } catch {
    return 'unsupported';
  }
}

const CUAD_HINT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'hold harmless', regex: /\bhold\s+harmless\b/i },
  { label: 'perpetual', regex: /\bperpetual\b/i },
  { label: 'irrevocable', regex: /\birrevocable\b/i },
  { label: 'auto-renew', regex: /\bauto-?renew(?:al|s|ing)?\b/i },
  { label: 'evergreen', regex: /\bevergreen\b/i },
  { label: 'arbitration', regex: /\barbitration\b/i },
  { label: 'class action', regex: /\bclass\s+action\b/i },
  { label: 'most favored', regex: /\bmost\s+favored\b/i },
  { label: 'liquidated damages', regex: /\bliquidated\s+damages\b/i },
  { label: 'change of control', regex: /\bchange\s+of\s+control\b/i },
  { label: 'sole discretion', regex: /\bsole\s+discretion\b/i }
];

export function extractCuadHints(text: string): string[] {
  const hints: string[] = [];
  for (const { label, regex } of CUAD_HINT_PATTERNS) {
    if (regex.test(text)) {
      hints.push(label);
    }
  }
  return hints;
}

export function extractDefinedTerms(text: string, maxTerms = 8): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const addTerm = (raw: string) => {
    const cleaned = raw.trim().replace(/\s+/g, ' ');
    if (!cleaned || cleaned.length > 40) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(cleaned);
  };

  const meansRegex = /["“]([A-Z][A-Za-z0-9\s-]{1,40})["”]\s+means\b/g;
  let match: RegExpExecArray | null;
  while ((match = meansRegex.exec(text)) !== null && terms.length < maxTerms) {
    addTerm(match[1]);
  }

  const parenRegex = /\b[A-Z][A-Za-z0-9\s-]{1,40}\s*\((?:the\s+)?["“]([A-Z][A-Za-z0-9\s-]{1,40})["”]\)/g;
  while ((match = parenRegex.exec(text)) !== null && terms.length < maxTerms) {
    addTerm(match[1]);
  }

  return terms.slice(0, maxTerms);
}

/**
 * Splits long legal/policy documents along section headings, paragraphs, or
 * sentence boundaries so Gemini Nano and Cloud models receive coherent chunks
 * rather than arbitrary mid-sentence slices.
 */
export function chunkDocumentText(
  text: string,
  maxCharsPerChunk = DEFAULT_TRIAGE_CHUNK_CHARS,
  maxChunks = DEFAULT_MAX_CHUNKS
): ChunkedDocument {
  const trimmed = text.trim();
  const estimatedTokens = estimateTokenCount(trimmed);
  if (!trimmed) {
    return {
      chunks: [''],
      chunkCount: 1,
      estimatedTokens: 0,
      wasChunked: false,
      wasTruncated: false
    };
  }

  if (trimmed.length <= maxCharsPerChunk) {
    return {
      chunks: [trimmed],
      chunkCount: 1,
      estimatedTokens,
      wasChunked: false,
      wasTruncated: false
    };
  }

  // Prefer splitting on numbered/titled sections or double newlines
  const sectionUnits = trimmed
    .split(/\n(?=(?:\d+\.\s+[A-Z]|ARTICLE\s+|SECTION\s+|#{1,3}\s+))|\n{2,}/)
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  const chunks: string[] = [];
  let current = '';

  const flushCurrent = () => {
    if (current.trim().length > 0) {
      chunks.push(current.trim());
      current = '';
    }
  };

  for (const unit of sectionUnits) {
    if (unit.length <= maxCharsPerChunk) {
      if (current.length === 0) {
        current = unit;
      } else if (current.length + 2 + unit.length <= maxCharsPerChunk) {
        current = `${current}\n\n${unit}`;
      } else {
        flushCurrent();
        current = unit;
      }
      continue;
    }

    // Oversized single section: split on sentence boundaries or hard fallback
    flushCurrent();
    let remaining = unit;
    while (remaining.length > maxCharsPerChunk) {
      const windowSlice = remaining.slice(0, maxCharsPerChunk);
      const sentenceCut = Math.max(
        windowSlice.lastIndexOf('. '),
        windowSlice.lastIndexOf('.\n'),
        windowSlice.lastIndexOf('; ')
      );
      const cutIdx =
        sentenceCut >= Math.floor(maxCharsPerChunk * 0.5)
          ? sentenceCut + 1
          : maxCharsPerChunk;
      chunks.push(remaining.slice(0, cutIdx).trim());
      remaining = remaining.slice(cutIdx).trim();
    }
    if (remaining.length > 0) {
      current = remaining;
    }
  }
  flushCurrent();

  const wasTruncated = chunks.length > maxChunks;
  const rawBoundedChunks = wasTruncated ? chunks.slice(0, maxChunks) : chunks;
  const overlapChars = Math.min(
    DEFAULT_CHUNK_OVERLAP_CHARS,
    Math.floor(maxCharsPerChunk * 0.25)
  );
  const definedTerms =
    rawBoundedChunks.length > 1 ? extractDefinedTerms(trimmed, 8) : [];
  const definedTermsHeader =
    definedTerms.length > 0
      ? `[DEFINED_TERMS: ${definedTerms.join(', ')}]\n\n`
      : '';

  const boundedChunks = rawBoundedChunks.map((chunk, idx) => {
    if (idx === 0) return chunk;
    const prev = rawBoundedChunks[idx - 1];
    let overlapSlice = '';
    if (overlapChars > 0 && prev.length > 0) {
      const rawTail = prev.slice(Math.max(0, prev.length - overlapChars));
      const boundaryMatch = rawTail.match(/\s/);
      overlapSlice =
        boundaryMatch && boundaryMatch.index !== undefined
          ? rawTail.slice(boundaryMatch.index + 1).trim()
          : rawTail.trim();
    }
    const withOverlap =
      overlapSlice.length > 0 ? `${overlapSlice}\n\n${chunk}` : chunk;
    return definedTermsHeader ? `${definedTermsHeader}${withOverlap}` : withOverlap;
  });

  return {
    chunks: boundedChunks,
    chunkCount: boundedChunks.length,
    estimatedTokens,
    wasChunked: boundedChunks.length > 1 || wasTruncated,
    wasTruncated
  };
}

export function buildSemanticPiiPrompt(redactedText: string): string {
  return [
    'You are LocalShield On-Device Semantic PII Scrubber.',
    'Identify unstructured sensitive entities that regex missed: person names (PERSON), company or organization names (ORG), and internal project codenames (CODENAME).',
    'Do NOT include existing bracketed mask tokens like [EMAIL_1] or [SSN_1].',
    'Return ONLY valid JSON: { "entities": [{ "value": "...", "category": "PERSON" | "ORG" | "CODENAME" }] }.',
    '',
    'DOCUMENT:',
    redactedText.length > 8000
      ? `${redactedText.slice(0, 4000)}\n...\n${redactedText.slice(-4000)}`
      : redactedText
  ].join('\n');
}

export function buildTriagePrompt(
  redactedText: string,
  chunkMeta?: { index: number; total: number; compactForNano?: boolean }
): string {
  const chunkLine =
    chunkMeta && chunkMeta.total > 1
      ? `SECTION CHUNK ${chunkMeta.index + 1} OF ${chunkMeta.total}:`
      : 'DOCUMENT (PII-REDACTED):';
  const sourceText = chunkMeta?.compactForNano
    ? redactedText.slice(0, 3500)
    : redactedText;
  const cuadHints = extractCuadHints(sourceText);
  const cuadHintsLine =
    cuadHints.length > 0 ? `[CUAD_HINTS: ${cuadHints.join(', ')}]` : null;
  const definedTerms = extractDefinedTerms(sourceText, 10);
  const definedTermsLine =
    definedTerms.length > 0
      ? `[DEFINED_TERMS: ${definedTerms.join(', ')}]`
      : null;

  if (chunkMeta?.compactForNano) {
    return [
      'LocalShield contract risk analyzer. Return ONLY valid JSON matching the schema.',
      'Flag high-risk clauses: uncapped indemnity, perpetual IP/AI license, auto-renewal, MFN, anti-assignment, URL modification, liquidated damages, arbitration/class waiver, non-compete, >72h breach notice.',
      'For each clause: exact verbatim excerpt, concrete rationale, drop-in redlineProposal, severity (critical/high/medium/low).',
      ...(cuadHintsLine ? [cuadHintsLine] : []),
      ...(definedTermsLine ? [definedTermsLine] : []),
      chunkLine,
      sourceText
    ].join('\n');
  }

  return [
    'You are LocalShield, an adversarial privacy-first contract and policy risk analyzer representing the reviewing/receiving party against drafter-favorable terms.',
    'Analyze the following PII-redacted document and return ONLY valid JSON matching the schema.',
    'Systematically audit against the CUAD high-risk legal taxonomy, actively hunting for buried, euphemistic, definitional, or cross-referenced traps:',
    '1) Uncapped / Asymmetric Indemnification (e.g., "hold harmless without limitation" or one-sided carve-outs)',
    '2) Irrevocable / Perpetual IP & AI Training Licenses (e.g., "worldwide, royalty-free, sublicensable license to improve services/models")',
    '3) Silent Evergreen Auto-Renewal (e.g., "successive terms unless written notice 60-90 days prior")',
    '4) Most Favored Nation (MFN) / Price Parity clauses',
    '5) Change-of-Control / Anti-Assignment restrictions',
    '6) Unilateral Modification via URL (e.g., "posted at [URL], continued use constitutes acceptance")',
    '7) Liquidated Damages / Disproportionate Penalties',
    '8) Mandatory Arbitration & Class-Action Waiver',
    '9) Non-Compete / Non-Solicit / Exclusivity restraints',
    '10) Delayed Breach Notification (e.g., "commercially reasonable time" or >72h notice)',
    'Follow the Evidence -> Legal Impact -> Counter-Proposal chain for every finding:',
    '- Evidence (excerpt): quote a short, exact verbatim substring from the document; never paraphrase or fabricate.',
    '- Legal Impact (rationale): explain the concrete financial/IP/liability exposure, any defined-term or cross-clause interaction, and worst-case scenario for the reviewing party.',
    '- Counter-Proposal (redlineProposal): provide drop-in replacement contract language (mutual caps, notice windows, explicit carve-outs) rather than generic advice.',
    '- Calibrate severity strictly: critical (uncapped liability, perpetual IP/AI license, unilateral termination/modification), high (asymmetric indemnity, silent auto-renewal, MFN, >72h breach notice), medium (ambiguous SLA/cure), low (minor boilerplate).',
    'Also include crossClauseFindings if multiple clauses or defined terms create compound risk.',
    '',
    ...(cuadHintsLine ? [cuadHintsLine] : []),
    ...(definedTermsLine ? [definedTermsLine] : []),
    chunkLine,
    redactedText
  ].join('\n');
}

export function buildEscalationPrompt(
  redactedText: string,
  triageSummary: DocumentAnalysisResult
): string {
  const clauseList = triageSummary.clauses
    .map((c) => `- [${c.severity.toUpperCase()}] ${c.id}: ${c.title} (${c.category})`)
    .join('\n');
  const cuadHints = extractCuadHints(redactedText);
  const cuadHintsLine =
    cuadHints.length > 0 ? `[CUAD_HINTS: ${cuadHints.join(', ')}]` : null;
  const definedTerms = extractDefinedTerms(redactedText, 12);
  const definedTermsLine =
    definedTerms.length > 0
      ? `[DEFINED_TERMS: ${definedTerms.join(', ')}]`
      : null;

  return [
    'You are LocalShield Cloud Escalation Reviewer, acting as a senior adversarial counsel representing the reviewing/receiving party. The user explicitly consented to send ONLY this PII-redacted text for deep multi-clause cross-referencing.',
    'Execute a two-step Adversarial Verification & Deep Audit:',
    'STEP 1 — AUDIT STAGE 1 TRIAGE: Verify every Stage 1 finding against the full text. Confirm verbatim excerpts exist, upgrade/downgrade severity where Stage 1 missed compound risk or over-flagged standard boilerplate, and sharpen redlines into drop-in contract language.',
    'STEP 2 — HUNT FOR BURIED & CROSS-CLAUSE TRAPS: Resolve all [DEFINED_TERMS] across sections (e.g., Customer Data, Confidential Information, Affiliates, Services) and audit for traps Stage 1 missed: uncapped/asymmetric indemnification, limitation-of-liability carve-outs, irrevocable/perpetual IP & AI training licenses, silent evergreen auto-renewal, MFN, change-of-control/anti-assignment, unilateral modification via URL, liquidated damages, mandatory arbitration & class-action waiver, non-compete/non-solicit, delayed breach notification (>72h), survival traps, and regulatory gaps (GDPR, CCPA, SOC 2).',
    'For every finding, enforce Evidence (exact verbatim excerpt) -> Legal Impact (exposure + cross-clause/defined-term interaction) -> Counter-Proposal (drop-in redline language).',
    'Return ONLY valid JSON matching the schema, including crossClauseFindings.',
    '',
    ...(cuadHintsLine ? [cuadHintsLine] : []),
    ...(definedTermsLine ? [definedTermsLine] : []),
    'STAGE 1 ON-DEVICE TRIAGE FINDINGS:',
    clauseList || '- None detected in initial triage.',
    '',
    'FULL DOCUMENT (PII-REDACTED):',
    redactedText.slice(0, 40000)
  ].join('\n');
}

function extractFirstJsonObject(rawText: string): string {
  const start = rawText.indexOf('{');
  if (start === -1) return rawText.trim();
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < rawText.length; i += 1) {
    const ch = rawText[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return rawText.slice(start, i + 1).trim();
      }
    }
  }
  return rawText.slice(start).trim();
}

function parseSemanticPiiResponse(rawText: string): SemanticPiiEntity[] {
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]
    ? fenced[1].trim()
    : extractFirstJsonObject(rawText);

  try {
    const parsed = JSON.parse(candidate) as { entities?: unknown };
    if (!Array.isArray(parsed.entities)) return [];
    return parsed.entities
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null
      )
      .map((item) => ({
        value: typeof item.value === 'string' ? item.value.trim() : '',
        category:
          typeof item.category === 'string'
            ? item.category.toUpperCase().trim()
            : ''
      }))
      .filter(
        (item): item is SemanticPiiEntity =>
          item.value.length >= 2 &&
          (item.category === 'PERSON' ||
            item.category === 'ORG' ||
            item.category === 'CODENAME')
      );
  } catch {
    return [];
  }
}

function mergeChunkAnalyses(
  analyses: DocumentAnalysisResult[]
): DocumentAnalysisResult {
  if (analyses.length === 1) return analyses[0];

  const clauseMap = new Map<string, RiskClause>();
  const crossMap = new Map<string, DocumentAnalysisResult['crossClauseFindings'][number]>();
  const complianceSet = new Set<string>();
  let maxScore = 0;

  for (const analysis of analyses) {
    if (analysis.overallRiskScore > maxScore) {
      maxScore = analysis.overallRiskScore;
    }
    for (const clause of analysis.clauses) {
      const normalizedExcerpt = clause.excerpt
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .slice(0, 240);
      const normalizedTitle = clause.title
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
      const key = `${clause.category.toLowerCase()}::${normalizedTitle}::${normalizedExcerpt}`;
      const existing = clauseMap.get(key);
      if (
        !existing ||
        SEVERITY_RANK[clause.severity] > SEVERITY_RANK[existing.severity]
      ) {
        clauseMap.set(key, clause);
      }
    }
    for (const finding of analysis.crossClauseFindings) {
      const key = finding.title.toLowerCase();
      if (!crossMap.has(key)) {
        crossMap.set(key, finding);
      }
    }
    for (const flag of analysis.complianceFlags) {
      complianceSet.add(flag);
    }
  }

  const mergedClauses = Array.from(clauseMap.values());
  const rawClauseScore = mergedClauses.reduce((sum, c) => {
    const weight =
      c.severity === 'critical'
        ? 28
        : c.severity === 'high'
          ? 18
          : c.severity === 'medium'
            ? 10
            : 4;
    return sum + weight;
  }, 0);
  const calibratedClauseScore =
    rawClauseScore > 0
      ? Math.round(100 * (1 - Math.exp(-rawClauseScore / 95)))
      : 0;
  const overallRiskScore =
    mergedClauses.length > 0
      ? Math.min(100, Math.max(maxScore, calibratedClauseScore))
      : maxScore;

  const riskPosture: DocumentAnalysisResult['riskPosture'] =
    overallRiskScore >= 75
      ? 'Critical'
      : overallRiskScore >= 50
        ? 'Elevated'
        : overallRiskScore >= 25
          ? 'Moderate'
          : 'Low';

  return {
    documentType: analyses[0].documentType,
    overallRiskScore,
    riskPosture,
    executiveSummary: analyses
      .map((a) => a.executiveSummary)
      .filter((s, idx, arr) => arr.indexOf(s) === idx)
      .join(' '),
    clauses: mergedClauses,
    crossClauseFindings: Array.from(crossMap.values()),
    complianceFlags: Array.from(complianceSet)
  };
}

function normalizeInferenceSource(
  rawSource: InferenceSource | 'on_device' | 'in_cloud' | string | undefined
): 'on_device' | 'in_cloud' {
  if (!rawSource) return 'in_cloud';
  const normalized = String(rawSource).toLowerCase();
  if (normalized === 'on_device') return 'on_device';
  return 'in_cloud';
}

function resolveBadgeFromSource(
  stage: 'triage' | 'escalation',
  source: 'on_device' | 'in_cloud'
): TelemetryBadgeKind {
  if (source === 'on_device') return 'ON-DEVICE';
  return stage === 'triage' ? 'CLOUD FALLBACK' : 'CLOUD ESCALATION';
}

function extractTokenStats(
  prompt: string,
  outputText: string,
  usage?: UsageMetadata
): Pick<
  RunTelemetry,
  'promptTokens' | 'candidateTokens' | 'totalTokens' | 'tokenCountSource'
> {
  if (usage && typeof usage.totalTokenCount === 'number') {
    return {
      promptTokens: usage.promptTokenCount ?? 0,
      candidateTokens: usage.candidatesTokenCount ?? 0,
      totalTokens: usage.totalTokenCount,
      tokenCountSource: 'usage_metadata'
    };
  }
  const promptTokens = estimateTokenCount(prompt);
  const candidateTokens = estimateTokenCount(outputText);
  return {
    promptTokens,
    candidateTokens,
    totalTokens: promptTokens + candidateTokens,
    tokenCountSource: 'estimated'
  };
}

async function invokeModelWithStreaming(
  model: HybridModelRunner,
  request: string | Array<string | Part>,
  options: {
    signal?: AbortSignal;
    onStreamChunk?: (chunkText: string, stage: PipelineStage) => void;
    stage: PipelineStage;
    timeoutMs?: number;
  }
): Promise<{ response: HybridModelResponse; streamed: boolean }> {
  throwIfAborted(options.signal);
  const timeoutMs = options.timeoutMs ?? 45000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Model invocation timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const onParentAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    options.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const reqOpts = { signal: controller.signal };

  try {
    if (typeof model.generateContentStream === 'function') {
      const streamResult = await model.generateContentStream(request, reqOpts);
      for await (const chunk of streamResult.stream) {
        throwIfAborted(controller.signal);
        const piece = chunk.text();
        if (piece) {
          options.onStreamChunk?.(piece, options.stage);
        }
      }
      const response = await streamResult.response;
      throwIfAborted(controller.signal);
      return { response, streamed: true };
    }

    const result = await model.generateContent(request, reqOpts);
    throwIfAborted(controller.signal);
    return { response: result.response, streamed: false };
  } finally {
    clearTimeout(timeoutId);
    if (options.signal) {
      options.signal.removeEventListener('abort', onParentAbort);
    }
  }
}

async function probeTokenBudget(
  model: HybridModelRunner | undefined,
  request: string | Array<string | Part>,
  fallbackText: string
): Promise<{ tokens: number; source: 'sdk_count_tokens' | 'estimated' }> {
  if (model && typeof model.countTokens === 'function') {
    try {
      const counted = await model.countTokens(request);
      if (typeof counted.totalTokens === 'number' && counted.totalTokens >= 0) {
        return { tokens: counted.totalTokens, source: 'sdk_count_tokens' };
      }
    } catch {
      // Fall back to deterministic estimation
    }
  }
  return { tokens: estimateTokenCount(fallbackText), source: 'estimated' };
}

function buildSimulatedCloudEscalation(
  triage: DocumentAnalysisResult,
  redactedText: string
): DocumentAnalysisResult {
  const base = analyzeDocumentHeuristically(redactedText);
  const mergedFindings = [...base.crossClauseFindings];
  if (mergedFindings.length === 0 && triage.clauses.length >= 2) {
    mergedFindings.push({
      id: 'sim-cross-1',
      title: `Compound Obligation Across ${triage.clauses[0].category} & ${triage.clauses[1].category}`,
      involvedClauses: [triage.clauses[0].id, triage.clauses[1].id],
      impact:
        'Combined obligations heighten downstream risk when read alongside termination and dispute clauses.',
      negotiationMove:
        'Negotiate a unified cap and cross-reference notice timelines in Section 1.'
    });
  }
  return {
    ...triage,
    crossClauseFindings: mergedFindings,
    executiveSummary: `${triage.executiveSummary} Cloud escalation cross-referenced ${triage.clauses.length} clause(s) for compound exposure and compliance gaps.`
  };
}

/**
 * Computes structured Stage 1 vs. Stage 2 comparison metrics.
 */
export function computeHybridDelta(
  triage: DocumentAnalysisResult,
  escalation: DocumentAnalysisResult | null,
  triageTelemetry: RunTelemetry,
  escalationTelemetry: RunTelemetry | null,
  semanticPii?: SemanticPiiReport,
  redactionLatencyMs = 0
): HybridDelta {
  const totalLatencyMs =
    redactionLatencyMs +
    (semanticPii?.latencyMs ?? 0) +
    triageTelemetry.latencyMs +
    (escalationTelemetry?.latencyMs ?? 0);
  const combinedTokens =
    triageTelemetry.totalTokens + (escalationTelemetry?.totalTokens ?? 0);

  if (!escalation) {
    return {
      newClausesCount: 0,
      upgradedSeverityCount: 0,
      newCrossClauseCount: 0,
      riskScoreDelta: 0,
      totalLatencyMs,
      combinedTokens
    };
  }

  const triageById = new Map<string, RiskClause>();
  const triageByTitle = new Map<string, RiskClause>();
  for (const clause of triage.clauses) {
    triageById.set(clause.id.toLowerCase(), clause);
    triageByTitle.set(clause.title.toLowerCase().trim(), clause);
  }

  let newClausesCount = 0;
  let upgradedSeverityCount = 0;

  for (const escClause of escalation.clauses) {
    const matched =
      triageById.get(escClause.id.toLowerCase()) ??
      triageByTitle.get(escClause.title.toLowerCase().trim());

    if (!matched) {
      newClausesCount += 1;
    } else if (SEVERITY_RANK[escClause.severity] > SEVERITY_RANK[matched.severity]) {
      upgradedSeverityCount += 1;
    }
  }

  const triageCrossIds = new Set(
    triage.crossClauseFindings.map((f) => f.id.toLowerCase())
  );
  const triageCrossTitles = new Set(
    triage.crossClauseFindings.map((f) => f.title.toLowerCase().trim())
  );
  let newCrossClauseCount = 0;
  for (const escFinding of escalation.crossClauseFindings) {
    if (
      !triageCrossIds.has(escFinding.id.toLowerCase()) &&
      !triageCrossTitles.has(escFinding.title.toLowerCase().trim())
    ) {
      newCrossClauseCount += 1;
    }
  }

  return {
    newClausesCount,
    upgradedSeverityCount,
    newCrossClauseCount,
    riskScoreDelta: escalation.overallRiskScore - triage.overallRiskScore,
    totalLatencyMs,
    combinedTokens
  };
}

export function classifyCloudError(
  err: unknown,
  stage: 'triage' | 'escalation'
): CloudDegradationInfo {
  const rawMessage = err instanceof Error ? err.message : String(err);
  let kind: CloudErrorKind = 'unknown';

  if (
    /app\s*check|401|unauthenticated|invalid.*token|token.*invalid/i.test(
      rawMessage
    )
  ) {
    kind = 'app_check_401';
  } else if (
    /fetch-error|failed to fetch|network|enotfound|econnrefused|timeout|403|429|5\d\d/i.test(
      rawMessage
    )
  ) {
    kind = 'network_or_api';
  }

  if (kind === 'app_check_401') {
    return {
      kind,
      stage,
      summary:
        'Cloud Gemini rejected the request (401 Firebase App Check token missing or invalid).',
      actionHint:
        'Set VITE_APPCHECK_RECAPTCHA_SITE_KEY (and register your debug token in Firebase Console) or switch to Sandbox Simulation.',
      rawMessage
    };
  }

  if (kind === 'network_or_api') {
    return {
      kind,
      stage,
      summary:
        'Cloud Gemini endpoint was unreachable or returned an API fetch error.',
      actionHint:
        'Verify network connectivity and Firebase AI Logic enablement, or run in Sandbox Simulation.',
      rawMessage
    };
  }

  return {
    kind,
    stage,
    summary: `Cloud Gemini ${stage} call failed (${rawMessage}).`,
    actionHint:
      'Review Firebase configuration or switch to Local Heuristic / Sandbox Simulation.',
    rawMessage
  };
}

/**
 * Executes the multi-stage Hybrid Inference pipeline:
 * 0.   Local deterministic PII redaction (always runs first, 0 bytes leave browser)
 * 0.5  Optional On-Device Semantic PII Scrubbing (strictly ONLY_ON_DEVICE via Gemini Nano)
 * 1.   Triage via Firebase AI Logic (streaming + chunk-aware + multimodal)
 * 2.   Optional PII-redacted Cloud Escalation for cross-clause synthesis
 *      (deduplicated automatically if Stage 1 already executed in Cloud)
 */
export async function runHybridDocumentAnalysis(
  rawDocumentText: string,
  options: RouterOptions
): Promise<HybridExecutionReport> {
  const now = options.now ?? (() => Date.now());
  const notes: string[] = [];

  throwIfAborted(options.signal);
  options.onStageChange?.('pii_redaction');
  let redaction = redactSensitiveData(rawDocumentText, {
    customTerms: options.customTerms
  });

  const cacheKey = hashCacheKey(
    [
      redaction.redactedText,
      options.policyMode,
      String(options.runCloudEscalation),
      String(Boolean(options.enableSemanticPii)),
      String(options.isOnline),
      String(options.useSimulatedSandbox),
      options.chromeNanoAvailability,
      options.cloudModelName,
      String(options.maxCharsPerChunk ?? DEFAULT_TRIAGE_CHUNK_CHARS),
      String(options.maxChunks ?? DEFAULT_MAX_CHUNKS),
      JSON.stringify(
        (options.inlineAttachments ?? []).map((att) => {
          const mid = Math.max(0, Math.floor(att.data.length / 2) - 32);
          const digest =
            att.data.slice(0, 64) +
            att.data.slice(mid, mid + 64) +
            att.data.slice(-64);
          return {
            name: att.name ?? '',
            mimeType: att.mimeType,
            length: att.data.length,
            digest
          };
        })
      )
    ].join('|')
  );

  if (!options.bypassCache) {
    const cached = hybridAnalysisCache.get(cacheKey);
    if (cached) {
      hybridAnalysisCache.delete(cacheKey);
      hybridAnalysisCache.set(cacheKey, cached);
      options.onStageChange?.('complete');
      return {
        ...cached,
        notes: [
          ...cached.notes,
          'cached: true — deterministic content-hash cache hit (<5ms).'
        ]
      };
    }
  }

  const cacheAndReturn = (report: HybridExecutionReport): HybridExecutionReport => {
    if (hybridAnalysisCache.size >= MAX_HYBRID_CACHE_ENTRIES) {
      const oldestKey = hybridAnalysisCache.keys().next().value;
      if (oldestKey !== undefined) {
        hybridAnalysisCache.delete(oldestKey);
      }
    }
    hybridAnalysisCache.set(cacheKey, report);
    return report;
  };

  // Stage 0.5: Optional On-Device Semantic PII Scrubbing (strictly ONLY_ON_DEVICE)
  let semanticPii: SemanticPiiReport = {
    status: 'skipped',
    entitiesAdded: 0,
    latencyMs: 0,
    reason: 'Semantic PII scrubbing not enabled.'
  };

  if (options.enableSemanticPii) {
    options.onStageChange?.('semantic_pii');
    const semStart = now();
    if (options.useSimulatedSandbox || !options.modelFactory) {
      semanticPii = {
        status: 'skipped',
        entitiesAdded: 0,
        latencyMs: 0,
        reason: options.useSimulatedSandbox
          ? 'Skipped in Sandbox Simulation mode.'
          : 'Firebase AI model factory unavailable.'
      };
    } else if (options.chromeNanoAvailability !== 'available') {
      semanticPii = {
        status: 'unavailable',
        entitiesAdded: 0,
        latencyMs: 0,
        reason:
          options.chromeNanoAvailability === 'downloadable'
            ? 'Chrome Gemini Nano is downloadable; initialize the on-device model to enable Stage 0.5 semantic PII scrubbing.'
            : `Chrome Gemini Nano status is "${options.chromeNanoAvailability}"; on-device semantic PII scrubbing skipped.`
      };
    } else {
      try {
        const semModel = options.modelFactory('only_on_device', 'semantic_pii');
        const semPrompt = buildSemanticPiiPrompt(redaction.redactedText);
        const { response } = await invokeModelWithStreaming(semModel, semPrompt, {
          signal: options.signal,
          onStreamChunk: options.onStreamChunk,
          stage: 'semantic_pii'
        });
        const entities = parseSemanticPiiResponse(response.text());
        const merged = mergeSemanticRedactions(redaction, entities);
        redaction = merged.result;
        semanticPii = {
          status: 'completed',
          entitiesAdded: merged.entitiesAdded,
          latencyMs: Math.max(1, Math.round(now() - semStart)),
          reason:
            merged.entitiesAdded > 0
              ? `Masked ${merged.entitiesAdded} additional semantic entity token(s) on-device before triage/cloud.`
              : 'On-device semantic scan completed with no additional unstructured entities.'
        };
      } catch (err) {
        if (isAbortError(err)) throw err;
        semanticPii = {
          status: 'failed',
          entitiesAdded: 0,
          latencyMs: Math.max(1, Math.round(now() - semStart)),
          reason:
            err instanceof Error
              ? `On-device semantic PII scan failed (${err.message}); continuing with Stage 0 vault.`
              : 'On-device semantic PII scan failed; continuing with Stage 0 vault.'
        };
      }
    }
    if (semanticPii.reason) {
      notes.push(`Stage 0.5 Semantic PII: ${semanticPii.reason}`);
    }
  }

  // Smart chunking & token budget awareness
  const chunked = chunkDocumentText(
    redaction.redactedText,
    options.maxCharsPerChunk ?? DEFAULT_TRIAGE_CHUNK_CHARS,
    options.maxChunks ?? DEFAULT_MAX_CHUNKS
  );

  let chunkInfo: DocumentChunkInfo = {
    chunkCount: chunked.chunkCount,
    estimatedTokens: chunked.estimatedTokens,
    wasChunked: chunked.wasChunked,
    wasTruncated: chunked.wasTruncated,
    tokenProbeSource: 'estimated'
  };

  if (chunked.wasChunked) {
    notes.push(
      `Smart chunking split document into ${chunked.chunkCount} section-aligned chunk(s) (~${chunked.estimatedTokens} tokens)${
        chunked.wasTruncated ? ' [truncated to max chunk budget]' : ''
      }.`
    );
  }

  options.onStageChange?.('triage');
  let triage: DocumentAnalysisResult;
  let triageTelemetry: RunTelemetry;
  let cloudDegradation: CloudDegradationInfo | undefined;
  let simulatedStage1WasCloud = false;

  const triageStart = now();

  if (options.modelFactory && !options.useSimulatedSandbox) {
    const executeStage1 = async (
      schemaKey: ModelSchemaKey,
      activeChunked: ChunkedDocument
    ) => {
      const model = options.modelFactory!(options.policyMode, schemaKey);
      const compactForNano =
        options.chromeNanoAvailability === 'available' &&
        options.policyMode !== 'only_in_cloud';
      const firstPrompt = buildTriagePrompt(activeChunked.chunks[0], {
        index: 0,
        total: activeChunked.chunkCount,
        compactForNano
      });
      const firstRequest = buildMultimodalContentParts(
        firstPrompt,
        options.inlineAttachments
      );

      const shouldProbeTokens =
        options.policyMode === 'only_on_device' ||
        (activeChunked.chunkCount > 1 && options.policyMode !== 'only_in_cloud');

      const tokenProbe = shouldProbeTokens
        ? await probeTokenBudget(model, firstRequest, redaction.redactedText)
        : {
            tokens: Math.ceil(redaction.redactedText.length / 4),
            source: 'estimated' as const
          };
      chunkInfo = {
        ...chunkInfo,
        chunkCount: activeChunked.chunkCount,
        wasChunked: activeChunked.wasChunked,
        wasTruncated: activeChunked.wasTruncated,
        estimatedTokens:
          activeChunked.chunkCount === 1
            ? tokenProbe.tokens
            : activeChunked.estimatedTokens,
        tokenProbeSource: tokenProbe.source
      };

      const chunkResults: DocumentAnalysisResult[] = [];
      let combinedPromptText = '';
      let combinedOutputText = '';
      let totalPromptTokens = 0;
      let totalCandidateTokens = 0;
      let totalUsageTokens = 0;
      let hasUsageMetadata = false;
      let resolvedSource: 'on_device' | 'in_cloud' = 'in_cloud';
      let anyStreamed = false;

      const runChunk = async (i: number) => {
        throwIfAborted(options.signal);
        const prompt =
          i === 0
            ? firstPrompt
            : buildTriagePrompt(activeChunked.chunks[i], {
                index: i,
                total: activeChunked.chunkCount,
                compactForNano
              });
        const request =
          i === 0
            ? firstRequest
            : buildMultimodalContentParts(prompt, options.inlineAttachments);

        const { response, streamed } = await invokeModelWithStreaming(
          model,
          request,
          {
            signal: options.signal,
            onStreamChunk: options.onStreamChunk,
            stage: 'triage'
          }
        );

        const rawOutput = response.text();
        anyStreamed = anyStreamed || streamed;
        resolvedSource = normalizeInferenceSource(response.inferenceSource);
        combinedPromptText += prompt;
        combinedOutputText += rawOutput;

        if (
          response.usageMetadata &&
          typeof response.usageMetadata.totalTokenCount === 'number'
        ) {
          hasUsageMetadata = true;
          totalPromptTokens += response.usageMetadata.promptTokenCount ?? 0;
          totalCandidateTokens += response.usageMetadata.candidatesTokenCount ?? 0;
          totalUsageTokens += response.usageMetadata.totalTokenCount;
        }

        return {
          analysis: parseStructuredAnalysis(rawOutput, activeChunked.chunks[i]),
          source: normalizeInferenceSource(response.inferenceSource)
        };
      };

      const chunkSources = new Set<'on_device' | 'in_cloud'>();
      if (
        activeChunked.chunkCount > 1 &&
        (options.policyMode === 'only_in_cloud' ||
          options.policyMode === 'prefer_in_cloud')
      ) {
        const concurrentResults = await Promise.all(
          activeChunked.chunks.map((_, i) => runChunk(i))
        );
        for (const item of concurrentResults) {
          chunkResults.push(item.analysis);
          chunkSources.add(item.source);
        }
      } else {
        for (let i = 0; i < activeChunked.chunks.length; i += 1) {
          const item = await runChunk(i);
          chunkResults.push(item.analysis);
          chunkSources.add(item.source);
        }
      }
      resolvedSource = chunkSources.has('in_cloud') ? 'in_cloud' : 'on_device';
      if (chunkSources.size > 1) {
        notes.push(
          'Multi-chunk triage used mixed on-device and in-cloud inference; reported source reflects cloud participation.'
        );
      }

      const stage1Triage = mergeChunkAnalyses(chunkResults);
      const tokenStats = hasUsageMetadata
        ? {
            promptTokens: totalPromptTokens,
            candidateTokens: totalCandidateTokens,
            totalTokens: totalUsageTokens,
            tokenCountSource: 'usage_metadata' as const
          }
        : extractTokenStats(combinedPromptText, combinedOutputText);

      const fallbackReason =
        options.policyMode === 'prefer_on_device' && resolvedSource === 'in_cloud'
          ? `Chrome Gemini Nano status was "${options.chromeNanoAvailability}"; Firebase AI Logic automatically fell back to ${options.cloudModelName}.`
          : options.policyMode === 'prefer_in_cloud' && resolvedSource === 'on_device'
            ? `Cloud inference was unavailable or offline; Firebase AI Logic fell back to on-device execution.`
            : undefined;

      const stage1Telemetry: RunTelemetry = {
        stage: 'triage',
        badge: resolveBadgeFromSource('triage', resolvedSource),
        requestedMode: options.policyMode,
        inferenceSource: resolvedSource,
        modelName:
          resolvedSource === 'on_device'
            ? 'Gemini Nano (Chrome Prompt API)'
            : options.cloudModelName,
        latencyMs: Math.max(1, Math.round(now() - triageStart)),
        ...tokenStats,
        piiMaskedBeforeInference: redaction.totalMasked,
        fallbackReason,
        streamed: anyStreamed,
        chunkCount: chunkInfo.chunkCount,
        estimatedTokens: chunkInfo.estimatedTokens,
        wasChunked: chunkInfo.wasChunked,
        timestamp: new Date().toISOString()
      };

      return { triage: stage1Triage, triageTelemetry: stage1Telemetry };
    };

    try {
      let stage1Result: {
        triage: DocumentAnalysisResult;
        triageTelemetry: RunTelemetry;
      };
      try {
        stage1Result = await executeStage1('document_analysis', chunked);
      } catch (firstErr) {
        const firstMsg =
          firstErr instanceof Error ? firstErr.message : String(firstErr);
        if (
          !isAbortError(firstErr) &&
          /input is too large|quota/i.test(firstMsg)
        ) {
          const liteChunked = chunkDocumentText(
            redaction.redactedText,
            500,
            options.maxChunks ?? 12
          );
          notes.push(
            'Stage 1 on-device Nano hit input/quota limit; retried with unconstrained JSON schema (document_analysis_nano_lite) and 500-char micro-batches.'
          );
          stage1Result = await executeStage1(
            'document_analysis_nano_lite',
            liteChunked
          );
        } else {
          throw firstErr;
        }
      }
      triage = stage1Result.triage;
      triageTelemetry = stage1Result.triageTelemetry;
    } catch (err) {
      if (isAbortError(err) || options.policyMode === 'only_on_device') {
        throw err;
      }
      cloudDegradation = classifyCloudError(err, 'triage');
      triage = analyzeDocumentHeuristically(redaction.redactedText);
      const serialized = JSON.stringify(triage);
      const fallbackPrompt = buildTriagePrompt(chunked.chunks[0]);
      triageTelemetry = {
        stage: 'triage',
        badge: 'LOCAL HEURISTIC',
        requestedMode: options.policyMode,
        inferenceSource: 'local_heuristic',
        modelName: 'LocalShield Deterministic Analyzer',
        latencyMs: Math.max(1, Math.round(now() - triageStart)),
        ...extractTokenStats(fallbackPrompt, serialized),
        piiMaskedBeforeInference: redaction.totalMasked,
        fallbackReason: `${cloudDegradation.summary} ${cloudDegradation.actionHint} Degraded cleanly to 100% in-browser heuristic triage.`,
        streamed: false,
        chunkCount: chunkInfo.chunkCount,
        estimatedTokens: chunkInfo.estimatedTokens,
        wasChunked: chunkInfo.wasChunked,
        timestamp: new Date().toISOString()
      };
    }
  } else if (options.useSimulatedSandbox) {
    const canRunOnDevice = options.chromeNanoAvailability === 'available';

    if (options.policyMode === 'only_on_device' && !canRunOnDevice) {
      throw new Error(
        `ONLY_ON_DEVICE mode selected, but on-device Gemini Nano is ${options.chromeNanoAvailability}.`
      );
    }

    let badge: TelemetryBadgeKind;
    let inferenceSource: RunTelemetry['inferenceSource'] = 'simulated';
    let modelName: string;
    let fallbackReason: string | undefined;

    if (options.policyMode === 'only_on_device') {
      badge = 'SIMULATED ON-DEVICE';
      modelName = 'Sandbox: Gemini Nano (On-Device)';
    } else if (options.policyMode === 'only_in_cloud') {
      badge = 'SIMULATED CLOUD';
      modelName = `Sandbox: ${options.cloudModelName}`;
      simulatedStage1WasCloud = true;
    } else if (options.policyMode === 'prefer_in_cloud') {
      if (options.isOnline) {
        badge = 'SIMULATED CLOUD';
        modelName = `Sandbox: ${options.cloudModelName}`;
        simulatedStage1WasCloud = true;
      } else if (canRunOnDevice) {
        badge = 'SIMULATED ON-DEVICE';
        modelName = 'Sandbox: Gemini Nano (On-Device)';
        fallbackReason = 'Browser offline; simulated fallback to on-device Gemini Nano.';
      } else {
        badge = 'LOCAL HEURISTIC';
        inferenceSource = 'local_heuristic';
        modelName = 'LocalShield Deterministic Analyzer';
        fallbackReason = `Browser offline and Gemini Nano is "${options.chromeNanoAvailability}"; ran local heuristic triage.`;
      }
    } else {
      // prefer_on_device
      if (canRunOnDevice) {
        badge = 'SIMULATED ON-DEVICE';
        modelName = 'Sandbox: Gemini Nano (On-Device)';
      } else if (options.isOnline) {
        badge = 'SIMULATED CLOUD';
        modelName = `Sandbox: ${options.cloudModelName}`;
        simulatedStage1WasCloud = true;
        fallbackReason = `Simulated cloud fallback: Chrome Gemini Nano is "${options.chromeNanoAvailability}", so Sandbox routed honestly to simulated ${options.cloudModelName}.`;
      } else {
        badge = 'LOCAL HEURISTIC';
        inferenceSource = 'local_heuristic';
        modelName = 'LocalShield Deterministic Analyzer';
        fallbackReason = `Browser offline and Chrome Gemini Nano is "${options.chromeNanoAvailability}"; ran local heuristic triage.`;
      }
    }

    triage = analyzeDocumentHeuristically(redaction.redactedText);
    const serialized = JSON.stringify(triage);
    const triagePrompt = buildTriagePrompt(chunked.chunks[0]);
    triageTelemetry = {
      stage: 'triage',
      badge,
      requestedMode: options.policyMode,
      inferenceSource,
      modelName,
      latencyMs: Math.max(12, Math.round(now() - triageStart)),
      ...extractTokenStats(triagePrompt, serialized),
      piiMaskedBeforeInference: redaction.totalMasked,
      fallbackReason,
      streamed: false,
      chunkCount: chunkInfo.chunkCount,
      estimatedTokens: chunkInfo.estimatedTokens,
      wasChunked: chunkInfo.wasChunked,
      note:
        badge === 'SIMULATED CLOUD'
          ? 'Simulated cloud execution (no live cloud quota spent).'
          : badge === 'SIMULATED ON-DEVICE'
            ? 'Simulated on-device execution.'
            : 'Offline deterministic heuristic execution.',
      timestamp: new Date().toISOString()
    };
  } else {
    triage = analyzeDocumentHeuristically(redaction.redactedText);
    const serialized = JSON.stringify(triage);
    const triagePrompt = buildTriagePrompt(chunked.chunks[0]);
    triageTelemetry = {
      stage: 'triage',
      badge: 'LOCAL HEURISTIC',
      requestedMode: options.policyMode,
      inferenceSource: 'local_heuristic',
      modelName: 'LocalShield Deterministic Analyzer',
      latencyMs: Math.max(1, Math.round(now() - triageStart)),
      ...extractTokenStats(triagePrompt, serialized),
      piiMaskedBeforeInference: redaction.totalMasked,
      fallbackReason:
        'Firebase credentials not configured in .env; executed 100% local deterministic triage.',
      streamed: false,
      chunkCount: chunkInfo.chunkCount,
      estimatedTokens: chunkInfo.estimatedTokens,
      wasChunked: chunkInfo.wasChunked,
      timestamp: new Date().toISOString()
    };
  }

  let escalation: DocumentAnalysisResult | null = null;
  let escalationTelemetry: RunTelemetry | null = null;
  let escalationBlockedReason: string | undefined;

  if (options.runCloudEscalation) {
    options.onStageChange?.('escalation');
    const stage1AlreadyInCloud =
      triageTelemetry.inferenceSource === 'in_cloud' || simulatedStage1WasCloud;

    if (options.policyMode === 'only_on_device') {
      escalationBlockedReason =
        'Blocked by Strict Air-Gapped On-Device Policy (InferenceMode.ONLY_ON_DEVICE). Zero outbound requests permitted.';
    } else if (!options.isOnline) {
      escalationBlockedReason =
        'Browser is currently offline. Cloud escalation skipped; Stage 1 on-device/local analysis preserved.';
    } else if (stage1AlreadyInCloud) {
      const dedupReason = `Stage 2 Cloud Escalation deduplicated: Stage 1 already executed in Cloud (${options.cloudModelName}) with full cross-clause schema.`;
      escalationBlockedReason = dedupReason;
      triageTelemetry.deduplicated = true;
      triageTelemetry.note = dedupReason;
      notes.push(dedupReason);
    } else if (options.modelFactory && !options.useSimulatedSandbox) {
      const escStart = now();
      if (redaction.redactedText.length > 40000) {
        chunkInfo = { ...chunkInfo, wasTruncated: true };
        notes.push(
          'Stage 2 Cloud Escalation input was truncated at 40,000 characters.'
        );
      }
      const escPrompt = buildEscalationPrompt(redaction.redactedText, triage);
      const escRequest = buildMultimodalContentParts(
        escPrompt,
        options.inlineAttachments
      );
      try {
        const cloudModel = options.modelFactory(
          'only_in_cloud',
          'document_analysis'
        );
        const { response: escRes, streamed } = await invokeModelWithStreaming(
          cloudModel,
          escRequest,
          {
            signal: options.signal,
            onStreamChunk: options.onStreamChunk,
            stage: 'escalation'
          }
        );
        const rawEsc = escRes.text();
        escalation = parseStructuredAnalysis(rawEsc, redaction.redactedText);
        escalationTelemetry = {
          stage: 'escalation',
          badge: 'CLOUD ESCALATION',
          requestedMode: 'only_in_cloud',
          inferenceSource: 'in_cloud',
          modelName: options.cloudModelName,
          latencyMs: Math.max(1, Math.round(now() - escStart)),
          ...extractTokenStats(escPrompt, rawEsc, escRes.usageMetadata),
          piiMaskedBeforeInference: redaction.totalMasked,
          streamed,
          chunkCount: chunkInfo.chunkCount,
          estimatedTokens: chunkInfo.estimatedTokens,
          wasChunked: chunkInfo.wasChunked,
          timestamp: new Date().toISOString()
        };
      } catch (err) {
        if (isAbortError(err)) throw err;
        const escDegradation = classifyCloudError(err, 'escalation');
        cloudDegradation = cloudDegradation ?? escDegradation;
        escalationBlockedReason = `${escDegradation.summary} ${escDegradation.actionHint} Preserved local Stage 1 & deterministic cross-clause findings.`;

        if (triageTelemetry.inferenceSource === 'on_device') {
          escalation = buildSimulatedCloudEscalation(triage, redaction.redactedText);
          const serialized = JSON.stringify(escalation);
          escalationTelemetry = {
            stage: 'escalation',
            badge: 'LOCAL HEURISTIC',
            requestedMode: 'only_in_cloud',
            inferenceSource: 'local_heuristic',
            modelName: 'Local Cross-Clause Fallback',
            latencyMs: Math.max(1, Math.round(now() - escStart)),
            ...extractTokenStats(escPrompt, serialized),
            piiMaskedBeforeInference: redaction.totalMasked,
            fallbackReason: escDegradation.summary,
            streamed: false,
            timestamp: new Date().toISOString()
          };
        }
      }
    } else if (options.useSimulatedSandbox) {
      const escStart = now();
      const escPrompt = buildEscalationPrompt(redaction.redactedText, triage);
      escalation = buildSimulatedCloudEscalation(triage, redaction.redactedText);
      const serialized = JSON.stringify(escalation);
      escalationTelemetry = {
        stage: 'escalation',
        badge: 'SIMULATED CLOUD',
        requestedMode: 'only_in_cloud',
        inferenceSource: 'simulated',
        modelName: `Sandbox: ${options.cloudModelName} (App Check Protected)`,
        latencyMs: Math.max(18, Math.round(now() - escStart)),
        ...extractTokenStats(escPrompt, serialized),
        piiMaskedBeforeInference: redaction.totalMasked,
        streamed: false,
        note: 'Simulated cloud escalation after on-device/local Stage 1 triage.',
        timestamp: new Date().toISOString()
      };
    } else {
      escalationBlockedReason =
        'Cloud escalation requires Firebase .env configuration (or Sandbox preview mode).';
    }
  }

  const delta = computeHybridDelta(
    triage,
    escalation,
    triageTelemetry,
    escalationTelemetry,
    semanticPii
  );

  options.onStageChange?.('complete');

  return cacheAndReturn({
    redaction,
    semanticPii,
    chunkInfo,
    triage,
    escalation,
    triageTelemetry,
    escalationTelemetry,
    delta,
    notes,
    escalationBlockedReason,
    cloudDegradation
  });
}

export interface ClauseNegotiatorParams {
  clause: RiskClause;
  redactedDocumentContext: string;
  policyMode?: HybridPolicyMode;
  isOnline: boolean;
  chromeNanoAvailability: ChromeNanoAvailability;
  useSimulatedSandbox?: boolean;
  modelFactory?: ModelFactory;
}

export interface ClauseNegotiator {
  effectiveMode: HybridPolicyMode;
  sendMessage: (
    userMessage: string,
    options?: {
      signal?: AbortSignal;
      onStreamChunk?: (chunkText: string) => void;
    }
  ) => Promise<ClauseNegotiationMessage>;
  getHistory: () => ClauseNegotiationMessage[];
}

function buildClauseSeedPrompt(
  clause: RiskClause,
  redactedDocumentContext: string
): string {
  return [
    'You are negotiating the following PII-redacted contract clause on behalf of the customer.',
    `Clause ID: ${clause.id} | Severity: ${clause.severity.toUpperCase()} | Category: ${clause.category}`,
    `Title: ${clause.title}`,
    `Excerpt: "${clause.excerpt}"`,
    `Identified Risk: ${clause.rationale}`,
    `Baseline Redline Proposal: ${clause.redlineProposal}`,
    '',
    'REDACTED CONTRACT CONTEXT (EXCERPT):',
    redactedDocumentContext.slice(0, 4000)
  ].join('\n');
}

function buildOfflineNegotiationFallback(
  clause: RiskClause,
  userMessage: string
): string {
  return [
    `Offline / Sandbox Negotiation Guidance for "${clause.title}" (${clause.severity.toUpperCase()}):`,
    `- Counter-Proposal: ${clause.redlineProposal}`,
    `- Rationale to Cite: ${clause.rationale}`,
    `- Response to your prompt ("${userMessage.trim().slice(0, 140)}"): Propose anchoring on mutual obligations, explicit caps, and written notice timelines before signing.`
  ].join('\n');
}

/**
 * Creates a multi-turn per-clause hybrid negotiation session backed by
 * Firebase AI Logic model.startChat() using PREFER_ON_DEVICE (or ONLY_ON_DEVICE
 * when offline or air-gapped) strictly against PII-redacted context.
 */
export function createClauseNegotiator(
  params: ClauseNegotiatorParams
): ClauseNegotiator {
  const effectiveMode: HybridPolicyMode =
    !params.isOnline || params.policyMode === 'only_on_device'
      ? 'only_on_device'
      : params.policyMode ?? 'prefer_on_device';

  const history: ClauseNegotiationMessage[] = [];
  let chatSession: HybridChatSession | null = null;

  const ensureChat = (): HybridChatSession | null => {
    if (chatSession) return chatSession;
    if (!params.modelFactory || params.useSimulatedSandbox) {
      return null;
    }
    if (!params.isOnline && params.chromeNanoAvailability !== 'available') {
      return null;
    }
    const model = params.modelFactory(effectiveMode, 'negotiation_chat');
    if (typeof model.startChat !== 'function') {
      return null;
    }
    chatSession = model.startChat({
      history: [
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              text: buildClauseSeedPrompt(
                params.clause,
                params.redactedDocumentContext
              )
            }
          ]
        },
        {
          role: 'model',
          parts: [
            {
              type: 'text',
              text: `Ready to negotiate "${params.clause.title}" using the PII-redacted context.`
            }
          ]
        }
      ]
    });
    return chatSession;
  };

  const sendMessage: ClauseNegotiator['sendMessage'] = async (
    userMessage,
    turnOptions
  ) => {
    throwIfAborted(turnOptions?.signal);

    history.push({
      role: 'user',
      text: userMessage,
      timestamp: new Date().toISOString()
    });

    const chat = ensureChat();
    if (!chat) {
      const reply: ClauseNegotiationMessage = {
        role: 'model',
        text: buildOfflineNegotiationFallback(params.clause, userMessage),
        inferenceSource: params.useSimulatedSandbox
          ? 'simulated'
          : 'local_heuristic',
        streamed: false,
        timestamp: new Date().toISOString()
      };
      history.push(reply);
      return reply;
    }

    const reqOpts = turnOptions?.signal
      ? { signal: turnOptions.signal }
      : undefined;

    let response: HybridModelResponse;
    let streamed = false;

    try {
      if (typeof chat.sendMessageStream === 'function') {
        const streamRes = await chat.sendMessageStream(userMessage, reqOpts);
        for await (const chunk of streamRes.stream) {
          throwIfAborted(turnOptions?.signal);
          const piece = chunk.text();
          if (piece) {
            turnOptions?.onStreamChunk?.(piece);
          }
        }
        response = await streamRes.response;
        streamed = true;
      } else {
        const res = await chat.sendMessage(userMessage, reqOpts);
        response = res.response;
      }
    } catch (err) {
      if (
        (err instanceof Error && err.name === 'AbortError') ||
        turnOptions?.signal?.aborted
      ) {
        history.pop();
        throw err;
      }
      const fallbackReply: ClauseNegotiationMessage = {
        role: 'model',
        text: buildOfflineNegotiationFallback(params.clause, userMessage),
        inferenceSource: 'local_heuristic',
        streamed: false,
        timestamp: new Date().toISOString()
      };
      history.push(fallbackReply);
      return fallbackReply;
    }

    throwIfAborted(turnOptions?.signal);

    const reply: ClauseNegotiationMessage = {
      role: 'model',
      text: response.text(),
      inferenceSource: normalizeInferenceSource(response.inferenceSource),
      streamed,
      timestamp: new Date().toISOString()
    };
    history.push(reply);
    return reply;
  };

  return {
    effectiveMode,
    sendMessage,
    getHistory: () => [...history]
  };
}

/**
 * Single-turn convenience wrapper for stateless clause negotiation calls.
 */
export async function negotiateClauseTurn(
  params: ClauseNegotiatorParams & {
    userMessage: string;
    signal?: AbortSignal;
    onStreamChunk?: (chunkText: string) => void;
  }
): Promise<ClauseNegotiationMessage> {
  const negotiator = createClauseNegotiator(params);
  return negotiator.sendMessage(params.userMessage, {
    signal: params.signal,
    onStreamChunk: params.onStreamChunk
  });
}
