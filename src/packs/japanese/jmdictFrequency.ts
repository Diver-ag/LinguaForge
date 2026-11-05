/**
 * Derives frequency rank, descriptive band, and badge text from JMdict priority tags.
 * Common priority tags in JMdict:
 * - nf01-nf48: Frequency ranking in 500-word bands (nf01 = Top 500 words, nf12 = Top 6,000, nfXX = XX * 500)
 * - news1 / news2: Mainichi Shimbun frequency corpus
 * - ichi1 / ichi2: Ichimango Japanese vocabulary corpus
 * - spec1 / spec2: Common loanwords and specific corpus
 * - gai1 / gai2: Loanwords (katakana) corpus
 */

export function deriveBandFromRank(rank: number): string {
  if (rank <= 500) return 'Top 500';
  const block = Math.ceil(rank / 500) * 500;
  return `Top ${block.toLocaleString()}`;
}

export function deriveFrequencyInfo(tags: string[] = [], customRank?: number): {
  priorityScore: number;
  frequencyBand: string;
  frequencyRank?: number;
  priorityBadge: string;
} {
  let score = 0;
  let minNfNum: number | undefined = undefined;

  const validCorpusTags = ['news1', 'news2', 'ichi1', 'ichi2', 'spec1', 'spec2', 'gai1', 'gai2'];
  const relevantTags: string[] = [];

  for (const t of tags) {
    if (t.startsWith('nf')) {
      const num = parseInt(t.slice(2), 10);
      if (!isNaN(num) && num >= 1 && num <= 48) {
        if (minNfNum === undefined || num < minNfNum) {
          minNfNum = num;
        }
        score += Math.max(0, 10000 - num * 180);
        if (!relevantTags.includes(t)) relevantTags.push(t);
      }
    } else if (t === 'news1') {
      score += 4000;
      if (!relevantTags.includes(t)) relevantTags.push(t);
    } else if (t === 'ichi1') {
      score += 3500;
      if (!relevantTags.includes(t)) relevantTags.push(t);
    } else if (t === 'spec1') {
      score += 3000;
      if (!relevantTags.includes(t)) relevantTags.push(t);
    } else if (t === 'gai1') {
      score += 2500;
      if (!relevantTags.includes(t)) relevantTags.push(t);
    } else if (t === 'news2' || t === 'ichi2') {
      score += 1500;
      if (!relevantTags.includes(t)) relevantTags.push(t);
    } else if (t === 'spec2' || t === 'gai2') {
      score += 1000;
      if (!relevantTags.includes(t)) relevantTags.push(t);
    }
  }

  let band = 'Uncommon';
  let rank: number | undefined = customRank;

  if (customRank && customRank > 0) {
    band = deriveBandFromRank(customRank);
    score += Math.max(0, 12000 - customRank);
  } else if (minNfNum !== undefined) {
    rank = minNfNum * 500;
    band = `Top ${(minNfNum * 500).toLocaleString()}`;
  } else if (tags.includes('news1') || tags.includes('ichi1')) {
    band = 'Core Vocab';
    score += 2000;
  } else if (tags.includes('news2') || tags.includes('ichi2') || score > 0) {
    band = 'Common';
  } else {
    band = 'Uncommon';
  }

  const priorityBadge = relevantTags.length > 0
    ? `Common (${relevantTags.join(', ')})`
    : 'Uncommon';

  return {
    priorityScore: score,
    frequencyBand: band,
    frequencyRank: rank,
    priorityBadge,
  };
}

