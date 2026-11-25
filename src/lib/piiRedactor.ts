import type { PiiCategory, PiiMatch, RedactionResult } from '../types/analysis';

interface PatternRule {
  category: PiiCategory;
  regex: RegExp;
}

const PII_RULES: PatternRule[] = [
  {
    category: 'API_SECRET',
    regex:
      /\b(?:sk-(?:live|test|proj)?-?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|ghp_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{12,})\b/g
  },
  {
    category: 'SSN',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g
  },
  {
    category: 'IBAN',
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g
  },
  {
    category: 'CARD',
    regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g
  },
  {
    category: 'EMAIL',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
  },
  {
    category: 'PHONE',
    regex:
      /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g
  },
  {
    category: 'IPV4',
    regex:
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
  },
  {
    category: 'ADDRESS',
    regex:
      /\b\d{1,5}\s+[A-Za-z0-9.\s]{2,32}\s+(?:Street|St\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Terrace|Ter\.?|Court|Ct\.?|Place|Pl\.?|Way|Suite\s+\d+|Ste\.?\s+\d+)\b/gi
  }
];

function createEmptyCounts(): Record<PiiCategory, number> {
  return {
    API_SECRET: 0,
    SSN: 0,
    CARD: 0,
    IBAN: 0,
    EMAIL: 0,
    PHONE: 0,
    IPV4: 0,
    ADDRESS: 0
  };
}

/**
 * Deterministically masks sensitive PII & secrets locally in-browser before any
 * prompt leaves the device. Maintains an in-memory reversible vault.
 */
export function redactSensitiveData(input: string): RedactionResult {
  const countsByCategory = createEmptyCounts();
  const valueToToken = new Map<string, string>();
  const vault: Record<string, string> = {};
  const rawSpans: Array<{
    start: number;
    end: number;
    category: PiiCategory;
    original: string;
  }> = [];

  for (const rule of PII_RULES) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
      const original = match[0];
      const start = match.index;
      const end = start + original.length;

      const overlaps = rawSpans.some(
        (existing) => !(end <= existing.start || start >= existing.end)
      );
      if (!overlaps) {
        rawSpans.push({ start, end, category: rule.category, original });
      }
    }
  }

  rawSpans.sort((a, b) => a.start - b.start);

  const matches: PiiMatch[] = [];
  let cursor = 0;
  let redactedText = '';

  for (const span of rawSpans) {
    let token = valueToToken.get(span.original);
    if (!token) {
      countsByCategory[span.category] += 1;
      token = `[${span.category}_${countsByCategory[span.category]}]`;
      valueToToken.set(span.original, token);
      vault[token] = span.original;
    }

    redactedText += input.slice(cursor, span.start) + token;
    cursor = span.end;

    matches.push({
      token,
      category: span.category,
      original: span.original,
      start: span.start,
      end: span.end
    });
  }

  redactedText += input.slice(cursor);

  return {
    originalText: input,
    redactedText,
    matches,
    vault,
    countsByCategory,
    totalMasked: matches.length
  };
}

/**
 * Restores masked tokens back to local originals for user-facing display/export.
 */
export function restoreFromVault(
  text: string,
  vault: Record<string, string>
): string {
  let output = text;
  for (const [token, original] of Object.entries(vault)) {
    output = output.split(token).join(original);
  }
  return output;
}

/**
 * Estimates token count deterministically (~4 chars per token) when on-device
 * Chrome Prompt API does not emit cloud UsageMetadata.
 */
export function estimateTokenCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}
