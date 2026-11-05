import React from 'react';
import type { FuriganaSegment } from '../core/languagePack';
import { buildFurigana } from '../packs/japanese/kanaUtils';

export interface FuriganaTextProps {
  segments?: FuriganaSegment[];
  text?: string;
  reading?: string;
  furiganaMode?: 'always' | 'hover' | 'never';
  className?: string;
  rtClassName?: string;
}

/**
 * Renders Japanese text with native <ruby>base<rt>reading</rt></ruby> elements:
 * 1. No inline-flex or inline-grid stacked wrappers; uses native browser ruby layout
 *    so all kanji stay on the exact same baseline as surrounding kana and punctuation.
 * 2. Letter-spacing is forced to 0 on <ruby> and <rt> so inherited spacing never spreads kana apart.
 * 3. Only the kanji run is placed inside <ruby>. Prefix kana and okurigana stay outside as plain text.
 * 4. A reading wider than its kanji may naturally overhang neighbouring kana.
 */
export const FuriganaText: React.FC<FuriganaTextProps> = ({
  segments: propSegments,
  text = '',
  reading,
  furiganaMode = 'always',
  className = '',
  rtClassName = '',
}) => {
  const segments: FuriganaSegment[] =
    propSegments && propSegments.length > 0
      ? propSegments
      : text && reading
      ? buildFurigana(text, reading) || [{ text }]
      : [{ text: text || '' }];

  if (furiganaMode === 'never') {
    return <span className={className}>{text || segments.map((s) => s.text).join('')}</span>;
  }

  const rtVisibilityClass =
    furiganaMode === 'hover'
      ? 'opacity-0 group-hover:opacity-100 group-hover/token:opacity-100 transition-opacity'
      : 'opacity-100';

  return (
    <span className={className}>
      {segments.map((seg, idx) => {
        if (!seg.ruby) {
          // Prefix kana, okurigana, or particles stay outside <ruby> as plain text
          return <React.Fragment key={idx}>{seg.text}</React.Fragment>;
        }

        // Native <ruby> around kanji run only
        return (
          <ruby key={idx} style={{ letterSpacing: 0 }}>
            {seg.text}
            <rt
              className={`${rtVisibilityClass} ${rtClassName}`}
              style={{ letterSpacing: 0 }}
            >
              {seg.ruby}
            </rt>
          </ruby>
        );
      })}
    </span>
  );
};
