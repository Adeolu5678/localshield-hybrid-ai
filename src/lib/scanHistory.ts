import { redactDocument } from './piiRedactor';
import type {
  DocumentAnalysisResult,
  HybridExecutionReport,
  PiiCategory,
  RiskClause
} from '../types/analysis';

export const HISTORY_DB_NAME = 'localshield-history-v1';
export const HISTORY_DB_VERSION = 1;
export const HISTORY_STORE_NAME = 'scans';
export const MAX_HISTORY_RECORDS = 25;

export interface ScanHistoryRecord {
  id: string;
  title: string;
  savedAt: string;
  riskScore: number;
  riskLabel: DocumentAnalysisResult['riskPosture'];
  routeLabel: string;
  piiCount: number;
  clauseCount: number;
  redactedText: string;
  reportSummary: string;
  clauses: RiskClause[];
  documentType?: string;
  complianceFlags?: string[];
}

const memoryStore = new Map<string, ScanHistoryRecord>();

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function scrubText(value: string): string {
  if (!value) return '';
  return redactDocument(value).redactedText;
}

function sanitizeClause(clause: RiskClause): RiskClause {
  return {
    id: clause.id,
    title: scrubText(clause.title),
    category: clause.category,
    severity: clause.severity,
    excerpt: scrubText(clause.excerpt),
    rationale: scrubText(clause.rationale),
    redlineProposal: scrubText(clause.redlineProposal)
  };
}

export function sanitizeScanRecord(
  record: ScanHistoryRecord
): ScanHistoryRecord {
  const sanitizedClauses = Array.isArray(record.clauses)
    ? record.clauses.map(sanitizeClause)
    : [];

  return {
    id: record.id,
    title: scrubText(record.title || 'Untitled Scan').slice(0, 140),
    savedAt: record.savedAt || new Date().toISOString(),
    riskScore: Number.isFinite(record.riskScore)
      ? Math.max(0, Math.min(100, Math.round(record.riskScore)))
      : 0,
    riskLabel: record.riskLabel,
    routeLabel: record.routeLabel || 'LOCAL HEURISTIC',
    piiCount: Math.max(0, Math.round(record.piiCount || 0)),
    clauseCount: sanitizedClauses.length,
    redactedText: scrubText(record.redactedText),
    reportSummary: scrubText(record.reportSummary),
    clauses: sanitizedClauses,
    documentType: record.documentType
      ? scrubText(record.documentType)
      : undefined,
    complianceFlags: Array.isArray(record.complianceFlags)
      ? record.complianceFlags.map((flag) => scrubText(flag))
      : undefined
  };
}

function sortNewestFirst(records: ScanHistoryRecord[]): ScanHistoryRecord[] {
  return [...records].sort((a, b) => {
    const timeDiff = Date.parse(b.savedAt) - Date.parse(a.savedAt);
    if (!Number.isNaN(timeDiff) && timeDiff !== 0) {
      return timeDiff;
    }
    return b.savedAt.localeCompare(a.savedAt);
  });
}

function createRecordId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `scan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildScanHistoryRecord(
  title: string,
  report: HybridExecutionReport
): ScanHistoryRecord {
  const activeAnalysis = report.escalation ?? report.triage;
  const routeLabel = report.escalationTelemetry
    ? `${report.triageTelemetry.badge} → ${report.escalationTelemetry.badge}`
    : report.triageTelemetry.badge;

  return sanitizeScanRecord({
    id: createRecordId(),
    title: title.trim() || activeAnalysis.documentType || 'Untitled Scan',
    savedAt: new Date().toISOString(),
    riskScore: activeAnalysis.overallRiskScore,
    riskLabel: activeAnalysis.riskPosture,
    routeLabel,
    piiCount: report.redaction.totalMasked,
    clauseCount: activeAnalysis.clauses.length,
    redactedText: report.redaction.redactedText,
    reportSummary: activeAnalysis.executiveSummary,
    clauses: activeAnalysis.clauses,
    documentType: activeAnalysis.documentType,
    complianceFlags: activeAnalysis.complianceFlags
  });
}

function emptyPiiCounts(): Record<PiiCategory, number> {
  return {
    API_SECRET: 0,
    AWS_KEY: 0,
    JWT: 0,
    SSN: 0,
    EIN: 0,
    CARD: 0,
    IBAN: 0,
    EMAIL: 0,
    PHONE: 0,
    IPV4: 0,
    ADDRESS: 0,
    CUSTOM: 0,
    PERSON: 0,
    ORG: 0,
    CODENAME: 0
  };
}

export function reconstructReportFromHistory(
  record: ScanHistoryRecord
): HybridExecutionReport {
  const analysis: DocumentAnalysisResult = {
    documentType: record.documentType ?? 'Saved Redacted Brief',
    overallRiskScore: record.riskScore,
    riskPosture: record.riskLabel,
    executiveSummary: record.reportSummary,
    clauses: record.clauses,
    crossClauseFindings: [],
    complianceFlags: record.complianceFlags ?? []
  };

  return {
    redaction: {
      originalText: record.redactedText,
      redactedText: record.redactedText,
      matches: [],
      vault: {},
      countsByCategory: emptyPiiCounts(),
      totalMasked: record.piiCount
    },
    triage: analysis,
    escalation: null,
    triageTelemetry: {
      stage: 'triage',
      badge: 'LOCAL HEURISTIC',
      requestedMode: 'only_on_device',
      inferenceSource: 'local_heuristic',
      modelName: `Local History (${record.routeLabel})`,
      latencyMs: 0,
      promptTokens: 0,
      candidateTokens: 0,
      totalTokens: 0,
      tokenCountSource: 'estimated',
      piiMaskedBeforeInference: record.piiCount,
      note: `Reloaded strictly redacted brief saved on ${record.savedAt}.`,
      timestamp: record.savedAt
    },
    escalationTelemetry: null,
    delta: {
      newClausesCount: 0,
      upgradedSeverityCount: 0,
      newCrossClauseCount: 0,
      riskScoreDelta: 0,
      totalLatencyMs: 0,
      combinedTokens: 0
    },
    notes: [
      `Loaded from local IndexedDB history (${record.savedAt}). Raw PII was never stored.`
    ]
  };
}

function openHistoryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
        const store = db.createObjectStore(HISTORY_STORE_NAME, {
          keyPath: 'id'
        });
        store.createIndex('savedAt', 'savedAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to open IndexedDB history.'));
  });
}

function runIdbTransaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  executor: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE_NAME, mode);
    const store = tx.objectStore(HISTORY_STORE_NAME);
    const req = executor(store);

    let resultValue: T;
    req.onsuccess = () => {
      resultValue = req.result;
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed.'));
    };
    tx.oncomplete = () => resolve(resultValue);
    tx.onerror = () =>
      reject(tx.error ?? new Error('IndexedDB transaction failed.'));
  });
}

function pruneMemoryStore(): void {
  if (memoryStore.size <= MAX_HISTORY_RECORDS) return;
  const sorted = sortNewestFirst(Array.from(memoryStore.values()));
  const toDrop = sorted.slice(MAX_HISTORY_RECORDS);
  for (const item of toDrop) {
    memoryStore.delete(item.id);
  }
}

export async function saveScanRecord(
  record: ScanHistoryRecord
): Promise<ScanHistoryRecord> {
  const sanitized = sanitizeScanRecord(record);

  if (!hasIndexedDb()) {
    memoryStore.set(sanitized.id, sanitized);
    pruneMemoryStore();
    return sanitized;
  }

  try {
    const db = await openHistoryDb();
    try {
      await runIdbTransaction(db, 'readwrite', (store) => store.put(sanitized));
      const all = await runIdbTransaction<ScanHistoryRecord[]>(
        db,
        'readonly',
        (store) => store.getAll()
      );
      if (all.length > MAX_HISTORY_RECORDS) {
        const sorted = sortNewestFirst(all);
        const overflow = sorted.slice(MAX_HISTORY_RECORDS);
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(HISTORY_STORE_NAME, 'readwrite');
          const store = tx.objectStore(HISTORY_STORE_NAME);
          for (const item of overflow) {
            store.delete(item.id);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () =>
            reject(tx.error ?? new Error('Failed to prune scan history.'));
        });
      }
      return sanitized;
    } finally {
      db.close();
    }
  } catch {
    memoryStore.set(sanitized.id, sanitized);
    pruneMemoryStore();
    return sanitized;
  }
}

export async function listScanRecords(
  limit: number = MAX_HISTORY_RECORDS
): Promise<ScanHistoryRecord[]> {
  const safeLimit = Math.max(0, Math.min(limit, MAX_HISTORY_RECORDS));

  if (!hasIndexedDb()) {
    return sortNewestFirst(Array.from(memoryStore.values())).slice(
      0,
      safeLimit
    );
  }

  try {
    const db = await openHistoryDb();
    try {
      const all = await runIdbTransaction<ScanHistoryRecord[]>(
        db,
        'readonly',
        (store) => store.getAll()
      );
      return sortNewestFirst(all).slice(0, safeLimit);
    } finally {
      db.close();
    }
  } catch {
    return sortNewestFirst(Array.from(memoryStore.values())).slice(
      0,
      safeLimit
    );
  }
}

export async function deleteScanRecord(id: string): Promise<void> {
  memoryStore.delete(id);

  if (!hasIndexedDb()) {
    return;
  }

  try {
    const db = await openHistoryDb();
    try {
      await runIdbTransaction(db, 'readwrite', (store) => store.delete(id));
    } finally {
      db.close();
    }
  } catch {
    // Fallback already deleted from memoryStore.
  }
}

export async function clearScanHistory(): Promise<void> {
  memoryStore.clear();

  if (!hasIndexedDb()) {
    return;
  }

  try {
    const db = await openHistoryDb();
    try {
      await runIdbTransaction(db, 'readwrite', (store) => store.clear());
    } finally {
      db.close();
    }
  } catch {
    // Fallback already cleared memoryStore.
  }
}
