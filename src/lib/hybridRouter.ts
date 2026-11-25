import type { InferenceSource, UsageMetadata } from 'firebase/ai';
import {
  analyzeDocumentHeuristically,
  parseStructuredAnalysis
} from './analysisParser';
import { estimateTokenCount, redactSensitiveData } from './piiRedactor';
import type {
  ChromeNanoAvailability,
  CloudDegradationInfo,
  CloudErrorKind,
  DocumentAnalysisResult,
  HybridExecutionReport,
  HybridPolicyMode,
  RunTelemetry,
  TelemetryBadgeKind
} from '../types/analysis';

export interface HybridModelResponse {
  text: () => string;
  inferenceSource?: InferenceSource | 'on_device' | 'in_cloud';
  usageMetadata?: UsageMetadata;
}

export interface HybridModelRunner {
  generateContent: (prompt: string) => Promise<{ response: HybridModelResponse }>;
  initializeDeviceModel?: (
    onDownloadProgress?: (progressValue: number) => void
  ) => Promise<void>;
}

export type ModelFactory = (mode: HybridPolicyMode) => HybridModelRunner;

export interface RouterOptions {
  policyMode: HybridPolicyMode;
  runCloudEscalation: boolean;
  isOnline: boolean;
  chromeNanoAvailability: ChromeNanoAvailability;
  useSimulatedSandbox: boolean;
  cloudModelName: string;
  modelFactory?: ModelFactory;
  now?: () => number;
}

interface ChromeLanguageModelGlobal {
  availability?: (options?: unknown) => Promise<string>;
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

export function buildTriagePrompt(redactedText: string): string {
  return [
    'You are LocalShield, a privacy-first contract and policy risk analyzer.',
    'Analyze the following PII-redacted document and return ONLY valid JSON matching the schema.',
    'Identify risky clauses (liability, AI data training, auto-renewal, arbitration, unilateral modifications, breach delays), assign severity (critical/high/medium/low), quote short excerpts, explain rationale, and propose concrete redline counter-language.',
    '',
    'DOCUMENT (PII-REDACTED):',
    redactedText.slice(0, 12000)
  ].join('\n');
}

export function buildEscalationPrompt(
  redactedText: string,
  triageSummary: DocumentAnalysisResult
): string {
  const clauseList = triageSummary.clauses
    .map((c) => `- [${c.severity.toUpperCase()}] ${c.id}: ${c.title} (${c.category})`)
    .join('\n');

  return [
    'You are LocalShield Cloud Escalation Reviewer. The user explicitly consented to send ONLY this PII-redacted text for deep multi-clause cross-referencing.',
    'Perform cross-clause contradiction analysis, compound liability interactions, regulatory compliance gaps (GDPR, CCPA, SOC 2), and executive negotiation strategy.',
    'Return ONLY valid JSON matching the schema, including crossClauseFindings.',
    '',
    'STAGE 1 ON-DEVICE TRIAGE FINDINGS:',
    clauseList || '- None detected in initial triage.',
    '',
    'FULL DOCUMENT (PII-REDACTED):',
    redactedText.slice(0, 24000)
  ].join('\n');
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
 * Executes the 2-stage Hybrid Inference pipeline:
 * 0. Local deterministic PII redaction (always runs first, 0 bytes leave browser)
 * 1. Triage via Firebase AI Logic (PREFER_ON_DEVICE -> Gemini Nano or Cloud Fallback)
 * 2. Optional PII-redacted Cloud Escalation for cross-clause synthesis (blocked in air-gap / offline)
 */
export async function runHybridDocumentAnalysis(
  rawDocumentText: string,
  options: RouterOptions
): Promise<HybridExecutionReport> {
  const now = options.now ?? (() => Date.now());
  const redaction = redactSensitiveData(rawDocumentText);
  const triagePrompt = buildTriagePrompt(redaction.redactedText);

  let triage: DocumentAnalysisResult;
  let triageTelemetry: RunTelemetry;
  let cloudDegradation: CloudDegradationInfo | undefined;

  const triageStart = now();

  if (options.modelFactory && !options.useSimulatedSandbox) {
    try {
      const model = options.modelFactory(options.policyMode);
      const result = await model.generateContent(triagePrompt);
      const rawOutput = result.response.text();
      const source =
        result.response.inferenceSource === 'on_device' ? 'on_device' : 'in_cloud';
      const fallbackReason =
        options.policyMode === 'prefer_on_device' && source === 'in_cloud'
          ? `Chrome Gemini Nano status was "${options.chromeNanoAvailability}"; Firebase AI Logic automatically fell back to ${options.cloudModelName}.`
          : undefined;

      triage = parseStructuredAnalysis(rawOutput, redaction.redactedText);
      const tokenStats = extractTokenStats(
        triagePrompt,
        rawOutput,
        result.response.usageMetadata
      );

      triageTelemetry = {
        stage: 'triage',
        badge: resolveBadgeFromSource('triage', source),
        requestedMode: options.policyMode,
        inferenceSource: source,
        modelName:
          source === 'on_device' ? 'Gemini Nano (Chrome Prompt API)' : options.cloudModelName,
        latencyMs: Math.max(1, Math.round(now() - triageStart)),
        ...tokenStats,
        piiMaskedBeforeInference: redaction.totalMasked,
        fallbackReason,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      if (options.policyMode === 'only_on_device') {
        throw err;
      }
      cloudDegradation = classifyCloudError(err, 'triage');
      triage = analyzeDocumentHeuristically(redaction.redactedText);
      const serialized = JSON.stringify(triage);
      triageTelemetry = {
        stage: 'triage',
        badge: 'LOCAL HEURISTIC',
        requestedMode: options.policyMode,
        inferenceSource: 'local_heuristic',
        modelName: 'LocalShield Deterministic Analyzer',
        latencyMs: Math.max(1, Math.round(now() - triageStart)),
        ...extractTokenStats(triagePrompt, serialized),
        piiMaskedBeforeInference: redaction.totalMasked,
        fallbackReason: `${cloudDegradation.summary} ${cloudDegradation.actionHint} Degraded cleanly to 100% in-browser heuristic triage.`,
        timestamp: new Date().toISOString()
      };
    }
  } else if (options.useSimulatedSandbox) {
    const canRunOnDevice =
      options.chromeNanoAvailability === 'available' ||
      options.policyMode === 'only_on_device' ||
      options.policyMode === 'prefer_on_device';
    const simulatedSource: 'on_device' | 'in_cloud' =
      options.policyMode === 'only_in_cloud' ||
      (options.policyMode === 'prefer_in_cloud' && options.isOnline) ||
      (!canRunOnDevice && options.isOnline)
        ? 'in_cloud'
        : 'on_device';

    if (
      options.policyMode === 'only_on_device' &&
      options.chromeNanoAvailability === 'unavailable'
    ) {
      throw new Error(
        'ONLY_ON_DEVICE mode selected, but on-device Gemini Nano is unavailable.'
      );
    }

    triage = analyzeDocumentHeuristically(redaction.redactedText);
    const serialized = JSON.stringify(triage);
    triageTelemetry = {
      stage: 'triage',
      badge:
        simulatedSource === 'on_device'
          ? 'SIMULATED ON-DEVICE'
          : 'SIMULATED CLOUD',
      requestedMode: options.policyMode,
      inferenceSource: 'simulated',
      modelName:
        simulatedSource === 'on_device'
          ? 'Sandbox: Gemini Nano (On-Device)'
          : `Sandbox: ${options.cloudModelName}`,
      latencyMs: Math.max(12, Math.round(now() - triageStart)),
      ...extractTokenStats(triagePrompt, serialized),
      piiMaskedBeforeInference: redaction.totalMasked,
      fallbackReason:
        simulatedSource === 'in_cloud' && options.policyMode === 'prefer_on_device'
          ? `Simulated fallback from on-device (${options.chromeNanoAvailability}) to cloud.`
          : undefined,
      timestamp: new Date().toISOString()
    };
  } else {
    triage = analyzeDocumentHeuristically(redaction.redactedText);
    const serialized = JSON.stringify(triage);
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
      timestamp: new Date().toISOString()
    };
  }

  let escalation: DocumentAnalysisResult | null = null;
  let escalationTelemetry: RunTelemetry | null = null;
  let escalationBlockedReason: string | undefined;

  if (options.runCloudEscalation) {
    if (options.policyMode === 'only_on_device') {
      escalationBlockedReason =
        'Blocked by Strict Air-Gapped On-Device Policy (InferenceMode.ONLY_ON_DEVICE). Zero outbound requests permitted.';
    } else if (!options.isOnline) {
      escalationBlockedReason =
        'Browser is currently offline. Cloud escalation skipped; Stage 1 on-device/local analysis preserved.';
    } else if (options.modelFactory && !options.useSimulatedSandbox) {
      const escStart = now();
      const escPrompt = buildEscalationPrompt(redaction.redactedText, triage);
      try {
        const cloudModel = options.modelFactory('only_in_cloud');
        const escRes = await cloudModel.generateContent(escPrompt);
        const rawEsc = escRes.response.text();
        escalation = parseStructuredAnalysis(rawEsc, redaction.redactedText);
        escalationTelemetry = {
          stage: 'escalation',
          badge: 'CLOUD ESCALATION',
          requestedMode: 'only_in_cloud',
          inferenceSource: 'in_cloud',
          modelName: options.cloudModelName,
          latencyMs: Math.max(1, Math.round(now() - escStart)),
          ...extractTokenStats(escPrompt, rawEsc, escRes.response.usageMetadata),
          piiMaskedBeforeInference: redaction.totalMasked,
          timestamp: new Date().toISOString()
        };
      } catch (err) {
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
        timestamp: new Date().toISOString()
      };
    } else {
      escalationBlockedReason =
        'Cloud escalation requires Firebase .env configuration (or Sandbox preview mode).';
    }
  }

  return {
    redaction,
    triage,
    escalation,
    triageTelemetry,
    escalationTelemetry,
    escalationBlockedReason,
    cloudDegradation
  };
}
