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
 * Correctly aligns multi-kanji compounds, okurigana (e.g. 見[み]られます, 食[た]べる),
 * and interleaved kanji-kana patterns (e.g. 咲[さ]き誇[ほこ]り, お花見[はなみ]).
 */
export function buildFurigana(
  surface: string,
  reading?: string,
  _baseForm?: string
): FuriganaSegment[] | undefined {
  if (!surface) return undefined;
  if (!/[\u4e00-\u9faf\u3400-\u4dbf々〆〇]/.test(surface)) return undefined;

  // Normalize reading to hiragana if katakana is passed
  const hiraganaReading = reading ? katakanaToHiragana(reading) : '';
  if (!hiraganaReading || surface === hiraganaReading) return undefined;

  // Word consists purely of Kanji (e.g. 日本, 春, 桜, 公園, 人々, 紅葉)
  if (/^[\u4e00-\u9faf\u3400-\u4dbf々〆〇]+$/.test(surface)) {
    return [{ text: surface, ruby: hiraganaReading }];
  }

  // Interleaved kanji and kana alignment
  const chunks: { isKanji: boolean; text: string }[] = [];
  const regex = /([\u4e00-\u9faf\u3400-\u4dbf々〆〇]+)|([^\u4e00-\u9faf\u3400-\u4dbf々〆〇]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(surface)) !== null) {
    if (match[1]) chunks.push({ isKanji: true, text: match[1] });
    else if (match[2]) chunks.push({ isKanji: false, text: match[2] });
  }

  let rIndex = 0;
  const result: FuriganaSegment[] = [];
  let valid = true;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk.isKanji) {
      // Must match chunk.text in reading at rIndex
      if (hiraganaReading.startsWith(chunk.text, rIndex)) {
        result.push({ text: chunk.text });
        rIndex += chunk.text.length;
      } else {
        valid = false;
        break;
      }
    } else {
      // Look ahead for next kana anchor to determine where kanji reading ends
      const nextKana = chunks[i + 1];
      if (nextKana && !nextKana.isKanji) {
        const nextKanaPos = hiraganaReading.indexOf(nextKana.text, rIndex + 1);
        if (nextKanaPos !== -1) {
          const kanjiRuby = hiraganaReading.slice(rIndex, nextKanaPos);
          result.push({ text: chunk.text, ruby: kanjiRuby });
          rIndex = nextKanaPos;
        } else {
          valid = false;
          break;
        }
      } else {
        // Last chunk or followed by another kanji chunk
        const kanjiRuby = hiraganaReading.slice(rIndex);
        result.push({ text: chunk.text, ruby: kanjiRuby });
        rIndex = hiraganaReading.length;
      }
    }
  }

  if (valid && rIndex === hiraganaReading.length) {
    return result;
  }

  // Fallback: strip matching okurigana ending and prefix
  let tailLen = 0;
  while (
    tailLen < surface.length &&
    tailLen < hiraganaReading.length &&
    surface[surface.length - 1 - tailLen] === hiraganaReading[hiraganaReading.length - 1 - tailLen]
  ) {
    tailLen++;
  }

  let headLen = 0;
  while (
    headLen < surface.length - tailLen &&
    headLen < hiraganaReading.length - tailLen &&
    surface[headLen] === hiraganaReading[headLen]
  ) {
    headLen++;
  }

  const kanjiPart = surface.slice(headLen, surface.length - tailLen);
  const rubyPart = hiraganaReading.slice(headLen, hiraganaReading.length - tailLen);
  const fallbackSegments: FuriganaSegment[] = [];
  if (headLen > 0) fallbackSegments.push({ text: surface.slice(0, headLen) });
  fallbackSegments.push({ text: kanjiPart, ruby: rubyPart });
  if (tailLen > 0) fallbackSegments.push({ text: surface.slice(surface.length - tailLen) });

  return fallbackSegments;
}
