import { useEffect, useMemo, useState } from 'react';
import {
  getInitialRuntimeStatus,
  initializeFirebaseServices,
  type FirebaseServicesHandle
} from '../src/lib/firebaseClient';
import {
  probeChromeNanoAvailability,
  runHybridDocumentAnalysis,
  type ModelFactory
} from '../src/lib/hybridRouter';
import { redactDocument } from '../src/lib/piiRedactor';
import type {
  ChromeNanoAvailability,
  HybridExecutionReport,
  HybridPolicyMode,
  PiiCategory,
  RiskClause
} from '../src/types/analysis';

type SidePanelPolicyChoice =
  | 'prefer_on_device'
  | 'only_on_device'
  | 'hybrid_escalation';

interface ExtractedPagePayload {
  title: string;
  url: string;
  text: string;
}

function mapPolicyChoice(choice: SidePanelPolicyChoice): {
  policyMode: HybridPolicyMode;
  runCloudEscalation: boolean;
} {
  if (choice === 'only_on_device') {
    return { policyMode: 'only_on_device', runCloudEscalation: false };
  }
  if (choice === 'hybrid_escalation') {
    return { policyMode: 'prefer_in_cloud', runCloudEscalation: true };
  }
  return { policyMode: 'prefer_on_device', runCloudEscalation: false };
}

function resolveRouteBadge(report: HybridExecutionReport): {
  label: 'ON_DEVICE' | 'IN_CLOUD' | 'LOCAL';
  className: string;
} {
  const source =
    report.escalationTelemetry?.inferenceSource ??
    report.triageTelemetry.inferenceSource;

  if (source === 'on_device') {
    return { label: 'ON_DEVICE', className: 'sp-pill-emerald' };
  }
  if (source === 'in_cloud') {
    return { label: 'IN_CLOUD', className: 'sp-pill-sky' };
  }
  return { label: 'LOCAL', className: 'sp-pill-amber' };
}

function severityPillClass(severity: RiskClause['severity']): string {
  if (severity === 'critical') return 'sp-pill-red';
  if (severity === 'high') return 'sp-pill-amber';
  if (severity === 'medium') return 'sp-pill-sky';
  return 'sp-pill-emerald';
}

function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return /^(?:chrome|edge|about|devtools|chrome-extension|view-source):/i.test(
    url
  );
}

function buildCompactBriefMarkdown(
  title: string,
  url: string,
  report: HybridExecutionReport
): string {
  const active = report.escalation ?? report.triage;
  const route = resolveRouteBadge(report);
  const lines = [
    `# LegalEase Side-Panel Brief`,
    ``,
    `- **Page:** ${title || active.documentType}`,
    url ? `- **URL:** ${url}` : '',
    `- **Risk Score:** ${active.overallRiskScore}/100 (${active.riskPosture})`,
    `- **Route:** ${route.label} (${report.triageTelemetry.modelName})`,
    `- **PII Masked Locally:** ${report.redaction.totalMasked}`,
    ``,
    `## Executive Summary`,
    active.executiveSummary,
    ``,
    `## Flagged Clauses`,
    ...active.clauses.map(
      (c) =>
        `### [${c.severity.toUpperCase()}] ${c.title}\n- **Risk:** ${c.rationale}\n- **Redline:** ${c.redlineProposal}\n`
    )
  ].filter(Boolean);

  return lines.join('\n');
}

export function SidePanelApp() {
  const [sourceText, setSourceText] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [policyChoice, setPolicyChoice] =
    useState<SidePanelPolicyChoice>('prefer_on_device');
  const [enableSemanticPii, setEnableSemanticPii] = useState(false);

  const [chromeAvailability, setChromeAvailability] =
    useState<ChromeNanoAvailability>('unsupported');
  const [firebaseHandle, setFirebaseHandle] =
    useState<FirebaseServicesHandle | null>(null);
  const [cloudModelName, setCloudModelName] = useState(
    () => getInitialRuntimeStatus().cloudModel
  );

  const [isScanningTab, setIsScanningTab] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<HybridExecutionReport | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void probeChromeNanoAvailability().then((status) => {
      if (active) setChromeAvailability(status);
    });
    void initializeFirebaseServices().then((handle) => {
      if (!active) return;
      if (handle) {
        setFirebaseHandle(handle);
        setCloudModelName(handle.status.cloudModel);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const modelFactory: ModelFactory | undefined = useMemo(
    () =>
      firebaseHandle
        ? (mode, schemaKey) => firebaseHandle.getHybridModel(mode, schemaKey)
        : undefined,
    [firebaseHandle]
  );

  const liveRedaction = useMemo(
    () => redactDocument(sourceText),
    [sourceText]
  );

  const runAuditOnText = async (textToAudit: string) => {
    if (!textToAudit.trim()) {
      setError('No text to audit. Scan an active tab or paste text below.');
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    setNotice(null);

    try {
      const { policyMode, runCloudEscalation } = mapPolicyChoice(policyChoice);
      const executionReport = await runHybridDocumentAnalysis(textToAudit, {
        policyMode,
        runCloudEscalation,
        isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
        chromeNanoAvailability: chromeAvailability,
        useSimulatedSandbox: !firebaseHandle,
        cloudModelName,
        modelFactory,
        enableSemanticPii
      });
      setReport(executionReport);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Hybrid analysis failed.'
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleScanActiveTab = async () => {
    setError(null);
    setNotice(null);

    if (
      typeof chrome === 'undefined' ||
      !chrome.tabs?.query ||
      !chrome.scripting?.executeScript
    ) {
      setNotice(
        'Chrome tab scripting API is unavailable in this preview. Paste page text below and click Audit Text.'
      );
      return;
    }

    setIsScanningTab(true);
    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });

      if (!activeTab?.id || isRestrictedUrl(activeTab.url)) {
        setPageTitle(activeTab?.title ?? 'Restricted Tab');
        setPageUrl(activeTab?.url ?? '');
        setNotice(
          'Cannot inject into chrome:// or restricted tabs. Paste the Terms or Privacy Policy text below instead.'
        );
        return;
      }

      const results = await chrome.scripting.executeScript<ExtractedPagePayload>({
        target: { tabId: activeTab.id },
        func: () => {
          const rawText = (document.body?.innerText || '').trim();
          const cleaned = rawText
            .replace(/\n{3,}/g, '\n\n')
            .slice(0, 28000);
          return {
            title: document.title || 'Untitled Page',
            url: window.location.href,
            text: cleaned
          };
        }
      });

      const payload = results[0]?.result;
      if (!payload || !payload.text.trim()) {
        setNotice(
          'No visible text could be extracted from this tab. Paste the clause text below.'
        );
        return;
      }

      setPageTitle(payload.title);
      setPageUrl(payload.url);
      setSourceText(payload.text);
      await runAuditOnText(payload.text);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Could not read active tab (${err.message}). Paste text below instead.`
          : 'Could not read active tab. Paste text below instead.'
      );
    } finally {
      setIsScanningTab(false);
    }
  };

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      setError('Clipboard copy was blocked by the browser.');
    }
  };

  const activeAnalysis = report ? (report.escalation ?? report.triage) : null;
  const routeBadge = report ? resolveRouteBadge(report) : null;
  const activeRedaction = report ? report.redaction : liveRedaction;
  const piiEntries = (
    Object.entries(activeRedaction.countsByCategory) as Array<
      [PiiCategory, number]
    >
  ).filter(([, count]) => count > 0);

  return (
    <div className="sp-shell">
      <header className="sp-header">
        <div className="sp-brand">
          <div className="sp-mark" aria-hidden="true">
            LE
          </div>
          <div>
            <h1 className="sp-title">LegalEase</h1>
            <p className="sp-sub">Side-Panel Legal &amp; Privacy Auditor</p>
          </div>
        </div>
        <span className="sp-pill sp-pill-emerald mono">
          {activeRedaction.totalMasked} PII masked
        </span>
      </header>

      <section className="sp-card">
        <button
          type="button"
          className="sp-btn-primary"
          disabled={isScanningTab || isAnalyzing}
          onClick={() => void handleScanActiveTab()}
        >
          {isScanningTab
            ? 'Extracting Active Tab...'
            : isAnalyzing
              ? 'Running Hybrid Audit...'
              : 'Scan Active Tab'}
        </button>

        {pageTitle && (
          <div className="sp-page-meta">
            <strong>{pageTitle}</strong>
            {pageUrl && <span className="sp-page-url mono">{pageUrl}</span>}
          </div>
        )}

        <label>
          <span className="sp-label">Policy Mode</span>
          <select
            className="sp-select"
            value={policyChoice}
            onChange={(e) =>
              setPolicyChoice(e.target.value as SidePanelPolicyChoice)
            }
          >
            <option value="prefer_on_device">Prefer On-Device</option>
            <option value="only_on_device">Strict Air-Gap (Nano Only)</option>
            <option value="hybrid_escalation">Hybrid Escalation</option>
          </select>
        </label>

        <label className="sp-checkbox">
          <input
            type="checkbox"
            checked={enableSemanticPii}
            onChange={(e) => setEnableSemanticPii(e.target.checked)}
          />
          <span>Stage 0.5 Semantic PII (On-Device PERSON/ORG scrub)</span>
        </label>

        <textarea
          className="sp-textarea mono"
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          placeholder="Click 'Scan Active Tab' above, or paste Terms of Service / Privacy Policy text here..."
        />

        <div className="sp-row">
          <span className="sp-sub mono">
            {sourceText.length.toLocaleString()} chars · Nano:{' '}
            {chromeAvailability}
          </span>
          <button
            type="button"
            className="sp-btn-secondary"
            disabled={isAnalyzing || !sourceText.trim()}
            onClick={() => void runAuditOnText(sourceText)}
          >
            {isAnalyzing ? 'Auditing...' : 'Audit Text'}
          </button>
        </div>

        {notice && <div className="sp-banner-info">{notice}</div>}
        {error && (
          <div className="sp-banner-error" role="alert">
            {error}
          </div>
        )}
      </section>

      {piiEntries.length > 0 && (
        <section className="sp-card">
          <span className="sp-label">Local PII Vault Masked</span>
          <div className="sp-chips mono">
            {piiEntries.map(([category, count]) => (
              <span key={category} className="sp-chip">
                {category}: {count}
              </span>
            ))}
          </div>
        </section>
      )}

      {report && activeAnalysis && routeBadge && (
        <section className="sp-card">
          <div className="sp-score-row">
            <div>
              <span className="sp-label">{activeAnalysis.documentType}</span>
              <div className="sp-score-value mono">
                {activeAnalysis.overallRiskScore}
                <span className="sp-sub"> / 100 · {activeAnalysis.riskPosture}</span>
              </div>
            </div>
            <span className={`sp-pill mono ${routeBadge.className}`}>
              {routeBadge.label}
            </span>
          </div>

          <p className="sp-clause-body">{activeAnalysis.executiveSummary}</p>

          <div className="sp-row">
            <span className="sp-sub mono">
              {activeAnalysis.clauses.length} flagged clause
              {activeAnalysis.clauses.length === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              className="sp-btn-secondary"
              onClick={() =>
                void copyText(
                  'brief',
                  buildCompactBriefMarkdown(pageTitle, pageUrl, report)
                )
              }
            >
              {copiedKey === 'brief' ? 'Copied Brief' : 'Copy Brief'}
            </button>
          </div>

          {activeAnalysis.clauses.map((clause) => (
            <article key={clause.id} className="sp-clause">
              <div className="sp-row">
                <span className="sp-clause-title">{clause.title}</span>
                <span
                  className={`sp-pill mono ${severityPillClass(clause.severity)}`}
                >
                  {clause.severity.toUpperCase()}
                </span>
              </div>
              <p className="sp-clause-body">{clause.rationale}</p>
              <div className="sp-redline-box">
                <strong>Redline:</strong> {clause.redlineProposal}
              </div>
              <div className="sp-row">
                <span className="sp-sub mono">{clause.category}</span>
                <button
                  type="button"
                  className="sp-btn-secondary"
                  onClick={() =>
                    void copyText(clause.id, clause.redlineProposal)
                  }
                >
                  {copiedKey === clause.id ? 'Copied' : 'Copy Redline'}
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
