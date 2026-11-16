import JSZip from 'jszip';
import type { SqlJsStatic } from 'sql.js';
import type { CardItem, CardType, DeckItem } from '../db/db';
import { buildFurigana, furiganaSegmentsToAnki } from '../packs/japanese/kanaUtils';

export const LINGUAFORGE_VOCAB_MODEL_ID = 1715000001001;
export const ANKI_SCHEMA_VERSION = 11;
export const ANKI_FIELD_SEPARATOR = '\x1f';

export type FuriganaExportFormat = 'html' | 'anki' | 'both';

export interface AnkiExportOptions {
  furiganaFormat: FuriganaExportFormat;
  useSubdeckPrefix: boolean;
  subdeckRootName: string; // e.g. "LinguaForge"
  languageName: string;
  includeAutoLevelTag: boolean;
  includeAutoSourceTag: boolean;
  includeAutoCardTypeTag: boolean;
}

export interface AnkiNoteDraft {
  nid: number;
  guid: string;
  anchorCardId: string;
  mid: number;
  mod: number;
  usn: number;
  tags: string; // space-padded e.g. " JLPT_N5 source " or ""
  flds: string; // 15 fields joined by \x1f
  fields: string[]; // 15 raw field values
  sfld: string; // stripped first field (Word)
  csum: number; // 32-bit unsigned int from SHA-1(sfld)
}

export interface AnkiCardDraft {
  cid: number;
  sourceCardId: string;
  cardType: CardType;
  nid: number;
  did: number;
  ord: number;
  mod: number;
  usn: number;
  type: number; // 0 = new
  queue: number; // 0 = new
  due: number; // ordinal position for new cards
  ivl: number; // 0
  factor: number; // 0
  reps: number; // 0
  lapses: number; // 0
  left: number; // 0
  odue: number; // 0
  odid: number; // 0
  flags: number; // 0
  data: string; // "{}"
}

export interface AnkiDeckDraft {
  did: number;
  name: string;
  description: string;
}

export interface AnkiExportPlan {
  modelId: number;
  modelName: string;
  presentCardTypes: CardType[];
  fieldNames: string[];
  decks: AnkiDeckDraft[];
  notes: AnkiNoteDraft[];
  cards: AnkiCardDraft[];
  exportedCardIds: string[];
  createdAtSec: number;
  modifiedAtMs: number;
}

export interface ApkgVerificationReport {
  ok: boolean;
  schemaVersion: number;
  noteCount: number;
  cardCount: number;
  revlogCount: number;
  deckCount: number;
  zipEntries: string[];
  firstNote?: {
    id: number;
    guid: string;
    word: string;
    meaning: string;
    csum: number;
  };
  lastNote?: {
    id: number;
    guid: string;
    word: string;
    meaning: string;
    csum: number;
  };
  error?: string;
}

export type CsvColumnKey =
  | 'word'
  | 'lemma'
  | 'reading'
  | 'furiganaHtml'
  | 'furiganaAnki'
  | 'meaning'
  | 'partOfSpeech'
  | 'level'
  | 'frequency'
  | 'sentence'
  | 'sentenceFuriganaHtml'
  | 'sentenceMeaning'
  | 'source'
  | 'notes'
  | 'deck'
  | 'cardType'
  | 'tags';

export interface CsvExportOptions {
  columns: CsvColumnKey[];
  delimiter: ',' | '\t';
  includeHeader: boolean;
  includeBom: boolean;
  allowHtml: boolean;
  furiganaFormat: FuriganaExportFormat;
  includeAutoLevelTag: boolean;
  includeAutoSourceTag: boolean;
  includeAutoCardTypeTag: boolean;
}

export const ANKI_VOCAB_FIELD_NAMES = [
  'Word',
  'Lemma',
  'Reading',
  'FuriganaHTML',
  'FuriganaAnki',
  'Meaning',
  'PartOfSpeech',
  'Level',
  'Frequency',
  'Sentence',
  'SentenceFuriganaHTML',
  'SentenceMeaning',
  'Source',
  'Notes',
  'Tags',
];

export const CSV_COLUMN_LABELS: Record<CsvColumnKey, string> = {
  word: 'Word',
  lemma: 'Lemma',
  reading: 'Reading',
  furiganaHtml: 'FuriganaHTML',
  furiganaAnki: 'FuriganaAnki',
  meaning: 'Meaning',
  partOfSpeech: 'PartOfSpeech',
  level: 'Level',
  frequency: 'Frequency',
  sentence: 'Sentence',
  sentenceFuriganaHtml: 'SentenceFuriganaHTML',
  sentenceMeaning: 'SentenceMeaning',
  source: 'Source',
  notes: 'Notes',
  deck: 'Deck',
  cardType: 'CardType',
  tags: 'Tags',
};

const CARD_TYPE_CANONICAL_ORDER: Record<CardType, number> = {
  word_to_meaning: 0,
  meaning_to_word: 1,
  reading: 2,
};

// ---------------------------------------------------------------------------
// Pure UTF-8 SHA-1 & Deterministic Identifiers
// ---------------------------------------------------------------------------

function rotateLeft32(val: number, shift: number): number {
  return ((val << shift) | (val >>> (32 - shift))) >>> 0;
}

/**
 * Pure synchronous SHA-1 returning raw 20-byte digest.
 * Works identically in main thread, Web Workers, and Node tsx tests.
 */
export function sha1Bytes(input: string): Uint8Array {
  const utf8 = new TextEncoder().encode(input);
  const bitLen = utf8.length * 8;

  // Pad to 56 mod 64 bytes + 8-byte big-endian length
  const totalBytes = Math.ceil((utf8.length + 9) / 64) * 64;
  const padded = new Uint8Array(totalBytes);
  padded.set(utf8);
  padded[utf8.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  view.setUint32(totalBytes - 8, highBits, false);
  view.setUint32(totalBytes - 4, lowBits, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let offset = 0; offset < totalBytes; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotateLeft32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f = 0;
      let k = 0;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotateLeft32(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft32(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  return out;
}

export function stripHtmlForSortField(html: string): string {
  if (!html) return '';
  return html
    .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '')
    .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

/**
 * Anki note `csum`: unsigned 32-bit integer derived from the first 8 hex chars
 * (top 32 bits) of SHA-1 of the HTML-stripped first field.
 */
export function ankiFieldChecksum(firstField: string): number {
  const stripped = stripHtmlForSortField(firstField);
  const digest = sha1Bytes(stripped);
  const view = new DataView(digest.buffer);
  return view.getUint32(0, false) >>> 0;
}

const ANKI_BASE91_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+,-./:;<=>?@[]^_`{|}~';

/**
 * Deterministic 10-character Base91 GUID compatible with Anki's `notes.guid`.
 * Re-exporting the same LinguaForge card produces the exact same GUID.
 */
export function deterministicNoteGuid(anchorCardId: string): string {
  const digest = sha1Bytes(`linguaforge:guid:v1:${anchorCardId}`);
  const dv = new DataView(digest.buffer);
  // Read 64-bit unsigned integer from digest bytes 0..7
  let num =
    (BigInt(dv.getUint32(0, false)) << 32n) | BigInt(dv.getUint32(4, false));

  let chars = '';
  const base = BigInt(ANKI_BASE91_ALPHABET.length);
  for (let i = 0; i < 10; i++) {
    const rem = Number(num % base);
    chars = ANKI_BASE91_ALPHABET[rem] + chars;
    num = num / base;
  }
  return chars;
}

/**
 * Deterministic positive integer ID in millisecond epoch range (1.7e12..1.8e12)
 * suitable for Anki `notes.id`, `cards.id`, and `decks` keys.
 */
export function deterministicAnkiIntId(
  namespace: 'note' | 'card' | 'deck',
  seed: string,
  used?: Set<number>
): number {
  const digest = sha1Bytes(`linguaforge:${namespace}:v1:${seed}`);
  const dv = new DataView(digest.buffer);
  const hi = dv.getUint32(0, false);
  const lo = dv.getUint32(4, false);
  // Combine into 36-bit positive offset added to base epoch ~2023 (1700000000000)
  const offset = (hi * 16 + (lo >>> 28)) % 99_999_999_999;
  let id = 1_700_000_000_000 + offset;
  if (used) {
    while (used.has(id)) {
      id += 1;
    }
    used.add(id);
  }
  return id;
}

// ---------------------------------------------------------------------------
// HTML / Furigana / Tag Helpers
// ---------------------------------------------------------------------------

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hasKanji(str: string): boolean {
  return /[\u4e00-\u9faf\u3400-\u4dbf々〆〇]/.test(str);
}

/**
 * Renders furigana segments as `<ruby>漢字<rt>かんじ</rt></ruby>` while keeping
 * okurigana / kana-only segments outside `<ruby>` tags.
 */
export function furiganaSegmentsToHtml(
  segments?: { text: string; ruby?: string }[],
  word = '',
  reading = ''
): string {
  let effective = segments;
  if ((!effective || effective.length === 0) && word && reading && hasKanji(word)) {
    effective = buildFurigana(word, reading);
  }

  if (!effective || effective.length === 0) {
    return escapeHtml(word || '');
  }

  let html = '';
  for (const seg of effective) {
    const text = seg.text || '';
    if (!text) continue;
    const ruby = seg.ruby?.trim();
    if (ruby && ruby !== text) {
      html += `<ruby>${escapeHtml(text)}<rt>${escapeHtml(ruby)}</rt></ruby>`;
    } else {
      html += escapeHtml(text);
    }
  }
  return html;
}

/**
 * Converts a sentence + optional segments into HTML, optionally keeping `<ruby>`
 * furigana and highlighting occurrences of the target word/lemma.
 */
export function formatSentenceHtml(
  sentence: string | undefined,
  sentenceSegments: { text: string; ruby?: string }[] | undefined,
  word: string,
  lemma: string,
  includeRuby: boolean
): string {
  const rawSentence = (sentence || '').trim();
  if (!rawSentence) return '';

  const targets = Array.from(
    new Set([word?.trim(), lemma?.trim()].filter((t): t is string => Boolean(t)))
  ).sort((a, b) => b.length - a.length);

  if (includeRuby && sentenceSegments && sentenceSegments.length > 0) {
    // Build segment HTML, grouping matches of target word across contiguous segments
    const fullText = sentenceSegments.map((s) => s.text || '').join('');
    if (targets.length === 0 || !fullText) {
      return furiganaSegmentsToHtml(sentenceSegments, rawSentence);
    }

    const highlightMask = new Uint8Array(fullText.length);
    for (const t of targets) {
      let idx = fullText.indexOf(t);
      while (idx !== -1) {
        for (let k = idx; k < idx + t.length; k++) {
          highlightMask[k] = 1;
        }
        idx = fullText.indexOf(t, idx + t.length);
      }
    }

    let cursor = 0;
    let out = '';
    for (const seg of sentenceSegments) {
      const segText = seg.text || '';
      if (!segText) continue;
      const start = cursor;
      const end = cursor + segText.length;
      cursor = end;

      let anyHighlighted = false;
      let allHighlighted = true;
      for (let i = start; i < end; i++) {
        if (highlightMask[i]) anyHighlighted = true;
        else allHighlighted = false;
      }

      const ruby = seg.ruby?.trim();
      if (ruby && ruby !== segText) {
        const rubyHtml = `<ruby>${escapeHtml(segText)}<rt>${escapeHtml(ruby)}</rt></ruby>`;
        out += anyHighlighted ? `<span class="lf-highlight">${rubyHtml}</span>` : rubyHtml;
      } else if (allHighlighted) {
        out += `<span class="lf-highlight">${escapeHtml(segText)}</span>`;
      } else if (!anyHighlighted) {
        out += escapeHtml(segText);
      } else {
        // Split partially highlighted kana chunk
        let buf = '';
        let curState = highlightMask[start] === 1;
        for (let i = start; i < end; i++) {
          const st = highlightMask[i] === 1;
          if (st !== curState) {
            out += curState
              ? `<span class="lf-highlight">${escapeHtml(buf)}</span>`
              : escapeHtml(buf);
            buf = '';
            curState = st;
          }
          buf += fullText[i];
        }
        if (buf) {
          out += curState
            ? `<span class="lf-highlight">${escapeHtml(buf)}</span>`
            : escapeHtml(buf);
        }
      }
    }
    return out;
  }

  // Plain sentence highlighting without furigana segments
  if (targets.length === 0) {
    return escapeHtml(rawSentence);
  }
  const escapedPattern = targets
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const regex = new RegExp(`(${escapedPattern})`, 'g');
  return rawSentence
    .split(regex)
    .map((part) => {
      if (targets.includes(part)) {
        return `<span class="lf-highlight">${escapeHtml(part)}</span>`;
      }
      return escapeHtml(part);
    })
    .join('');
}

export function sanitizeAnkiTag(tag: string): string {
  return tag
    .trim()
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function collectCardTags(
  card: CardItem,
  options: {
    includeAutoLevelTag: boolean;
    includeAutoSourceTag: boolean;
    includeAutoCardTypeTag: boolean;
  }
): string[] {
  const tagSet = new Set<string>();
  for (const t of card.tags || []) {
    const clean = sanitizeAnkiTag(t);
    if (clean) tagSet.add(clean);
  }
  if (options.includeAutoLevelTag && card.level?.trim()) {
    const rawLvl = card.level.trim().toUpperCase();
    const prefix =
      /^N[1-5]$/.test(rawLvl)
        ? `JLPT_${rawLvl}`
        : /^[ABC][12]$/.test(rawLvl)
        ? `CEFR_${rawLvl}`
        : rawLvl;
    const clean = sanitizeAnkiTag(prefix);
    if (clean) tagSet.add(clean);
  }
  if (options.includeAutoSourceTag && card.sourceDocTitle?.trim()) {
    const clean = sanitizeAnkiTag(`source:${card.sourceDocTitle.trim()}`);
    if (clean) tagSet.add(clean);
  }
  if (options.includeAutoCardTypeTag) {
    tagSet.add(sanitizeAnkiTag(`type:${card.cardType}`));
  }
  return Array.from(tagSet);
}

// ---------------------------------------------------------------------------
// Anki Note Type CSS & Templates
// ---------------------------------------------------------------------------

const CARD_TYPE_TEMPLATE_DEFINITIONS: Record<
  CardType,
  { name: string; qfmt: string; afmt: string }
> = {
  word_to_meaning: {
    name: 'Word → Meaning',
    qfmt: `<div class="lf-card">
  <div class="lf-type-label">Word → Meaning</div>
  <div class="lf-word">{{#FuriganaHTML}}{{FuriganaHTML}}{{/FuriganaHTML}}{{^FuriganaHTML}}{{Word}}{{/FuriganaHTML}}</div>
  {{#Sentence}}
  <div class="lf-sentence">{{#SentenceFuriganaHTML}}{{SentenceFuriganaHTML}}{{/SentenceFuriganaHTML}}{{^SentenceFuriganaHTML}}{{Sentence}}{{/SentenceFuriganaHTML}}</div>
  {{/Sentence}}
</div>`,
    afmt: `{{FrontSide}}
<hr id="answer">
<div class="lf-card lf-back">
  {{#Reading}}<div class="lf-reading">{{Reading}}</div>{{/Reading}}
  <div class="lf-meaning">{{Meaning}}</div>
  <div class="lf-badges">
    {{#PartOfSpeech}}<span class="lf-badge">{{PartOfSpeech}}</span>{{/PartOfSpeech}}
    {{#Level}}<span class="lf-badge lf-badge-level">{{Level}}</span>{{/Level}}
    {{#Frequency}}<span class="lf-badge">{{Frequency}}</span>{{/Frequency}}
  </div>
  {{#SentenceMeaning}}<div class="lf-sentence-meaning">{{SentenceMeaning}}</div>{{/SentenceMeaning}}
  {{#Notes}}<div class="lf-notes">{{Notes}}</div>{{/Notes}}
  {{#Source}}<div class="lf-source">Source: {{Source}}</div>{{/Source}}
</div>`,
  },
  meaning_to_word: {
    name: 'Meaning → Word',
    qfmt: `<div class="lf-card">
  <div class="lf-type-label">Meaning → Word</div>
  <div class="lf-meaning lf-meaning-prompt">{{Meaning}}</div>
  <div class="lf-badges">
    {{#PartOfSpeech}}<span class="lf-badge">{{PartOfSpeech}}</span>{{/PartOfSpeech}}
    {{#Level}}<span class="lf-badge lf-badge-level">{{Level}}</span>{{/Level}}
  </div>
  {{#SentenceMeaning}}<div class="lf-sentence-meaning">{{SentenceMeaning}}</div>{{/SentenceMeaning}}
</div>`,
    afmt: `{{FrontSide}}
<hr id="answer">
<div class="lf-card lf-back">
  <div class="lf-word">{{#FuriganaHTML}}{{FuriganaHTML}}{{/FuriganaHTML}}{{^FuriganaHTML}}{{Word}}{{/FuriganaHTML}}</div>
  {{#Reading}}<div class="lf-reading">{{Reading}}</div>{{/Reading}}
  {{#Sentence}}
  <div class="lf-sentence">{{#SentenceFuriganaHTML}}{{SentenceFuriganaHTML}}{{/SentenceFuriganaHTML}}{{^SentenceFuriganaHTML}}{{Sentence}}{{/SentenceFuriganaHTML}}</div>
  {{/Sentence}}
  {{#Notes}}<div class="lf-notes">{{Notes}}</div>{{/Notes}}
  {{#Source}}<div class="lf-source">Source: {{Source}}</div>{{/Source}}
</div>`,
  },
  reading: {
    name: 'Reading',
    qfmt: `<div class="lf-card">
  <div class="lf-type-label">Reading</div>
  <div class="lf-word">{{Word}}</div>
  {{#Sentence}}
  <div class="lf-sentence">{{Sentence}}</div>
  {{/Sentence}}
</div>`,
    afmt: `{{FrontSide}}
<hr id="answer">
<div class="lf-card lf-back">
  {{#FuriganaHTML}}<div class="lf-furigana-reveal">{{FuriganaHTML}}</div>{{/FuriganaHTML}}
  {{#Reading}}<div class="lf-reading">{{Reading}}</div>{{/Reading}}
  <div class="lf-meaning">{{Meaning}}</div>
  <div class="lf-badges">
    {{#PartOfSpeech}}<span class="lf-badge">{{PartOfSpeech}}</span>{{/PartOfSpeech}}
    {{#Level}}<span class="lf-badge lf-badge-level">{{Level}}</span>{{/Level}}
    {{#Frequency}}<span class="lf-badge">{{Frequency}}</span>{{/Frequency}}
  </div>
  {{#SentenceFuriganaHTML}}<div class="lf-sentence">{{SentenceFuriganaHTML}}</div>{{/SentenceFuriganaHTML}}
  {{#SentenceMeaning}}<div class="lf-sentence-meaning">{{SentenceMeaning}}</div>{{/SentenceMeaning}}
  {{#Notes}}<div class="lf-notes">{{Notes}}</div>{{/Notes}}
  {{#Source}}<div class="lf-source">Source: {{Source}}</div>{{/Source}}
</div>`,
  },
};

export const ANKI_MODEL_CSS = `.card {
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Noto Sans JP", sans-serif;
  font-size: 18px;
  line-height: 1.6;
  text-align: center;
  color: #18181b;
  background-color: #f8fafc;
  margin: 0;
  padding: 16px 12px;
}

.lf-card {
  max-width: 600px;
  margin: 0 auto;
  padding: 20px 18px;
  border-radius: 16px;
  background-color: #ffffff;
  border: 1px solid #e2e8f0;
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.05);
}

.lf-back {
  margin-top: 10px;
}

.lf-type-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #6366f1;
  margin-bottom: 10px;
}

.lf-word {
  font-size: 38px;
  font-weight: 700;
  line-height: 1.45;
  color: #0f172a;
  margin: 6px 0 12px;
  word-break: break-word;
}

.lf-furigana-reveal {
  font-size: 30px;
  font-weight: 700;
  line-height: 1.5;
  color: #0f172a;
  margin-bottom: 6px;
}

ruby {
  ruby-align: center;
}

rt {
  font-size: 0.44em;
  font-weight: 500;
  color: #4f46e5;
}

.lf-reading {
  font-size: 20px;
  font-weight: 600;
  color: #4f46e5;
  margin-bottom: 10px;
}

.lf-meaning {
  font-size: 20px;
  font-weight: 600;
  color: #1e293b;
  margin: 8px 0 12px;
}

.lf-meaning-prompt {
  font-size: 24px;
  margin: 14px 0;
}

.lf-sentence {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 12px;
  background-color: #f1f5f9;
  color: #1e293b;
  font-size: 18px;
  line-height: 1.85;
  text-align: left;
}

.lf-sentence-meaning {
  margin-top: 10px;
  font-size: 15px;
  color: #475569;
  text-align: left;
}

.lf-highlight {
  font-weight: 700;
  color: #3730a3;
  background-color: rgba(99, 102, 241, 0.16);
  padding: 1px 4px;
  border-radius: 5px;
}

.lf-badges {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin-top: 8px;
}

.lf-badge {
  display: inline-block;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 8px;
  background-color: #f1f5f9;
  color: #475569;
  border: 1px solid #cbd5e1;
}

.lf-badge-level {
  background-color: #eef2ff;
  color: #4338ca;
  border-color: #c7d2fe;
}

.lf-notes {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background-color: #fffbeb;
  border: 1px solid #fde68a;
  color: #78350f;
  font-size: 14px;
  text-align: left;
  white-space: pre-wrap;
}

.lf-source {
  margin-top: 12px;
  font-size: 12px;
  color: #64748b;
  text-align: right;
}

hr#answer {
  border: none;
  border-top: 1px solid #e2e8f0;
  margin: 14px auto;
  max-width: 600px;
}

/* Anki Desktop & AnkiDroid Dark Mode */
.nightMode .card,
.night_mode .card,
body.nightMode,
body.night_mode {
  color: #f1f5f9;
  background-color: #0f172a;
}

.nightMode .lf-card,
.night_mode .lf-card {
  background-color: #1e293b;
  border-color: #334155;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
}

.nightMode .lf-word,
.night_mode .lf-word,
.nightMode .lf-furigana-reveal,
.night_mode .lf-furigana-reveal {
  color: #f8fafc;
}

.nightMode rt,
.night_mode rt,
.nightMode .lf-reading,
.night_mode .lf-reading,
.nightMode .lf-type-label,
.night_mode .lf-type-label {
  color: #a5b4fc;
}

.nightMode .lf-meaning,
.night_mode .lf-meaning {
  color: #e2e8f0;
}

.nightMode .lf-sentence,
.night_mode .lf-sentence {
  background-color: #0f172a;
  color: #e2e8f0;
}

.nightMode .lf-sentence-meaning,
.night_mode .lf-sentence-meaning {
  color: #cbd5e1;
}

.nightMode .lf-highlight,
.night_mode .lf-highlight {
  color: #e0e7ff;
  background-color: rgba(129, 140, 248, 0.28);
}

.nightMode .lf-badge,
.night_mode .lf-badge {
  background-color: #334155;
  color: #e2e8f0;
  border-color: #475569;
}

.nightMode .lf-badge-level,
.night_mode .lf-badge-level {
  background-color: rgba(99, 102, 241, 0.24);
  color: #c7d2fe;
  border-color: rgba(129, 140, 248, 0.45);
}

.nightMode .lf-notes,
.night_mode .lf-notes {
  background-color: rgba(180, 83, 9, 0.2);
  border-color: rgba(245, 158, 11, 0.35);
  color: #fde68a;
}

.nightMode .lf-source,
.night_mode .lf-source {
  color: #94a3b8;
}

.nightMode hr#answer,
.night_mode hr#answer {
  border-top-color: #334155;
}

@media (prefers-color-scheme: dark) {
  .card {
    color: #f1f5f9;
    background-color: #0f172a;
  }
  .lf-card {
    background-color: #1e293b;
    border-color: #334155;
  }
  .lf-word,
  .lf-furigana-reveal {
    color: #f8fafc;
  }
  rt,
  .lf-reading,
  .lf-type-label {
    color: #a5b4fc;
  }
  .lf-meaning {
    color: #e2e8f0;
  }
  .lf-sentence {
    background-color: #0f172a;
    color: #e2e8f0;
  }
  .lf-highlight {
    color: #e0e7ff;
    background-color: rgba(129, 140, 248, 0.28);
  }
  .lf-badge {
    background-color: #334155;
    color: #e2e8f0;
    border-color: #475569;
  }
  .lf-notes {
    background-color: rgba(180, 83, 9, 0.2);
    border-color: rgba(245, 158, 11, 0.35);
    color: #fde68a;
  }
}

@media (max-width: 480px) {
  .card {
    padding: 10px 6px;
    font-size: 16px;
  }
  .lf-card {
    padding: 16px 12px;
  }
  .lf-word {
    font-size: 32px;
  }
  .lf-sentence {
    font-size: 16px;
  }
}`;

// ---------------------------------------------------------------------------
// Plan Builder (Notes, Cards, Decks)
// ---------------------------------------------------------------------------

export function formatAnkiDeckName(
  deckName: string,
  options: Pick<AnkiExportOptions, 'useSubdeckPrefix' | 'subdeckRootName' | 'languageName'>
): string {
  const cleanDeck = deckName.trim() || 'Default';
  if (!options.useSubdeckPrefix) {
    return cleanDeck;
  }
  const root = options.subdeckRootName.trim() || 'LinguaForge';
  const lang = options.languageName.trim() || 'Vocabulary';
  if (cleanDeck.startsWith(`${root}::`)) {
    return cleanDeck;
  }
  return `${root}::${lang}::${cleanDeck}`;
}

function buildFuriganaFieldsForCard(card: CardItem, furiganaFormat: FuriganaExportFormat) {
  const wordSegs =
    card.furiganaSegments && card.furiganaSegments.length > 0
      ? card.furiganaSegments
      : card.word && card.reading && hasKanji(card.word)
      ? buildFurigana(card.word, card.reading)
      : undefined;

  const htmlWord =
    furiganaFormat === 'html' || furiganaFormat === 'both'
      ? furiganaSegmentsToHtml(wordSegs, card.word, card.reading)
      : '';

  const ankiWord =
    furiganaFormat === 'anki' || furiganaFormat === 'both'
      ? wordSegs && wordSegs.length > 0
        ? furiganaSegmentsToAnki(wordSegs, card.word)
        : card.word || ''
      : '';

  const sentenceHtml = formatSentenceHtml(
    card.sentence,
    card.sentenceFuriganaSegments,
    card.word,
    card.lemma,
    furiganaFormat === 'html' || furiganaFormat === 'both'
  );

  return {
    htmlWord,
    ankiWord,
    sentenceHtml,
  };
}

/**
 * Groups matching cards into Anki Notes and Cards deterministically.
 * Cards sharing `(languageId, deckId, lemma, reading)` with distinct card types
 * become multiple cards of one Anki note; its GUID & ID derive from the
 * canonical anchor card ID so re-exporting produces identical Anki note GUIDs.
 */
export function buildAnkiExportPlan(
  selectedCards: CardItem[],
  decks: DeckItem[],
  options: AnkiExportOptions,
  nowMs = Date.now()
): AnkiExportPlan {
  const deckMap = new Map<string, DeckItem>();
  for (const d of decks) deckMap.set(d.id, d);

  const presentTypesSet = new Set<CardType>();
  for (const c of selectedCards) {
    presentTypesSet.add(c.cardType);
  }
  const presentCardTypes = (['word_to_meaning', 'meaning_to_word', 'reading'] as CardType[]).filter(
    (ct) => presentTypesSet.has(ct)
  );
  const templateOrdByType = new Map<CardType, number>();
  presentCardTypes.forEach((ct, idx) => templateOrdByType.set(ct, idx));

  // Canonical sort so note grouping and due ordinals are 100% deterministic
  const sortedCards = [...selectedCards].sort((a, b) => {
    const typeDiff =
      (CARD_TYPE_CANONICAL_ORDER[a.cardType] ?? 9) -
      (CARD_TYPE_CANONICAL_ORDER[b.cardType] ?? 9);
    if (typeDiff !== 0) return typeDiff;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });

  // Group cards by note key; avoid duplicating the same cardType within one note
  interface NoteGroup {
    anchor: CardItem;
    cards: CardItem[];
    typesSeen: Set<CardType>;
  }
  const groupsByKey = new Map<string, NoteGroup[]>();
  const orderedGroups: NoteGroup[] = [];

  for (const card of sortedCards) {
    const key = [
      card.languageId,
      card.deckId,
      (card.lemma || card.word || '').trim(),
      (card.reading || '').trim(),
    ].join('\x1e');

    let list = groupsByKey.get(key);
    if (!list) {
      list = [];
      groupsByKey.set(key, list);
    }

    let targetGroup = list.find((g) => !g.typesSeen.has(card.cardType));
    if (!targetGroup) {
      targetGroup = {
        anchor: card,
        cards: [],
        typesSeen: new Set<CardType>(),
      };
      list.push(targetGroup);
      orderedGroups.push(targetGroup);
    }
    targetGroup.cards.push(card);
    targetGroup.typesSeen.add(card.cardType);
  }

  const usedDeckIds = new Set<number>([1]);
  const usedNoteIds = new Set<number>();
  const usedCardIds = new Set<number>();
  const deckDrafts = new Map<string, AnkiDeckDraft>();

  const getDeckDraft = (deckId: string): AnkiDeckDraft => {
    const existing = deckDrafts.get(deckId);
    if (existing) return existing;
    const deckObj = deckMap.get(deckId);
    const fullName = formatAnkiDeckName(deckObj?.name || 'Default', options);
    const did = deterministicAnkiIntId('deck', `${deckId}:${fullName}`, usedDeckIds);
    const draft: AnkiDeckDraft = {
      did,
      name: fullName,
      description: deckObj?.description || '',
    };
    deckDrafts.set(deckId, draft);
    return draft;
  };

  const createdAtSec = Math.floor(nowMs / 1000);
  const notes: AnkiNoteDraft[] = [];
  const ankiCards: AnkiCardDraft[] = [];
  let dueOrdinal = 1;

  for (const group of orderedGroups) {
    const anchor = group.anchor;
    const nid = deterministicAnkiIntId('note', anchor.id, usedNoteIds);
    const guid = deterministicNoteGuid(anchor.id);

    // Aggregate unique tags across cards in the note
    const tagSet = new Set<string>();
    for (const c of group.cards) {
      for (const t of collectCardTags(c, options)) {
        tagSet.add(t);
      }
    }
    const tagsArr = Array.from(tagSet);
    const tagsColStr = tagsArr.length > 0 ? ` ${tagsArr.join(' ')} ` : '';
    const tagsFieldStr = tagsArr.join(', ');

    const { htmlWord, ankiWord, sentenceHtml } = buildFuriganaFieldsForCard(
      anchor,
      options.furiganaFormat
    );

    const plainSentence = (anchor.sentence || '').trim();
    const firstField = anchor.word || '';
    const fields = [
      firstField, // Word
      anchor.lemma || anchor.word || '', // Lemma
      anchor.reading || '', // Reading
      htmlWord, // FuriganaHTML
      ankiWord, // FuriganaAnki
      anchor.meaning || '', // Meaning
      anchor.partOfSpeech || '', // PartOfSpeech
      anchor.level || '', // Level
      anchor.frequencyBand || '', // Frequency
      plainSentence, // Sentence
      sentenceHtml, // SentenceFuriganaHTML
      '', // SentenceMeaning (blank unless provided in future)
      anchor.sourceDocTitle || '', // Source
      anchor.notes || '', // Notes
      tagsFieldStr, // Tags
    ];

    const flds = fields.join(ANKI_FIELD_SEPARATOR);
    const sfld = stripHtmlForSortField(firstField);
    const csum = ankiFieldChecksum(firstField);
    const noteModSec = Math.floor((anchor.updatedAt || nowMs) / 1000);

    notes.push({
      nid,
      guid,
      anchorCardId: anchor.id,
      mid: LINGUAFORGE_VOCAB_MODEL_ID,
      mod: noteModSec,
      usn: -1,
      tags: tagsColStr,
      flds,
      fields,
      sfld,
      csum,
    });

    for (const c of group.cards) {
      const deckDraft = getDeckDraft(c.deckId);
      const cid = deterministicAnkiIntId('card', c.id, usedCardIds);
      const ord = templateOrdByType.get(c.cardType) ?? 0;
      const cardModSec = Math.floor((c.updatedAt || nowMs) / 1000);

      ankiCards.push({
        cid,
        sourceCardId: c.id,
        cardType: c.cardType,
        nid,
        did: deckDraft.did,
        ord,
        mod: cardModSec,
        usn: -1,
        type: 0, // New card
        queue: 0, // New queue
        due: dueOrdinal++,
        ivl: 0,
        factor: 0,
        reps: 0,
        lapses: 0,
        left: 0,
        odue: 0,
        odid: 0,
        flags: 0,
        data: '{}',
      });
    }
  }

  return {
    modelId: LINGUAFORGE_VOCAB_MODEL_ID,
    modelName: 'LinguaForge Vocabulary',
    presentCardTypes,
    fieldNames: [...ANKI_VOCAB_FIELD_NAMES],
    decks: Array.from(deckDrafts.values()),
    notes,
    cards: ankiCards,
    exportedCardIds: sortedCards.map((c) => c.id),
    createdAtSec,
    modifiedAtMs: nowMs,
  };
}

// ---------------------------------------------------------------------------
// Anki 2.1 Legacy SQLite Schema v11 Generator & Self-Verifier
// ---------------------------------------------------------------------------

function buildAnkiModelsJson(plan: AnkiExportPlan): string {
  const flds = plan.fieldNames.map((name, ord) => ({
    name,
    ord,
    sticky: false,
    rtl: false,
    font: 'Arial',
    size: 20,
    media: [],
  }));

  const tmpls = plan.presentCardTypes.map((ct, ord) => {
    const def = CARD_TYPE_TEMPLATE_DEFINITIONS[ct];
    return {
      name: def.name,
      ord,
      qfmt: def.qfmt,
      afmt: def.afmt,
      bqfmt: '',
      bafmt: '',
      did: null,
    };
  });

  const modelObj = {
    [String(plan.modelId)]: {
      id: plan.modelId,
      name: plan.modelName,
      type: 0,
      mod: plan.createdAtSec,
      usn: -1,
      sortf: 0,
      did: plan.decks[0]?.did ?? 1,
      tmpls,
      flds,
      css: ANKI_MODEL_CSS,
      latexPre:
        '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
      latexPost: '\\end{document}',
      latexsvg: false,
      req: plan.presentCardTypes.map((_, ord) => [ord, 'any', [0]]),
      tags: [],
      vers: [],
    },
  };

  return JSON.stringify(modelObj);
}

function buildAnkiDecksJson(plan: AnkiExportPlan): string {
  const decksObj: Record<string, any> = {
    '1': {
      id: 1,
      name: 'Default',
      desc: '',
      mod: plan.createdAtSec,
      usn: -1,
      lrnToday: [0, 0],
      revToday: [0, 0],
      newToday: [0, 0],
      timeToday: [0, 0],
      collapsed: false,
      browserCollapsed: false,
      extendNew: 0,
      extendRev: 0,
      conf: 1,
      dyn: 0,
    },
  };

  for (const d of plan.decks) {
    decksObj[String(d.did)] = {
      id: d.did,
      name: d.name,
      desc: d.description || '',
      mod: plan.createdAtSec,
      usn: -1,
      lrnToday: [0, 0],
      revToday: [0, 0],
      newToday: [0, 0],
      timeToday: [0, 0],
      collapsed: false,
      browserCollapsed: false,
      extendNew: 0,
      extendRev: 0,
      conf: 1,
      dyn: 0,
    };
  }

  return JSON.stringify(decksObj);
}

function buildAnkiConfJson(plan: AnkiExportPlan): string {
  return JSON.stringify({
    activeDecks: [plan.decks[0]?.did ?? 1],
    curDeck: plan.decks[0]?.did ?? 1,
    newSpread: 0,
    collapseTime: 1200,
    timeLim: 0,
    estTimes: true,
    dueCounts: true,
    curModel: String(plan.modelId),
    nextPos: plan.cards.length + 1,
    sortType: 'noteFld',
    sortBackwards: false,
    addToCur: true,
  });
}

function buildAnkiDconfJson(createdAtSec: number): string {
  return JSON.stringify({
    '1': {
      id: 1,
      name: 'Default',
      mod: createdAtSec,
      usn: -1,
      maxTaken: 60,
      autoplay: true,
      timer: 0,
      replayq: true,
      new: {
        bury: false,
        delays: [1, 10],
        initialFactor: 2500,
        ints: [1, 4, 7],
        order: 1,
        perDay: 20,
      },
      rev: {
        bury: false,
        ease4: 1.3,
        ivlFct: 1,
        maxIvl: 36500,
        perDay: 200,
        hardFactor: 1.2,
      },
      lapse: {
        delays: [10],
        leechAction: 0,
        leechFails: 8,
        minInt: 1,
        mult: 0,
      },
      dyn: false,
    },
  });
}

export const ANKI_SCHEMA_DDL = [
  `CREATE TABLE col (
    id integer primary key,
    crt integer not null,
    mod integer not null,
    scm integer not null,
    ver integer not null,
    dty integer not null,
    usn integer not null,
    ls integer not null,
    conf text not null,
    models text not null,
    decks text not null,
    dconf text not null,
    tags text not null
  );`,
  `CREATE TABLE notes (
    id integer primary key,
    guid text not null,
    mid integer not null,
    mod integer not null,
    usn integer not null,
    tags text not null,
    flds text not null,
    sfld integer not null,
    csum integer not null,
    flags integer not null,
    data text not null
  );`,
  `CREATE TABLE cards (
    id integer primary key,
    nid integer not null,
    did integer not null,
    ord integer not null,
    mod integer not null,
    usn integer not null,
    type integer not null,
    queue integer not null,
    due integer not null,
    ivl integer not null,
    factor integer not null,
    reps integer not null,
    lapses integer not null,
    left integer not null,
    odue integer not null,
    odid integer not null,
    flags integer not null,
    data text not null
  );`,
  `CREATE TABLE revlog (
    id integer primary key,
    cid integer not null,
    usn integer not null,
    ease integer not null,
    ivl integer not null,
    lastIvl integer not null,
    factor integer not null,
    time integer not null,
    type integer not null
  );`,
  `CREATE TABLE graves (
    usn integer not null,
    oid integer not null,
    type integer not null
  );`,
  `CREATE INDEX ix_notes_usn on notes (usn);`,
  `CREATE INDEX ix_cards_usn on cards (usn);`,
  `CREATE INDEX ix_revlog_usn on revlog (usn);`,
  `CREATE INDEX ix_cards_nid on cards (nid);`,
  `CREATE INDEX ix_cards_sched on cards (did, queue, due);`,
  `CREATE INDEX ix_revlog_cid on revlog (cid);`,
  `CREATE INDEX ix_notes_csum on notes (csum);`,
];

export interface SqliteBuildProgress {
  phase: 'preparing' | 'writing_notes' | 'writing_cards' | 'zipping' | 'verifying';
  processed: number;
  total: number;
  percent: number;
}

export async function buildAnkiSqliteBytes(
  plan: AnkiExportPlan,
  sqlJs: SqlJsStatic,
  onProgress?: (progress: SqliteBuildProgress) => void,
  isCancelled?: () => boolean
): Promise<Uint8Array> {
  const db = new sqlJs.Database();
  try {
    for (const stmt of ANKI_SCHEMA_DDL) {
      db.run(stmt);
    }

    db.run(
      `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1,
        plan.createdAtSec,
        plan.modifiedAtMs,
        plan.modifiedAtMs,
        ANKI_SCHEMA_VERSION,
        0,
        0,
        0,
        buildAnkiConfJson(plan),
        buildAnkiModelsJson(plan),
        buildAnkiDecksJson(plan),
        buildAnkiDconfJson(plan.createdAtSec),
        '{}',
      ]
    );

    const totalWork = Math.max(1, plan.notes.length + plan.cards.length);
    const BATCH = 400;

    // Insert notes in batches
    const noteStmt = db.prepare(
      `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    try {
      db.run('BEGIN TRANSACTION;');
      for (let i = 0; i < plan.notes.length; i++) {
        if (isCancelled?.()) {
          throw new Error('Export cancelled by user');
        }
        const n = plan.notes[i];
        noteStmt.run([
          n.nid,
          n.guid,
          n.mid,
          n.mod,
          n.usn,
          n.tags,
          n.flds,
          n.sfld,
          n.csum,
          0,
          '',
        ]);

        if ((i + 1) % BATCH === 0 || i === plan.notes.length - 1) {
          db.run('COMMIT;');
          onProgress?.({
            phase: 'writing_notes',
            processed: i + 1,
            total: totalWork,
            percent: Math.min(75, Math.round(((i + 1) / totalWork) * 75)),
          });
          if (i < plan.notes.length - 1) {
            await new Promise((r) => setTimeout(r, 0));
            db.run('BEGIN TRANSACTION;');
          }
        }
      }
      if (plan.notes.length === 0) {
        db.run('COMMIT;');
      }
    } finally {
      noteStmt.free();
    }

    // Insert cards in batches
    const cardStmt = db.prepare(
      `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    try {
      db.run('BEGIN TRANSACTION;');
      for (let i = 0; i < plan.cards.length; i++) {
        if (isCancelled?.()) {
          throw new Error('Export cancelled by user');
        }
        const c = plan.cards[i];
        cardStmt.run([
          c.cid,
          c.nid,
          c.did,
          c.ord,
          c.mod,
          c.usn,
          c.type,
          c.queue,
          c.due,
          c.ivl,
          c.factor,
          c.reps,
          c.lapses,
          c.left,
          c.odue,
          c.odid,
          c.flags,
          c.data,
        ]);

        if ((i + 1) % BATCH === 0 || i === plan.cards.length - 1) {
          db.run('COMMIT;');
          const done = plan.notes.length + i + 1;
          onProgress?.({
            phase: 'writing_cards',
            processed: done,
            total: totalWork,
            percent: Math.min(82, Math.round((done / totalWork) * 82)),
          });
          if (i < plan.cards.length - 1) {
            await new Promise((r) => setTimeout(r, 0));
            db.run('BEGIN TRANSACTION;');
          }
        }
      }
      if (plan.cards.length === 0) {
        db.run('COMMIT;');
      }
    } finally {
      cardStmt.free();
    }

    return db.export();
  } finally {
    db.close();
  }
}

/**
 * Packages `collection.anki2` and `media` ("{}") into a valid Anki 2.1 LEGACY `.apkg` zip,
 * with NO `.anki21` or `.anki21b` files, then re-opens & verifies the generated package.
 */
export async function buildAndVerifyApkg(
  plan: AnkiExportPlan,
  sqlJs: SqlJsStatic,
  onProgress?: (progress: SqliteBuildProgress) => void,
  isCancelled?: () => boolean
): Promise<{ zipBytes: Uint8Array; verification: ApkgVerificationReport }> {
  if (plan.notes.length === 0 || plan.cards.length === 0) {
    throw new Error('No cards selected for export.');
  }

  const sqliteBytes = await buildAnkiSqliteBytes(plan, sqlJs, onProgress, isCancelled);
  if (isCancelled?.()) {
    throw new Error('Export cancelled by user');
  }

  onProgress?.({
    phase: 'zipping',
    processed: plan.notes.length + plan.cards.length,
    total: plan.notes.length + plan.cards.length,
    percent: 88,
  });

  const zip = new JSZip();
  zip.file('collection.anki2', sqliteBytes);
  zip.file('media', '{}');

  const zipBytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  if (isCancelled?.()) {
    throw new Error('Export cancelled by user');
  }

  onProgress?.({
    phase: 'verifying',
    processed: plan.notes.length + plan.cards.length,
    total: plan.notes.length + plan.cards.length,
    percent: 95,
  });

  const verification = await verifyAnkiApkgPackage(
    zipBytes,
    sqlJs,
    plan.notes.length,
    plan.cards.length
  );

  if (!verification.ok) {
    throw new Error(verification.error || 'Self-check failed on generated .apkg package.');
  }

  onProgress?.({
    phase: 'verifying',
    processed: plan.notes.length + plan.cards.length,
    total: plan.notes.length + plan.cards.length,
    percent: 100,
  });

  return { zipBytes, verification };
}

/**
 * Self-check step: re-opens the built `.apkg` zip, validates entries (`collection.anki2` + `media`
 * only), opens SQLite with `sql.js`, checks schema version 11, counts rows, and decodes the
 * first and last notes.
 */
export async function verifyAnkiApkgPackage(
  zipBytes: Uint8Array,
  sqlJs: SqlJsStatic,
  expectedNotes?: number,
  expectedCards?: number
): Promise<ApkgVerificationReport> {
  try {
    const zip = await JSZip.loadAsync(zipBytes);
    const entries = Object.keys(zip.files).sort();

    if (entries.includes('collection.anki21') || entries.includes('collection.anki21b')) {
      return {
        ok: false,
        schemaVersion: 0,
        noteCount: 0,
        cardCount: 0,
        revlogCount: 0,
        deckCount: 0,
        zipEntries: entries,
        error: 'Legacy .apkg must not include .anki21 or .anki21b database files.',
      };
    }

    const colFile = zip.file('collection.anki2');
    const mediaFile = zip.file('media');
    if (!colFile || !mediaFile) {
      return {
        ok: false,
        schemaVersion: 0,
        noteCount: 0,
        cardCount: 0,
        revlogCount: 0,
        deckCount: 0,
        zipEntries: entries,
        error: 'Missing collection.anki2 or media file inside .apkg zip.',
      };
    }

    const mediaText = await mediaFile.async('string');
    if (mediaText.trim() !== '{}') {
      return {
        ok: false,
        schemaVersion: 0,
        noteCount: 0,
        cardCount: 0,
        revlogCount: 0,
        deckCount: 0,
        zipEntries: entries,
        error: `Unexpected media manifest content: ${mediaText}`,
      };
    }

    const dbBytes = await colFile.async('uint8array');
    const checkDb = new sqlJs.Database(dbBytes);
    try {
      const colRes = checkDb.exec('SELECT ver, models, decks FROM col LIMIT 1;');
      const colRow = colRes[0]?.values?.[0];
      if (!colRow) {
        return {
          ok: false,
          schemaVersion: 0,
          noteCount: 0,
          cardCount: 0,
          revlogCount: 0,
          deckCount: 0,
          zipEntries: entries,
          error: 'col table is empty.',
        };
      }

      const schemaVersion = Number(colRow[0]);
      const modelsObj = JSON.parse(String(colRow[1] || '{}'));
      const decksObj = JSON.parse(String(colRow[2] || '{}'));

      if (schemaVersion !== ANKI_SCHEMA_VERSION) {
        return {
          ok: false,
          schemaVersion,
          noteCount: 0,
          cardCount: 0,
          revlogCount: 0,
          deckCount: Object.keys(decksObj).length,
          zipEntries: entries,
          error: `Expected schema version 11, found ${schemaVersion}.`,
        };
      }

      if (!modelsObj[String(LINGUAFORGE_VOCAB_MODEL_ID)]) {
        return {
          ok: false,
          schemaVersion,
          noteCount: 0,
          cardCount: 0,
          revlogCount: 0,
          deckCount: Object.keys(decksObj).length,
          zipEntries: entries,
          error: 'LinguaForge Vocabulary model missing in col.models.',
        };
      }

      const noteCount = Number(
        checkDb.exec('SELECT COUNT(*) FROM notes;')[0]?.values?.[0]?.[0] ?? 0
      );
      const cardCount = Number(
        checkDb.exec('SELECT COUNT(*) FROM cards;')[0]?.values?.[0]?.[0] ?? 0
      );
      const revlogCount = Number(
        checkDb.exec('SELECT COUNT(*) FROM revlog;')[0]?.values?.[0]?.[0] ?? 0
      );

      if (expectedNotes !== undefined && noteCount !== expectedNotes) {
        return {
          ok: false,
          schemaVersion,
          noteCount,
          cardCount,
          revlogCount,
          deckCount: Object.keys(decksObj).length,
          zipEntries: entries,
          error: `Expected ${expectedNotes} notes, found ${noteCount}.`,
        };
      }

      if (expectedCards !== undefined && cardCount !== expectedCards) {
        return {
          ok: false,
          schemaVersion,
          noteCount,
          cardCount,
          revlogCount,
          deckCount: Object.keys(decksObj).length,
          zipEntries: entries,
          error: `Expected ${expectedCards} cards, found ${cardCount}.`,
        };
      }

      if (revlogCount !== 0) {
        return {
          ok: false,
          schemaVersion,
          noteCount,
          cardCount,
          revlogCount,
          deckCount: Object.keys(decksObj).length,
          zipEntries: entries,
          error: `Expected empty revlog (0 rows), found ${revlogCount}.`,
        };
      }

      const firstRes = checkDb.exec(
        'SELECT id, guid, flds, csum FROM notes ORDER BY rowid ASC LIMIT 1;'
      );
      const lastRes = checkDb.exec(
        'SELECT id, guid, flds, csum FROM notes ORDER BY rowid DESC LIMIT 1;'
      );

      const decodeNoteSummary = (row: any[] | undefined) => {
        if (!row) return undefined;
        const fields = String(row[2] || '').split(ANKI_FIELD_SEPARATOR);
        return {
          id: Number(row[0]),
          guid: String(row[1]),
          word: fields[0] || '',
          meaning: fields[5] || '',
          csum: Number(row[3]),
        };
      };

      const firstNote = decodeNoteSummary(firstRes[0]?.values?.[0]);
      const lastNote = decodeNoteSummary(lastRes[0]?.values?.[0]);

      if (!firstNote || !lastNote) {
        return {
          ok: false,
          schemaVersion,
          noteCount,
          cardCount,
          revlogCount,
          deckCount: Object.keys(decksObj).length,
          zipEntries: entries,
          error: 'Could not decode first or last note from collection.anki2.',
        };
      }

      return {
        ok: true,
        schemaVersion,
        noteCount,
        cardCount,
        revlogCount,
        deckCount: Object.keys(decksObj).length,
        zipEntries: entries,
        firstNote,
        lastNote,
      };
    } finally {
      checkDb.close();
    }
  } catch (err: any) {
    return {
      ok: false,
      schemaVersion: 0,
      noteCount: 0,
      cardCount: 0,
      revlogCount: 0,
      deckCount: 0,
      zipEntries: [],
      error: err?.message || 'Failed to verify generated .apkg file.',
    };
  }
}

// ---------------------------------------------------------------------------
// CSV / TSV Exporter
// ---------------------------------------------------------------------------

function escapeCsvCell(value: string, delimiter: ',' | '\t'): string {
  const clean = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (
    delimiter === ',' &&
    (clean.includes(',') || clean.includes('"') || clean.includes('\n'))
  ) {
    return `"${clean.replace(/"/g, '""')}"`;
  }
  if (
    delimiter === '\t' &&
    (clean.includes('\t') || clean.includes('"') || clean.includes('\n'))
  ) {
    return `"${clean.replace(/"/g, '""')}"`;
  }
  return clean;
}

export function buildCsvTsvExport(
  cards: CardItem[],
  decks: DeckItem[],
  options: CsvExportOptions
): { text: string; bytes: Uint8Array; rowCount: number } {
  const deckNameMap = new Map<string, string>();
  for (const d of decks) deckNameMap.set(d.id, d.name);

  const lines: string[] = [];
  if (options.includeHeader) {
    lines.push(
      options.columns
        .map((col) => escapeCsvCell(CSV_COLUMN_LABELS[col], options.delimiter))
        .join(options.delimiter)
    );
  }

  for (const card of cards) {
    const { htmlWord, ankiWord, sentenceHtml } = buildFuriganaFieldsForCard(
      card,
      options.furiganaFormat
    );
    const tags = collectCardTags(card, options).join(' ');

    const row = options.columns.map((col) => {
      let val = '';
      switch (col) {
        case 'word':
          val = card.word || '';
          break;
        case 'lemma':
          val = card.lemma || card.word || '';
          break;
        case 'reading':
          val = card.reading || '';
          break;
        case 'furiganaHtml':
          val = options.allowHtml ? htmlWord : stripHtmlForSortField(htmlWord);
          break;
        case 'furiganaAnki':
          val = ankiWord;
          break;
        case 'meaning':
          val = card.meaning || '';
          break;
        case 'partOfSpeech':
          val = card.partOfSpeech || '';
          break;
        case 'level':
          val = card.level || '';
          break;
        case 'frequency':
          val = card.frequencyBand || '';
          break;
        case 'sentence':
          val = (card.sentence || '').trim();
          break;
        case 'sentenceFuriganaHtml':
          val = options.allowHtml ? sentenceHtml : stripHtmlForSortField(sentenceHtml);
          break;
        case 'sentenceMeaning':
          val = '';
          break;
        case 'source':
          val = card.sourceDocTitle || '';
          break;
        case 'notes':
          val = card.notes || '';
          break;
        case 'deck':
          val = deckNameMap.get(card.deckId) || 'Default';
          break;
        case 'cardType':
          val = card.cardType;
          break;
        case 'tags':
          val = tags;
          break;
      }
      return escapeCsvCell(val, options.delimiter);
    });

    lines.push(row.join(options.delimiter));
  }

  const body = lines.join('\n');
  const text = options.includeBom ? `\uFEFF${body}` : body;
  const bytes = new TextEncoder().encode(text);

  return { text, bytes, rowCount: cards.length };
}

export function formatExportFilename(
  languageId: string,
  extension: 'apkg' | 'csv' | 'tsv',
  date = new Date()
): string {
  const safeLang = (languageId || 'vocab').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `linguaforge-${safeLang}-${yyyy}-${mm}-${dd}.${extension}`;
}
