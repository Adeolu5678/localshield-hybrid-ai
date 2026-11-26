export type HybridPolicyMode =
  | 'prefer_on_device'
  | 'only_on_device'
  | 'prefer_in_cloud'
  | 'only_in_cloud';

export type TelemetryBadgeKind =
  | 'ON-DEVICE'
  | 'CLOUD FALLBACK'
  | 'CLOUD ESCALATION'
  | 'SIMULATED ON-DEVICE'
  | 'SIMULATED CLOUD'
  | 'LOCAL HEURISTIC';

export type ChromeNanoAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'
  | 'unsupported';

export type AppCheckMode =
  | 'recaptcha-enterprise'
  | 'recaptcha-v3'
  | 'debug-token'
  | 'unconfigured'
  | 'error';

export interface AppCheckStatus {
  mode: AppCheckMode;
  initialized: boolean;
  limitedUseTokens: boolean;
  tokenVerified: boolean;
  tokenPreview?: string;
  lastCheckedAt?: string;
  note: string;
}

export interface FirebaseRuntimeStatus {
  configured: boolean;
  projectId?: string;
  cloudModel: string;
  appCheck: AppCheckStatus;
  missingEnvKeys: string[];
}

export type PiiCategory =
  | 'API_SECRET'
  | 'AWS_KEY'
  | 'JWT'
  | 'PEM_KEY'
  | 'SSN'
  | 'EIN'
  | 'CARD'
  | 'IBAN'
  | 'EMAIL'
  | 'PHONE'
  | 'IPV4'
  | 'IPV6'
  | 'ADDRESS'
  | 'CUSTOM'
  | 'PERSON'
  | 'ORG'
  | 'CODENAME';

export type SemanticPiiCategory = 'PERSON' | 'ORG' | 'CODENAME';

export interface SemanticPiiEntity {
  value: string;
  category: SemanticPiiCategory;
}

export interface SemanticPiiReport {
  status: 'completed' | 'skipped' | 'unavailable' | 'failed';
  entitiesAdded: number;
  latencyMs: number;
  reason?: string;
}

export interface PiiMatch {
  token: string;
  category: PiiCategory;
  original: string;
  start: number;
  end: number;
}

export interface RedactionResult {
  originalText: string;
  redactedText: string;
  matches: PiiMatch[];
  vault: Record<string, string>;
  countsByCategory: Record<PiiCategory, number>;
  totalMasked: number;
}

export type ClauseSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface RiskClause {
  id: string;
  title: string;
  category: string;
  severity: ClauseSeverity;
  excerpt: string;
  rationale: string;
  redlineProposal: string;
}

export interface CrossClauseFinding {
  id: string;
  title: string;
  involvedClauses: string[];
  impact: string;
  negotiationMove: string;
}

export interface DocumentAnalysisResult {
  documentType: string;
  overallRiskScore: number;
  riskPosture: 'Critical' | 'Elevated' | 'Moderate' | 'Low';
  executiveSummary: string;
  clauses: RiskClause[];
  crossClauseFindings: CrossClauseFinding[];
  complianceFlags: string[];
}

export interface InlineAttachment {
  mimeType: string;
  data: string;
  name?: string;
}

export interface DocumentChunkInfo {
  chunkCount: number;
  estimatedTokens: number;
  wasChunked: boolean;
  wasTruncated: boolean;
  tokenProbeSource: 'sdk_count_tokens' | 'estimated';
}

export type PipelineStage =
  | 'pii_redaction'
  | 'semantic_pii'
  | 'triage'
  | 'escalation'
  | 'complete';

export interface RunTelemetry {
  stage: 'triage' | 'escalation';
  badge: TelemetryBadgeKind;
  requestedMode: HybridPolicyMode;
  inferenceSource: 'on_device' | 'in_cloud' | 'local_heuristic' | 'simulated';
  modelName: string;
  latencyMs: number;
  promptTokens: number;
  candidateTokens: number;
  totalTokens: number;
  tokenCountSource: 'usage_metadata' | 'estimated';
  piiMaskedBeforeInference: number;
  fallbackReason?: string;
  streamed?: boolean;
  chunkCount?: number;
  estimatedTokens?: number;
  wasChunked?: boolean;
  deduplicated?: boolean;
  note?: string;
  timestamp: string;
}

export interface HybridDelta {
  newClausesCount: number;
  upgradedSeverityCount: number;
  newCrossClauseCount: number;
  riskScoreDelta: number;
  totalLatencyMs: number;
  combinedTokens: number;
}

export type CloudErrorKind = 'app_check_401' | 'network_or_api' | 'unknown';

export interface CloudDegradationInfo {
  kind: CloudErrorKind;
  stage: 'triage' | 'escalation';
  summary: string;
  actionHint: string;
  rawMessage: string;
}

export interface HybridExecutionReport {
  redaction: RedactionResult;
  semanticPii?: SemanticPiiReport;
  chunkInfo?: DocumentChunkInfo;
  triage: DocumentAnalysisResult;
  escalation: DocumentAnalysisResult | null;
  triageTelemetry: RunTelemetry;
  escalationTelemetry: RunTelemetry | null;
  delta: HybridDelta;
  notes: string[];
  escalationBlockedReason?: string;
  cloudDegradation?: CloudDegradationInfo;
}

export interface ClauseNegotiationMessage {
  role: 'user' | 'model';
  text: string;
  inferenceSource?: 'on_device' | 'in_cloud' | 'simulated' | 'local_heuristic';
  streamed?: boolean;
  timestamp: string;
}
