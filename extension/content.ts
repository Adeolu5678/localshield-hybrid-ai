import { analyzeDocumentHeuristically } from '../src/lib/analysisParser';
import { initializeFirebaseServices, readFirebaseEnvConfig } from '../src/lib/firebaseClient';
import { redactSensitiveData } from '../src/lib/piiRedactor';
import type { ClauseSeverity, DocumentAnalysisResult, RiskClause } from '../src/types/analysis';

declare const process: { env: Record<string, string | undefined> };
const EXTENSION_API_KEY = process.env.VITE_FIREBASE_API_KEY || readFirebaseEnvConfig().config.firebaseOptions.apiKey;

const HOST_ID = 'legalease-floating-root';
const MARK_STYLE_ID = 'legalease-inline-mark-styles';
const STORAGE_KEY = 'legalease_badge_pos';
const SETTINGS_STORAGE_KEY = 'legalease_settings';
const EDGE_MARGIN = 12;
const LEGAL_KEYWORDS = /\b(terms|privacy|agreement|contract|msa|dpa|legal)\b/i;
const LEGAL_SIGNALS_GLOBAL = /\b(indemnify|liability|arbitration|confidential|warranty|termination|governing law|intellectual property|auto-renew|hereby|terms|privacy|agreement|contract)\b/gi;

type SnapEdge = 'left' | 'right' | 'top' | 'bottom';
type PopupSize = 'compact' | 'standard' | 'large';
type TextSize = 'small' | 'medium' | 'large';
type PolicyMode = 'prefer_on_device' | 'only_on_device' | 'prefer_in_cloud' | 'only_in_cloud';

const POLICY_MODES: Record<PolicyMode, string> = {
  prefer_on_device: 'Prefer On-Device',
  only_on_device: 'Only On-Device',
  prefer_in_cloud: 'Prefer In-Cloud',
  only_in_cloud: 'Only In-Cloud'
};

const POPUP_DIMENSIONS: Record<PopupSize, { width: number; height: number; badgeSize: number; label: string }> = {
  compact: { width: 340, height: 420, badgeSize: 40, label: 'Compact (340×420)' },
  standard: { width: 360, height: 480, badgeSize: 48, label: 'Standard (360×480)' },
  large: { width: 420, height: 560, badgeSize: 56, label: 'Large (420×560)' }
};

function getBadgeSize(): number {
  return POPUP_DIMENSIONS[state.settings.popupSize].badgeSize;
}

const TEXT_SIZES: Record<TextSize, { fontSize: string; label: string }> = {
  small: { fontSize: '12px', label: 'Small (12px)' },
  medium: { fontSize: '13.5px', label: 'Medium (13.5px)' },
  large: { fontSize: '15px', label: 'Large (15px)' }
};

interface UserSettings {
  popupSize: PopupSize;
  textSize: TextSize;
  customRedactionTerms: string;
  autoScan: boolean;
  policyMode: PolicyMode;
  enableSemanticPii: boolean;
  sandboxMode: boolean;
}

interface BadgePosition {
  edge: SnapEdge;
  offset: number;
}

interface ContentState {
  isOpen: boolean;
  settingsOpen: boolean;
  isScanning: boolean;
  hasScanned: boolean;
  isEditableContext: boolean;
  analysis: DocumentAnalysisResult | null;
  redactedCount: number;
  expandedClauseId: string | null;
  error: string | null;
  badgePos: BadgePosition;
  settings: UserSettings;
}

let wasDrawerOpen = false;
let activeEditableEl: HTMLElement | null = null;
let editDebounceTimer: number | null = null;

interface DraftState {
  targetEl: HTMLElement | null;
  pillVisible: boolean;
  isBarOpen: boolean;
  prompt: string;
  draftText: string;
  isGenerating: boolean;
  error: string | null;
  pillOffset: { dx: number; dy: number } | null;
}

const draftState: DraftState = {
  targetEl: null,
  pillVisible: false,
  isBarOpen: false,
  prompt: '',
  draftText: '',
  isGenerating: false,
  error: null,
  pillOffset: null
};

interface CompanionState {
  isActive: boolean;
  isOpen: boolean;
  selectedText: string;
  isEditable: boolean;
  targetEl: HTMLElement | null;
  selectionStart: number;
  selectionEnd: number;
  savedRange: Range | null;
  anchorRect: { left: number; top: number } | null;
  explanation: string;
  isExplaining: boolean;
  draftText: string;
  isRewriting: boolean;
  prompt: string;
  error: string | null;
}

const companionState: CompanionState = {
  isActive: false,
  isOpen: false,
  selectedText: '',
  isEditable: false,
  targetEl: null,
  selectionStart: 0,
  selectionEnd: 0,
  savedRange: null,
  anchorRect: null,
  explanation: '',
  isExplaining: false,
  draftText: '',
  isRewriting: false,
  prompt: '',
  error: null
};

let companionDebounceTimer: number | null = null;

const state: ContentState = {
  isOpen: false,
  settingsOpen: false,
  isScanning: false,
  hasScanned: false,
  isEditableContext: false,
  analysis: null,
  redactedCount: 0,
  expandedClauseId: null,
  error: null,
  badgePos: {
    edge: 'right',
    offset: Math.max(EDGE_MARGIN, Math.round((window.innerHeight - POPUP_DIMENSIONS.standard.badgeSize) / 2))
  },
  settings: {
    popupSize: 'standard',
    textSize: 'medium',
    customRedactionTerms: '',
    autoScan: true,
    policyMode: 'prefer_on_device',
    enableSemanticPii: false,
    sandboxMode: false
  }
};

let hasScannedCurrentContext = false;
let lastContextUrl = window.location.href;

function syncContextUrl(): void {
  if (window.location.href !== lastContextUrl) {
    lastContextUrl = window.location.href;
    hasScannedCurrentContext = false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSeverityColor(severity: ClauseSeverity): string {
  switch (severity) {
    case 'critical':
      return '#B91C1C';
    case 'high':
      return '#D97706';
    case 'medium':
      return '#1D4ED8';
    case 'low':
    default:
      return '#0B4F3A';
  }
}

function getSeverityLabel(severity: ClauseSeverity): string {
  return severity.toUpperCase();
}

function isLikelyLegalText(text: string): boolean {
  const matches = text.toLowerCase().match(LEGAL_SIGNALS_GLOBAL);
  if (!matches) return false;
  return new Set(matches).size >= 2;
}

function isLegalPage(): boolean {
  const urlAndTitle = `${window.location.href} ${document.title}`;
  if (LEGAL_KEYWORDS.test(urlAndTitle)) return true;
  const sample = (document.body?.innerText || '').slice(0, 4000);
  return LEGAL_KEYWORDS.test(sample) || isLikelyLegalText(sample);
}

function getEditableElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLElement) {
    return target.closest('[contenteditable="true"]') as HTMLElement | null;
  }
  return null;
}

function getEditableText(el: HTMLElement): string {
  return el instanceof HTMLTextAreaElement ? el.value : el.innerText;
}

function setEditableText(el: HTMLElement, nextText: string): void {
  if (el instanceof HTMLTextAreaElement) {
    el.value = nextText;
  } else {
    el.innerText = nextText;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function applyClauseFixToText(text: string, clause: RiskClause): string | null {
  if (!clause.excerpt || !clause.redlineProposal) return null;
  if (!text.includes(clause.excerpt)) return null;
  return text.replace(clause.excerpt, clause.redlineProposal);
}

function injectInlineMarkStyles(): void {
  if (document.getElementById(MARK_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = MARK_STYLE_ID;
  style.textContent = `
mark[data-legalease-id] {
  background: transparent;
  color: inherit;
  cursor: pointer;
  border-bottom: 2px solid #0B4F3A;
  padding-bottom: 1px;
  border-radius: 2px;
  transition: background-color 0.15s ease;
}
mark[data-legalease-id][data-severity="critical"] {
  border-bottom-color: #B91C1C;
}
mark[data-legalease-id][data-severity="high"] {
  border-bottom-color: #D97706;
}
mark[data-legalease-id][data-severity="medium"] {
  border-bottom-color: #1D4ED8;
}
mark[data-legalease-id][data-severity="low"] {
  border-bottom-color: #0B4F3A;
}
mark[data-legalease-id]:hover {
  background: rgba(11, 79, 58, 0.1);
}
@keyframes leMarkPulse {
  0%, 100% {
    background: rgba(11, 79, 58, 0.24);
    box-shadow: 0 0 0 3px rgba(11, 79, 58, 0.18);
  }
  50% {
    background: rgba(11, 79, 58, 0.08);
    box-shadow: 0 0 0 1px rgba(11, 79, 58, 0.08);
  }
}
mark[data-legalease-id].le-mark-pulse {
  animation: leMarkPulse 0.7s ease-in-out 2;
}
`;
  (document.head || document.documentElement).appendChild(style);
}

function clearInlineHighlights(): void {
  const marks = document.querySelectorAll('mark[data-legalease-id]');
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    const textNode = document.createTextNode(mark.textContent || '');
    parent.replaceChild(textNode, mark);
    parent.normalize();
  });
}

function highlightClauseInDom(
  clause: RiskClause,
  onSelect: (clauseId: string) => void
): boolean {
  const snippet = clause.excerpt.trim();
  if (snippet.length < 12) return false;
  const needle = snippet.slice(0, 72).replace(/\s+/g, ' ').trim();
  if (needle.length < 10) return false;

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(`#${HOST_ID}`)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('mark[data-legalease-id]')) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue || node.nodeValue.trim().length < 10) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const needleLower = needle.toLowerCase();
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const text = current.nodeValue || '';
    const idx = text.toLowerCase().indexOf(needleLower);
    if (idx === -1) continue;

    const range = document.createRange();
    range.setStart(current, idx);
    range.setEnd(current, Math.min(text.length, idx + needle.length));

    const mark = document.createElement('mark');
    mark.setAttribute('data-legalease-id', clause.id);
    mark.setAttribute('data-severity', clause.severity);
    mark.title = `LegalEase (${getSeverityLabel(clause.severity)}): ${clause.title}`;
    mark.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSelect(clause.id);
    });

    try {
      range.surroundContents(mark);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function runLocalScan(shadow: ShadowRoot, sourceText?: string): void {
  syncContextUrl();
  hasScannedCurrentContext = true;
  state.isScanning = true;
  state.error = null;
  if (sourceText === undefined) {
    state.isEditableContext = false;
    activeEditableEl = null;
  }
  render(shadow);

  try {
    const rawText = (sourceText !== undefined ? sourceText : document.body?.innerText || '').trim();
    if (rawText.length < 40) {
      state.analysis = null;
      state.redactedCount = 0;
      state.hasScanned = true;
      state.isScanning = false;
      render(shadow);
      return;
    }

    const redaction = redactSensitiveData(rawText.slice(0, 60000));
    let redactedText = redaction.redactedText;
    let totalMasked = redaction.totalMasked;

    const customTerms = state.settings.customRedactionTerms
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    for (const term of customTerms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'gi');
      const matches = redactedText.match(regex);
      if (matches && matches.length > 0) {
        totalMasked += matches.length;
        redactedText = redactedText.replace(regex, '[REDACTED]');
      }
    }

    const analysis = analyzeDocumentHeuristically(redactedText);

    state.redactedCount = totalMasked;
    state.analysis = analysis;
    state.hasScanned = true;
    state.expandedClauseId = analysis.clauses[0]?.id ?? null;

    clearInlineHighlights();
    if (!state.isEditableContext) {
      injectInlineMarkStyles();
      for (const clause of analysis.clauses.slice(0, 20)) {
        highlightClauseInDom(clause, (clauseId) => {
          state.isOpen = true;
          state.expandedClauseId = clauseId;
          render(shadow);
          const target = shadow.querySelector(`[data-card-id="${clauseId}"]`);
          target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      }
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Local scan failed.';
  } finally {
    state.isScanning = false;
    render(shadow);
  }
}

function getShadowStyles(): string {
  return `
:host {
  all: initial;
}
* {
  box-sizing: border-box;
}
.le-fab {
  position: fixed;
  z-index: 2147483647;
  width: 48px;
  height: 48px;
  border-radius: 9999px;
  border: 2px solid #0B4F3A;
  background: #FFFFFF;
  box-shadow: 0 8px 24px rgba(17, 17, 17, 0.18);
  cursor: grab;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  user-select: none;
  transition: left 0.2s ease, top 0.2s ease, right 0.2s ease, bottom 0.2s ease, transform 0.15s ease, box-shadow 0.15s ease;
}
.le-fab:active {
  cursor: grabbing;
}
.le-fab:hover {
  transform: scale(1.06);
  box-shadow: 0 10px 28px rgba(11, 79, 58, 0.28);
}
.le-fab.is-scanning {
  border-color: #1D4ED8;
  box-shadow: 0 0 0 4px rgba(29, 78, 216, 0.18), 0 8px 24px rgba(17, 17, 17, 0.18);
}
.le-fab img {
  width: calc(100% - 14px);
  height: calc(100% - 14px);
  border-radius: 9999px;
  object-fit: cover;
  display: block;
}
.le-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 9999px;
  background: #0B4F3A;
  color: #FFFFFF;
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 11px;
  font-weight: 700;
  line-height: 20px;
  text-align: center;
  border: 2px solid #FFFFFF;
}
.le-badge.is-high {
  background: #B91C1C;
}
@keyframes lePopIn {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
.le-drawer {
  position: fixed;
  z-index: 2147483647;
  width: 360px;
  height: 480px;
  max-height: calc(100vh - 32px);
  background: #F4F3EF;
  color: #111111;
  border: 1px solid #D1CEC6;
  border-radius: 16px;
  box-shadow: 0 18px 48px rgba(17, 17, 17, 0.22);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: var(--le-font-size, 13.5px);
  line-height: 1.45;
}
.le-drawer.le-animate-in {
  animation: lePopIn 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.le-btn-settings,
.le-btn-back {
  background: #F4F3EF;
  color: #111111;
  border: 1px solid #D1CEC6;
  border-radius: 8px;
  padding: 5px 8px;
  font-size: 0.9em;
  font-weight: 600;
  cursor: pointer;
}
.le-btn-settings:hover,
.le-btn-back:hover {
  background: #E8E6E0;
}
.le-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 2px;
}
.le-settings-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.le-settings-title {
  font-weight: 700;
  font-size: 1.05em;
  color: #111111;
}
.le-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.le-field-label {
  font-weight: 600;
  font-size: 0.88em;
  color: #374151;
}
.le-select,
.le-input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  border: 1px solid #D1CEC6;
  border-radius: 10px;
  background: #FFFFFF;
  color: #111111;
  font-size: 0.92em;
  font-family: inherit;
}
.le-dropdown {
  position: relative;
  width: 100%;
}
.le-dropdown-trigger {
  width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 11px;
  border: 1px solid #D1CEC6;
  border-radius: 10px;
  background: #FFFFFF;
  color: #111111;
  font-size: 0.92em;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.le-dropdown-trigger:hover {
  border-color: #0B4F3A;
  background: #F4F3EF;
}
.le-dropdown-trigger[aria-expanded="true"] {
  border-color: #0B4F3A;
  box-shadow: 0 0 0 2px rgba(11, 79, 58, 0.12);
}
.le-dropdown-chevron {
  font-size: 0.78em;
  color: #0B4F3A;
  transition: transform 0.15s ease;
}
.le-dropdown-trigger[aria-expanded="true"] .le-dropdown-chevron {
  transform: rotate(180deg);
}
.le-dropdown-menu {
  display: none;
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  background: #FFFFFF;
  border: 1px solid #D1CEC6;
  border-radius: 10px;
  box-shadow: 0 10px 24px rgba(17, 17, 17, 0.12);
  padding: 4px;
  max-height: 190px;
  overflow-y: auto;
}
.le-dropdown.is-open .le-dropdown-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.le-dropdown-item {
  width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #111111;
  font-size: 0.9em;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.le-dropdown-item:hover {
  background: #F4F3EF;
}
.le-dropdown-item.is-selected {
  background: #0B4F3A;
  color: #FFFFFF;
  font-weight: 600;
}
.le-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  background: #FFFFFF;
  border: 1px solid #E4E2DC;
  border-radius: 8px;
  font-size: 0.92em;
  font-weight: 500;
  cursor: pointer;
}
.le-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: #FFFFFF;
  border-bottom: 1px solid #E4E2DC;
}
.le-brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.le-brand img {
  width: 26px;
  height: 26px;
  border-radius: 9999px;
  object-fit: cover;
  border: 1px solid #B9D8CA;
}
.le-brand-title {
  font-weight: 700;
  font-size: 1.05em;
  color: #111111;
}
.le-brand-sub {
  font-size: 0.8em;
  color: #6B7280;
}
.le-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.le-btn-scan {
  background: #0B4F3A;
  color: #FFFFFF;
  border: none;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 0.88em;
  font-weight: 600;
  cursor: pointer;
}
.le-btn-scan:hover {
  background: #083D2D;
}
.le-btn-close {
  background: #FAF9F6;
  color: #374151;
  border: 1px solid #E4E2DC;
  border-radius: 8px;
  width: 28px;
  height: 28px;
  font-size: 1.08em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.le-score-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: #FFFFFF;
  border-bottom: 1px solid #E4E2DC;
}
.le-score-label {
  font-size: 0.82em;
  font-weight: 600;
  color: #6B7280;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.le-score-value {
  font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif;
  font-size: 2.1em;
  line-height: 1;
  color: #0B4F3A;
}
.le-meta-pills {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.le-pill {
  font-size: 0.8em;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 9999px;
  background: #E9F3EE;
  color: #0B4F3A;
  border: 1px solid #B9D8CA;
}
.le-body {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.le-empty {
  background: #FFFFFF;
  border: 1px solid #E4E2DC;
  border-radius: 12px;
  padding: 18px 14px;
  text-align: center;
  color: #374151;
}
.le-card {
  background: #FFFFFF;
  border: 1px solid #E4E2DC;
  border-radius: 12px;
  flex-shrink: 0;
}
.le-card-head {
  width: 100%;
  height: auto;
  background: transparent;
  border: none;
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.le-card-title {
  font-weight: 600;
  font-size: 0.96em;
  color: #111111;
}
.le-sev {
  font-size: 0.76em;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 6px;
  color: #FFFFFF;
  flex-shrink: 0;
}
.le-card-body {
  padding: 0 12px 12px;
  border-top: 1px solid #F1EFE9;
  color: #374151;
  font-size: 0.92em;
}
[data-tooltip] {
  position: relative;
}
[data-tooltip]:hover::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  max-width: 240px;
  width: max-content;
  background: #FFFFFF;
  border: 1px solid #E4E2DC;
  color: #111111;
  border-radius: 8px;
  box-shadow: 0 6px 18px rgba(17, 17, 17, 0.12);
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.35;
  z-index: 20;
  pointer-events: none;
  white-space: normal;
}
.le-card-head[data-tooltip]:hover::after {
  top: calc(100% + 6px);
  bottom: auto;
}
.le-card-body p {
  margin: 8px 0 0;
}
.le-excerpt {
  margin-top: 8px;
  padding: 7px 9px;
  background: #FAF9F6;
  border-left: 3px solid #0B4F3A;
  border-radius: 4px;
  font-size: 0.88em;
  color: #4B5563;
}
.le-draft-shell {
  position: fixed;
  z-index: 2147483647;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  overflow: hidden;
  transition: width 220ms cubic-bezier(0.16, 1, 0.3, 1), height 220ms cubic-bezier(0.16, 1, 0.3, 1), border-radius 220ms cubic-bezier(0.16, 1, 0.3, 1), left 220ms cubic-bezier(0.16, 1, 0.3, 1), top 220ms cubic-bezier(0.16, 1, 0.3, 1);
}
.le-draft-shell.expanded {
  width: 400px;
  max-width: calc(100vw - 16px);
  height: auto;
  border-radius: 24px;
}
.le-draft-pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid #D1CEC6;
  background: #FAF9F6;
  color: #0B4F3A;
  cursor: pointer;
  touch-action: none;
  box-shadow: 0 2px 8px rgba(17, 17, 17, 0.14);
  transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
}
.le-draft-pill img {
  width: 18px;
  height: 18px;
  pointer-events: none;
  user-select: none;
}
.le-draft-pill:hover {
  background: #F4F3EF;
  border-color: #0B4F3A;
  transform: translateY(-1px);
}
.le-draft-bar {
  position: relative;
  width: 100%;
  background: #F4F3EF;
  color: #111111;
  border: 1px solid #E4E2DC;
  border-radius: 24px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 12.5px;
}
.le-draft-bar.multiline,
.le-draft-bar.has-preview {
  border-radius: 18px;
}
.le-draft-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
  color: #374151;
}
.le-draft-preview {
  max-height: 220px;
  overflow-y: auto;
  padding: 10px 12px;
  background: #FAF9F6;
  border: 1px solid #E4E2DC;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.5;
  color: #1F2937;
  white-space: pre-wrap;
}
@keyframes leShimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.le-draft-shimmer-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.le-draft-shimmer {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, #ECEAE4 25%, #F7F6F2 50%, #ECEAE4 75%);
  background-size: 200% 100%;
  animation: leShimmer 1.4s infinite linear;
}
.le-draft-shimmer.short {
  width: 68%;
}
.le-draft-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.le-draft-recreate {
  background: #F4F3EF;
  color: #374151;
  border: 1px solid #E4E2DC;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.le-draft-recreate:hover {
  background: #E9E7E0;
}
.le-draft-insert {
  background: #0B4F3A;
  color: #FFFFFF;
  border: none;
  border-radius: 999px;
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.le-draft-insert:hover {
  background: #093F2E;
}
.le-draft-close {
  background: transparent;
  color: #6B7280;
  border: none;
  border-radius: 999px;
  width: 24px;
  height: 24px;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.le-draft-close:hover {
  background: #F3F4F6;
  color: #111111;
}
.le-draft-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  min-height: 28px;
}
.le-draft-sparkle {
  width: 20px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #0B4F3A;
  font-size: 15px;
  line-height: 1;
  flex-shrink: 0;
  user-select: none;
}
.le-draft-input {
  flex: 1;
  min-width: 0;
  min-height: 28px;
  max-height: 140px;
  padding: 5px 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: #111111;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  resize: none;
  overflow-y: auto;
  outline: none;
  box-sizing: border-box;
}
.le-draft-input::placeholder {
  color: #6B7280;
}
.le-companion-input {
  max-height: 68px;
}
.le-draft-submit {
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: #0B4F3A;
  color: #FFFFFF;
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
  display: none;
  align-items: center;
  justify-content: center;
}
.le-draft-submit.visible {
  display: inline-flex;
}
.le-draft-submit:hover {
  background: #093F2E;
}
.le-draft-submit:disabled {
  opacity: 0.6;
  cursor: default;
}
.le-draft-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.le-draft-chip {
  background: #FAF9F6;
  color: #374151;
  border: 1px solid #D1CEC6;
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
}
.le-draft-chip:hover {
  border-color: #0B4F3A;
  color: #0B4F3A;
}
.le-draft-error {
  font-size: 11.5px;
  color: #B91C1C;
}
`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function getClampedBadgePos(pos: BadgePosition): BadgePosition {
  const badgeSize = getBadgeSize();
  if (pos.edge === 'left' || pos.edge === 'right') {
    return {
      edge: pos.edge,
      offset: clamp(pos.offset, EDGE_MARGIN, window.innerHeight - badgeSize - EDGE_MARGIN)
    };
  }
  return {
    edge: pos.edge,
    offset: clamp(pos.offset, EDGE_MARGIN, window.innerWidth - badgeSize - EDGE_MARGIN)
  };
}

function getFabStyle(pos: BadgePosition): string {
  const clamped = getClampedBadgePos(pos);
  const badgeSize = getBadgeSize();
  const sizeStyle = `width:${badgeSize}px;height:${badgeSize}px;`;
  switch (clamped.edge) {
    case 'left':
      return `${sizeStyle}left:${EDGE_MARGIN}px;top:${clamped.offset}px;`;
    case 'right':
      return `${sizeStyle}right:${EDGE_MARGIN}px;top:${clamped.offset}px;`;
    case 'top':
      return `${sizeStyle}top:${EDGE_MARGIN}px;left:${clamped.offset}px;`;
    case 'bottom':
      return `${sizeStyle}bottom:${EDGE_MARGIN}px;left:${clamped.offset}px;`;
  }
}

function getDrawerStyle(pos: BadgePosition): string {
  const clamped = getClampedBadgePos(pos);
  const badgeSize = getBadgeSize();
  const { width, height } = POPUP_DIMENSIONS[state.settings.popupSize];
  const { fontSize } = TEXT_SIZES[state.settings.textSize];
  const sizeStyle = `width:${width}px;height:${height}px;font-size:${fontSize};`;
  if (clamped.edge === 'left' || clamped.edge === 'right') {
    const idealTop = clamped.offset + badgeSize / 2 - height / 2;
    const top = clamp(idealTop, EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN);
    return clamped.edge === 'left'
      ? `${sizeStyle}left:16px;top:${Math.round(top)}px;`
      : `${sizeStyle}right:16px;top:${Math.round(top)}px;`;
  }
  const idealLeft = clamped.offset + badgeSize / 2 - width / 2;
  const left = clamp(idealLeft, EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN);
  return clamped.edge === 'top'
    ? `${sizeStyle}top:16px;left:${Math.round(left)}px;`
    : `${sizeStyle}bottom:16px;left:${Math.round(left)}px;`;
}

function saveSettings(next: UserSettings): void {
  state.settings = next;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: state.settings });
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

function saveBadgePos(pos: BadgePosition): void {
  state.badgePos = getClampedBadgePos(pos);
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.set({ [STORAGE_KEY]: state.badgePos });
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

function render(shadow: ShadowRoot): void {
  const logoUrl = chrome.runtime.getURL('icons/legalease-logo.jpg');
  const flagCount = state.analysis?.clauses.length ?? 0;
  const riskScore = state.analysis?.overallRiskScore ?? 0;

  if (!state.isOpen) {
    wasDrawerOpen = false;
    const showFab = (flagCount > 0 || isLegalPage()) && !draftState.pillVisible && !draftState.isBarOpen;
    shadow.innerHTML = `
      <style>${getShadowStyles()}</style>
      ${showFab ? `<button class="le-fab${state.isScanning ? ' is-scanning' : ''}" type="button" title="Open LegalEase Audit" style="${getFabStyle(state.badgePos)}">
        <img src="${escapeHtml(logoUrl)}" alt="LegalEase" draggable="false" />
        ${
          state.isScanning
            ? '<span class="le-badge">…</span>'
            : flagCount > 0
              ? `<span class="le-badge ${riskScore >= 60 ? 'is-high' : ''}">${flagCount}</span>`
              : ''
        }
      </button>` : ''}
      <div id="le-draft-layer"></div>
    `;
    const fab = shadow.querySelector<HTMLButtonElement>('.le-fab');
    if (fab) {
      let startX = 0;
      let startY = 0;
      let originLeft = 0;
      let originTop = 0;
      let isDragging = false;
      let suppressNextClick = false;

      fab.addEventListener('pointerdown', (e: PointerEvent) => {
        if (e.button !== 0) return;
        const rect = fab.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        originLeft = rect.left;
        originTop = rect.top;
        isDragging = false;
        fab.setPointerCapture(e.pointerId);
      });

      fab.addEventListener('pointermove', (e: PointerEvent) => {
        if (!fab.hasPointerCapture(e.pointerId)) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!isDragging && Math.hypot(dx, dy) > 5) {
          isDragging = true;
          fab.style.transition = 'none';
        }
        if (!isDragging) return;
        const badgeSize = getBadgeSize();
        const nextLeft = clamp(originLeft + dx, 0, window.innerWidth - badgeSize);
        const nextTop = clamp(originTop + dy, 0, window.innerHeight - badgeSize);
        fab.style.left = `${nextLeft}px`;
        fab.style.top = `${nextTop}px`;
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
      });

      const finishDrag = (e: PointerEvent) => {
        if (fab.hasPointerCapture(e.pointerId)) {
          fab.releasePointerCapture(e.pointerId);
        }
        if (!isDragging) return;
        isDragging = false;
        suppressNextClick = true;

        const badgeSize = getBadgeSize();
        const rect = fab.getBoundingClientRect();
        const cx = rect.left + badgeSize / 2;
        const cy = rect.top + badgeSize / 2;
        const distances: Array<{ edge: SnapEdge; dist: number; offset: number }> = [
          { edge: 'left', dist: cx, offset: rect.top },
          { edge: 'right', dist: window.innerWidth - cx, offset: rect.top },
          { edge: 'top', dist: cy, offset: rect.left },
          { edge: 'bottom', dist: window.innerHeight - cy, offset: rect.left }
        ];
        distances.sort((a, b) => a.dist - b.dist);
        const nearest = distances[0];
        saveBadgePos({ edge: nearest.edge, offset: nearest.offset });

        fab.style.transition = '';
        fab.style.left = '';
        fab.style.top = '';
        fab.style.right = '';
        fab.style.bottom = '';
        fab.setAttribute('style', getFabStyle(state.badgePos));
      };

      fab.addEventListener('pointerup', finishDrag);
      fab.addEventListener('pointercancel', finishDrag);

      fab.addEventListener('click', () => {
        if (suppressNextClick) {
          suppressNextClick = false;
          return;
        }
        syncContextUrl();
        if (!state.settings.autoScan && !hasScannedCurrentContext) {
          if (!state.isScanning) {
            runLocalScan(shadow);
          }
          return;
        }
        state.isOpen = true;
        if (!state.hasScanned && !state.isScanning) {
          runLocalScan(shadow);
        } else {
          render(shadow);
        }
      });
    }
    renderDraftLayer(shadow);
    return;
  }

  const cardsHtml =
    state.analysis && state.analysis.clauses.length > 0
      ? state.analysis.clauses
          .map((clause: RiskClause) => {
            const expanded = state.expandedClauseId === clause.id;
            const sevColor = getSeverityColor(clause.severity);
            return `
              <div class="le-card" data-card-id="${escapeHtml(clause.id)}">
                <button class="le-card-head" type="button" data-toggle-id="${escapeHtml(clause.id)}"${!expanded ? ' data-tooltip="Click to view full explanation &amp; fix"' : ''}>
                  <span class="le-card-title">${escapeHtml(clause.title)}</span>
                  <span class="le-sev" style="background:${sevColor};">${escapeHtml(getSeverityLabel(clause.severity))}</span>
                </button>
                ${
                  expanded
                    ? `
                  <div class="le-card-body">
                    <p>${escapeHtml(clause.rationale)}</p>
                    ${
                      clause.excerpt
                        ? `<div class="le-excerpt">${escapeHtml(clause.excerpt)}</div>`
                        : ''
                    }
                    ${
                      clause.redlineProposal
                        ? `<p><strong>Redline:</strong> ${escapeHtml(clause.redlineProposal)}</p>`
                        : ''
                    }
                    ${
                      state.isEditableContext
                        ? `
                      <div class="le-card-actions">
                        <button class="le-btn-apply" type="button" data-apply-id="${escapeHtml(clause.id)}">✓ Apply Fix</button>
                        <button class="le-btn-dismiss" type="button" data-dismiss-id="${escapeHtml(clause.id)}">✕ Dismiss</button>
                      </div>
                    `
                        : ''
                    }
                  </div>
                `
                    : ''
                }
              </div>
            `;
          })
          .join('')
      : `
        <div class="le-empty">
          ${
            state.isScanning
              ? 'Scanning page locally...'
              : state.error
                ? escapeHtml(state.error)
                : state.hasScanned
                  ? 'No high-risk clauses detected on this page.'
                  : 'Click Scan Page to audit this document locally.'
          }
        </div>
      `;

  const animateOpen = !wasDrawerOpen;
  wasDrawerOpen = true;

  const settingsHtml = `
    <div class="le-settings">
      <div class="le-settings-top">
        <button class="le-btn-back" type="button">← Back</button>
        <span class="le-settings-title">Settings</span>
        <span></span>
      </div>
      <div class="le-field">
        <label class="le-field-label" id="le-popup-size-label">Popup Size</label>
        <div class="le-dropdown" data-dropdown="popupSize" id="le-popup-size">
          <button class="le-dropdown-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="le-popup-size-label">
            <span>${escapeHtml(POPUP_DIMENSIONS[state.settings.popupSize].label)}</span>
            <span class="le-dropdown-chevron">▾</span>
          </button>
          <div class="le-dropdown-menu" role="listbox">
            ${(Object.keys(POPUP_DIMENSIONS) as PopupSize[])
              .map(
                (key) =>
                  `<button class="le-dropdown-item${state.settings.popupSize === key ? ' is-selected' : ''}" type="button" role="option" aria-selected="${state.settings.popupSize === key}" data-value="${key}">${escapeHtml(POPUP_DIMENSIONS[key].label)}</button>`
              )
              .join('')}
          </div>
        </div>
      </div>
      <div class="le-field">
        <label class="le-field-label" id="le-text-size-label">Text Size</label>
        <div class="le-dropdown" data-dropdown="textSize" id="le-text-size">
          <button class="le-dropdown-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="le-text-size-label">
            <span>${escapeHtml(TEXT_SIZES[state.settings.textSize].label)}</span>
            <span class="le-dropdown-chevron">▾</span>
          </button>
          <div class="le-dropdown-menu" role="listbox">
            ${(Object.keys(TEXT_SIZES) as TextSize[])
              .map(
                (key) =>
                  `<button class="le-dropdown-item${state.settings.textSize === key ? ' is-selected' : ''}" type="button" role="option" aria-selected="${state.settings.textSize === key}" data-value="${key}">${escapeHtml(TEXT_SIZES[key].label)}</button>`
              )
              .join('')}
          </div>
        </div>
      </div>
      <div class="le-field">
        <label class="le-field-label" id="le-policy-mode-label">Policy Mode</label>
        <div class="le-dropdown" data-dropdown="policyMode" id="le-policy-mode">
          <button class="le-dropdown-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="le-policy-mode-label">
            <span>${escapeHtml(POLICY_MODES[state.settings.policyMode])}</span>
            <span class="le-dropdown-chevron">▾</span>
          </button>
          <div class="le-dropdown-menu" role="listbox">
            ${(Object.keys(POLICY_MODES) as PolicyMode[])
              .map(
                (key) =>
                  `<button class="le-dropdown-item${state.settings.policyMode === key ? ' is-selected' : ''}" type="button" role="option" aria-selected="${state.settings.policyMode === key}" data-value="${key}">${escapeHtml(POLICY_MODES[key])}</button>`
              )
              .join('')}
          </div>
        </div>
      </div>
      <div class="le-field">
        <label class="le-field-label" for="le-custom-terms">AI &amp; Privacy: Custom Redaction Terms</label>
        <input class="le-input" id="le-custom-terms" type="text" placeholder="e.g. Acme Corp, John Doe" value="${escapeHtml(state.settings.customRedactionTerms)}" />
      </div>
      <label class="le-toggle-row" data-tooltip="Automatically scans pages and textboxes for legal risks">
        <span>Auto-scan pages &amp; sites</span>
        <input id="le-auto-scan" type="checkbox" ${state.settings.autoScan ? 'checked' : ''} />
      </label>
      <label class="le-toggle-row" data-tooltip="Uses on-device AI to hide person names, company names, and codenames before any cloud call">
        <span>Hide names &amp; companies locally</span>
        <input id="le-semantic-pii" type="checkbox" ${state.settings.enableSemanticPii ? 'checked' : ''} />
      </label>
      <label class="le-toggle-row" data-tooltip="Simulates AI analysis locally using offline rules without network calls">
        <span>Sandbox Mode</span>
        <input id="le-sandbox-mode" type="checkbox" ${state.settings.sandboxMode ? 'checked' : ''} />
      </label>
    </div>
  `;

  shadow.innerHTML = `
    <style>${getShadowStyles()}</style>
    <div class="le-drawer${animateOpen ? ' le-animate-in' : ''}" role="dialog" aria-label="LegalEase Floating Audit" style="${getDrawerStyle(state.badgePos)}">
      <div class="le-header">
        <div class="le-brand">
          <img src="${escapeHtml(logoUrl)}" alt="LegalEase" />
          <div>
            <div class="le-brand-title">LegalEase</div>
            <div class="le-brand-sub">Private · On-device</div>
          </div>
        </div>
        <div class="le-actions">
          <button class="le-btn-scan" type="button">${state.isScanning ? 'Scanning...' : 'Scan Page'}</button>
          <button class="le-btn-settings" type="button" aria-label="Settings" title="Settings">⚙</button>
          <button class="le-btn-close" type="button" aria-label="Close">×</button>
        </div>
      </div>
      ${
        state.settingsOpen
          ? `<div class="le-body">${settingsHtml}</div>`
          : `
      <div class="le-score-bar">
        <div>
          <div class="le-score-label">Risk Score</div>
          <div class="le-score-value">${state.analysis ? `${riskScore}/100` : '--'}</div>
        </div>
        <div class="le-meta-pills">
          <span class="le-pill">${flagCount} flags</span>
          <span class="le-pill">${state.redactedCount} ${state.redactedCount === 1 ? 'private detail' : 'private details'} hidden</span>
        </div>
      </div>
      <div class="le-body">
        ${
          state.isEditableContext && state.analysis && state.analysis.clauses.length > 0
            ? `<div class="le-editable-bar"><button class="le-btn-accept-all" type="button">Accept All (${state.analysis.clauses.length})</button></div>`
            : ''
        }
        ${cardsHtml}
      </div>`
      }
    </div>
  `;

  shadow.querySelector('.le-btn-close')?.addEventListener('click', () => {
    state.isOpen = false;
    state.settingsOpen = false;
    render(shadow);
  });

  shadow.querySelector('.le-btn-settings')?.addEventListener('click', () => {
    state.settingsOpen = !state.settingsOpen;
    render(shadow);
  });

  shadow.querySelector('.le-btn-back')?.addEventListener('click', () => {
    state.settingsOpen = false;
    render(shadow);
  });

  const closeAllDropdowns = () => {
    shadow.querySelectorAll('.le-dropdown.is-open').forEach((el) => {
      el.classList.remove('is-open');
      el.querySelector('.le-dropdown-trigger')?.setAttribute('aria-expanded', 'false');
    });
  };

  shadow.querySelectorAll<HTMLButtonElement>('.le-dropdown-trigger').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = trigger.closest('.le-dropdown');
      if (!dropdown) return;
      const willOpen = !dropdown.classList.contains('is-open');
      closeAllDropdowns();
      if (willOpen) {
        dropdown.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
  });

  shadow.querySelectorAll<HTMLButtonElement>('.le-dropdown-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = item.closest<HTMLElement>('.le-dropdown');
      const key = dropdown?.dataset.dropdown;
      const val = item.dataset.value;
      if (!key || !val) return;
      if (key === 'popupSize') {
        saveSettings({ ...state.settings, popupSize: val as PopupSize });
      } else if (key === 'textSize') {
        saveSettings({ ...state.settings, textSize: val as TextSize });
      } else if (key === 'policyMode') {
        saveSettings({ ...state.settings, policyMode: val as PolicyMode });
      }
      render(shadow);
    });
  });

  shadow.querySelector('.le-drawer')?.addEventListener('click', () => {
    closeAllDropdowns();
  });

  shadow.querySelector<HTMLInputElement>('#le-custom-terms')?.addEventListener('input', (e) => {
    const val = (e.target as HTMLInputElement).value;
    saveSettings({ ...state.settings, customRedactionTerms: val });
  });

  shadow.querySelector<HTMLInputElement>('#le-semantic-pii')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    saveSettings({ ...state.settings, enableSemanticPii: checked });
  });

  shadow.querySelector<HTMLInputElement>('#le-sandbox-mode')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    saveSettings({ ...state.settings, sandboxMode: checked });
  });

  shadow.querySelector<HTMLInputElement>('#le-auto-scan')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    saveSettings({ ...state.settings, autoScan: checked });
  });

  shadow.querySelector('.le-btn-scan')?.addEventListener('click', () => {
    runLocalScan(shadow);
  });

  shadow.querySelectorAll('[data-toggle-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-toggle-id');
      const nextId = state.expandedClauseId === id ? null : id;
      state.expandedClauseId = nextId;
      render(shadow);
      if (nextId) {
        const mark = document.querySelector(`mark[data-legalease-id="${nextId}"]`);
        if (mark) {
          mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
          mark.classList.remove('le-mark-pulse');
          void (mark as HTMLElement).offsetWidth;
          mark.classList.add('le-mark-pulse');
          window.setTimeout(() => mark.classList.remove('le-mark-pulse'), 1400);
        }
      }
    });
  });

  shadow.querySelector('.le-btn-accept-all')?.addEventListener('click', () => {
    if (!activeEditableEl || !state.analysis) return;
    let nextText = getEditableText(activeEditableEl);
    let changed = false;
    for (const clause of state.analysis.clauses) {
      const updated = applyClauseFixToText(nextText, clause);
      if (updated !== null) {
        nextText = updated;
        changed = true;
      }
    }
    if (changed) {
      setEditableText(activeEditableEl, nextText);
      runLocalScan(shadow, nextText);
    }
  });

  shadow.querySelectorAll<HTMLButtonElement>('[data-apply-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!activeEditableEl || !state.analysis) return;
      const id = btn.getAttribute('data-apply-id');
      const clause = state.analysis.clauses.find((c) => c.id === id);
      if (!clause) return;
      const updated = applyClauseFixToText(getEditableText(activeEditableEl), clause);
      if (updated !== null) {
        setEditableText(activeEditableEl, updated);
        runLocalScan(shadow, updated);
      }
    });
  });

  shadow.querySelectorAll<HTMLButtonElement>('[data-dismiss-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.analysis) return;
      const id = btn.getAttribute('data-dismiss-id');
      state.analysis = {
        ...state.analysis,
        clauses: state.analysis.clauses.filter((c) => c.id !== id)
      };
      if (state.expandedClauseId === id) {
        state.expandedClauseId = state.analysis.clauses[0]?.id ?? null;
      }
      render(shadow);
    });
  });

  if (!shadow.getElementById('le-draft-layer')) {
    const draftLayer = document.createElement('div');
    draftLayer.id = 'le-draft-layer';
    shadow.appendChild(draftLayer);
  }
  renderDraftLayer(shadow);
}

const DRAFT_TEMPLATES: Record<string, string> = {
  'Balanced NDA':
    'Mutual Confidentiality. Each party ("Receiving Party") agrees to hold the other party\'s Confidential Information in strict confidence using at least the same degree of care it uses for its own confidential information, and not less than reasonable care. This obligation survives for three (3) years from disclosure and excludes information that is publicly available, independently developed, or rightfully received from a third party without restriction.',
  'Fair Liability Cap':
    'Limitation of Liability. Except for breaches of confidentiality, indemnification obligations, or gross negligence/willful misconduct, each party\'s aggregate liability arising out of or related to this Agreement shall not exceed the total fees paid or payable by Customer in the twelve (12) months immediately preceding the event giving rise to liability. Neither party shall be liable for indirect, incidental, or consequential damages.',
  'Payment Terms':
    'Fees and Payment. Undisputed invoices are due net thirty (30) days from receipt. Customer may withhold payment of any amount disputed in good faith by providing written notice within fifteen (15) days of invoice receipt, and the parties will work promptly to resolve the dispute. Late undisputed balances may accrue interest at 1.0% per month or the maximum rate permitted by law, whichever is lower.'
};

function getLocalTemplateDraft(prompt: string, previousDraft?: string): string {
  const normalized = prompt.trim().toLowerCase();
  const pctMatch = prompt.match(/\b(\d+(?:\.\d+)?%)/);
  const monthMatch = prompt.match(/\b(\d+)\s*months?\b/i);

  if (previousDraft) {
    let updated = previousDraft;
    let changed = false;

    if (normalized.includes('mutual')) {
      updated = updated
        .replace(/\b(Receiving Party|Provider|Vendor)\b/gi, 'either party')
        .replace(/Confidentiality\./i, 'Mutual Confidentiality.');
      changed = true;
    }
    if (monthMatch) {
      const months = monthMatch[1];
      const replaced = updated.replace(/\b\d+\s*\(\d+\)\s*months?\b|\b\d+\s*months?\b/gi, `${months} months`);
      if (replaced !== updated) {
        updated = replaced;
        changed = true;
      }
    }
    if (pctMatch) {
      const replaced = updated.replace(/\b\d+(?:\.\d+)?%/, pctMatch[1]);
      if (replaced !== updated) {
        updated = replaced;
        changed = true;
      }
    }
    if ((normalized.includes('ip') || normalized.includes('intellectual property')) && !/intellectual property/i.test(updated)) {
      updated = `${updated}\n\nIntellectual Property Assignment. Each party hereby assigns to the Company all right, title, and interest in and to any Intellectual Property created in connection with this Agreement.`;
      changed = true;
    }
    if ((normalized.includes('non-solicit') || normalized.includes('nonsolicit')) && !/non-solicitation/i.test(updated)) {
      updated = `${updated}\n\nNon-Solicitation. For a period of twelve (12) months following termination, neither party shall directly solicit for employment any employee or contractor of the other party.`;
      changed = true;
    }
    if (!changed && !updated.toLowerCase().includes('good faith')) {
      updated = `${updated}\n\nGeneral. Both parties shall perform their respective obligations in good faith and provide written notice of any material breach with a thirty (30) day cure period.`;
    }
    return updated;
  }

  if (/\b(co-?founder|equity|vesting|shares|startup)\b/i.test(normalized)) {
    const equityPct = pctMatch ? pctMatch[1] : 'the agreed percentage';
    return `Co-Founder Equity & Vesting Agreement. Founder shall receive ${equityPct} of the Company's common stock, subject to a four (4) year vesting schedule with a one (1) year cliff: twenty-five percent (25%) of the shares shall vest on the one-year anniversary of the Vesting Commencement Date, and the remaining seventy-five percent (75%) shall vest in equal monthly installments over the following thirty-six (36) months, conditioned upon continuous service. Founder may file a timely election under Section 83(b) of the Internal Revenue Code within thirty (30) days of the grant date. Founder hereby assigns to the Company all right, title, and interest in and to all Intellectual Property conceived or developed in connection with the Company, and agrees to maintain strict confidentiality of all proprietary Company information.`;
  }

  if (/\b(freelance|contractor|services|sow|statement of work)\b/i.test(normalized)) {
    return 'Independent Contractor & Services. Contractor shall perform the Services in a professional and workmanlike manner in accordance with the applicable Statement of Work. Contractor is an independent contractor and not an employee of Client. Upon full payment of undisputed fees, all deliverables created specifically for Client under this Agreement shall be owned by Client as work made for hire, or otherwise assigned to Client.';
  }

  if (/\b(privacy|data|gdpr|ai|model|training)\b/i.test(normalized)) {
    return 'Data Privacy & AI Processing. Each party shall comply with all applicable data protection laws. Provider shall process Customer Data solely to deliver and support the Services and shall not use Customer Data to train or fine-tune foundation models for third parties without Customer\'s prior written consent. Provider shall maintain industry-standard technical and organizational safeguards.';
  }

  for (const [label, template] of Object.entries(DRAFT_TEMPLATES)) {
    if (
      normalized.includes(label.toLowerCase()) ||
      (label === 'Balanced NDA' && normalized.includes('nda')) ||
      (label === 'Fair Liability Cap' && normalized.includes('liability')) ||
      (label === 'Payment Terms' && normalized.includes('payment'))
    ) {
      return template;
    }
  }

  return 'Standard Commercial Terms. Each party shall perform its obligations in good faith, comply with all applicable laws and regulations, and provide written notice of any material breach with a thirty (30) day cure period prior to termination.';
}

async function generateLegalDraft(prompt: string, previousDraft?: string): Promise<string> {
  const mode = state.settings.policyMode;
  const systemInstruction = 'You are LegalEase, a concise commercial contract drafting assistant. Return only the ready-to-insert legal clause text with no preamble or markdown fences.';
  const fullPrompt = previousDraft
    ? `Refine the following contract clause based on this instruction: "${prompt}".\n\nCurrent draft:\n${previousDraft}`
    : `Draft a clear, balanced contract clause for: "${prompt}".`;

  const tryOnDevice = async (): Promise<string | null> => {
    try {
      const lm = (window as unknown as { LanguageModel?: { create?: (opts?: unknown) => Promise<{ prompt: (q: string) => Promise<string>; destroy?: () => void }> } }).LanguageModel;
      if (!lm?.create) return null;
      const session = await lm.create({ systemPrompt: systemInstruction });
      try {
        const result = await session.prompt(fullPrompt);
        return result?.trim() || null;
      } finally {
        session.destroy?.();
      }
    } catch {
      return null;
    }
  };

  let cloudError: string | null = null;

  const tryCloud = async (): Promise<string | null> => {
    try {
      const services = await initializeFirebaseServices({ skipAppCheck: true });
      const model = (services as unknown as { geminiModel?: { generateContent?: (p: string) => Promise<{ response?: { text?: () => string } }> } })?.geminiModel;
      if (model?.generateContent) {
        const res = await model.generateContent(`${systemInstruction}\n\n${fullPrompt}`);
        const text = res?.response?.text?.();
        if (text?.trim()) return text.trim();
      }
    } catch {
      // Fall through to background service worker Gemini 2.5 Flash Lite call
    }

    try {
      const runtime = chrome.runtime as unknown as {
        sendMessage: (msg: unknown) => Promise<{ ok?: boolean; text?: string; error?: string } | undefined>;
      };
      const response = await runtime.sendMessage({
        type: 'LEGALEASE_CLOUD_DRAFT',
        prompt,
        previousDraft,
        apiKey: EXTENSION_API_KEY,
      });
      if (response?.ok && response.text?.trim()) {
        return response.text.trim();
      }
      if (response?.error) {
        cloudError = response.error;
      }
    } catch (err) {
      cloudError = err instanceof Error ? err.message : String(err);
      return null;
    }
    return null;
  };

  const fallbackOfflineOrThrow = (): string => {
    if (!navigator.onLine || state.settings.sandboxMode) {
      return getLocalTemplateDraft(prompt, previousDraft);
    }
    throw new Error(cloudError || 'Unable to generate legal draft: both on-device and cloud models failed.');
  };

  if (mode === 'only_on_device') {
    return (await tryOnDevice()) ?? fallbackOfflineOrThrow();
  }
  if (mode === 'prefer_on_device') {
    return (await tryOnDevice()) ?? (await tryCloud()) ?? fallbackOfflineOrThrow();
  }
  if (mode === 'prefer_in_cloud') {
    return (await tryCloud()) ?? (await tryOnDevice()) ?? fallbackOfflineOrThrow();
  }
  return (await tryCloud()) ?? fallbackOfflineOrThrow();
}

function insertDraftIntoTarget(el: HTMLElement, text: string): void {
  if (el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const spacer =
      before.length > 0 && !before.endsWith('\n')
        ? '\n\n'
        : before.endsWith('\n') && !before.endsWith('\n\n')
          ? '\n'
          : '';
    el.value = `${before}${spacer}${text}${after}`;
    const nextPos = before.length + spacer.length + text.length;
    el.setSelectionRange(nextPos, nextPos);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    return;
  }

  el.focus();
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    let insertText = text;
    if (range.collapsed) {
      const preRange = document.createRange();
      preRange.selectNodeContents(el);
      preRange.setEnd(range.startContainer, range.startOffset);
      const preText = preRange.toString();
      if (preText.length > 0 && !preText.endsWith('\n')) {
        insertText = `\n\n${text}`;
      } else if (preText.endsWith('\n') && !preText.endsWith('\n\n')) {
        insertText = `\n${text}`;
      }
    }
    range.deleteContents();
    const node = document.createTextNode(insertText);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    const current = el.innerText;
    el.innerText = current.trim().length > 0 ? `${current.replace(/\s+$/, '')}\n\n${text}` : text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const companionExplanationCache = new Map<string, string>();

function clearCompanionHighlight(): void {
  document.querySelectorAll('mark.le-companion-active-sel').forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize();
  });
}

function createCompanionMark(): HTMLElement {
  const mark = document.createElement('mark');
  mark.className = 'le-companion-active-sel';
  mark.style.cssText = 'background:rgba(11,79,58,0.12);color:inherit;border-radius:3px;padding:0 2px;';
  return mark;
}

function highlightCompanionRange(range: Range): void {
  clearCompanionHighlight();
  const mark = createCompanionMark();
  try {
    range.surroundContents(mark);
  } catch {
    const frag = range.extractContents();
    mark.appendChild(frag);
    range.insertNode(mark);
  }
}

function navigateToSectionInDom(sectionQuery: string): string | null {
  const escaped = sectionQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`(?:^|\\b)(?:section\\s+)?${escaped}(?:\\b|\\.|\\s|$)`, 'i');
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, li, dt, div, section'),
  );
  let targetEl: HTMLElement | null = null;
  for (const el of candidates) {
    if (el.closest('#legalease-root')) continue;
    const text = (el.innerText || '').trim();
    if (!text || text.length > 2500) continue;
    if (headingRe.test(text.slice(0, 120))) {
      targetEl = el;
      break;
    }
  }
  if (!targetEl) return null;

  targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const range = document.createRange();
  range.selectNodeContents(targetEl);
  highlightCompanionRange(range);
  return (targetEl.innerText || '').trim().slice(0, 4000);
}

function formatCompanionText(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

async function explainSelection(selectedText: string, followUpQuestion?: string): Promise<string> {
  const runtime = chrome.runtime as unknown as {
    sendMessage: (msg: unknown) => Promise<{ ok?: boolean; text?: string; error?: string } | undefined>;
  };
  const documentContext = (document.body?.innerText || '').trim().slice(0, 45000);
  const response = await runtime.sendMessage({
    type: 'LEGALEASE_COMPANION_EXPLAIN',
    selectedText,
    documentContext,
    followUpQuestion,
    apiKey: EXTENSION_API_KEY,
  });
  if (response?.ok && response.text) {
    return response.text;
  }
  throw new Error(response?.error || 'Unable to explain selection.');
}

function replaceSelectionInTarget(replacement: string): void {
  const el = companionState.targetEl;
  if (!el || !el.isConnected) return;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.focus();
    el.setRangeText(replacement, companionState.selectionStart, companionState.selectionEnd, 'select');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (companionState.savedRange) {
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(companionState.savedRange);
    }
    companionState.savedRange.deleteContents();
    const node = document.createTextNode(replacement);
    companionState.savedRange.insertNode(node);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function isRectInViewport(rect: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

function updateDraftPositions(shadow: ShadowRoot): void {
  const shell = shadow.querySelector<HTMLDivElement>('.le-draft-shell');
  const fab = shadow.querySelector<HTMLButtonElement>('.le-fab');
  const isExpanded = companionState.isActive ? companionState.isOpen : draftState.isBarOpen;

  if (fab) {
    const flagCount = state.analysis?.clauses.length ?? 0;
    const shouldShowFab =
      (flagCount > 0 || isLegalPage() || state.isOpen) &&
      !draftState.pillVisible &&
      !draftState.isBarOpen &&
      !companionState.isActive;
    fab.style.display = shouldShowFab ? 'inline-flex' : 'none';
  }

  if (!shell) return;

  if (companionState.isActive && companionState.anchorRect) {
    shell.style.display = 'block';
    const { left: anchorLeft, top: anchorTop } = companionState.anchorRect;
    if (isExpanded) {
      const barWidth = Math.min(400, window.innerWidth - 24);
      const barHeight = shell.scrollHeight || 160;
      const onRightSide = anchorLeft + 16 > window.innerWidth / 2;
      const rawLeft = onRightSide ? anchorLeft + 32 - barWidth : anchorLeft;
      shell.style.width = `${barWidth}px`;
      shell.style.left = `${clamp(rawLeft, 12, Math.max(12, window.innerWidth - barWidth - 12))}px`;
      shell.style.top = `${clamp(anchorTop, 12, Math.max(12, window.innerHeight - barHeight - 12))}px`;
    } else {
      shell.style.width = '32px';
      shell.style.left = `${clamp(anchorLeft, 8, window.innerWidth - 40)}px`;
      shell.style.top = `${clamp(anchorTop, 8, window.innerHeight - 40)}px`;
    }
    return;
  }

  const el = draftState.targetEl;
  if (!el || !el.isConnected) {
    shell.style.display = 'none';
    return;
  }
  const rect = el.getBoundingClientRect();
  const visible = isRectInViewport(rect);
  if (!visible) {
    shell.style.display = 'none';
    return;
  }
  shell.style.display = 'block';
  const defaultLeft = rect.right + 8;
  const defaultTop = rect.bottom - 32;
  const minLeft = Math.max(8, rect.left - 36);
  const maxLeft = Math.min(window.innerWidth - 40, rect.right + 36 - 32);
  const minTop = Math.max(8, rect.top - 36);
  const maxTop = Math.min(window.innerHeight - 40, rect.bottom + 36 - 32);
  const rawLeft = draftState.pillOffset ? rect.left + draftState.pillOffset.dx : defaultLeft;
  const rawTop = draftState.pillOffset ? rect.top + draftState.pillOffset.dy : defaultTop;
  const pillLeft = clamp(rawLeft, Math.min(minLeft, maxLeft), Math.max(minLeft, maxLeft));
  const pillTop = clamp(rawTop, Math.min(minTop, maxTop), Math.max(minTop, maxTop));

  if (isExpanded) {
    const barWidth = Math.min(400, window.innerWidth - 24);
    const barHeight = shell.scrollHeight || 110;
    const onRightSide = pillLeft + 16 > window.innerWidth / 2;
    const rawBarLeft = onRightSide ? pillLeft + 32 - barWidth : pillLeft;
    shell.style.width = `${barWidth}px`;
    shell.style.left = `${clamp(rawBarLeft, 12, Math.max(12, window.innerWidth - barWidth - 12))}px`;
    shell.style.top = `${clamp(pillTop, 12, Math.max(12, window.innerHeight - barHeight - 12))}px`;
  } else {
    shell.style.width = '32px';
    shell.style.left = `${pillLeft}px`;
    shell.style.top = `${pillTop}px`;
  }
}

function renderDraftLayer(shadow: ShadowRoot): void {
  const layer = shadow.getElementById('le-draft-layer');
  if (!layer) return;

  const logoUrl = chrome.runtime.getURL('icons/legalease-logo.jpg');

  if (companionState.isActive) {
    if (!companionState.isOpen) {
      layer.innerHTML = `
        <div class="le-draft-shell">
          <button class="le-draft-pill le-companion-pill" type="button" title="Explain selection with LegalEase"><img src="${escapeHtml(logoUrl)}" alt="LegalEase" draggable="false" /></button>
        </div>
      `;
      updateDraftPositions(shadow);
      layer.querySelector<HTMLButtonElement>('.le-companion-pill')?.addEventListener('click', () => {
        if (!companionState.isEditable && companionState.savedRange) {
          highlightCompanionRange(companionState.savedRange);
        }
        const cached = companionExplanationCache.get(companionState.selectedText);
        if (cached) {
          companionState.isOpen = true;
          companionState.isExplaining = false;
          companionState.explanation = cached;
          companionState.error = null;
          renderDraftLayer(shadow);
          return;
        }
        companionState.isOpen = true;
        companionState.isExplaining = true;
        companionState.error = null;
        renderDraftLayer(shadow);
        void explainSelection(companionState.selectedText)
          .then((res) => {
            companionExplanationCache.set(companionState.selectedText, res);
            companionState.explanation = res;
          })
          .catch((err: unknown) => {
            companionState.error = err instanceof Error ? err.message : 'Unable to explain selection.';
          })
          .finally(() => {
            companionState.isExplaining = false;
            renderDraftLayer(shadow);
          });
      });
      return;
    }

    const explanationHtml = companionState.isExplaining
      ? `<div class="le-draft-preview">
          <div class="le-draft-shimmer-wrap">
            <div class="le-draft-shimmer"></div>
            <div class="le-draft-shimmer"></div>
            <div class="le-draft-shimmer short"></div>
          </div>
        </div>`
      : companionState.explanation
        ? `<div class="le-draft-preview">${formatCompanionText(companionState.explanation)}</div>`
        : '';

    const rewritePreviewHtml = companionState.isRewriting
      ? `<div class="le-draft-preview">
          <div class="le-draft-shimmer-wrap">
            <div class="le-draft-shimmer"></div>
            <div class="le-draft-shimmer short"></div>
          </div>
        </div>`
      : companionState.draftText
        ? `<div class="le-draft-preview">${escapeHtml(companionState.draftText)}</div>`
        : '';

    const editableChipsHtml = companionState.isEditable
      ? `<div class="le-draft-chips">
          <button class="le-draft-chip le-companion-chip" type="button" data-chip="Fix this to favor me">Fix this to favor me</button>
          <button class="le-draft-chip le-companion-chip" type="button" data-chip="Make formal">Make formal</button>
        </div>`
      : '';

    const replaceActionHtml =
      companionState.isEditable && !companionState.isRewriting && companionState.draftText
        ? `<div class="le-draft-actions">
            <button class="le-draft-insert le-companion-replace" type="button">Replace Selection</button>
          </div>`
        : '';

    const hasPrompt = companionState.prompt.trim().length > 0;
    const placeholder = companionState.isEditable
      ? companionState.draftText
        ? 'Refine rewrite...'
        : 'How should I rewrite this?'
      : 'Ask a follow-up question...';

    layer.innerHTML = `
      <div class="le-draft-shell expanded">
        <div class="le-draft-bar has-preview" role="dialog" aria-label="LegalEase Companion">
          <div style="display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:12px;color:#0B4F3A;">
            <span>LegalEase Companion</span>
            <button class="le-companion-close" type="button" aria-label="Close Companion" style="border:none;background:transparent;cursor:pointer;font-size:14px;color:#4B5563;">✕</button>
          </div>
          ${explanationHtml}
          ${rewritePreviewHtml}
          <div class="le-draft-row">
            <span class="le-draft-sparkle" aria-hidden="true">✦</span>
            <textarea rows="1" class="le-draft-input le-companion-input" placeholder="${placeholder}">${escapeHtml(companionState.prompt)}</textarea>
            <button class="le-draft-submit le-companion-submit${hasPrompt ? ' visible' : ''}" type="button" aria-label="Send" ${companionState.isExplaining || companionState.isRewriting ? 'disabled' : ''}>↑</button>
          </div>
          ${editableChipsHtml}
          ${replaceActionHtml}
          ${companionState.error ? `<div class="le-draft-error">${escapeHtml(companionState.error)}</div>` : ''}
        </div>
      </div>
    `;
    updateDraftPositions(shadow);

    const input = layer.querySelector<HTMLTextAreaElement>('.le-companion-input');
    const submitBtn = layer.querySelector<HTMLButtonElement>('.le-companion-submit');

    const runCompanionPrompt = async (promptOverride?: string) => {
      const query = (promptOverride ?? input?.value ?? companionState.prompt).trim();
      if (!query || companionState.isExplaining || companionState.isRewriting) return;
      companionState.prompt = promptOverride ? '' : query;
      companionState.error = null;
      if (companionState.isEditable) {
        companionState.isRewriting = true;
        renderDraftLayer(shadow);
        try {
          const baseText = companionState.draftText || companionState.selectedText;
          companionState.draftText = await generateLegalDraft(query, baseText);
          companionState.prompt = '';
        } catch (err: unknown) {
          companionState.error = err instanceof Error ? err.message : 'Unable to rewrite selection.';
        } finally {
          companionState.isRewriting = false;
          renderDraftLayer(shadow);
        }
      } else {
        companionState.isExplaining = true;
        renderDraftLayer(shadow);
        try {
          const navMatch =
            query.match(/\b(?:navigate|go|jump|scroll)\s+to\s+(?:section\s+)?([a-z0-9.]+)/i) ||
            query.match(/\bsection\s+([0-9]+(?:\.[0-9]+)*)/i);
          if (navMatch?.[1]) {
            const sectionText = navigateToSectionInDom(navMatch[1]);
            if (sectionText) {
              companionState.selectedText = sectionText;
            }
          }
          companionState.explanation = await explainSelection(companionState.selectedText, query);
          companionState.prompt = '';
        } catch (err: unknown) {
          companionState.error = err instanceof Error ? err.message : 'Unable to answer follow-up.';
        } finally {
          companionState.isExplaining = false;
          renderDraftLayer(shadow);
        }
      }
    };

    const syncInputHeight = () => {
      if (!input) return;
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 68)}px`;
    };
    syncInputHeight();

    input?.addEventListener('mousedown', (e: MouseEvent) => {
      e.stopPropagation();
    });
    input?.addEventListener('input', () => {
      companionState.prompt = input.value;
      submitBtn?.classList.toggle('visible', input.value.trim().length > 0);
      syncInputHeight();
    });
    input?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void runCompanionPrompt();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        clearCompanionHighlight();
        companionState.isActive = false;
        companionState.isOpen = false;
        renderDraftLayer(shadow);
      }
    });
    submitBtn?.addEventListener('click', () => void runCompanionPrompt());
    layer.querySelectorAll<HTMLButtonElement>('.le-companion-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const val = chip.getAttribute('data-chip') || '';
        void runCompanionPrompt(val);
      });
    });
    layer.querySelector<HTMLButtonElement>('.le-companion-replace')?.addEventListener('click', () => {
      if (companionState.draftText) {
        replaceSelectionInTarget(companionState.draftText);
      }
      clearCompanionHighlight();
      companionState.isActive = false;
      companionState.isOpen = false;
      companionState.draftText = '';
      companionState.prompt = '';
      renderDraftLayer(shadow);
    });
    layer.querySelector<HTMLButtonElement>('.le-companion-close')?.addEventListener('click', () => {
      clearCompanionHighlight();
      companionState.isActive = false;
      companionState.isOpen = false;
      renderDraftLayer(shadow);
    });
    return;
  }

  if (!draftState.pillVisible || !draftState.targetEl || !draftState.targetEl.isConnected) {
    layer.innerHTML = '';
    updateDraftPositions(shadow);
    return;
  }

  const chipsHtml =
    !draftState.isGenerating && draftState.draftText
      ? `<div class="le-draft-chips">
          <button class="le-draft-chip" type="button" data-chip="Add Protections">Add Protections</button>
          <button class="le-draft-chip" type="button" data-chip="Make Mutual">Make Mutual</button>
          <button class="le-draft-chip" type="button" data-chip="Tighten Terms">Tighten Terms</button>
        </div>`
      : '';

  const previewHtml = draftState.isGenerating
    ? `<div class="le-draft-preview">
        <div class="le-draft-shimmer-wrap">
          <div class="le-draft-shimmer"></div>
          <div class="le-draft-shimmer"></div>
          <div class="le-draft-shimmer short"></div>
        </div>
      </div>`
    : draftState.draftText
      ? `<div class="le-draft-preview">${escapeHtml(draftState.draftText)}</div>`
      : '';

  const actionsHtml =
    !draftState.isGenerating && draftState.draftText
      ? `<div class="le-draft-actions">
          <button class="le-draft-recreate" type="button">↻ Redraft</button>
          <button class="le-draft-insert" type="button">Insert</button>
        </div>`
      : '';

  const hasPreview = Boolean(previewHtml);
  const hasPrompt = draftState.prompt.trim().length > 0;
  const barHtml = draftState.isBarOpen
    ? `<div class="le-draft-bar${hasPreview ? ' has-preview' : ''}" role="dialog" aria-label="LegalEase Draft & Refine">
        ${previewHtml}
        <div class="le-draft-row">
          <span class="le-draft-sparkle" aria-hidden="true">✦</span>
          <textarea rows="1" class="le-draft-input" placeholder="${draftState.draftText ? 'Refine this draft...' : 'Describe your contract or clause...'}">${escapeHtml(draftState.prompt)}</textarea>
          <button class="le-draft-submit${hasPrompt ? ' visible' : ''}" type="button" aria-label="Send prompt" ${draftState.isGenerating ? 'disabled' : ''}>↑</button>
        </div>
        ${chipsHtml}
        ${actionsHtml}
        ${draftState.error ? `<div class="le-draft-error">${escapeHtml(draftState.error)}</div>` : ''}
      </div>`
    : '';

  layer.innerHTML = `
    <div class="le-draft-shell${draftState.isBarOpen ? ' expanded' : ''}">
      ${draftState.isBarOpen ? barHtml : `<button class="le-draft-pill" type="button" title="Draft with LegalEase (Ctrl+J)"><img src="${escapeHtml(logoUrl)}" alt="LegalEase" draggable="false" /></button>`}
    </div>
  `;

  updateDraftPositions(shadow);

  const pill = layer.querySelector<HTMLButtonElement>('.le-draft-pill');
  if (pill) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let isDragging = false;
    let suppressNextClick = false;

    pill.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      const pRect = pill.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      originLeft = pRect.left;
      originTop = pRect.top;
      isDragging = false;
      pill.setPointerCapture(e.pointerId);
    });

    pill.addEventListener('pointermove', (e: PointerEvent) => {
      if (!pill.hasPointerCapture(e.pointerId) || !draftState.targetEl) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!isDragging && Math.hypot(dx, dy) > 4) {
        isDragging = true;
        suppressNextClick = true;
      }
      if (!isDragging) return;
      const rect = draftState.targetEl.getBoundingClientRect();
      const minLeft = Math.max(8, rect.left - 36);
      const maxLeft = Math.min(window.innerWidth - 40, rect.right + 36 - 32);
      const minTop = Math.max(8, rect.top - 36);
      const maxTop = Math.min(window.innerHeight - 40, rect.bottom + 36 - 32);
      const nextLeft = clamp(originLeft + dx, Math.min(minLeft, maxLeft), Math.max(minLeft, maxLeft));
      const nextTop = clamp(originTop + dy, Math.min(minTop, maxTop), Math.max(minTop, maxTop));
      pill.style.left = `${nextLeft}px`;
      pill.style.top = `${nextTop}px`;
      draftState.pillOffset = { dx: nextLeft - rect.left, dy: nextTop - rect.top };
    });

    pill.addEventListener('pointerup', (e: PointerEvent) => {
      if (pill.hasPointerCapture(e.pointerId)) {
        pill.releasePointerCapture(e.pointerId);
      }
    });

    pill.addEventListener('click', () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      draftState.isBarOpen = true;
      renderDraftLayer(shadow);
      layer.querySelector<HTMLTextAreaElement>('.le-draft-input')?.focus();
    });
  }

  const input = layer.querySelector<HTMLTextAreaElement>('.le-draft-input');
  const submitBtn = layer.querySelector<HTMLButtonElement>('.le-draft-submit');

  const runDraft = async (promptOverride?: string) => {
    const query = (promptOverride ?? input?.value ?? draftState.prompt).trim();
    if (!query || draftState.isGenerating) return;
    draftState.prompt = promptOverride ? '' : query;
    draftState.isGenerating = true;
    draftState.error = null;
    renderDraftLayer(shadow);
    try {
      const result = await generateLegalDraft(query, draftState.draftText || undefined);
      draftState.draftText = result;
      draftState.prompt = '';
    } catch (err) {
      draftState.error = err instanceof Error ? err.message : 'Unable to generate draft.';
    } finally {
      draftState.isGenerating = false;
      renderDraftLayer(shadow);
      layer.querySelector<HTMLTextAreaElement>('.le-draft-input')?.focus();
    }
  };

  const syncDraftInputLayout = () => {
    if (!input) return;
    input.style.height = 'auto';
    const nextHeight = Math.min(input.scrollHeight, 140);
    input.style.height = `${nextHeight}px`;
    const barEl = layer.querySelector<HTMLDivElement>('.le-draft-bar');
    barEl?.classList.toggle('multiline', input.scrollHeight > 34);
    submitBtn?.classList.toggle('visible', input.value.trim().length > 0);
  };

  if (input && input.value) {
    syncDraftInputLayout();
  }

  input?.addEventListener('input', () => {
    draftState.prompt = input.value;
    syncDraftInputLayout();
  });

  input?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void runDraft();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      draftState.isBarOpen = false;
      renderDraftLayer(shadow);
      draftState.targetEl?.focus();
    }
  });

  submitBtn?.addEventListener('click', () => {
    void runDraft();
  });

  layer.querySelectorAll<HTMLButtonElement>('.le-draft-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const val = chip.getAttribute('data-chip') || '';
      void runDraft(val);
    });
  });

  layer.querySelector<HTMLButtonElement>('.le-draft-recreate')?.addEventListener('click', () => {
    void runDraft('Recreate this legal draft with a fresh variation');
  });

  layer.querySelector<HTMLButtonElement>('.le-draft-insert')?.addEventListener('click', () => {
    if (draftState.targetEl && draftState.draftText) {
      insertDraftIntoTarget(draftState.targetEl, draftState.draftText);
    }
    draftState.isBarOpen = false;
    draftState.draftText = '';
    draftState.prompt = '';
    renderDraftLayer(shadow);
  });

  layer.querySelector<HTMLButtonElement>('.le-draft-close')?.addEventListener('click', () => {
    draftState.isBarOpen = false;
    renderDraftLayer(shadow);
    draftState.targetEl?.focus();
  });
}

function init(): void {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  render(shadow);

  document.addEventListener('focusin', (e: FocusEvent) => {
    if (!state.settings.autoScan) return;
    const el = getEditableElement(e.target);
    if (!el) return;
    draftState.targetEl = el;
    draftState.pillVisible = true;
    renderDraftLayer(shadow);
    const text = getEditableText(el);
    if (!isLikelyLegalText(text)) return;
    state.isEditableContext = true;
    activeEditableEl = el;
    runLocalScan(shadow, text);
  });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
      const el = getEditableElement(document.activeElement) ?? draftState.targetEl;
      if (!el) return;
      e.preventDefault();
      draftState.targetEl = el;
      draftState.pillVisible = true;
      draftState.isBarOpen = true;
      renderDraftLayer(shadow);
      shadow.querySelector<HTMLTextAreaElement>('.le-draft-input')?.focus();
    }
  });

  window.addEventListener('scroll', () => updateDraftPositions(shadow), { capture: true, passive: true });
  window.addEventListener('resize', () => updateDraftPositions(shadow), { passive: true });

  document.addEventListener('pointerdown', (e: PointerEvent) => {
    const target = e.target as Node | null;
    if (target && (target === host || host.contains(target))) return;
    let changed = false;
    if (draftState.isBarOpen) {
      draftState.isBarOpen = false;
      changed = true;
    }
    if (companionState.isOpen) {
      clearCompanionHighlight();
      companionState.isActive = false;
      companionState.isOpen = false;
      changed = true;
    }
    if (changed) {
      renderDraftLayer(shadow);
    }
  });

  const handleSelectionChange = (e: Event) => {
    const target = e.target as Node | null;
    if (target && (target === host || host.contains(target))) return;
    if (companionDebounceTimer !== null) {
      window.clearTimeout(companionDebounceTimer);
    }
    companionDebounceTimer = window.setTimeout(() => {
      companionDebounceTimer = null;
      const activeEl = document.activeElement;
      const editableEl = getEditableElement(activeEl);
      let selectedText = '';
      let isEditable = false;
      let selectionStart = 0;
      let selectionEnd = 0;
      let savedRange: Range | null = null;
      let anchorRect: { left: number; top: number } | null = null;

      if (editableEl instanceof HTMLTextAreaElement || editableEl instanceof HTMLInputElement) {
        selectionStart = editableEl.selectionStart ?? 0;
        selectionEnd = editableEl.selectionEnd ?? 0;
        selectedText = editableEl.value.slice(selectionStart, selectionEnd).trim();
        if (selectedText.length >= 20) {
          isEditable = true;
          const rect = editableEl.getBoundingClientRect();
          anchorRect = { left: rect.right - 36, top: rect.bottom - 36 };
        }
      } else {
        const sel = window.getSelection();
        selectedText = sel?.toString().trim() ?? '';
        if (selectedText.length >= 20 && sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          savedRange = range.cloneRange();
          const rects = range.getClientRects();
          const lastRect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
          anchorRect = { left: lastRect.right + 6, top: lastRect.bottom - 16 };
          isEditable = Boolean(editableEl && editableEl.contains(range.commonAncestorContainer));
        }
      }

      if (selectedText.length < 20 || !anchorRect) return;

      companionState.isActive = true;
      companionState.isOpen = false;
      companionState.selectedText = selectedText;
      companionState.isEditable = isEditable;
      companionState.targetEl = isEditable ? editableEl : null;
      companionState.selectionStart = selectionStart;
      companionState.selectionEnd = selectionEnd;
      companionState.savedRange = savedRange;
      companionState.anchorRect = anchorRect;
      companionState.explanation = '';
      companionState.draftText = '';
      companionState.prompt = '';
      companionState.error = null;

      if (state.isOpen) {
        state.isOpen = false;
        render(shadow);
      }
      renderDraftLayer(shadow);
    }, 180);
  };

  document.addEventListener('mouseup', handleSelectionChange);
  document.addEventListener('keyup', handleSelectionChange);

  document.addEventListener('input', (e: Event) => {
    if (!state.settings.autoScan) return;
    const el = getEditableElement(e.target);
    if (!el) return;
    if (editDebounceTimer !== null) {
      window.clearTimeout(editDebounceTimer);
    }
    editDebounceTimer = window.setTimeout(() => {
      editDebounceTimer = null;
      const text = getEditableText(el);
      if (!isLikelyLegalText(text)) return;
      state.isEditableContext = true;
      activeEditableEl = el;
      runLocalScan(shadow, text);
    }, 450);
  });

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((message: unknown) => {
        if ((message as { type?: string } | null)?.type === 'LEGALEASE_TOGGLE_DRAWER') {
          state.isOpen = !state.isOpen;
          if (!state.isOpen) {
            state.settingsOpen = false;
          } else if (!state.hasScanned && !state.isScanning) {
            runLocalScan(shadow);
            return;
          }
          render(shadow);
        }
      });
    }
  } catch {
    // Ignore runtime listener errors in restricted contexts
  }

  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      chrome.storage.local.get([STORAGE_KEY, SETTINGS_STORAGE_KEY]).then((result: Record<string, unknown>) => {
        const saved = result?.[STORAGE_KEY] as BadgePosition | undefined;
        if (saved && (saved.edge === 'left' || saved.edge === 'right' || saved.edge === 'top' || saved.edge === 'bottom') && typeof saved.offset === 'number') {
          state.badgePos = getClampedBadgePos(saved);
        }
        const savedSettings = result?.[SETTINGS_STORAGE_KEY] as Partial<UserSettings> | undefined;
        if (savedSettings) {
          state.settings = {
            popupSize: savedSettings.popupSize && savedSettings.popupSize in POPUP_DIMENSIONS ? savedSettings.popupSize : 'standard',
            textSize: savedSettings.textSize && savedSettings.textSize in TEXT_SIZES ? savedSettings.textSize : 'medium',
            customRedactionTerms: typeof savedSettings.customRedactionTerms === 'string' ? savedSettings.customRedactionTerms : '',
            autoScan: typeof savedSettings.autoScan === 'boolean' ? savedSettings.autoScan : true,
            policyMode: savedSettings.policyMode && savedSettings.policyMode in POLICY_MODES ? savedSettings.policyMode : 'prefer_on_device',
            enableSemanticPii: typeof savedSettings.enableSemanticPii === 'boolean' ? savedSettings.enableSemanticPii : false,
            sandboxMode: typeof savedSettings.sandboxMode === 'boolean' ? savedSettings.sandboxMode : false
          };
        }
        render(shadow);
        if (isLegalPage() && state.settings.autoScan) {
          runLocalScan(shadow);
        }
      });
      return;
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }

  if (isLegalPage() && state.settings.autoScan) {
    runLocalScan(shadow);
  }
}

init();
