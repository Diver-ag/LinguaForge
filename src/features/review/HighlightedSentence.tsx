import React from 'react';
import type { FuriganaSegment } from '../../core/languagePack';

interface HighlightedSentenceProps {
  sentence: string;
  segments?: FuriganaSegment[];
  targetWord: string;
  targetLemma?: string;
  furiganaMode?: 'always' | 'hover' | 'never';
  className?: string;
}

/**
 * Renders an example sentence with optional furigana and highlights occurrences
 * of the target word (or lemma) cleanly without breaking ruby alignment.
 */
export const HighlightedSentence: React.FC<HighlightedSentenceProps> = ({
  sentence,
  segments,
  targetWord,
  targetLemma,
  furiganaMode = 'always',
  className = '',
}) => {
  if (!sentence) return null;

  const candidates = Array.from(
    new Set([targetWord, targetLemma].map((s) => (s || '').trim()).filter(Boolean))
  ).sort((a, b) => b.length - a.length);

  if (segments && segments.length > 0 && furiganaMode !== 'never') {
    // Build a flat character offset map so we know which character indices fall inside a match
    const fullText = segments.map((s) => s.text).join('');
    const highlightedMask = new Array<boolean>(fullText.length).fill(false);

    for (const term of candidates) {
      let startIdx = 0;
      const lowerFull = fullText.toLowerCase();
      const lowerTerm = term.toLowerCase();
      while (startIdx < lowerFull.length) {
        const idx = lowerFull.indexOf(lowerTerm, startIdx);
        if (idx === -1) break;
        for (let k = idx; k < idx + term.length; k++) {
          highlightedMask[k] = true;
        }
        startIdx = idx + Math.max(1, term.length);
      }
    }

    const rtVisibilityClass =
      furiganaMode === 'hover'
        ? 'opacity-0 group-hover:opacity-100 transition-opacity'
        : 'opacity-100';

    let cursor = 0;
    return (
      <span className={`group ${className}`}>
        {segments.map((seg, idx) => {
          const segStart = cursor;
          const segEnd = segStart + seg.text.length;
          cursor = segEnd;

          let anyHighlighted = false;
          for (let k = segStart; k < segEnd; k++) {
            if (highlightedMask[k]) {
              anyHighlighted = true;
              break;
            }
          }

          if (seg.ruby) {
            return (
              <ruby
                key={idx}
                style={{ letterSpacing: 0 }}
                className={
                  anyHighlighted
                    ? 'rounded px-0.5 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 font-semibold'
                    : ''
                }
              >
                {seg.text}
                <rt
                  className={`${rtVisibilityClass} text-[0.6em] text-[var(--text-muted)]`}
                  style={{ letterSpacing: 0 }}
                >
                  {seg.ruby}
                </rt>
              </ruby>
            );
          }

          // Split plain segment at highlight boundaries for exact span highlighting
          const parts: { text: string; hl: boolean }[] = [];
          for (let i = 0; i < seg.text.length; i++) {
            const hl = highlightedMask[segStart + i];
            if (parts.length === 0 || parts[parts.length - 1].hl !== hl) {
              parts.push({ text: seg.text[i], hl });
            } else {
              parts[parts.length - 1].text += seg.text[i];
            }
          }

          return (
            <React.Fragment key={idx}>
              {parts.map((p, pIdx) =>
                p.hl ? (
                  <mark
                    key={pIdx}
                    className="rounded px-0.5 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 font-semibold"
                  >
                    {p.text}
                  </mark>
                ) : (
                  <React.Fragment key={pIdx}>{p.text}</React.Fragment>
                )
              )}
            </React.Fragment>
          );
        })}
      </span>
    );
  }

  // Plain text fallback (or furiganaMode === 'never')
  if (candidates.length === 0) {
    return <span className={className}>{sentence}</span>;
  }

  const escaped = candidates.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const pieces = sentence.split(regex);

  return (
    <span className={className}>
      {pieces.map((piece, idx) => {
        const isMatch = candidates.some(
          (c) => c.toLowerCase() === piece.toLowerCase()
        );
        return isMatch ? (
          <mark
            key={idx}
            className="rounded px-0.5 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 font-semibold"
          >
            {piece}
          </mark>
        ) : (
          <React.Fragment key={idx}>{piece}</React.Fragment>
        );
      })}
    </span>
  );
};
