import type { FuriganaSegment } from '../../core/languagePack';

/**
 * Converts Katakana characters in a string to Hiragana.
 * Pure utility function with no external or browser dependencies.
 */
export function katakanaToHiragana(str: string): string {
  if (!str) return '';
  return str.replace(/[\u30a1-\u30f6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

/**
 * Builds furigana segments for ruby rendering over Kanji in a word or phrase.
 * Pure utility function with no external or browser dependencies.
 */
export function buildFurigana(
  surface: string,
  reading?: string,
  _baseForm?: string
): FuriganaSegment[] | undefined {
  if (!reading || surface === reading) return undefined;
  if (!/[\u4e00-\u9faf\u3400-\u4dbf]/.test(surface)) return undefined;

  // Word consists purely of Kanji
  if (/^[\u4e00-\u9faf\u3400-\u4dbf]+$/.test(surface)) {
    return [{ text: surface, ruby: reading }];
  }

  // Kanji stem + okurigana ending (e.g. 食べる reading たべる -> 食(た) + べる)
  let tailLen = 0;
  while (
    tailLen < surface.length &&
    tailLen < reading.length &&
    surface[surface.length - 1 - tailLen] === reading[reading.length - 1 - tailLen]
  ) {
    tailLen++;
  }

  if (tailLen > 0) {
    const kanjiPart = surface.slice(0, surface.length - tailLen);
    const okurigana = surface.slice(surface.length - tailLen);
    const rubyPart = reading.slice(0, reading.length - tailLen);
    return [
      { text: kanjiPart, ruby: rubyPart },
      { text: okurigana },
    ];
  }

  return [{ text: surface, ruby: reading }];
}
