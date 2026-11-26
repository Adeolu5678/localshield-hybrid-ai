import type { RiskClause } from '../types/analysis';

export type DiffSegmentKind = 'equal' | 'delete' | 'insert';

export interface DiffSegment {
  kind: DiffSegmentKind;
  text: string;
}

export type ClauseDecisionStatus = 'pending' | 'accepted' | 'rejected';

export interface ClauseRedlineDecision {
  status: ClauseDecisionStatus;
  customRedline?: string;
}

export interface CompiledRedlineResult {
  compiledText: string;
  appliedClauseIds: string[];
  unmatchedClauseIds: string[];
  appliedCount: number;
  rejectedCount: number;
  pendingCount: number;
}

const MAX_LCS_CELLS = 2_000_000;

function tokenizeWords(text: string): string[] {
  if (!text) return [];
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function mergeSegments(segments: DiffSegment[]): DiffSegment[] {
  const merged: DiffSegment[] = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === seg.kind) {
      prev.text += seg.text;
    } else {
      merged.push({ kind: seg.kind, text: seg.text });
    }
  }
  return merged;
}

/**
 * Deterministic word-level diff using Longest Common Subsequence (LCS)
 * with common prefix/suffix trimming and a safe line-level fallback for
 * very large documents.
 */
export function computeWordDiff(
  original: string,
  revised: string
): DiffSegment[] {
  if (original === revised) {
    return original ? [{ kind: 'equal', text: original }] : [];
  }
  if (!original) {
    return revised ? [{ kind: 'insert', text: revised }] : [];
  }
  if (!revised) {
    return [{ kind: 'delete', text: original }];
  }

  const aTokens = tokenizeWords(original);
  const bTokens = tokenizeWords(revised);

  let prefixLen = 0;
  const minLen = Math.min(aTokens.length, bTokens.length);
  while (prefixLen < minLen && aTokens[prefixLen] === bTokens[prefixLen]) {
    prefixLen += 1;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    aTokens[aTokens.length - 1 - suffixLen] ===
      bTokens[bTokens.length - 1 - suffixLen]
  ) {
    suffixLen += 1;
  }

  const aMid = aTokens.slice(prefixLen, aTokens.length - suffixLen);
  const bMid = bTokens.slice(prefixLen, bTokens.length - suffixLen);

  const raw: DiffSegment[] = [];
  if (prefixLen > 0) {
    raw.push({ kind: 'equal', text: aTokens.slice(0, prefixLen).join('') });
  }

  if (aMid.length === 0 && bMid.length > 0) {
    raw.push({ kind: 'insert', text: bMid.join('') });
  } else if (bMid.length === 0 && aMid.length > 0) {
    raw.push({ kind: 'delete', text: aMid.join('') });
  } else if (aMid.length * bMid.length > MAX_LCS_CELLS) {
    // Safe deterministic fallback for massive inputs
    raw.push({ kind: 'delete', text: aMid.join('') });
    raw.push({ kind: 'insert', text: bMid.join('') });
  } else if (aMid.length > 0 && bMid.length > 0) {
    const m = aMid.length;
    const n = bMid.length;
    const width = n + 1;
    const dp = new Uint32Array((m + 1) * width);

    for (let i = m - 1; i >= 0; i -= 1) {
      const rowOffset = i * width;
      const nextRowOffset = (i + 1) * width;
      for (let j = n - 1; j >= 0; j -= 1) {
        if (aMid[i] === bMid[j]) {
          dp[rowOffset + j] = dp[nextRowOffset + j + 1] + 1;
        } else {
          const down = dp[nextRowOffset + j];
          const right = dp[rowOffset + j + 1];
          dp[rowOffset + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (aMid[i] === bMid[j]) {
        raw.push({ kind: 'equal', text: aMid[i] });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        raw.push({ kind: 'delete', text: aMid[i] });
        i += 1;
      } else {
        raw.push({ kind: 'insert', text: bMid[j] });
        j += 1;
      }
    }
    while (i < m) {
      raw.push({ kind: 'delete', text: aMid[i] });
      i += 1;
    }
    while (j < n) {
      raw.push({ kind: 'insert', text: bMid[j] });
      j += 1;
    }
  }

  if (suffixLen > 0) {
    raw.push({
      kind: 'equal',
      text: aTokens.slice(aTokens.length - suffixLen).join('')
    });
  }

  return mergeSegments(raw);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces the first matching occurrence of `excerpt` in `source` with `replacement`
 * (single-occurrence replacement using exact, flexible-whitespace, or 5-word anchor matching).
 */
function replaceExcerptInText(
  source: string,
  excerpt: string,
  replacement: string
): { updated: string; matched: boolean } {
  const cleanExcerpt = excerpt.trim();
  if (!cleanExcerpt) {
    return { updated: source, matched: false };
  }

  const exactIdx = source.indexOf(cleanExcerpt);
  if (exactIdx !== -1) {
    return {
      updated:
        source.slice(0, exactIdx) +
        replacement +
        source.slice(exactIdx + cleanExcerpt.length),
      matched: true
    };
  }

  // Fallback: match with flexible whitespace and case-insensitivity (capped to avoid massive regexes)
  const flexWords = cleanExcerpt.split(/\s+/).filter(Boolean);
  if (flexWords.length > 0 && flexWords.length <= 80) {
    try {
      const flexPattern = flexWords.map((part) => escapeRegExp(part)).join('\\s+');
      const flexRe = new RegExp(flexPattern, 'i');
      const flexMatch = flexRe.exec(source);
      if (flexMatch && typeof flexMatch.index === 'number') {
        return {
          updated:
            source.slice(0, flexMatch.index) +
            replacement +
            source.slice(flexMatch.index + flexMatch[0].length),
          matched: true
        };
      }
    } catch {
      // Fall through to 3rd-tier anchor match
    }
  }

  // 3rd-tier fallback: anchor match using first 5 words and last 5 words within <= 1200 chars
  const words = cleanExcerpt.split(/\s+/).filter(Boolean);
  if (words.length >= 6) {
    const startPattern = words.slice(0, 5).map(escapeRegExp).join('\\s+');
    const endPattern = words.slice(-5).map(escapeRegExp).join('\\s+');
    const startRe = new RegExp(startPattern, 'i');
    const startMatch = startRe.exec(source);
    if (startMatch && typeof startMatch.index === 'number') {
      const searchFrom = startMatch.index + startMatch[0].length;
      const tail = source.slice(searchFrom);
      const endRe = new RegExp(endPattern, 'i');
      const endMatch = endRe.exec(tail);
      if (endMatch && typeof endMatch.index === 'number') {
        const spanEnd = searchFrom + endMatch.index + endMatch[0].length;
        if (spanEnd - startMatch.index <= 1200) {
          return {
            updated:
              source.slice(0, startMatch.index) +
              replacement +
              source.slice(spanEnd),
            matched: true
          };
        }
      }
    }
  }

  return { updated: source, matched: false };
}

/**
 * Compiles a redlined contract by applying all accepted (or custom-edited)
 * clause redlines onto the source document text.
 */
export function compileRedlinedDocument(
  sourceText: string,
  clauses: RiskClause[],
  decisions: Record<string, ClauseRedlineDecision>
): CompiledRedlineResult {
  let compiledText = sourceText;
  const appliedClauseIds: string[] = [];
  const unmatchedClauseIds: string[] = [];
  const addenda: string[] = [];

  let appliedCount = 0;
  let rejectedCount = 0;
  let pendingCount = 0;

  for (const clause of clauses) {
    const decision = decisions[clause.id];
    const status = decision?.status ?? 'pending';

    if (status === 'rejected') {
      rejectedCount += 1;
      continue;
    }
    if (status !== 'accepted') {
      pendingCount += 1;
      continue;
    }

    appliedCount += 1;
    const replacement =
      decision?.customRedline !== undefined && decision.customRedline.trim().length > 0
        ? decision.customRedline.trim()
        : clause.redlineProposal.trim();

    const { updated, matched } = replaceExcerptInText(
      compiledText,
      clause.excerpt,
      replacement
    );

    if (matched) {
      compiledText = updated;
      appliedClauseIds.push(clause.id);
    } else {
      unmatchedClauseIds.push(clause.id);
      addenda.push(`[Redline Addendum — ${clause.title}]: ${replacement}`);
    }
  }

  if (addenda.length > 0) {
    const separator = compiledText.endsWith('\n') ? '\n' : '\n\n';
    compiledText = `${compiledText}${separator}${addenda.join('\n\n')}`;
  }

  return {
    compiledText,
    appliedClauseIds,
    unmatchedClauseIds,
    appliedCount,
    rejectedCount,
    pendingCount
  };
}
