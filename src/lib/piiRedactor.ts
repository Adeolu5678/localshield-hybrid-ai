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

const INVALID_EIN_PREFIXES = new Set([
  '00', '07', '08', '09', '17', '18', '19', '28', '29',
  '49', '69', '70', '78', '79', '89', '96', '97'
]);

function isValidEinMatch(value: string): boolean {
  return !INVALID_EIN_PREFIXES.has(value.slice(0, 2));
}

/**
 * Validates IBAN strings using ISO 7064 mod-97 checksum so patent, docket, or
 * tracking IDs that happen to match `[A-Z]{2}\d{2}[A-Z0-9]{11,30}` do not false-positive.
 */
export function isValidIban(candidate: string): boolean {
  const cleaned = candidate.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(cleaned)) return false;

  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i += 1) {
    const code = rearranged.charCodeAt(i);
    const digits = code >= 65 && code <= 90 ? String(code - 55) : rearranged[i];
    for (let j = 0; j < digits.length; j += 1) {
      remainder = (remainder * 10 + Number(digits[j])) % 97;
    }
  }
  return remainder === 1;
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
    category: 'PEM_KEY',
    regex: /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----)/g
  },
  {
    category: 'API_SECRET',
    regex:
      /\b(?:sk-(?:live|test|proj)?-?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|ghp_[0-9A-Za-z]{20,}|glpat-[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[0-9A-Za-z-]{12,}|(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,})\b/g
  },
  {
    category: 'SSN',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g
  },
  {
    category: 'EIN',
    regex: /\b\d{2}-\d{7}\b/g,
    validate: isValidEinMatch
  },
  {
    category: 'IBAN',
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    validate: isValidIban
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
      /(?<![vV])\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    validate: (val) => val !== '0.0.0.0' && val !== '255.255.255.255'
  },
  {
    category: 'IPV6',
    regex:
      /(?<![A-Fa-f0-9:])(?:(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}|(?:[A-Fa-f0-9]{1,4}:){1,7}:|:(?::[A-Fa-f0-9]{1,4}){1,7}|(?:[A-Fa-f0-9]{1,4}:){1,6}:[A-Fa-f0-9]{1,4}|(?:[A-Fa-f0-9]{1,4}:){1,5}(?::[A-Fa-f0-9]{1,4}){1,2}|(?:[A-Fa-f0-9]{1,4}:){1,4}(?::[A-Fa-f0-9]{1,4}){1,3}|(?:[A-Fa-f0-9]{1,4}:){1,3}(?::[A-Fa-f0-9]{1,4}){1,4}|(?:[A-Fa-f0-9]{1,4}:){1,2}(?::[A-Fa-f0-9]{1,4}){1,5}|[A-Fa-f0-9]{1,4}:(?::[A-Fa-f0-9]{1,4}){1,6}|::1)(?![A-Fa-f0-9:])/g
  },
  {
    category: 'ADDRESS',
    regex:
      /\b\d{1,5}[ \t]+[A-Za-z0-9.]+(?:[ \t]+[A-Za-z0-9.]+){0,4}[ \t]+(?:Street|St\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Terrace|Ter\.?|Court|Ct\.?|Place|Pl\.?|Way|Parkway|Pkwy\.?)(?:(?:,[ \t]*|[ \t]+)(?:Suite|Ste\.?|Apt\.?|Apartment|Unit|Floor|Fl\.?|#)[ \t]*[A-Za-z0-9-]+)?(?:,[ \t]*[A-Za-z][A-Za-z. \t-]{1,28},[ \t]*[A-Z]{2}(?:[ \t]+\d{5}(?:-\d{4})?)?)?\b/gi
  },
  {
    category: 'ADDRESS',
    regex: /\bP\.?O\.?\s*Box\s+\d+[A-Za-z0-9-]*/gi
  }
];

function createEmptyCounts(): Record<PiiCategory, number> {
  return {
    API_SECRET: 0,
    AWS_KEY: 0,
    JWT: 0,
    PEM_KEY: 0,
    SSN: 0,
    EIN: 0,
    CARD: 0,
    IBAN: 0,
    EMAIL: 0,
    PHONE: 0,
    IPV4: 0,
    IPV6: 0,
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
  /\[(?:API_SECRET|AWS_KEY|JWT|PEM_KEY|SSN|EIN|CARD|IBAN|EMAIL|PHONE|IPV4|IPV6|ADDRESS|CUSTOM|PERSON|ORG|CODENAME)_\d+\]/;

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
  type CandidateSpan = {
    start: number;
    end: number;
    category: PiiCategory;
    original: string;
    key: string;
  };
  const candidates: CandidateSpan[] = [];

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
      const normalizedKeyVal =
        rule.category === 'EMAIL' ||
        rule.category === 'IPV4' ||
        rule.category === 'IPV6'
          ? original.toLowerCase()
          : rule.category === 'PHONE'
            ? original.replace(/\D/g, '')
            : original;
      candidates.push({
        start,
        end,
        category: rule.category,
        original,
        key: `${rule.category}::${normalizedKeyVal}`
      });
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
      candidates.push({
        start,
        end,
        category: 'CUSTOM',
        original,
        key: `CUSTOM::${original.toLowerCase()}`
      });
    }
  }

  candidates.sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start
  );

  const rawSpans: CandidateSpan[] = [];
  for (const candidate of candidates) {
    const overlaps = rawSpans.some(
      (existing) => !(candidate.end <= existing.start || candidate.start >= existing.end)
    );
    if (!overlaps) {
      rawSpans.push(candidate);
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

  const baseText = base.redactedText;
  let entitiesAdded = 0;

  // Collect ranges of existing vault tokens once so we never replace inside a token
  const protectedRanges: Array<{ start: number; end: number }> = [];
  const tokenRe = new RegExp(EXISTING_TOKEN_RE.source, 'g');
  let tMatch: RegExpExecArray | null;
  while ((tMatch = tokenRe.exec(baseText)) !== null) {
    protectedRanges.push({
      start: tMatch.index,
      end: tMatch.index + tMatch[0].length
    });
  }

  // Collect all candidate entity spans in a single pass
  const candidateSpans: Array<{
    start: number;
    end: number;
    original: string;
    category: PiiCategory;
    lookupKey: string;
  }> = [];

  for (const entity of dedupedEntities) {
    const entityRe = buildTermRegex(entity.value);
    const lookupKey = `${entity.category}::${entity.value.toLowerCase()}`;
    let eMatch: RegExpExecArray | null;
    while ((eMatch = entityRe.exec(baseText)) !== null) {
      const start = eMatch.index;
      const end = start + eMatch[0].length;
      const insideProtected = protectedRanges.some(
        (r) => !(end <= r.start || start >= r.end)
      );
      if (!insideProtected) {
        candidateSpans.push({
          start,
          end,
          original: eMatch[0],
          category: entity.category,
          lookupKey
        });
      }
    }
  }

  // Resolve overlaps in a single O(N log N) sweep: earliest start first, then longest match.
  candidateSpans.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });

  const acceptedSpans: typeof candidateSpans = [];
  let lastEnd = -1;
  for (const span of candidateSpans) {
    if (span.start >= lastEnd) {
      acceptedSpans.push(span);
      lastEnd = span.end;
    }
  }

  // Assign tokens and apply all replacements in one linear cursor pass.
  // Note: match start/end offsets are relative to the input redactedText.
  let rebuilt = '';
  let cursor = 0;
  for (const span of acceptedSpans) {
    let token = valueToToken.get(span.lookupKey);
    if (!token) {
      countsByCategory[span.category] += 1;
      token = `[${span.category}_${countsByCategory[span.category]}]`;
      valueToToken.set(span.lookupKey, token);
      vault[token] = span.original;
      entitiesAdded += 1;
    }

    rebuilt += baseText.slice(cursor, span.start) + token;
    cursor = span.end;
    matches.push({
      token,
      category: span.category,
      original: span.original,
      start: span.start,
      end: span.end
    });
  }
  rebuilt += baseText.slice(cursor);

  return {
    result: {
      originalText: base.originalText,
      redactedText: rebuilt,
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
  return text.replace(/\[[A-Z0-9_]+_\d+\]/g, (token) => vault[token] ?? token);
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
