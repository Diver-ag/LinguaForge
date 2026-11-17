export type ClozeHintMode = 'meaning' | 'reading' | 'both' | 'none';

export interface ClozeData {
  sentence: string;
  start: number;
  end: number;
  answer: string;
  lemma: string;
  reading: string;
  hint?: string;
}

export interface ClozeOffsetValidation {
  valid: boolean;
  slice: string;
  mismatch: boolean;
}

export interface AnkiClozeParseResult {
  isCloze: boolean;
  supported: boolean;
  sentence: string;
  start: number;
  end: number;
  answer: string;
  hint: string;
  clozeNumbers: number[];
  hasMultipleClozeNumbers: boolean;
  hasMultipleSameNumber: boolean;
  hasNestedCloze: boolean;
  unsupportedReason?: string;
}

const SENTENCE_TERMINATORS = /[。！？.!?\n\r]/;
const SENTENCE_PUNCTUATION = /[。！？.!?]/;

/**
 * Extracts the surrounding sentence for a token whose character span in `fullText`
 * is `[tokenStart, tokenEnd)` and returns the trimmed sentence plus exact adjusted
 * `[start, end)` character offsets inside that trimmed sentence.
 *
 * Uses token offsets directly rather than searching by substring, so repeated words
 * or conjugated forms in the same sentence always resolve to the exact clicked token.
 */
export function extractSentenceWithOffsets(
  fullText: string,
  tokenStart: number,
  tokenEnd: number
): { sentence: string; start: number; end: number } | null {
  if (!fullText) return null;
  if (!Number.isInteger(tokenStart) || !Number.isInteger(tokenEnd)) return null;
  if (tokenStart < 0 || tokenEnd <= tokenStart || tokenEnd > fullText.length) return null;

  let rawStart = tokenStart;
  while (rawStart > 0 && !SENTENCE_TERMINATORS.test(fullText[rawStart - 1])) {
    rawStart--;
  }

  let rawEnd = Math.max(tokenStart, tokenEnd);
  while (rawEnd < fullText.length && !SENTENCE_TERMINATORS.test(fullText[rawEnd])) {
    rawEnd++;
  }
  if (rawEnd < fullText.length && SENTENCE_PUNCTUATION.test(fullText[rawEnd])) {
    rawEnd++;
  }

  const rawSlice = fullText.slice(rawStart, rawEnd);
  const leadingMatch = rawSlice.match(/^\s*/);
  const trailingMatch = rawSlice.match(/\s*$/);
  const leadingWs = leadingMatch ? leadingMatch[0].length : 0;
  const trailingWs = trailingMatch ? trailingMatch[0].length : 0;

  const trimmedStart = rawStart + leadingWs;
  const trimmedEnd = Math.max(trimmedStart, rawEnd - trailingWs);
  const sentence = fullText.slice(trimmedStart, trimmedEnd);

  if (!sentence) return null;

  const start = tokenStart - trimmedStart;
  const end = tokenEnd - trimmedStart;
  if (start < 0 || end <= start || end > sentence.length) {
    return null;
  }

  return { sentence, start, end };
}

export function validateClozeOffsets(
  sentence: string,
  start: number,
  end: number,
  expectedAnswer?: string
): ClozeOffsetValidation {
  if (
    !sentence ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > sentence.length
  ) {
    return { valid: false, slice: '', mismatch: Boolean(expectedAnswer) };
  }

  const slice = sentence.slice(start, end);
  const mismatch =
    expectedAnswer !== undefined && expectedAnswer.length > 0 && slice !== expectedAnswer;

  return {
    valid: true,
    slice,
    mismatch,
  };
}

export function getEffectiveClozeData(card: {
  word: string;
  lemma?: string;
  reading?: string;
  meaning?: string;
  sentence?: string;
  cloze?: ClozeData;
}): ClozeData | null {
  if (!card.cloze) return null;
  const sentence = card.cloze.sentence ?? card.sentence ?? '';
  const start = card.cloze.start;
  const end = card.cloze.end;
  const check = validateClozeOffsets(sentence, start, end);
  if (!check.valid) return null;
  return {
    sentence,
    start,
    end,
    answer: card.cloze.answer || check.slice || card.word,
    lemma: card.cloze.lemma || card.lemma || card.word,
    reading: card.cloze.reading ?? card.reading ?? '',
    hint: card.cloze.hint !== undefined ? card.cloze.hint : card.meaning || '',
  };
}

export function formatClozeHint(
  card: {
    cloze?: ClozeData;
    meaning?: string;
    reading?: string;
  },
  mode: ClozeHintMode
): string {
  if (mode === 'none') return '';

  const meaningOrCustomHint = (card.cloze?.hint ?? '').trim() || (card.meaning ?? '').trim();
  const readingHint = (card.cloze?.reading ?? '').trim() || (card.reading ?? '').trim();

  if (mode === 'meaning') {
    return meaningOrCustomHint;
  }
  if (mode === 'reading') {
    return readingHint;
  }

  // 'both'
  const parts: string[] = [];
  if (meaningOrCustomHint) parts.push(meaningOrCustomHint);
  if (readingHint && readingHint !== meaningOrCustomHint) parts.push(readingHint);
  return parts.join(' · ');
}

export function buildClozeDuplicateKey(params: {
  languageId: string;
  lemma: string;
  sentence: string;
  start: number;
  end: number;
}): string {
  return [
    params.languageId.trim(),
    params.lemma.trim().normalize('NFC'),
    params.sentence.trim().normalize('NFC'),
    String(params.start),
    String(params.end),
  ].join('\x1f');
}

export interface ClozeTokenCandidate {
  surface: string;
  lemma?: string;
  reading?: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Resolves exact cloze offsets inside an existing sentence for bulk cloze creation.
 * Uses tokenizer spans first (to match conjugated verb surfaces to lemma) before
 * falling back to an exact substring search of word/lemma.
 */
export function resolveClozeFromSentence(params: {
  sentence: string;
  word: string;
  lemma?: string;
  reading?: string;
  meaning?: string;
  tokens?: ClozeTokenCandidate[];
}): ClozeData | null {
  const sentence = (params.sentence || '').trim();
  if (!sentence) return null;

  const targetWord = (params.word || '').trim();
  const targetLemma = (params.lemma || targetWord).trim();
  const targetReading = (params.reading || '').trim();
  const hint = (params.meaning || '').trim();

  if (params.tokens && params.tokens.length > 0) {
    // Pass 1: exact surface + lemma match (preferring matching reading if supplied)
    let matchedToken = params.tokens.find((t) => {
      const surfaceOk = Boolean(targetWord && t.surface === targetWord);
      const lemmaOk = Boolean(targetLemma && (t.lemma === targetLemma || t.surface === targetLemma));
      const readingOk = !targetReading || !t.reading || t.reading === targetReading;
      return surfaceOk && lemmaOk && readingOk;
    });

    // Pass 2: lemma match (catches conjugated forms like 食べる -> 食べた)
    if (!matchedToken && targetLemma) {
      matchedToken = params.tokens.find(
        (t) =>
          (t.lemma === targetLemma || t.surface === targetLemma) &&
          (!targetReading || !t.reading || t.reading === targetReading)
      );
      if (!matchedToken) {
        matchedToken = params.tokens.find(
          (t) => t.lemma === targetLemma || t.surface === targetLemma
        );
      }
    }

    // Pass 3: surface match anywhere in tokens
    if (!matchedToken && targetWord) {
      matchedToken = params.tokens.find((t) => t.surface === targetWord);
    }

    if (
      matchedToken &&
      matchedToken.startIndex >= 0 &&
      matchedToken.endIndex > matchedToken.startIndex &&
      matchedToken.endIndex <= sentence.length &&
      sentence.slice(matchedToken.startIndex, matchedToken.endIndex) === matchedToken.surface
    ) {
      return {
        sentence,
        start: matchedToken.startIndex,
        end: matchedToken.endIndex,
        answer: matchedToken.surface,
        lemma: targetLemma || matchedToken.lemma || matchedToken.surface,
        reading: targetReading || matchedToken.reading || '',
        hint,
      };
    }
  }

  // Fallback substring lookup when tokenizer tokens are unavailable (e.g., Spanish/offline fallback)
  const candidates = [targetWord, targetLemma].filter(Boolean);
  for (const cand of candidates) {
    const idx = sentence.indexOf(cand);
    if (idx !== -1) {
      return {
        sentence,
        start: idx,
        end: idx + cand.length,
        answer: cand,
        lemma: targetLemma || cand,
        reading: targetReading,
        hint,
      };
    }
  }

  return null;
}

/**
 * Formats a LinguaForge cloze into Anki's native cloze field syntax:
 * `prefix{{c1::answer::hint}}suffix` (or `{{c1::answer}}` when hint is empty).
 */
export function formatAnkiClozeMarkup(cloze: ClozeData, hintOverride?: string): string {
  const { sentence, start, end, answer } = cloze;
  const check = validateClozeOffsets(sentence, start, end);
  const blankAnswer = answer || check.slice;
  const safeStart = check.valid ? start : Math.max(0, Math.min(start, sentence.length));
  const safeEnd = check.valid ? end : Math.max(safeStart, Math.min(end, sentence.length));
  const rawHint = hintOverride !== undefined ? hintOverride : cloze.hint || '';
  const hint = rawHint.replace(/::/g, ':').replace(/\}\}/g, '} }').trim();
  const safeAnswer = blankAnswer.replace(/\}\}/g, '} }');
  const tag = hint ? `{{c1::${safeAnswer}::${hint}}}` : `{{c1::${safeAnswer}}}`;
  return `${sentence.slice(0, safeStart)}${tag}${sentence.slice(safeEnd)}`;
}

function defaultStripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<rp>[\s\S]*?<\/rp>/gi, '')
    .replace(/<rt>[\s\S]*?<\/rt>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parses Anki cloze syntax (`{{c1::answer}}` / `{{c1::answer::hint}}`) from a note field.
 * Reports unsupported constructs (nested clozes, multiple distinct cN cards like c2+,
 * or multiple clozes with the same cN) so the importer can handle or warn transparently.
 */
export function parseAnkiClozeMarkup(
  rawField: string,
  stripHtml: (html: string) => string = defaultStripHtml
): AnkiClozeParseResult {
  const text = stripHtml(rawField || '');
  const empty: AnkiClozeParseResult = {
    isCloze: false,
    supported: false,
    sentence: text,
    start: 0,
    end: 0,
    answer: '',
    hint: '',
    clozeNumbers: [],
    hasMultipleClozeNumbers: false,
    hasMultipleSameNumber: false,
    hasNestedCloze: false,
  };

  if (!text || !text.includes('{{c')) {
    return empty;
  }

  // Detect nested clozes such as `{{c1::outer {{c2::inner}}}}`
  const openMatches = text.match(/\{\{c\d+::/g) || [];
  if (openMatches.length === 0) {
    return empty;
  }

  // Walk braces to detect nesting accurately
  let depth = 0;
  let hasNested = false;
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') {
      if (text.slice(i).match(/^\{\{c\d+::/)) {
        if (depth > 0) hasNested = true;
        depth++;
      } else if (depth > 0) {
        depth++;
      }
      i++;
    } else if (text[i] === '}' && text[i + 1] === '}') {
      if (depth > 0) depth--;
      i++;
    }
  }

  const tokenRegex = /\{\{c(\d+)::([\s\S]*?)\}\}/g;
  const matches: {
    index: number;
    rawLength: number;
    clozeNum: number;
    answer: string;
    hint: string;
  }[] = [];

  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(text)) !== null) {
    const clozeNum = Number(m[1]);
    const body = m[2];
    if (body.includes('{{c')) {
      hasNested = true;
    }
    const hintSepIdx = body.indexOf('::');
    const answer = hintSepIdx >= 0 ? body.slice(0, hintSepIdx) : body;
    const hint = hintSepIdx >= 0 ? body.slice(hintSepIdx + 2) : '';
    matches.push({
      index: m.index,
      rawLength: m[0].length,
      clozeNum,
      answer,
      hint,
    });
  }

  if (matches.length === 0) {
    return {
      ...empty,
      isCloze: true,
      hasNestedCloze: hasNested,
      unsupportedReason: 'Malformed cloze tag could not be parsed.',
    };
  }

  const clozeNumbers = Array.from(new Set(matches.map((x) => x.clozeNum))).sort((a, b) => a - b);
  const hasMultipleClozeNumbers = clozeNumbers.length > 1 || clozeNumbers.some((n) => n !== 1);

  const countByNum = new Map<number, number>();
  for (const x of matches) {
    countByNum.set(x.clozeNum, (countByNum.get(x.clozeNum) || 0) + 1);
  }
  const hasMultipleSameNumber = Array.from(countByNum.values()).some((c) => c > 1);

  if (hasNested) {
    return {
      ...empty,
      isCloze: true,
      clozeNumbers,
      hasMultipleClozeNumbers,
      hasMultipleSameNumber,
      hasNestedCloze: true,
      unsupportedReason: 'Nested Anki cloze deletions ({{c1::...{{c2::...}}}}) are not supported.',
    };
  }

  // Reconstruct the plain sentence by replacing every {{cN::answer::hint}} with its answer,
  // and record the exact [start, end) span of the primary cloze (prefer c1, otherwise first match).
  const primaryMatch = matches.find((x) => x.clozeNum === 1) || matches[0];
  let sentence = '';
  let cursor = 0;
  let start = 0;
  let end = 0;

  for (const item of matches) {
    sentence += text.slice(cursor, item.index);
    const ansStart = sentence.length;
    sentence += item.answer;
    const ansEnd = sentence.length;
    if (item === primaryMatch) {
      start = ansStart;
      end = ansEnd;
    }
    cursor = item.index + item.rawLength;
  }
  sentence += text.slice(cursor);

  const trimmedStartDiff = sentence.length - sentence.trimStart().length;
  const cleanSentence = sentence.trim();
  const cleanStart = Math.max(0, start - trimmedStartDiff);
  const cleanEnd = Math.min(cleanSentence.length, Math.max(cleanStart, end - trimmedStartDiff));

  if (!cleanSentence || cleanEnd <= cleanStart) {
    return {
      ...empty,
      isCloze: true,
      clozeNumbers,
      hasMultipleClozeNumbers,
      hasMultipleSameNumber,
      hasNestedCloze: false,
      unsupportedReason: 'Cloze deletion had an empty answer or sentence.',
    };
  }

  let unsupportedReason: string | undefined;
  if (hasMultipleClozeNumbers || hasMultipleSameNumber) {
    const reasons: string[] = [];
    if (hasMultipleClozeNumbers) {
      reasons.push(
        `additional cloze numbers (${clozeNumbers.map((n) => `c${n}`).join(', ')}) collapsed into single card`
      );
    }
    if (hasMultipleSameNumber) {
      reasons.push('multiple blanks in same note used primary blank only');
    }
    unsupportedReason = reasons.join('; ');
  }

  return {
    isCloze: true,
    supported: true,
    sentence: cleanSentence,
    start: cleanStart,
    end: cleanEnd,
    answer: cleanSentence.slice(cleanStart, cleanEnd),
    hint: primaryMatch.hint.trim(),
    clozeNumbers,
    hasMultipleClozeNumbers,
    hasMultipleSameNumber,
    hasNestedCloze: false,
    unsupportedReason,
  };
}
