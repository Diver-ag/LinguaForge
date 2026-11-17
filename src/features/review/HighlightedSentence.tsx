import React from 'react';
import type { FuriganaSegment } from '../../core/languagePack';

interface HighlightedSentenceProps {
  sentence: string;
  segments?: FuriganaSegment[];
  targetWord: string;
  targetLemma?: string;
  highlightRange?: { start: number; end: number };
  furiganaMode?: 'always' | 'hover' | 'never';
  className?: string;
}

/**
 * Renders an example sentence with optional furigana and highlights occurrences
 * of the target word (or an exact character range) cleanly without breaking ruby alignment.
 */
export const HighlightedSentence: React.FC<HighlightedSentenceProps> = ({
  sentence,
  segments,
  targetWord,
  targetLemma,
  highlightRange,
  furiganaMode = 'always',
  className = '',
}) => {
  if (!sentence) return null;

  const candidates = Array.from(
    new Set([targetWord, targetLemma].map((s) => (s || '').trim()).filter(Boolean))
  ).sort((a, b) => b.length - a.length);

  if (segments && segments.length > 0 && furiganaMode !== 'never') {
    const fullText = segments.map((s) => s.text).join('');
    const highlightedMask = new Array<boolean>(fullText.length).fill(false);

    if (
      highlightRange &&
      highlightRange.start >= 0 &&
      highlightRange.end > highlightRange.start &&
      highlightRange.end <= fullText.length &&
      fullText === sentence
    ) {
      for (let k = highlightRange.start; k < highlightRange.end; k++) {
        highlightedMask[k] = true;
      }
    } else {
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

  // Plain text with explicit exact highlightRange
  if (
    highlightRange &&
    highlightRange.start >= 0 &&
    highlightRange.end > highlightRange.start &&
    highlightRange.end <= sentence.length
  ) {
    return (
      <span className={className}>
        {sentence.slice(0, highlightRange.start)}
        <mark className="rounded px-1 bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 font-semibold">
          {sentence.slice(highlightRange.start, highlightRange.end)}
        </mark>
        {sentence.slice(highlightRange.end)}
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

interface ClozeSentenceViewProps {
  sentence: string;
  start: number;
  end: number;
  mode: 'front' | 'back';
  segments?: FuriganaSegment[];
  furiganaMode?: 'always' | 'hover' | 'never';
  className?: string;
}

/**
 * Renders a Cloze card sentence:
 * - `front`: replaces `[start, end)` with `[ … ]` (omitting furigana on blanked characters)
 *            while respecting `furiganaMode` on the rest of the sentence.
 * - `back`:  renders the full sentence with `[start, end)` highlighted and furigana intact.
 */
export const ClozeSentenceView: React.FC<ClozeSentenceViewProps> = ({
  sentence,
  start,
  end,
  mode,
  segments,
  furiganaMode = 'always',
  className = '',
}) => {
  if (!sentence) return null;

  const hasValidRange =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= sentence.length;

  if (!hasValidRange) {
    return <span className={className}>{sentence}</span>;
  }

  if (mode === 'back') {
    return (
      <HighlightedSentence
        sentence={sentence}
        segments={segments}
        targetWord={sentence.slice(start, end)}
        highlightRange={{ start, end }}
        furiganaMode={furiganaMode}
        className={className}
      />
    );
  }

  // Front face: blank out [start, end) while preserving furigana on non-blanked segments
  const blankNode = (
    <span
      className="inline-flex items-center justify-center mx-1 px-2.5 py-0.5 rounded-lg border-b-2 border-indigo-500 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 font-bold tracking-wider"
      aria-label="Blank"
    >
      [ … ]
    </span>
  );

  const segmentsMatchSentence =
    Boolean(segments && segments.length > 0) &&
    segments!.map((s) => s.text).join('') === sentence &&
    furiganaMode !== 'never';

  if (!segmentsMatchSentence) {
    return (
      <span className={className}>
        {sentence.slice(0, start)}
        {blankNode}
        {sentence.slice(end)}
      </span>
    );
  }

  const rtVisibilityClass =
    furiganaMode === 'hover'
      ? 'opacity-0 group-hover:opacity-100 transition-opacity'
      : 'opacity-100';

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let blankEmitted = false;

  segments!.forEach((seg, idx) => {
    const segStart = cursor;
    const segEnd = segStart + seg.text.length;
    cursor = segEnd;

    // Completely outside [start, end)
    if (segEnd <= start || segStart >= end) {
      if (seg.ruby) {
        nodes.push(
          <ruby key={`seg-${idx}`} style={{ letterSpacing: 0 }}>
            {seg.text}
            <rt
              className={`${rtVisibilityClass} text-[0.6em] text-[var(--text-muted)]`}
              style={{ letterSpacing: 0 }}
            >
              {seg.ruby}
            </rt>
          </ruby>
        );
      } else {
        nodes.push(<React.Fragment key={`seg-${idx}`}>{seg.text}</React.Fragment>);
      }
      return;
    }

    // Before the blank inside a partially overlapping segment
    if (segStart < start) {
      const beforeText = seg.text.slice(0, start - segStart);
      if (beforeText) {
        nodes.push(<React.Fragment key={`before-${idx}`}>{beforeText}</React.Fragment>);
      }
    }

    if (!blankEmitted) {
      nodes.push(<React.Fragment key="cloze-blank">{blankNode}</React.Fragment>);
      blankEmitted = true;
    }

    // After the blank inside a partially overlapping segment
    if (segEnd > end) {
      const afterText = seg.text.slice(end - segStart);
      if (afterText) {
        nodes.push(<React.Fragment key={`after-${idx}`}>{afterText}</React.Fragment>);
      }
    }
  });

  return <span className={`group ${className}`}>{nodes}</span>;
};
