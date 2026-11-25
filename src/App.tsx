import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { ClauseCard } from './components/ClauseCard';
import { RedactionDiff } from './components/RedactionDiff';
import { TelemetryBar } from './components/TelemetryBar';
import { SAMPLE_DOCUMENTS } from './data/sampleDocuments';
import {
  getUnconfiguredRuntimeStatus,
  initializeFirebaseServices,
  type FirebaseServicesHandle
} from './lib/firebaseClient';
import {
  probeChromeNanoAvailability,
  runHybridDocumentAnalysis
} from './lib/hybridRouter';
import { redactSensitiveData } from './lib/piiRedactor';
import type {
  ChromeNanoAvailability,
  FirebaseRuntimeStatus,
  HybridExecutionReport,
  HybridPolicyMode
} from './types/analysis';

function formatBriefMarkdown(report: HybridExecutionReport): string {
  const analysis = report.escalation ?? report.triage;
  const lines = [
    `# LocalShield HybridDoc Brief`,
    ``,
    `- **Document Type:** ${analysis.documentType}`,
    `- **Risk Score:** ${analysis.overallRiskScore}/100 (${analysis.riskPosture})`,
    `- **Stage 1 Route:** ${report.triageTelemetry.badge} (${report.triageTelemetry.modelName})`,
    `- **PII Masked Locally:** ${report.redaction.totalMasked}`,
    report.escalationTelemetry
      ? `- **Stage 2 Escalation:** ${report.escalationTelemetry.badge} (${report.escalationTelemetry.modelName})`
      : `- **Stage 2 Escalation:** ${report.escalationBlockedReason ?? 'Not requested'}`,
    ``,
    `## Executive Summary`,
    analysis.executiveSummary,
    ``,
    `## Flagged Risk Clauses`,
    ...analysis.clauses.map(
      (c) =>
        `### [${c.severity.toUpperCase()}] ${c.title} (${c.category})\n> ${c.excerpt}\n\n- **Risk:** ${c.rationale}\n- **Redline:** ${c.redlineProposal}\n`
    )
  ];

  if (analysis.crossClauseFindings.length > 0) {
    lines.push(`## Cross-Clause Synthesis`);
    for (const f of analysis.crossClauseFindings) {
      lines.push(
        `### ${f.title}\n- **Involved:** ${f.involvedClauses.join(', ')}\n- **Impact:** ${f.impact}\n- **Negotiation Move:** ${f.negotiationMove}\n`
      );
    }
  }
  return lines.join('\n');
}

export function App() {
  const [documentText, setDocumentText] = useState(SAMPLE_DOCUMENTS[0].content);
  const [selectedSampleId, setSelectedSampleId] = useState(SAMPLE_DOCUMENTS[0].id);
  const [policyMode, setPolicyMode] =
    useState<HybridPolicyMode>('prefer_on_device');
  const [runCloudEscalation, setRunCloudEscalation] = useState(true);
  const [useSimulatedSandbox, setUseSimulatedSandbox] = useState(false);

  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [chromeAvailability, setChromeAvailability] =
    useState<ChromeNanoAvailability>('unsupported');
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  const [firebaseHandle, setFirebaseHandle] =
    useState<FirebaseServicesHandle | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<FirebaseRuntimeStatus>(() =>
    getUnconfiguredRuntimeStatus()
  );

  const [report, setReport] = useState<HybridExecutionReport | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportCopied, setExportCopied] = useState(false);

  const liveRedaction = useMemo(
    () => redactSensitiveData(documentText),
    [documentText]
  );

  useEffect(() => {
    let active = true;

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    void probeChromeNanoAvailability().then((status) => {
      if (active) setChromeAvailability(status);
    });

    void initializeFirebaseServices().then((handle) => {
      if (!active) return;
      if (handle) {
        setFirebaseHandle(handle);
        setRuntimeStatus(handle.status);
      } else {
        setUseSimulatedSandbox(true);
      }
    });

    return () => {
      active = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleSampleSelect = (id: string) => {
    const sample = SAMPLE_DOCUMENTS.find((d) => d.id === id);
    if (!sample) return;
    setSelectedSampleId(sample.id);
    setDocumentText(sample.content);
    setReport(null);
    setErrorMessage(null);
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setSelectedSampleId('custom');
    setDocumentText(text);
    setReport(null);
    setErrorMessage(null);
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

  const handleRefreshAppCheck = async () => {
    if (!firebaseHandle) return;
    const updatedAppCheck = await firebaseHandle.refreshAppCheckStatus();
    setRuntimeStatus((prev) => ({
      ...prev,
      appCheck: updatedAppCheck
    }));
  };

  const handleAnalyze = async () => {
    if (!documentText.trim()) {
      setErrorMessage('Paste or upload a contract, policy, or technical document first.');
      return;
    }
    setIsAnalyzing(true);
    setErrorMessage(null);

    try {
      const executionReport = await runHybridDocumentAnalysis(documentText, {
        policyMode,
        runCloudEscalation,
        isOnline,
        chromeNanoAvailability: chromeAvailability,
        useSimulatedSandbox: !firebaseHandle || useSimulatedSandbox,
        cloudModelName: runtimeStatus.cloudModel,
        modelFactory: firebaseHandle
          ? (mode) => firebaseHandle.getHybridModel(mode)
          : undefined
      });
      setReport(executionReport);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Hybrid document analysis failed.'
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleExportBrief = async () => {
    if (!report) return;
    const md = formatBriefMarkdown(report);
    try {
      await navigator.clipboard.writeText(md);
      setExportCopied(true);
      setTimeout(() => setExportCopied(false), 1800);
    } catch {
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'LocalShield Risk Brief.md';
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const activeAnalysis = report?.escalation ?? report?.triage ?? null;

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            LS
          </div>
          <div>
            <h1>LocalShield — HybridDoc Brief</h1>
            <p className="subtitle">
              Zero-Leakage On-Device Contract &amp; Policy Triage via Firebase AI
              Logic + Chrome Gemini Nano
            </p>
          </div>
        </div>
        <div className="top-actions">
          <span
            className={`env-pill ${runtimeStatus.configured ? 'env-live' : 'env-sandbox'}`}
          >
            {runtimeStatus.configured
              ? `Firebase: ${runtimeStatus.projectId}`
              : 'Sandbox Mode (.env unconfigured)'}
          </span>
        </div>
      </header>

      <TelemetryBar
        chromeAvailability={chromeAvailability}
        downloadProgress={downloadProgress}
        isOnline={isOnline}
        firebaseConfigured={runtimeStatus.configured}
        appCheck={runtimeStatus.appCheck}
        triageTelemetry={report?.triageTelemetry ?? null}
        escalationTelemetry={report?.escalationTelemetry ?? null}
        onWarmUpNano={handleWarmUpNano}
        onRefreshAppCheck={handleRefreshAppCheck}
      />

      <main className="workbench">
        <section className="pane pane-left">
          <div className="panel-card">
            <div className="panel-header-row">
              <h2>1. Document &amp; Privacy Controls</h2>
              <label className="upload-btn">
                Load .txt / .md
                <input
                  type="file"
                  accept=".txt,.md,.policy,.contract"
                  onChange={handleFileUpload}
                  hidden
                />
              </label>
            </div>

            <div className="sample-pills">
              {SAMPLE_DOCUMENTS.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  className={`sample-pill ${
                    selectedSampleId === doc.id ? 'active' : ''
                  }`}
                  onClick={() => handleSampleSelect(doc.id)}
                >
                  <span className="pill-tag">{doc.tag}</span>
                  <span>{doc.label}</span>
                </button>
              ))}
            </div>

            <textarea
              className="doc-textarea mono"
              rows={11}
              value={documentText}
              onChange={(e) => {
                setDocumentText(e.target.value);
                setSelectedSampleId('custom');
              }}
              placeholder="Paste a contract, privacy policy, SLA, or NDA here..."
            />

            <div className="controls-grid">
              <label className="control-field">
                <span>Firebase AI Logic InferenceMode</span>
                <select
                  value={policyMode}
                  onChange={(e) =>
                    setPolicyMode(e.target.value as HybridPolicyMode)
                  }
                >
                  <option value="prefer_on_device">
                    PREFER_ON_DEVICE (Nano first, Cloud fallback)
                  </option>
                  <option value="only_on_device">
                    ONLY_ON_DEVICE (Strict Air-Gapped Vault)
                  </option>
                  <option value="prefer_in_cloud">
                    PREFER_IN_CLOUD (Cloud first, Nano fallback)
                  </option>
                  <option value="only_in_cloud">
                    ONLY_IN_CLOUD (App Check Protected Cloud)
                  </option>
                </select>
              </label>

              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={runCloudEscalation}
                  disabled={policyMode === 'only_on_device'}
                  onChange={(e) => setRunCloudEscalation(e.target.checked)}
                />
                <span>
                  Stage 2: Escalate <strong>PII-redacted</strong> brief to Cloud
                  Gemini for cross-clause synthesis
                </span>
              </label>

              {runtimeStatus.configured && (
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={useSimulatedSandbox}
                    onChange={(e) => setUseSimulatedSandbox(e.target.checked)}
                  />
                  <span>
                    Force Local Sandbox Simulation (dry-run without spending cloud
                    quota)
                  </span>
                </label>
              )}
            </div>

            {errorMessage && (
              <div className="error-banner" role="alert">
                {errorMessage}
              </div>
            )}

            <button
              type="button"
              className="btn-primary"
              onClick={handleAnalyze}
              disabled={isAnalyzing}
            >
              {isAnalyzing
                ? 'Running Hybrid Pipeline...'
                : 'Analyze Document with Hybrid AI'}
            </button>
          </div>

          <div className="panel-card">
            <RedactionDiff redaction={liveRedaction} />
          </div>
        </section>

        <section className="pane pane-right">
          {!activeAnalysis ? (
            <div className="empty-state panel-card">
              <h2>Ready for Zero-Leakage Hybrid Analysis</h2>
              <p>
                LocalShield masks emails, tax IDs, cards, IBANs, IPs, addresses,
                and API secrets <strong>100% locally</strong> before running{' '}
                <code>InferenceMode.PREFER_ON_DEVICE</code> triage via Firebase AI
                Logic.
              </p>
              <ul>
                <li>
                  <strong>Stage 1 (On-Device / Fallback):</strong> Clause extraction
                  and redline generation with live <code>inferenceSource</code>{' '}
                  telemetry.
                </li>
                <li>
                  <strong>Stage 2 (PII-Redacted Cloud Escalation):</strong>{' '}
                  Cross-clause contradiction detection protected by Firebase App
                  Check.
                </li>
              </ul>
            </div>
          ) : (
            <>
              <div className="panel-card summary-card">
                <div className="summary-top">
                  <div>
                    <span className="telemetry-label">
                      {activeAnalysis.documentType}
                    </span>
                    <h2>Risk Posture: {activeAnalysis.riskPosture}</h2>
                    <p className="summary-text">
                      {activeAnalysis.executiveSummary}
                    </p>
                  </div>
                  <div className="score-ring">
                    <span className="score-num">
                      {activeAnalysis.overallRiskScore}
                    </span>
                    <span className="score-den">/ 100</span>
                  </div>
                </div>

                {activeAnalysis.complianceFlags.length > 0 && (
                  <div className="compliance-row">
                    {activeAnalysis.complianceFlags.map((flag) => (
                      <span key={flag} className="compliance-pill">
                        {flag}
                      </span>
                    ))}
                  </div>
                )}

                {report?.escalationBlockedReason && (
                  <div className="info-banner">
                    <strong>Stage 2 Cloud Escalation Guard:</strong>{' '}
                    {report.escalationBlockedReason}
                  </div>
                )}

                <div className="summary-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleExportBrief}
                  >
                    {exportCopied
                      ? 'Copied Markdown Brief'
                      : 'Copy / Export Brief (.md)'}
                  </button>
                </div>
              </div>

              {activeAnalysis.crossClauseFindings.length > 0 && (
                <div className="panel-card">
                  <h3>Cross-Clause Compound Findings (Stage 2 Synthesis)</h3>
                  <div className="cross-list">
                    {activeAnalysis.crossClauseFindings.map((finding) => (
                      <div key={finding.id} className="cross-card">
                        <div className="cross-head">
                          <strong>{finding.title}</strong>
                          <span className="mono muted-sm">
                            {finding.involvedClauses.join(' + ')}
                          </span>
                        </div>
                        <p>{finding.impact}</p>
                        <p className="negotiation-line">
                          <strong>Negotiation Move:</strong>{' '}
                          {finding.negotiationMove}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="clauses-stack">
                {activeAnalysis.clauses.map((clause) => (
                  <ClauseCard key={clause.id} clause={clause} />
                ))}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
