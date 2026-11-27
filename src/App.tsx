import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent
} from 'react';
import { ClauseCard } from './components/ClauseCard';
import { ClauseNegotiationDrawer } from './components/ClauseNegotiationDrawer';
import { ContractDiffView } from './components/ContractDiffView';
import {
  buildClauseDeltaMap,
  HybridDeltaPanel,
  type AnalysisViewMode
} from './components/HybridDeltaPanel';
import { LocalHistoryDrawer } from './components/LocalHistoryDrawer';
import { RedactionDiff } from './components/RedactionDiff';
import { TelemetryBar } from './components/TelemetryBar';
import { SAMPLE_DOCUMENTS } from './data/sampleDocuments';
import { extractPartialClausesFromStream } from './lib/analysisParser';
import type { IngestedDocumentMeta } from './lib/documentIngestor';
import {
  getInitialRuntimeStatus,
  getUnconfiguredRuntimeStatus,
  initializeFirebaseServices,
  warmUpModelCache,
  type FirebaseServicesHandle
} from './lib/firebaseClient';
import {
  probeChromeNanoAvailability,
  runHybridDocumentAnalysis,
  type ModelFactory
} from './lib/hybridRouter';
import {
  estimateTokenCount,
  redactDocument,
  restoreFromVault
} from './lib/piiRedactor';
import {
  compileRedlinedDocument,
  type ClauseRedlineDecision
} from './lib/redlineDiff';
import {
  buildScanHistoryRecord,
  clearScanHistory,
  deleteScanRecord,
  listScanRecords,
  reconstructReportFromHistory,
  saveScanRecord,
  type ScanHistoryRecord
} from './lib/scanHistory';
import type {
  ChromeNanoAvailability,
  ClauseSeverity,
  DocumentAnalysisResult,
  FirebaseRuntimeStatus,
  HybridExecutionReport,
  HybridPolicyMode,
  InlineAttachment,
  PipelineStage,
  RiskClause
} from './types/analysis';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function parseCustomTermsInput(chips: string[], draft: string): string[] {
  const draftTerms = draft
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return Array.from(new Set([...chips, ...draftTerms]));
}

function formatBriefMarkdown(
  report: HybridExecutionReport,
  analysis: DocumentAnalysisResult,
  decisions: Record<string, ClauseRedlineDecision>,
  restoreVault: boolean
): string {
  const maybeRestore = (value: string) =>
    restoreVault ? restoreFromVault(value, report.redaction.vault) : value;

  const compiled = compileRedlinedDocument(
    report.redaction.redactedText,
    analysis.clauses,
    decisions
  );

  const lines = [
    `# LegalEase HybridDoc Brief`,
    ``,
    `- **Document Type:** ${analysis.documentType}`,
    `- **Risk Score:** ${analysis.overallRiskScore}/100 (${analysis.riskPosture})`,
    `- **Stage 1 Route:** ${report.triageTelemetry.badge} (${report.triageTelemetry.modelName})`,
    `- **PII Masked Locally:** ${report.redaction.totalMasked}`,
    `- **Export Privacy Mode:** ${
      restoreVault
        ? 'Local PII Vault Restored (Browser-Only)'
        : 'PII-Redacted Safe Copy'
    }`,
    report.escalationTelemetry
      ? `- **Stage 2 Escalation:** ${report.escalationTelemetry.badge} (${report.escalationTelemetry.modelName})`
      : `- **Stage 2 Escalation:** ${report.escalationBlockedReason ?? 'Not requested'}`,
    ``,
    `## Executive Summary`,
    maybeRestore(analysis.executiveSummary),
    ``,
    `## Flagged Risk Clauses`,
    ...analysis.clauses.map((c) => {
      const dec = decisions[c.id];
      const statusLabel = (dec?.status ?? 'pending').toUpperCase();
      const redlineText =
        dec?.customRedline && dec.customRedline.trim().length > 0
          ? dec.customRedline.trim()
          : c.redlineProposal;
      return `### [${c.severity.toUpperCase()}] ${c.title} (${c.category}) — ${statusLabel}\n> ${maybeRestore(c.excerpt)}\n\n- **Risk:** ${maybeRestore(c.rationale)}\n- **Redline:** ${maybeRestore(redlineText)}\n`;
    })
  ];

  if (analysis.crossClauseFindings.length > 0) {
    lines.push(`## Cross-Clause Synthesis`);
    for (const f of analysis.crossClauseFindings) {
      lines.push(
        `### ${f.title}\n- **Involved:** ${f.involvedClauses.join(', ')}\n- **Impact:** ${maybeRestore(f.impact)}\n- **Negotiation Move:** ${maybeRestore(f.negotiationMove)}\n`
      );
    }
  }

  if (compiled.appliedCount > 0) {
    lines.push(
      `## Compiled Redlined Document (${compiled.appliedCount} Accepted Redline${
        compiled.appliedCount === 1 ? '' : 's'
      })`,
      ``,
      maybeRestore(compiled.compiledText)
    );
  }

  return lines.join('\n');
}

export function App() {
  const [documentText, setDocumentText] = useState(SAMPLE_DOCUMENTS[0].content);
  const [selectedSampleId, setSelectedSampleId] = useState(SAMPLE_DOCUMENTS[0].id);
  const [reviewStep, setReviewStep] = useState<'issues' | 'final'>('issues');
  const [privacyDrawerOpen, setPrivacyDrawerOpen] = useState(false);
  const [expandedClauseId, setExpandedClauseId] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [policyMode, setPolicyMode] =
    useState<HybridPolicyMode>('prefer_on_device');
  const [runCloudEscalation, setRunCloudEscalation] = useState(true);
  const [enableSemanticPii, setEnableSemanticPii] = useState(false);
  const [useSimulatedSandbox, setUseSimulatedSandbox] = useState(false);

  const [customTermChips, setCustomTermChips] = useState<string[]>([]);
  const [customTermDraft, setCustomTermDraft] = useState('');

  const [ingestedMeta, setIngestedMeta] = useState<IngestedDocumentMeta | null>(
    null
  );
  const [ingestedSource, setIngestedSource] = useState<{
    filename: string;
    extension: string;
    originalBuffer?: ArrayBuffer;
  } | null>(null);
  const [inlineAttachments, setInlineAttachments] = useState<InlineAttachment[]>(
    []
  );
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isIngestingFile, setIsIngestingFile] = useState(false);

  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [chromeAvailability, setChromeAvailability] =
    useState<ChromeNanoAvailability>('unsupported');
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [isReprobingNano, setIsReprobingNano] = useState(false);

  const [firebaseHandle, setFirebaseHandle] =
    useState<FirebaseServicesHandle | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<FirebaseRuntimeStatus>(() =>
    getInitialRuntimeStatus()
  );

  const [report, setReport] = useState<HybridExecutionReport | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [activeStage, setActiveStage] = useState<PipelineStage | null>(null);
  const [streamPreview, setStreamPreview] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!isAnalyzing) {
      setElapsedSeconds(0);
      return;
    }
    setElapsedSeconds(0);
    const id = window.setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [isAnalyzing]);

  const [partialClauses, setPartialClauses] = useState<
    ReturnType<typeof extractPartialClausesFromStream>
  >([]);
  const lastPartialParseRef = useRef<number>(0);

  useEffect(() => {
    if (!isAnalyzing || !streamPreview) {
      setPartialClauses([]);
      lastPartialParseRef.current = 0;
      return;
    }
    const now = Date.now();
    const elapsed = now - lastPartialParseRef.current;
    if (elapsed >= 150) {
      lastPartialParseRef.current = now;
      setPartialClauses(extractPartialClausesFromStream(streamPreview));
      return;
    }
    const timer = window.setTimeout(() => {
      lastPartialParseRef.current = Date.now();
      setPartialClauses(extractPartialClausesFromStream(streamPreview));
    }, 150 - elapsed);
    return () => window.clearTimeout(timer);
  }, [isAnalyzing, streamPreview]);

  const [analysisViewMode, setAnalysisViewMode] =
    useState<AnalysisViewMode>('merged');
  const [severityFilter, setSeverityFilter] = useState<'all' | ClauseSeverity>(
    'all'
  );
  const [clauseDecisions, setClauseDecisions] = useState<
    Record<string, ClauseRedlineDecision>
  >({});
  const [negotiatingClause, setNegotiatingClause] = useState<RiskClause | null>(
    null
  );
  const [restoreVaultForExport, setRestoreVaultForExport] = useState(false);
  const [exportCopied, setExportCopied] = useState(false);

  const [sampleMenuOpen, setSampleMenuOpen] = useState(false);
  const [policyMenuOpen, setPolicyMenuOpen] = useState(false);
  const sampleMenuRef = useRef<HTMLDivElement | null>(null);
  const policyMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sampleMenuOpen && !policyMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        sampleMenuOpen &&
        sampleMenuRef.current &&
        !sampleMenuRef.current.contains(e.target as Node)
      ) {
        setSampleMenuOpen(false);
      }
      if (
        policyMenuOpen &&
        policyMenuRef.current &&
        !policyMenuRef.current.contains(e.target as Node)
      ) {
        setPolicyMenuOpen(false);
      }
    };
    const handleEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSampleMenuOpen(false);
        setPolicyMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [sampleMenuOpen, policyMenuOpen]);

  const [deferredInstallPrompt, setDeferredInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [offlineShellReady, setOfflineShellReady] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    const anyDrawerOpen =
      diagnosticsOpen ||
      historyOpen ||
      privacyDrawerOpen ||
      Boolean(negotiatingClause);
    if (!anyDrawerOpen) return;
    const scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.overflow = '';
      window.scrollTo(0, scrollY);
    };
  }, [diagnosticsOpen, historyOpen, privacyDrawerOpen, negotiatingClause]);

  useEffect(() => {
    if (reviewStep === 'final') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [reviewStep]);
  const [historyRecords, setHistoryRecords] = useState<ScanHistoryRecord[]>([]);

  const abortControllerRef = useRef<AbortController | null>(null);

  const effectiveCustomTerms = useMemo(
    () => parseCustomTermsInput(customTermChips, customTermDraft),
    [customTermChips, customTermDraft]
  );

  const [debouncedDocText, setDebouncedDocText] = useState(documentText);
  useEffect(() => {
    if (documentText.length <= 20_000) {
      setDebouncedDocText(documentText);
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedDocText(documentText);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [documentText]);

  const liveRedaction = useMemo(
    () => redactDocument(debouncedDocText, { customTerms: effectiveCustomTerms }),
    [debouncedDocText, effectiveCustomTerms]
  );

  const reportCustomTermsKey = useMemo(
    () => (report ? effectiveCustomTerms.join('\u0000') : ''),
    [report, effectiveCustomTerms]
  );
  const [lastReportTermsKey, setLastReportTermsKey] = useState('');
  useEffect(() => {
    if (report) {
      setLastReportTermsKey(effectiveCustomTerms.join('\u0000'));
    }
    // Only capture the custom terms active when the report object changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  const displayRedaction =
    report &&
    report.redaction.originalText === documentText &&
    reportCustomTermsKey === lastReportTermsKey
      ? report.redaction
      : liveRedaction;

  const estimatedDocTokens = useMemo(
    () => estimateTokenCount(displayRedaction.redactedText),
    [displayRedaction.redactedText]
  );

  const modelFactory: ModelFactory | undefined = useMemo(
    () =>
      firebaseHandle
        ? (mode, schemaKey) => firebaseHandle.getHybridModel(mode, schemaKey)
        : undefined,
    [firebaseHandle]
  );

  useEffect(() => {
    if (!firebaseHandle) return;
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.requestIdleCallback === 'function') {
      const id = win.requestIdleCallback(() => {
        warmUpModelCache(firebaseHandle);
      }, { timeout: 2000 });
      return () => win.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(() => {
      warmUpModelCache(firebaseHandle);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [firebaseHandle]);

  useEffect(() => {
    let active = true;

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setDeferredInstallPrompt(null);
    };
    const handleSwControllerChange = () => {
      if (active && navigator.serviceWorker?.controller) {
        setOfflineShellReady(true);
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    if ('serviceWorker' in navigator) {
      if (navigator.serviceWorker.controller) {
        setOfflineShellReady(true);
      }
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        handleSwControllerChange
      );
      void navigator.serviceWorker.ready
        .then((registration) => {
          if (active && registration.active) {
            setOfflineShellReady(true);
          }
        })
        .catch(() => {
          // Ignore service worker readiness check errors in restricted contexts.
        });
    }

    void listScanRecords().then((records) => {
      if (active) setHistoryRecords(records);
    });

    void probeChromeNanoAvailability().then((status) => {
      if (active) setChromeAvailability(status);
    });

    void initializeFirebaseServices().then((handle) => {
      if (!active) return;
      if (handle) {
        setFirebaseHandle(handle);
        setRuntimeStatus(handle.status);
        void handle.refreshAppCheckStatus().then((updated) => {
          if (active) {
            setRuntimeStatus((prev) => ({
              ...prev,
              appCheck: updated
            }));
          }
        });
      } else {
        setRuntimeStatus(getUnconfiguredRuntimeStatus());
        setUseSimulatedSandbox(true);
      }
    });

    return () => {
      active = false;
      abortControllerRef.current?.abort();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener(
        'beforeinstallprompt',
        handleBeforeInstallPrompt
      );
      window.removeEventListener('appinstalled', handleAppInstalled);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener(
          'controllerchange',
          handleSwControllerChange
        );
      }
    };
  }, []);

  const commitDraftTerms = (raw: string) => {
    const incoming = raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (incoming.length === 0) return;
    setCustomTermChips((prev) => Array.from(new Set([...prev, ...incoming])));
    setCustomTermDraft('');
  };

  const handleCustomTermKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commitDraftTerms(customTermDraft);
    }
  };

  const handleSampleSelect = (id: string) => {
    const sample = SAMPLE_DOCUMENTS.find((d) => d.id === id);
    if (!sample) return;
    setSelectedSampleId(sample.id);
    setDocumentText(sample.content);
    setIngestedMeta(null);
    setIngestedSource(null);
    setReport(null);
    setSeverityFilter('all');
    setClauseDecisions({});
    setNegotiatingClause(null);
    setErrorMessage(null);
    setCancelNotice(null);
  };

  const processFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setIsIngestingFile(true);
    setErrorMessage(null);
    setCancelNotice(null);

    try {
      for (const file of files) {
        const { ingestUploadedFile } = await import('./lib/documentIngestor');
        const result = await ingestUploadedFile(file);
        if (result.kind === 'image' && result.attachment) {
          setInlineAttachments((prev) => [...prev, result.attachment!]);
        } else if (typeof result.text === 'string') {
          setSelectedSampleId('custom');
          setDocumentText(result.text);
          setIngestedMeta(result.meta);
          setIngestedSource({
            filename: result.meta.fileName,
            extension: result.meta.extension,
            originalBuffer: result.originalBuffer
          });
          setReport(null);
          setClauseDecisions({});
          setNegotiatingClause(null);
        }
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to ingest uploaded file.'
      );
    } finally {
      setIsIngestingFile(false);
    }
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      await processFiles(event.target.files);
      event.target.value = '';
    }
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingFile(false);
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      await processFiles(event.dataTransfer.files);
    }
  };

  const removeAttachment = (idx: number) => {
    setInlineAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleWarmUpNano = async () => {
    if (!firebaseHandle) return;
    setErrorMessage(null);
    setDownloadProgress(0);
    try {
      const model = firebaseHandle.getHybridModel('prefer_on_device');
      await model.initializeDeviceModel((progress) => {
        setDownloadProgress(progress);
      });
      const updated = await probeChromeNanoAvailability();
      setChromeAvailability(updated);
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? `Failed to initialize on-device Gemini Nano: ${err.message}`
          : 'Failed to initialize on-device Gemini Nano.'
      );
    } finally {
      setDownloadProgress(null);
    }
  };

  const handleReprobeNano = async () => {
    setIsReprobingNano(true);
    try {
      const updated = await probeChromeNanoAvailability();
      setChromeAvailability(updated);
    } finally {
      setIsReprobingNano(false);
    }
  };

  const handleRefreshAppCheck = async () => {
    if (!firebaseHandle) return;
    const updatedAppCheck = await firebaseHandle.refreshAppCheckStatus();
    setRuntimeStatus((prev) => ({
      ...prev,
      appCheck: updatedAppCheck
    }));
  };

  const handleCancelRun = () => {
    abortControllerRef.current?.abort();
  };

  const runAnalysis = async (forceSandboxOverride?: boolean) => {
    if (!documentText.trim() && inlineAttachments.length === 0) {
      setErrorMessage(
        'Paste or upload a contract, policy, PDF, DOCX, or scanned image first.'
      );
      return;
    }
    const effectiveSandbox =
      typeof forceSandboxOverride === 'boolean'
        ? forceSandboxOverride
        : !firebaseHandle || useSimulatedSandbox;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsAnalyzing(true);
    setActiveStage('pii_redaction');
    setStreamPreview('');
    setErrorMessage(null);
    setCancelNotice(null);

    try {
      const executionReport = await runHybridDocumentAnalysis(documentText, {
        policyMode,
        runCloudEscalation,
        isOnline,
        chromeNanoAvailability: chromeAvailability,
        useSimulatedSandbox: effectiveSandbox,
        cloudModelName: runtimeStatus.cloudModel,
        modelFactory,
        customTerms: effectiveCustomTerms,
        enableSemanticPii,
        inlineAttachments:
          inlineAttachments.length > 0 ? inlineAttachments : undefined,
        signal: controller.signal,
        onStageChange: (stage) => {
          setActiveStage(stage);
          if (stage === 'escalation') {
            setStreamPreview('');
          }
        },
        onStreamChunk: (chunkText) => {
          setStreamPreview((prev) => prev + chunkText);
        }
      });
      setReport(executionReport);
      setAnalysisViewMode(executionReport.escalation ? 'merged' : 'triage');
      setSeverityFilter('all');
      setClauseDecisions({});
      setNegotiatingClause(null);

      if (documentText.trim().length > 0) {
        const sampleMatch = SAMPLE_DOCUMENTS.find(
          (doc) => doc.id === selectedSampleId
        );
        const derivedTitle =
          ingestedMeta?.fileName ??
          sampleMatch?.label ??
          executionReport.redaction.redactedText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0)
            ?.slice(0, 80) ??
          'Redacted Document Brief';
        const record = buildScanHistoryRecord(derivedTitle, executionReport);
        void saveScanRecord(record)
          .then(() => listScanRecords())
          .then((updated) => setHistoryRecords(updated))
          .catch(() => {
            // Local history persistence is best-effort.
          });
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setCancelNotice('Hybrid analysis cancelled by user.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Hybrid document analysis failed.'
        );
      }
    } finally {
      setIsAnalyzing(false);
      setActiveStage(null);
      abortControllerRef.current = null;
    }
  };

  const handleEnableSandboxAndRerun = () => {
    setUseSimulatedSandbox(true);
    void runAnalysis(true);
  };

  const activeAnalysis: DocumentAnalysisResult | null = useMemo(() => {
    if (!report) return null;
    if (analysisViewMode === 'triage') return report.triage;
    if (analysisViewMode === 'escalation') {
      return report.escalation ?? report.triage;
    }
    return report.escalation ?? report.triage;
  }, [report, analysisViewMode]);

  const clauseDeltaMap = useMemo(() => {
    if (!report || analysisViewMode === 'triage') return {};
    return buildClauseDeltaMap(report.triage, report.escalation);
  }, [report, analysisViewMode]);

  const severityCounts = useMemo(() => {
    const counts: Record<ClauseSeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0
    };
    if (!activeAnalysis) return counts;
    for (const clause of activeAnalysis.clauses) {
      counts[clause.severity] = (counts[clause.severity] ?? 0) + 1;
    }
    return counts;
  }, [activeAnalysis]);

  const filteredClauses = useMemo(() => {
    if (!activeAnalysis) return [];
    if (severityFilter === 'all') return activeAnalysis.clauses;
    return activeAnalysis.clauses.filter(
      (clause) => clause.severity === severityFilter
    );
  }, [activeAnalysis, severityFilter]);

  const handleClauseDecisionChange = (
    clauseId: string,
    next: ClauseRedlineDecision
  ) => {
    if (next.status !== 'pending') {
      setExpandedClauseId((curr) => (curr === clauseId ? null : curr));
    }
    setClauseDecisions((prev) => {
      const updated = {
        ...prev,
        [clauseId]: next
      };
      if (
        activeAnalysis &&
        activeAnalysis.clauses.length > 0 &&
        activeAnalysis.clauses.every((c) => {
          const s = updated[c.id]?.status;
          return s === 'accepted' || s === 'rejected';
        })
      ) {
        setReviewStep('final');
      }
      return updated;
    });
  };

  const handleAcceptAll = () => {
    if (!activeAnalysis) return;
    setExpandedClauseId(null);
    setClauseDecisions((prev) => {
      const updated = { ...prev };
      for (const clause of activeAnalysis.clauses) {
        const current = updated[clause.id];
        if (!current || current.status === 'pending') {
          updated[clause.id] = {
            ...current,
            status: 'accepted',
          };
        }
      }
      return updated;
    });
    setReviewStep('final');
  };

  const handleApplyNegotiationSuggestion = (
    clauseId: string,
    suggestedRedline: string
  ) => {
    setClauseDecisions((prev) => ({
      ...prev,
      [clauseId]: {
        status: 'accepted',
        customRedline: suggestedRedline
      }
    }));
  };

  const handleCopyMarkdown = async () => {
    if (!report || !activeAnalysis) return;
    const md = formatBriefMarkdown(
      report,
      activeAnalysis,
      clauseDecisions,
      restoreVaultForExport
    );
    try {
      await navigator.clipboard.writeText(md);
      setExportCopied(true);
      setTimeout(() => setExportCopied(false), 1800);
    } catch {
      setErrorMessage(
        'Clipboard access was blocked by the browser. Use {exportDownloaded ? "Downloaded .md" : "Download .md"} instead.'
      );
    }
  };

  const handleExportEditedDocument = async () => {
    if (!report || !activeAnalysis) return;
    const compiled = compileRedlinedDocument(
      report.redaction.redactedText,
      activeAnalysis.clauses,
      clauseDecisions
    );
    const compiledText = restoreVaultForExport
      ? restoreFromVault(compiled.compiledText, report.redaction.vault)
      : compiled.compiledText;

    const replacements = activeAnalysis.clauses
      .filter((clause) => clauseDecisions[clause.id]?.status === 'accepted')
      .map((clause) => {
        const proposal =
          clauseDecisions[clause.id]?.customRedline?.trim() ||
          clause.redlineProposal;
        return {
          original: restoreVaultForExport
            ? restoreFromVault(clause.excerpt, report.redaction.vault)
            : clause.excerpt,
          replacement: restoreVaultForExport
            ? restoreFromVault(proposal, report.redaction.vault)
            : proposal
        };
      })
      .filter((item) => Boolean(item.original && item.replacement));

    const { exportEditedDocument } = await import('./lib/documentExporter');
    const { blob, filename } = await exportEditedDocument({
      originalFilename: ingestedSource?.filename,
      originalBuffer: ingestedSource?.originalBuffer,
      compiledText,
      replacements
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePrintPdf = () => {
    window.print();
  };
  void handlePrintPdf;

  const handleInstallPwa = async () => {
    if (!deferredInstallPrompt) return;
    try {
      await deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
    } finally {
      setDeferredInstallPrompt(null);
    }
  };

  const handleLoadHistoryRecord = (record: ScanHistoryRecord) => {
    const restoredReport = reconstructReportFromHistory(record);
    setSelectedSampleId('custom');
    setIngestedMeta(null);
    setIngestedSource(null);
    setDocumentText(record.redactedText);
    setReport(restoredReport);
    setAnalysisViewMode('triage');
    setSeverityFilter('all');
    setClauseDecisions({});
    setNegotiatingClause(null);
    setRestoreVaultForExport(false);
    setErrorMessage(null);
    setCancelNotice(null);
    setHistoryOpen(false);
  };

  const handleDeleteHistoryRecord = async (id: string) => {
    await deleteScanRecord(id);
    const updated = await listScanRecords();
    setHistoryRecords(updated);
  };

  const handleClearHistory = async () => {
    await clearScanHistory();
    setHistoryRecords([]);
  };

  const handleNewDocument = () => {
    setReport(null);
    setActiveStage(null);
    setStreamPreview('');
    setErrorMessage(null);
    setCancelNotice(null);
    setNegotiatingClause(null);
    setReviewStep('issues');
    setPrivacyDrawerOpen(false);
  };

  const statusLabel =
    chromeAvailability === "available"
      ? "On-Device Ready"
      : useSimulatedSandbox || !runtimeStatus.configured
        ? "Sandbox Ready"
        : "Hybrid Ready";

  const statusDotClass =
    chromeAvailability === "available"
      ? ""
      : isOnline
        ? ""
        : "amber";

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <img
              src="/icons/legalease-logo.jpg"
              alt="LegalEase"
              className="brand-logo-img"
            />
          </div>
          <h1 className="brand-title">LegalEase</h1>
        </div>

        <div className="top-actions">
          <button
            type="button"
            className="status-pill"
            onClick={() => setDiagnosticsOpen((prev) => !prev)}
            aria-expanded={diagnosticsOpen}
          >
            <span className={`status-dot ${statusDotClass}`} />
            <span>{statusLabel}{offlineShellReady ? " · Offline" : ""}</span>
          </button>

          <button
            type="button"
            className="btn"
            onClick={() => setHistoryOpen(true)}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
            <span>History{historyRecords.length > 0 ? ` (${historyRecords.length})` : ""}</span>
          </button>

          {deferredInstallPrompt && (
            <button
              type="button"
              className="btn"
              onClick={() => void handleInstallPwa()}
            >
              Install
            </button>
          )}

          {activeAnalysis && report && (
            <div className="export-menu-wrap">
              <button
                type="button"
                className="btn"
                onClick={() => setExportMenuOpen((prev) => !prev)}
                aria-expanded={exportMenuOpen}
              >
                Export ▾
              </button>
              {exportMenuOpen && (
                <div className="export-menu" role="menu">
                  <button
                    type="button"
                    onClick={() => {
                      void handleCopyMarkdown();
                      setExportMenuOpen(false);
                    }}
                  >
                    {exportCopied ? "Copied Markdown" : "Copy Markdown"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void handleExportEditedDocument();
                      setExportMenuOpen(false);
                    }}
                  >
                    {ingestedSource
                      ? `Download .${ingestedSource.extension}`
                      : 'Download .md'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false);
                      window.print();
                    }}
                  >
                    Print PDF
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {diagnosticsOpen && (
        <div
          className="drawer-backdrop no-print"
          role="dialog"
          aria-modal="true"
          aria-label="System and AI Diagnostics"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDiagnosticsOpen(false);
          }}
        >
          <aside className="drawer-panel history-drawer-panel">
            <div className="drawer-header">
              <div>
                <span className="telemetry-label">
                  Hybrid Runtime &amp; Routing
                </span>
                <h3>System &amp; AI Diagnostics</h3>
              </div>
              <button
                type="button"
                className="btn-inline"
                onClick={() => setDiagnosticsOpen(false)}
                aria-label="Close diagnostics drawer"
              >
                Close
              </button>
            </div>

            <TelemetryBar
              chromeAvailability={chromeAvailability}
              downloadProgress={downloadProgress}
              isReprobingNano={isReprobingNano}
              isOnline={isOnline}
              firebaseConfigured={runtimeStatus.configured}
              useSimulatedSandbox={useSimulatedSandbox}
              appCheck={runtimeStatus.appCheck}
              triageTelemetry={report?.triageTelemetry ?? null}
              escalationTelemetry={report?.escalationTelemetry ?? null}
              semanticPii={report?.semanticPii}
              cloudDegradation={report?.cloudDegradation}
              onWarmUpNano={handleWarmUpNano}
              onReprobeNano={() => void handleReprobeNano()}
              onRefreshAppCheck={handleRefreshAppCheck}
              onEnableSandbox={handleEnableSandboxAndRerun}
            />

            <div
              className="telemetry-row"
              style={{
                marginTop: '14px',
                paddingTop: '14px',
                borderTop: '1px solid var(--border)'
              }}
            >
              <div className="sample-dropdown" ref={policyMenuRef}>
                <button
                  type="button"
                  className="sample-dropdown-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={policyMenuOpen}
                  aria-label="Routing Policy"
                  onClick={() => setPolicyMenuOpen((prev) => !prev)}
                >
                  <span>
                    Policy:{' '}
                    {policyMode === 'prefer_on_device'
                      ? 'Prefer On-Device'
                      : policyMode === 'only_on_device'
                        ? 'Only On-Device'
                        : policyMode === 'prefer_in_cloud'
                          ? 'Prefer Cloud'
                          : 'Only Cloud'}
                  </span>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 20 20"
                    fill="none"
                    aria-hidden="true"
                    className={`sample-chevron ${policyMenuOpen ? 'open' : ''}`}
                  >
                    <path
                      d="M5 7.5L10 12.5L15 7.5"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>

                {policyMenuOpen && (
                  <div
                    className="sample-menu"
                    role="listbox"
                    aria-label="Routing Policy Options"
                  >
                    {(
                      [
                        { value: 'prefer_on_device', label: 'Prefer On-Device' },
                        { value: 'only_on_device', label: 'Only On-Device' },
                        { value: 'prefer_in_cloud', label: 'Prefer Cloud' },
                        { value: 'only_in_cloud', label: 'Only Cloud' }
                      ] as const
                    ).map((opt) => {
                      const isSelected = opt.value === policyMode;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className={`sample-menu-item ${isSelected ? 'active' : ''}`}
                          onClick={() => {
                            setPolicyMode(opt.value);
                            setPolicyMenuOpen(false);
                          }}
                        >
                          <span>{opt.label}</span>
                          {isSelected && (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 20 20"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M4.5 10.5L8.2 14.2L15.5 6.5"
                                stroke="#0B4F3A"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

            <label className="telemetry-pill" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={runCloudEscalation}
                onChange={(e) => setRunCloudEscalation(e.target.checked)}
              />
              <span>Cloud Escalation</span>
            </label>

            <label className="telemetry-pill" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={enableSemanticPii}
                onChange={(e) => setEnableSemanticPii(e.target.checked)}
              />
              <span>Stage 0.5 Semantic PII</span>
            </label>

            <label className="telemetry-pill" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={useSimulatedSandbox}
                onChange={(e) => setUseSimulatedSandbox(e.target.checked)}
              />
              <span>Sandbox Mode</span>
            </label>
          </div>
          </aside>
        </div>
      )}

      <main className="single-canvas">
        {!activeAnalysis && !report && !isAnalyzing ? (
          <section className="intake-canvas no-print" aria-label="Document Intake">
            <div className="intake-hero">
              <h2 className="intake-headline">Review any contract, privately.</h2>
              <p className="intake-subtitle">
                Personal details are masked locally in your browser before any AI analysis runs.
              </p>
            </div>

            {errorMessage && (
              <div className="error-banner" role="alert">
                {errorMessage}
              </div>
            )}

            {cancelNotice && (
              <div className="error-banner" role="status">
                {cancelNotice}
              </div>
            )}

            <div className="doc-sheet">
              <div className="doc-sheet-header">
                <div className="sample-dropdown" ref={sampleMenuRef}>
                  <button
                    type="button"
                    className="sample-dropdown-trigger"
                    aria-haspopup="listbox"
                    aria-expanded={sampleMenuOpen}
                    aria-label="Sample Contract"
                    onClick={() => setSampleMenuOpen((prev) => !prev)}
                  >
                    <span>
                      {selectedSampleId === 'custom'
                        ? 'Custom Document'
                        : selectedSampleId === SAMPLE_DOCUMENTS[0]?.id
                          ? 'Contract Template'
                          : `Contract Template · ${
                              SAMPLE_DOCUMENTS.find((d) => d.id === selectedSampleId)
                                ?.label ?? 'Sample'
                            }`}
                    </span>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 20 20"
                      fill="none"
                      aria-hidden="true"
                      className={`sample-chevron ${sampleMenuOpen ? 'open' : ''}`}
                    >
                      <path
                        d="M5 7.5L10 12.5L15 7.5"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>

                  {sampleMenuOpen && (
                    <div
                      className="sample-menu"
                      role="listbox"
                      aria-label="Sample Contract Options"
                    >
                      {SAMPLE_DOCUMENTS.map((doc) => {
                        const isSelected = doc.id === selectedSampleId;
                        return (
                          <button
                            key={doc.id}
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            className={`sample-menu-item ${isSelected ? 'active' : ''}`}
                            onClick={() => {
                              handleSampleSelect(doc.id);
                              setSampleMenuOpen(false);
                            }}
                          >
                            <span>{doc.label}</span>
                            {isSelected && (
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 20 20"
                                fill="none"
                                aria-hidden="true"
                              >
                                <path
                                  d="M4.5 10.5L8.2 14.2L15.5 6.5"
                                  stroke="#0B4F3A"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <span className="doc-privacy-badge">
                  {displayRedaction.totalMasked} personal details hidden locally
                </span>
              </div>

              <div
                className={`dropzone-wrap ${isDraggingFile ? "dragging" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDraggingFile(true);
                }}
                onDragLeave={() => setIsDraggingFile(false)}
                onDrop={(e) => void handleDrop(e)}
              >
                <textarea
                  className="doc-textarea"
                  value={documentText}
                  onChange={(e) => {
                    setDocumentText(e.target.value);
                    setSelectedSampleId("custom");
                  }}
                  placeholder="Paste a contract, privacy policy, or vendor DPA here — or drag and drop a PDF, DOCX, or scanned image."
                />

                {inlineAttachments.length > 0 && (
                  <div className="attachment-chips">
                    {inlineAttachments.map((att, idx) => (
                      <span
                        key={`${att.name ?? att.mimeType}-${idx}`}
                        className="attachment-chip"
                      >
                        <span>{att.name ?? att.mimeType}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${att.name ?? "image attachment"}`}
                          onClick={() => removeAttachment(idx)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="doc-sheet-footer">
                <div className="doc-toolbar-left">
                  <label className="btn btn-sm" style={{ cursor: "pointer" }}>
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                    <span>{isIngestingFile ? "Reading..." : "Upload PDF, DOCX, or Image"}</span>
                    <input
                      type="file"
                      accept=".txt,.md,.pdf,.docx,.png,.jpg,.jpeg,.webp"
                      multiple
                      onChange={(e) => void handleFileUpload(e)}
                      hidden
                    />
                  </label>

                  <input
                    type="text"
                    className="custom-terms-input"
                    value={customTermDraft}
                    onChange={(e) => setCustomTermDraft(e.target.value)}
                    onKeyDown={handleCustomTermKeyDown}
                    placeholder="Protect custom names..."
                  />
                </div>

                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void runAnalysis()}
                  disabled={!documentText.trim() && inlineAttachments.length === 0}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M22 2L11 13" />
                    <path d="M22 2L15 22L11 13L2 9L22 2Z" />
                  </svg>
                  <span>Review Document</span>
                </button>
              </div>

              <div className="doc-meta-line">
                <span>
                  {documentText.length.toLocaleString()} chars · ~{estimatedDocTokens} tokens
                  {ingestedMeta ? ` · ${ingestedMeta.fileName}` : ""}
                </span>
              </div>
            </div>

            <p className="trust-footer">
              Personal details stay on your device · Powered by Gemini Nano &amp; Firebase AI Logic · Works offline
            </p>
          </section>
        ) : (
          <section className="review-canvas" aria-label="Executive Brief">
            {isAnalyzing && activeStage && (
              <div className="progress-banner" role="status">
                <div className="progress-banner-row">
                  <span style={{ display: 'inline-flex', alignItems: 'center', fontWeight: 600 }}>
                    <span className="progress-live-dot" aria-hidden="true" />
                    Reviewing contract...
                  </span>
                  <span className="muted-sm mono tabular" style={{ marginLeft: '10px' }}>
                    {elapsedSeconds}s
                  </span>
                  <button
                    type="button"
                    className="btn btn-danger-soft btn-sm"
                    onClick={handleCancelRun}
                    style={{ marginLeft: 'auto' }}
                  >
                    Cancel
                  </button>
                </div>
                <div className="progress-track" aria-hidden="true">
                  <div className="progress-indeterminate" />
                </div>
              </div>
            )}

            {errorMessage && (
              <div className="error-banner" role="alert">
                {errorMessage}
              </div>
            )}

            {cancelNotice && !isAnalyzing && (
              <div className="error-banner" role="status">
                {cancelNotice}
              </div>
            )}

            {isAnalyzing && !report && (
              <div className="grammarly-split">
                <div className="grammarly-doc-pane">
                  <div className="grammarly-pane-head">
                    <span>Document</span>
                    <span className="grammarly-pane-meta">
                      {partialClauses.length} highlighted{' '}
                      {partialClauses.length === 1 ? 'issue' : 'issues'}
                    </span>
                  </div>
                  <div className="grammarly-doc-body">
                    {(() => {
                      const sourceText = documentText;
                      const lowerSource = sourceText.toLowerCase();
                      const matches: Array<{
                        start: number;
                        end: number;
                        clause: (typeof partialClauses)[number];
                      }> = [];
                      for (const clause of partialClauses) {
                        const rawExcerpt = clause.excerpt.trim();
                        if (!rawExcerpt) continue;
                        const exactIdx = lowerSource.indexOf(rawExcerpt.toLowerCase());
                        if (exactIdx !== -1) {
                          const matchStart = exactIdx;
                          const matchEnd = exactIdx + rawExcerpt.length;
                          const overlaps = matches.some(
                            (m) => matchStart < m.end && matchEnd > m.start
                          );
                          if (!overlaps) {
                            matches.push({ start: matchStart, end: matchEnd, clause });
                          }
                        }
                      }
                      matches.sort((a, b) => a.start - b.start);
                      const nodes: React.ReactNode[] = [];
                      let cursor = 0;
                      for (const m of matches) {
                        if (m.start > cursor) {
                          nodes.push(sourceText.slice(cursor, m.start));
                        }
                        nodes.push(
                          <mark
                            key={`${m.clause.id}-${m.start}`}
                            className={`doc-highlight sev-${m.clause.severity}`}
                            title={`${m.clause.severity.toUpperCase()}: ${m.clause.title}`}
                          >
                            {sourceText.slice(m.start, m.end)}
                          </mark>
                        );
                        cursor = m.end;
                      }
                      if (cursor < sourceText.length) {
                        nodes.push(sourceText.slice(cursor));
                      }
                      return nodes;
                    })()}
                  </div>
                </div>

                <div className="grammarly-issues-pane">
                  <div className="clause-list">
                    {partialClauses.map((clause) => (
                      <ClauseCard
                        key={clause.id}
                        clause={clause}
                        isExpanded={false}
                        isSelected={false}
                      />
                    ))}
                    <div className="clause-skeleton-card" aria-hidden="true">
                      <div className="clause-skeleton-line" style={{ width: '38%' }} />
                      <div className="clause-skeleton-line" style={{ width: '82%' }} />
                      <div className="clause-skeleton-line" style={{ width: '64%' }} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeAnalysis && report && (
              <>
                <div className="verdict-card">
                  <div className="verdict-top-row">
                    <div className="risk-headline">
                      <span className="risk-score-num tabular">
                        {activeAnalysis.overallRiskScore} / 100
                      </span>
                      <span
                        className={`risk-posture-pill ${activeAnalysis.riskPosture.toLowerCase()}`}
                      >
                        {activeAnalysis.riskPosture} Risk
                      </span>
                      <button
                        type="button"
                        className="privacy-indicator privacy-indicator-btn"
                        data-tooltip="Inspect personal details hidden locally before AI review"
                        onClick={() => setPrivacyDrawerOpen(true)}
                      >
                        Proof of Privacy ({report.redaction.totalMasked}) ↗
                      </button>
                    </div>

                    <div className="verdict-actions no-print">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={handleNewDocument}
                      >
                        ← New Document
                      </button>
                    </div>
                  </div>
                  <p className="review-summary-text">
                    {activeAnalysis.executiveSummary}
                  </p>
                </div>

                {reviewStep === 'issues' && (
                  <div className="review-tab-panel">
                    {report.delta && (
                      <HybridDeltaPanel
                        delta={report.delta}
                        triageTelemetry={report.triageTelemetry}
                        escalationTelemetry={report.escalationTelemetry}
                        hasEscalation={Boolean(report.escalation)}
                        viewMode={analysisViewMode}
                        onViewModeChange={setAnalysisViewMode}
                      />
                    )}

                    <div className="grammarly-split">
                      <div className="grammarly-doc-pane">
                        <div className="grammarly-pane-head">
                          <span>Document</span>
                          {(() => {
                            const pendingCount = activeAnalysis.clauses.filter((c) => {
                              const s = clauseDecisions[c.id]?.status;
                              return s !== 'accepted' && s !== 'rejected';
                            }).length;
                            return (
                              <span className="grammarly-pane-meta">
                                {pendingCount} highlighted{' '}
                                {pendingCount === 1 ? 'issue' : 'issues'}
                              </span>
                            );
                          })()}
                        </div>
                        <div className="grammarly-doc-body">
                          {(() => {
                            const sourceText = report.redaction.originalText || documentText;
                            const lowerSource = sourceText.toLowerCase();
                            type MatchRange = {
                              start: number;
                              end: number;
                              clause: (typeof activeAnalysis.clauses)[number];
                            };
                            const matches: MatchRange[] = [];
                            for (const clause of activeAnalysis.clauses) {
                              const rawExcerpt = restoreFromVault(
                                clause.excerpt,
                                report.redaction.vault
                              ).trim();
                              if (!rawExcerpt) continue;
                              const segments = rawExcerpt
                                .split(/\.{3}|…/)
                                .map((s) => s.replace(/\s+/g, ' ').trim())
                                .filter((s) => s.length >= 6)
                                .sort((a, b) => b.length - a.length);
                              const candidates =
                                segments.length > 0
                                  ? segments
                                  : [rawExcerpt.replace(/\s+/g, ' ')];

                              let matchStart = -1;
                              let matchEnd = -1;
                              for (const cand of candidates) {
                                const exactIdx = lowerSource.indexOf(cand.toLowerCase());
                                if (exactIdx !== -1) {
                                  matchStart = exactIdx;
                                  matchEnd = exactIdx + cand.length;
                                  break;
                                }
                                const escaped = cand
                                  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                                  .replace(/\s+/g, '\\s+');
                                const re = new RegExp(escaped, 'i');
                                const m = re.exec(sourceText);
                                if (m && m.index !== undefined) {
                                  matchStart = m.index;
                                  matchEnd = m.index + m[0].length;
                                  break;
                                }
                              }
                              if (matchStart === -1) continue;
                              const overlaps = matches.some(
                                (m) => matchStart < m.end && matchEnd > m.start
                              );
                              if (!overlaps) {
                                matches.push({ start: matchStart, end: matchEnd, clause });
                              }
                            }
                            matches.sort((a, b) => a.start - b.start);
                            const nodes: React.ReactNode[] = [];
                            let cursor = 0;
                            for (const m of matches) {
                              if (m.start > cursor) {
                                nodes.push(sourceText.slice(cursor, m.start));
                              }
                              const isActive = expandedClauseId === m.clause.id;
                              const decisionStatus =
                                clauseDecisions[m.clause.id]?.status;
                              if (
                                decisionStatus === 'accepted' ||
                                decisionStatus === 'rejected'
                              ) {
                                nodes.push(sourceText.slice(m.start, m.end));
                              } else {
                                nodes.push(
                                  <mark
                                    key={`${m.clause.id}-${m.start}`}
                                    className={`doc-highlight sev-${m.clause.severity}${
                                      isActive ? ' is-active' : ''
                                    }`}
                                    title={`${m.clause.severity.toUpperCase()}: ${m.clause.title}`}
                                    onClick={() => {
                                      setExpandedClauseId(m.clause.id);
                                      requestAnimationFrame(() => {
                                        document
                                          .getElementById(`clause-card-${m.clause.id}`)
                                          ?.scrollIntoView({
                                            behavior: 'smooth',
                                            block: 'nearest'
                                          });
                                      });
                                    }}
                                  >
                                    {sourceText.slice(m.start, m.end)}
                                  </mark>
                                );
                              }
                              cursor = m.end;
                            }
                            if (cursor < sourceText.length) {
                              nodes.push(sourceText.slice(cursor));
                            }
                            return nodes;
                          })()}
                        </div>
                      </div>

                      <div className="grammarly-issues-pane">
                        {activeAnalysis.clauses.length > 0 && (
                          <div className="filter-row">
                            <div className="filter-pills">
                              <button
                                type="button"
                                className={`filter-pill ${
                                  severityFilter === "all" ? "active" : ""
                                }`}
                                onClick={() => setSeverityFilter("all")}
                              >
                                All ({activeAnalysis.clauses.length})
                              </button>
                              {(
                                [
                                  ["critical", "Critical"],
                                  ["high", "High"],
                                  ["medium", "Medium"],
                                  ["low", "Low"]
                                ] as const
                              )
                                .filter(([sev]) => severityCounts[sev] > 0)
                                .map(([sev, label]) => (
                                <button
                                  key={sev}
                                  type="button"
                                  className={`filter-pill ${
                                    severityFilter === sev ? "active" : ""
                                  }`}
                                  onClick={() =>
                                    setSeverityFilter((prev) =>
                                      prev === sev ? "all" : sev
                                    )
                                  }
                                >
                                  {label} ({severityCounts[sev]})
                                </button>
                              ))}
                            </div>
                            {(() => {
                              const pendingCount = activeAnalysis.clauses.filter(
                                (c) =>
                                  !clauseDecisions[c.id] ||
                                  clauseDecisions[c.id].status === 'pending'
                              ).length;
                              return (
                                pendingCount > 0 && (
                                  <button
                                    type="button"
                                    className="btn-accept-all"
                                    onClick={handleAcceptAll}
                                  >
                                    Accept All ({pendingCount})
                                  </button>
                                )
                              );
                            })()}
                          </div>
                        )}

                        <div className="clause-list">
                          {filteredClauses.length > 0 ? (
                            filteredClauses.map((clause) => (
                              <ClauseCard
                                key={clause.id}
                                clause={clause}
                                decision={clauseDecisions[clause.id]}
                                deltaBadge={clauseDeltaMap[clause.id]}
                                isExpanded={expandedClauseId === clause.id}
                                isSelected={expandedClauseId === clause.id}
                                onToggleExpand={() =>
                                  setExpandedClauseId((prev) =>
                                    prev === clause.id ? null : clause.id
                                  )
                                }
                                onDecisionChange={handleClauseDecisionChange}
                                onOpenNegotiate={setNegotiatingClause}
                              />
                            ))
                          ) : (
                            <div style={{ padding: "20px 0", color: "var(--muted)", fontSize: "0.85rem" }}>
                              No {severityFilter} issues found.{" "}
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => setSeverityFilter("all")}
                              >
                                Show all
                              </button>
                            </div>
                          )}
                        </div>

                        <div
                          className="issues-bottom-cta no-print"
                          style={{
                            display: 'flex',
                            justifyContent: 'flex-end',
                            marginTop: '16px'
                          }}
                        >
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => setReviewStep('final')}
                          >
                            Review Final Changes (
                            {Object.values(clauseDecisions).filter((d) => d.status === 'accepted').length}) →
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {reviewStep === 'final' && (
                  <div className="review-tab-panel">
                    <div
                      className="step2-back-row no-print"
                      style={{ marginBottom: '12px' }}
                    >
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setReviewStep('issues')}
                      >
                        ← Back to Issues
                      </button>
                    </div>
                    <ContractDiffView
                      redaction={report.redaction}
                      clauses={activeAnalysis.clauses}
                      decisions={clauseDecisions}
                      restoreVaultForView={restoreVaultForExport}
                      onToggleRestoreVault={setRestoreVaultForExport}
                      onExport={() => {
                        void handleExportEditedDocument();
                      }}
                    />
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </main>

      {privacyDrawerOpen && report && (
        <div
          className="drawer-backdrop"
          role="presentation"
          onClick={() => setPrivacyDrawerOpen(false)}
        >
          <aside
            className="privacy-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Proof of Privacy"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="privacy-drawer-head">
              <div>
                <h3>Proof of Privacy</h3>
                <p className="muted-sm">
                  Before any cloud AI call ran, {report.redaction.totalMasked} personal{' '}
                  {report.redaction.totalMasked === 1 ? 'detail was' : 'details were'} masked
                  locally in your browser. Your original names, emails, and numbers never left
                  this device.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setPrivacyDrawerOpen(false)}
                aria-label="Close Proof of Privacy"
              >
                ✕
              </button>
            </div>
            <div className="privacy-drawer-body">
              <RedactionDiff redaction={report.redaction} />
            </div>
          </aside>
        </div>
      )}

      <ClauseNegotiationDrawer
        clause={negotiatingClause}
        redactedDocumentContext={displayRedaction.redactedText}
        policyMode={policyMode}
        isOnline={isOnline}
        chromeNanoAvailability={chromeAvailability}
        useSimulatedSandbox={!firebaseHandle || useSimulatedSandbox}
        modelFactory={modelFactory}
        onClose={() => setNegotiatingClause(null)}
        onApplySuggestion={handleApplyNegotiationSuggestion}
      />

      <LocalHistoryDrawer
        isOpen={historyOpen}
        records={historyRecords}
        onClose={() => setHistoryOpen(false)}
        onSelectRecord={handleLoadHistoryRecord}
        onDeleteRecord={(id) => void handleDeleteHistoryRecord(id)}
        onClearAll={() => void handleClearHistory()}
      />
    </div>
  );
}

export default App;
