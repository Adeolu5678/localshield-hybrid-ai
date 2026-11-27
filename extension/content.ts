import { analyzeDocumentHeuristically } from '../src/lib/analysisParser';
import { redactSensitiveData } from '../src/lib/piiRedactor';
import type { ClauseSeverity, DocumentAnalysisResult, RiskClause } from '../src/types/analysis';

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
    shadow.innerHTML = `
      <style>${getShadowStyles()}</style>
      <button class="le-fab" type="button" title="Open LegalEase Audit" style="${getFabStyle(state.badgePos)}">
        <img src="${escapeHtml(logoUrl)}" alt="LegalEase" draggable="false" />
        ${
          flagCount > 0
            ? `<span class="le-badge ${riskScore >= 60 ? 'is-high' : ''}">${flagCount}</span>`
            : ''
        }
      </button>
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
        state.isOpen = true;
        if (!state.hasScanned && !state.isScanning) {
          runLocalScan(shadow);
        } else {
          render(shadow);
        }
      });
    }
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
                <button class="le-card-head" type="button" data-toggle-id="${escapeHtml(clause.id)}">
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
      <label class="le-toggle-row">
        <span>Auto-scan legal pages</span>
        <input id="le-auto-scan" type="checkbox" ${state.settings.autoScan ? 'checked' : ''} />
      </label>
      <label class="le-toggle-row" title="Uses on-device AI to hide person names, company names, and codenames before any cloud call">
        <span>Hide names &amp; companies locally</span>
        <input id="le-semantic-pii" type="checkbox" ${state.settings.enableSemanticPii ? 'checked' : ''} />
      </label>
      <label class="le-toggle-row">
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
    const text = getEditableText(el);
    if (!isLikelyLegalText(text)) return;
    state.isEditableContext = true;
    activeEditableEl = el;
    runLocalScan(shadow, text);
  });

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
