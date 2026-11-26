import type {
  PiiCategory,
  PiiMatch,
  RedactionResult,
  SemanticPiiEntity
} from '../types/analysis';

interface PatternRule {
  category: PiiCategory;
  regex: RegExp;
  validate?: (match: string) => boolean;
}

export interface RedactOptions {
  customTerms?: string[];
}

/**
 * Validates payment card numbers using the Luhn checksum algorithm so 16-digit
 * non-card IDs, tracking numbers, or order numbers do not false-positive.
 */
export function isValidLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function isValidPhoneMatch(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (candidate.startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15;
  }
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

const PII_RULES: PatternRule[] = [
  {
    category: 'AWS_KEY',
    regex: /\bAKIA[0-9A-Z]{16}\b/g
  },
  {
    category: 'JWT',
    regex: /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g
  },
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
    category: 'EIN',
    regex: /\b\d{2}-\d{7}\b/g
  },
  {
    category: 'IBAN',
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g
  },
  {
    category: 'CARD',
    regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    validate: isValidLuhn
  },
  {
    category: 'EMAIL',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
  },
  {
    category: 'PHONE',
    regex:
      /(?<!\w)(?:\+[1-9]\d{0,2}(?:[ \t.-]?\(?\d{1,4}\)?){1,4}[ \t.-]?\d{2,6}|\+[1-9]\d{7,14}|\(\d{3}\)[ \t.-]?\d{3}[ \t.-]\d{4}|\d{3}[ \t.-]\d{3}[ \t.-]\d{4})\b/g,
    validate: isValidPhoneMatch
  },
  {
    category: 'IPV4',
    regex:
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
  },
  {
    category: 'ADDRESS',
    regex:
      /\b\d{1,5}[ \t]+[A-Za-z0-9.]+(?:[ \t]+[A-Za-z0-9.]+){0,4}[ \t]+(?:Street|St\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Terrace|Ter\.?|Court|Ct\.?|Place|Pl\.?|Way|Parkway|Pkwy\.?)(?:(?:,[ \t]*|[ \t]+)(?:Suite|Ste\.?|Apt\.?|Apartment|Unit|Floor|Fl\.?|#)[ \t]*[A-Za-z0-9-]+)?(?:,[ \t]*[A-Za-z][A-Za-z. \t-]{1,28},[ \t]*[A-Z]{2}(?:[ \t]+\d{5}(?:-\d{4})?)?)?\b/gi
  }
];

function createEmptyCounts(): Record<PiiCategory, number> {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTermRegex(term: string): RegExp {
  const escaped = escapeRegExp(term);
  const startsWithWord = /^\w/.test(term);
  const endsWithWord = /\w$/.test(term);
  const prefix = startsWithWord ? '(?<!\\w)' : '';
  const suffix = endsWithWord ? '(?!\\w)' : '';
  return new RegExp(`${prefix}${escaped}${suffix}`, 'gi');
}

const EXISTING_TOKEN_RE =
  /\[(?:API_SECRET|AWS_KEY|JWT|SSN|EIN|CARD|IBAN|EMAIL|PHONE|IPV4|ADDRESS|CUSTOM|PERSON|ORG|CODENAME)_\d+\]/g;

/**
 * Deterministically masks sensitive PII & secrets locally in-browser before any
 * prompt leaves the device. Maintains an in-memory reversible vault.
 */
export function redactSensitiveData(
  input: string,
  options?: RedactOptions
): RedactionResult {
  const countsByCategory = createEmptyCounts();
  const valueToToken = new Map<string, string>();
  const vault: Record<string, string> = {};
  const rawSpans: Array<{
    start: number;
    end: number;
    category: PiiCategory;
    original: string;
    key: string;
  }> = [];

  for (const rule of PII_RULES) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
      const original = match[0];
      if (rule.validate && !rule.validate(original)) {
        continue;
      }
      const start = match.index;
      const end = start + original.length;

      const overlaps = rawSpans.some(
        (existing) => !(end <= existing.start || start >= existing.end)
      );
      if (!overlaps) {
        rawSpans.push({
          start,
          end,
          category: rule.category,
          original,
          key: `${rule.category}::${original}`
        });
      }
    }
  }

  const normalizedCustomTerms = Array.from(
    new Map(
      (options?.customTerms ?? [])
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t) => [t.toLowerCase(), t])
    ).values()
  ).sort((a, b) => b.length - a.length);

  for (const term of normalizedCustomTerms) {
    const regex = buildTermRegex(term);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
      const original = match[0];
      const start = match.index;
      const end = start + original.length;
      const overlaps = rawSpans.some(
        (existing) => !(end <= existing.start || start >= existing.end)
      );
      if (!overlaps) {
        rawSpans.push({
          start,
          end,
          category: 'CUSTOM',
          original,
          key: `CUSTOM::${original.toLowerCase()}`
        });
      }
    }
  }

  rawSpans.sort((a, b) => a.start - b.start);

  const matches: PiiMatch[] = [];
  let cursor = 0;
  let redactedText = '';

  for (const span of rawSpans) {
    let token = valueToToken.get(span.key);
    if (!token) {
      countsByCategory[span.category] += 1;
      token = `[${span.category}_${countsByCategory[span.category]}]`;
      valueToToken.set(span.key, token);
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
 * Alias for redactSensitiveData supporting custom confidential terms.
 */
export const redactDocument = redactSensitiveData;

/**
 * Merges Stage 0.5 on-device semantic PII findings (person names, organizations,
 * project codenames) into an existing Stage 0 RedactionResult vault while
 * preserving token consistency and full restoreFromVault() compatibility.
 */
export function mergeSemanticRedactions(
  base: RedactionResult,
  entities: SemanticPiiEntity[]
): { result: RedactionResult; entitiesAdded: number } {
  if (!entities || entities.length === 0) {
    return { result: base, entitiesAdded: 0 };
  }

  const countsByCategory: Record<PiiCategory, number> = {
    ...base.countsByCategory
  };
  const vault: Record<string, string> = { ...base.vault };
  const matches: PiiMatch[] = [...base.matches];
  const valueToToken = new Map<string, string>();

  for (const [token, original] of Object.entries(vault)) {
    const catMatch = /^\[([A-Z0-9_]+)_\d+\]$/.exec(token);
    if (catMatch) {
      valueToToken.set(`${catMatch[1]}::${original.toLowerCase()}`, token);
    }
  }

  const dedupedEntities = Array.from(
    new Map(
      entities
        .map((e) => ({
          value: e.value.trim(),
          category: e.category
        }))
        .filter(
          (e) =>
            e.value.length >= 2 &&
            !EXISTING_TOKEN_RE.test(e.value) &&
            (e.category === 'PERSON' ||
              e.category === 'ORG' ||
              e.category === 'CODENAME')
        )
        .map((e) => [`${e.category}::${e.value.toLowerCase()}`, e])
    ).values()
  ).sort((a, b) => b.value.length - a.value.length);

  // Reset stateful regex lastIndex after filter check
  EXISTING_TOKEN_RE.lastIndex = 0;

  let currentText = base.redactedText;
  let entitiesAdded = 0;

  for (const entity of dedupedEntities) {
    // Collect ranges of existing vault tokens so we never replace inside a token
    const protectedRanges: Array<{ start: number; end: number }> = [];
    const tokenRe = new RegExp(EXISTING_TOKEN_RE.source, 'g');
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tokenRe.exec(currentText)) !== null) {
      protectedRanges.push({
        start: tMatch.index,
        end: tMatch.index + tMatch[0].length
      });
    }

    const entityRe = buildTermRegex(entity.value);
    const spans: Array<{ start: number; end: number; original: string }> = [];
    let eMatch: RegExpExecArray | null;
    while ((eMatch = entityRe.exec(currentText)) !== null) {
      const start = eMatch.index;
      const end = start + eMatch[0].length;
      const insideProtected = protectedRanges.some(
        (r) => !(end <= r.start || start >= r.end)
      );
      if (!insideProtected) {
        spans.push({ start, end, original: eMatch[0] });
      }
    }

    if (spans.length === 0) continue;

    const lookupKey = `${entity.category}::${entity.value.toLowerCase()}`;
    let token = valueToToken.get(lookupKey);
    if (!token) {
      countsByCategory[entity.category] += 1;
      token = `[${entity.category}_${countsByCategory[entity.category]}]`;
      valueToToken.set(lookupKey, token);
      vault[token] = spans[0].original;
      entitiesAdded += 1;
    }

    let rebuilt = '';
    let cursor = 0;
    for (const span of spans) {
      rebuilt += currentText.slice(cursor, span.start) + token;
      cursor = span.end;
      matches.push({
        token,
        category: entity.category,
        original: span.original,
        start: span.start,
        end: span.end
      });
    }
    rebuilt += currentText.slice(cursor);
    currentText = rebuilt;
  }

  return {
    result: {
      originalText: base.originalText,
      redactedText: currentText,
      matches,
      vault,
      countsByCategory,
      totalMasked: matches.length
    },
    entitiesAdded
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
