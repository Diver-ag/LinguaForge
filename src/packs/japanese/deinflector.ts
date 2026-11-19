import type { GrammarStep } from '../../core/languagePack';

export type JapaneseWordClass = 'v1' | 'v5' | 'vk' | 'vs' | 'adj-i' | 'any';

export interface DeinflectionCandidate {
  lemma: string;
  reasons: string[];
  steps: GrammarStep[];
  grammarMeaning: string;
  wordClass: JapaneseWordClass;
}

interface DeinflectRule {
  kanaIn: string;
  kanaOut: string;
  /** Resulting class required for the output stem/word when peeling kanaIn */
  rulesIn: JapaneseWordClass[];
  /** Word class of the inflected input that accepts kanaIn */
  rulesOut: JapaneseWordClass[];
  reason: string;
  /** Concise plain-English explanation when this rule is the sole/primary step */
  grammarMeaning: string;
  /** Short tag used when multiple rules are chained together (e.g. causative + passive + past) */
  chainTag?: string;
  /** True when the preceding rule ending in て/で already absorbed the te-form bridge */
  isTeBridge?: boolean;
}

// Each rule transforms an inflected word ending in `kanaIn` back to `kanaOut`.
// `rulesIn` is the class of the produced stem; `rulesOut` is the class of the input form.
const DEINFLECT_RULES: DeinflectRule[] = [
  // --- Polite (-ます family) ---
  {
    kanaIn: 'ませんでした',
    kanaOut: 'る',
    rulesIn: ['v1'],
    rulesOut: ['v1'],
    reason: 'polite past negative',
    grammarMeaning: 'polite past negative',
    chainTag: 'polite past negative',
  },
  {
    kanaIn: 'ませんでした',
    kanaOut: 'ます',
    rulesIn: ['any'],
    rulesOut: ['any'],
    reason: 'polite past negative',
    grammarMeaning: 'polite past negative',
    chainTag: 'polite past negative',
  },
  {
    kanaIn: 'ましょう',
    kanaOut: 'る',
    rulesIn: ['v1'],
    rulesOut: ['v1'],
    reason: 'polite volitional',
    grammarMeaning: "polite volitional (let's ~)",
    chainTag: 'polite volitional',
  },
  {
    kanaIn: 'ましょう',
    kanaOut: 'ます',
    rulesIn: ['any'],
    rulesOut: ['any'],
    reason: 'polite volitional',
    grammarMeaning: "polite volitional (let's ~)",
    chainTag: 'polite volitional',
  },
  {
    kanaIn: 'ました',
    kanaOut: 'る',
    rulesIn: ['v1'],
    rulesOut: ['v1'],
    reason: 'polite past',
    grammarMeaning: 'polite past',
    chainTag: 'polite past',
  },
  {
    kanaIn: 'ました',
    kanaOut: 'ます',
    rulesIn: ['any'],
    rulesOut: ['any'],
    reason: 'polite past',
    grammarMeaning: 'polite past',
    chainTag: 'polite past',
  },
  {
    kanaIn: 'ません',
    kanaOut: 'る',
    rulesIn: ['v1'],
    rulesOut: ['v1'],
    reason: 'polite negative',
    grammarMeaning: 'polite negative',
    chainTag: 'polite negative',
  },
  {
    kanaIn: 'ません',
    kanaOut: 'ます',
    rulesIn: ['any'],
    rulesOut: ['any'],
    reason: 'polite negative',
    grammarMeaning: 'polite negative',
    chainTag: 'polite negative',
  },
  {
    kanaIn: 'まして',
    kanaOut: 'る',
    rulesIn: ['v1'],
    rulesOut: ['v1'],
    reason: 'polite te-form',
    grammarMeaning: 'polite te-form (and / linking)',
    chainTag: 'polite te-form',
  },
  {
    kanaIn: 'まして',
    kanaOut: 'ます',
    rulesIn: ['any'],
    rulesOut: ['any'],
    reason: 'polite te-form',
    grammarMeaning: 'polite te-form (and / linking)',
    chainTag: 'polite te-form',
  },
  { kanaIn: 'ます', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['v1'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },
  { kanaIn: 'います', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['v5'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },
  { kanaIn: 'きます', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['v5'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },
  { kanaIn: 'ぎます', kanaOut: 'ぐ', rulesIn: ['v5'], rulesOut: ['v5'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },
  { kanaIn: 'します', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['v5'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },
  { kanaIn: 'します', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['vs'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },
  { kanaIn: 'ちます', kanaOut: 'つ', rulesIn: ['v5'], rulesOut: ['v5'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },
  { kanaIn: 'にます', kanaOut: 'ぬ', rulesIn: ['v5'], rulesOut: ['v5'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },
  { kanaIn: 'びます', kanaOut: 'ぶ', rulesIn: ['v5'], rulesOut: ['v5'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },
  { kanaIn: 'みます', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['v5'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },
  { kanaIn: 'ります', kanaOut: 'る', rulesIn: ['v5'], rulesOut: ['v5'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },
  { kanaIn: 'きます', kanaOut: 'くる', rulesIn: ['vk'], rulesOut: ['vk'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },
  { kanaIn: '来ます', kanaOut: '来る', rulesIn: ['vk'], rulesOut: ['vk'], reason: 'polite', grammarMeaning: 'polite form', chainTag: 'polite' },

  // --- Progressive / Resultative / Subsidiary (-ている / -ておく / -てしまう / -てみる / -てある) ---
  { kanaIn: 'ています', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1', 'v5', 'vs', 'vk'], reason: 'progressive polite', grammarMeaning: 'is doing / ongoing state (polite)', chainTag: 'progressive polite' },
  { kanaIn: 'てます', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1', 'v5', 'vs', 'vk'], reason: 'progressive polite', grammarMeaning: 'is doing / ongoing state (polite)', chainTag: 'progressive polite' },
  { kanaIn: 'ていました', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1', 'v5', 'vs', 'vk'], reason: 'past progressive polite', grammarMeaning: 'was doing / past ongoing state (polite)', chainTag: 'past progressive polite' },
  { kanaIn: 'てました', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1', 'v5', 'vs', 'vk'], reason: 'past progressive polite', grammarMeaning: 'was doing / past ongoing state (polite)', chainTag: 'past progressive polite' },
  { kanaIn: 'ていません', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1', 'v5', 'vs', 'vk'], reason: 'negative progressive polite', grammarMeaning: 'is not doing (polite negative progressive)', chainTag: 'negative progressive polite' },
  { kanaIn: 'てませんでした', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1', 'v5', 'vs', 'vk'], reason: 'past negative progressive polite', grammarMeaning: 'was not doing (polite past negative progressive)', chainTag: 'past negative progressive polite' },
  { kanaIn: 'ている', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1'], reason: 'progressive', grammarMeaning: 'is doing / ongoing state', chainTag: 'progressive' },
  { kanaIn: 'てる', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1'], reason: 'progressive', grammarMeaning: 'is doing / ongoing state', chainTag: 'progressive' },
  { kanaIn: 'ていた', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1', 'v5', 'vs', 'vk'], reason: 'past progressive', grammarMeaning: 'was doing / past ongoing state', chainTag: 'past progressive' },
  { kanaIn: 'てた', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1', 'v5', 'vs', 'vk'], reason: 'past progressive', grammarMeaning: 'was doing / past ongoing state', chainTag: 'past progressive' },
  { kanaIn: 'ていない', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['adj-i'], reason: 'negative progressive', grammarMeaning: 'is not doing (negative progressive)', chainTag: 'negative progressive' },
  { kanaIn: 'てない', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['adj-i'], reason: 'negative progressive', grammarMeaning: 'is not doing (negative progressive)', chainTag: 'negative progressive' },
  { kanaIn: 'ていなかった', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['adj-i'], reason: 'past negative progressive', grammarMeaning: 'was not doing (past negative progressive)', chainTag: 'past negative progressive' },
  { kanaIn: 'てある', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'resultative', grammarMeaning: 'has been done (resulting state)', chainTag: 'resultative' },
  { kanaIn: 'てあります', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'resultative polite', grammarMeaning: 'has been done (resulting state, polite)', chainTag: 'resultative polite' },
  { kanaIn: 'てあった', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'past resultative', grammarMeaning: 'had been done (past resulting state)', chainTag: 'past resultative' },
  { kanaIn: 'ておく', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'preparatory', grammarMeaning: 'do ~ in advance', chainTag: 'do in advance' },
  { kanaIn: 'ておきます', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'preparatory polite', grammarMeaning: 'do ~ in advance (polite)', chainTag: 'do in advance (polite)' },
  { kanaIn: 'ておいた', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'past preparatory', grammarMeaning: 'did ~ in advance (past)', chainTag: 'did in advance' },
  { kanaIn: 'とく', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'preparatory', grammarMeaning: 'do ~ in advance', chainTag: 'do in advance' },
  { kanaIn: 'てしまう', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'completive', grammarMeaning: 'end up doing / completely', chainTag: 'completive' },
  { kanaIn: 'てしまいます', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'completive polite', grammarMeaning: 'end up doing / completely (polite)', chainTag: 'completive polite' },
  { kanaIn: 'てしまった', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'past completive', grammarMeaning: 'ended up doing / completely (past)', chainTag: 'past completive' },
  { kanaIn: 'ちゃう', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'completive', grammarMeaning: 'end up doing / completely', chainTag: 'completive' },
  { kanaIn: 'ちゃった', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'past completive', grammarMeaning: 'ended up doing / completely (past)', chainTag: 'past completive' },
  { kanaIn: 'てみる', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1'], reason: 'attemptive', grammarMeaning: 'try doing ~', chainTag: 'try doing' },
  { kanaIn: 'てみます', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1'], reason: 'attemptive polite', grammarMeaning: 'try doing ~ (polite)', chainTag: 'try doing (polite)' },
  { kanaIn: 'てみた', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v1'], reason: 'past attemptive', grammarMeaning: 'tried doing ~ (past)', chainTag: 'tried doing' },
  { kanaIn: 'てくる', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['vk'], reason: 'directional', grammarMeaning: 'come to / begin to ~', chainTag: 'directional' },
  { kanaIn: 'てきた', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['vk'], reason: 'past directional', grammarMeaning: 'came to / have been doing ~', chainTag: 'past directional' },
  { kanaIn: 'ていく', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'directional', grammarMeaning: 'go on doing ~', chainTag: 'directional' },
  { kanaIn: 'ていった', kanaOut: 'て', rulesIn: ['any'], rulesOut: ['v5'], reason: 'past directional', grammarMeaning: 'went on doing ~', chainTag: 'past directional' },

  // Voiced -で variants (泳いでいます, 読んでいた, etc.)
  { kanaIn: 'でいます', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['v1', 'v5'], reason: 'progressive polite', grammarMeaning: 'is doing / ongoing state (polite)', chainTag: 'progressive polite' },
  { kanaIn: 'でます', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['v1', 'v5'], reason: 'progressive polite', grammarMeaning: 'is doing / ongoing state (polite)', chainTag: 'progressive polite' },
  { kanaIn: 'でいました', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['v1', 'v5'], reason: 'past progressive polite', grammarMeaning: 'was doing / past ongoing state (polite)', chainTag: 'past progressive polite' },
  { kanaIn: 'でいません', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['v1', 'v5'], reason: 'negative progressive polite', grammarMeaning: 'is not doing (polite negative progressive)', chainTag: 'negative progressive polite' },
  { kanaIn: 'でいる', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['v1'], reason: 'progressive', grammarMeaning: 'is doing / ongoing state', chainTag: 'progressive' },
  { kanaIn: 'でる', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['v1'], reason: 'progressive', grammarMeaning: 'is doing / ongoing state', chainTag: 'progressive' },
  { kanaIn: 'でいた', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['v1', 'v5'], reason: 'past progressive', grammarMeaning: 'was doing / past ongoing state', chainTag: 'past progressive' },
  { kanaIn: 'でいない', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['adj-i'], reason: 'negative progressive', grammarMeaning: 'is not doing (negative progressive)', chainTag: 'negative progressive' },
  { kanaIn: 'でおく', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['v5'], reason: 'preparatory', grammarMeaning: 'do ~ in advance', chainTag: 'do in advance' },
  { kanaIn: 'でしまう', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['v5'], reason: 'completive', grammarMeaning: 'end up doing / completely', chainTag: 'completive' },
  { kanaIn: 'でしまった', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['v5'], reason: 'past completive', grammarMeaning: 'ended up doing / completely (past)', chainTag: 'past completive' },
  { kanaIn: 'じゃう', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['v5'], reason: 'completive', grammarMeaning: 'end up doing / completely', chainTag: 'completive' },
  { kanaIn: 'じゃった', kanaOut: 'で', rulesIn: ['any'], rulesOut: ['v5'], reason: 'past completive', grammarMeaning: 'ended up doing / completely (past)', chainTag: 'past completive' },

  // --- Chained auxiliary peelers on -いる/-ない ---
  { kanaIn: 'いる', kanaOut: 'い', rulesIn: ['any'], rulesOut: ['v1'], reason: 'progressive', grammarMeaning: 'is doing / ongoing state', chainTag: 'progressive' },
  { kanaIn: 'ない', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: 'なかった', kanaOut: 'ない', rulesIn: ['adj-i'], rulesOut: ['adj-i'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'なくて', kanaOut: 'ない', rulesIn: ['adj-i'], rulesOut: ['adj-i'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form' },
  { kanaIn: 'ないで', kanaOut: 'ない', rulesIn: ['adj-i'], rulesOut: ['any'], reason: 'negative conjunctive', grammarMeaning: 'without doing ~ (negative)', chainTag: 'without doing' },

  // --- Plain Negative (-ない / -ず / -ぬ) ---
  { kanaIn: 'わない', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: 'かない', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: 'がない', kanaOut: 'ぐ', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: 'さない', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: 'たない', kanaOut: 'つ', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: 'なない', kanaOut: 'ぬ', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: 'ばない', kanaOut: 'ぶ', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: 'まない', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: 'らない', kanaOut: 'る', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: 'しない', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: 'こない', kanaOut: 'くる', rulesIn: ['vk'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: '来ない', kanaOut: '来る', rulesIn: ['vk'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative', chainTag: 'negative' },
  { kanaIn: 'ず', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['any'], reason: 'negative (without ~)', grammarMeaning: 'without doing ~ (negative)', chainTag: 'without doing' },
  { kanaIn: 'せず', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['any'], reason: 'negative (without ~)', grammarMeaning: 'without doing ~ (negative)', chainTag: 'without doing' },

  // --- I-Adjective inflections ---
  { kanaIn: 'くなかった', kanaOut: 'い', rulesIn: ['adj-i'], rulesOut: ['adj-i'], reason: 'past negative', grammarMeaning: 'past negative adjective', chainTag: 'past negative' },
  { kanaIn: 'くない', kanaOut: 'い', rulesIn: ['adj-i'], rulesOut: ['adj-i'], reason: 'negative', grammarMeaning: 'negative adjective', chainTag: 'negative' },
  { kanaIn: 'かった', kanaOut: 'い', rulesIn: ['adj-i'], rulesOut: ['adj-i'], reason: 'past', grammarMeaning: 'past adjective', chainTag: 'past' },
  { kanaIn: 'くて', kanaOut: 'い', rulesIn: ['adj-i'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'adjective te-form (and / linking)', chainTag: 'te-form' },
  { kanaIn: 'ければ', kanaOut: 'い', rulesIn: ['adj-i'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'conditional' },
  { kanaIn: 'く', kanaOut: 'い', rulesIn: ['adj-i'], rulesOut: [], reason: 'adverbial', grammarMeaning: 'adverbial (-ly)', chainTag: 'adverbial' },
  { kanaIn: 'すぎる', kanaOut: 'い', rulesIn: ['adj-i'], rulesOut: ['v1'], reason: 'excessive', grammarMeaning: 'too much ~', chainTag: 'too much' },
  { kanaIn: 'すぎます', kanaOut: 'い', rulesIn: ['adj-i'], rulesOut: ['v1'], reason: 'excessive polite', grammarMeaning: 'too much ~ (polite)', chainTag: 'too much (polite)' },
  { kanaIn: 'すぎた', kanaOut: 'い', rulesIn: ['adj-i'], rulesOut: ['v1'], reason: 'past excessive', grammarMeaning: 'too much ~ (past)', chainTag: 'too much (past)' },
  { kanaIn: 'そう', kanaOut: 'い', rulesIn: ['adj-i'], rulesOut: ['any'], reason: 'evidential', grammarMeaning: 'looks like / seems ~', chainTag: 'looks like' },

  // --- Past (-た / -だ) & Conditional (-たら) & Representative (-たり) ---
  { kanaIn: 'った', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'った', kanaOut: 'つ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'った', kanaOut: 'る', rulesIn: ['v5'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: '行った', kanaOut: '行く', rulesIn: ['v5'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'いった', kanaOut: 'いく', rulesIn: ['v5'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'いた', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'いだ', kanaOut: 'ぐ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'した', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'した', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'んだ', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'んだ', kanaOut: 'ぶ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'んだ', kanaOut: 'ぬ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'きた', kanaOut: 'くる', rulesIn: ['vk'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: '来た', kanaOut: '来る', rulesIn: ['vk'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },
  { kanaIn: 'た', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['any'], reason: 'past', grammarMeaning: 'past tense', chainTag: 'past' },

  { kanaIn: 'ったら', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'ったら', kanaOut: 'つ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'ったら', kanaOut: 'る', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'いたら', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'いだら', kanaOut: 'ぐ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'したら', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'したら', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'んだら', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'んだら', kanaOut: 'ぶ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'きたら', kanaOut: 'くる', rulesIn: ['vk'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: '来たら', kanaOut: '来る', rulesIn: ['vk'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'たら', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'かったら', kanaOut: 'い', rulesIn: ['adj-i'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },

  { kanaIn: 'ったり', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['any'], reason: 'representative', grammarMeaning: 'doing things like ~', chainTag: 'doing things like ~' },
  { kanaIn: 'ったり', kanaOut: 'る', rulesIn: ['v5'], rulesOut: ['any'], reason: 'representative', grammarMeaning: 'doing things like ~', chainTag: 'doing things like ~' },
  { kanaIn: 'いたり', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['any'], reason: 'representative', grammarMeaning: 'doing things like ~', chainTag: 'doing things like ~' },
  { kanaIn: 'したり', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['any'], reason: 'representative', grammarMeaning: 'doing things like ~', chainTag: 'doing things like ~' },
  { kanaIn: 'したり', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['any'], reason: 'representative', grammarMeaning: 'doing things like ~', chainTag: 'doing things like ~' },
  { kanaIn: 'んだり', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['any'], reason: 'representative', grammarMeaning: 'doing things like ~', chainTag: 'doing things like ~' },
  { kanaIn: 'たり', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['any'], reason: 'representative', grammarMeaning: 'doing things like ~', chainTag: 'doing things like ~' },

  // --- Te-form (-て / -で) ---
  { kanaIn: 'って', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: 'って', kanaOut: 'つ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: 'って', kanaOut: 'る', rulesIn: ['v5'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: '行って', kanaOut: '行く', rulesIn: ['v5'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: 'いって', kanaOut: 'いく', rulesIn: ['v5'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: 'いて', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: 'いで', kanaOut: 'ぐ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: 'して', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: 'して', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: 'んで', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: 'んで', kanaOut: 'ぶ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: 'んで', kanaOut: 'ぬ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: 'きて', kanaOut: 'くる', rulesIn: ['vk'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: '来て', kanaOut: '来る', rulesIn: ['vk'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },
  { kanaIn: 'て', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['any'], reason: 'te-form', grammarMeaning: 'te-form (and / linking)', chainTag: 'te-form', isTeBridge: true },

  // --- Potential / Passive / Causative ---
  { kanaIn: 'られる', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['v1'], reason: 'passive / potential', grammarMeaning: 'passive / potential (can / be done)', chainTag: 'passive' },
  { kanaIn: 'られる', kanaOut: 'る', rulesIn: ['vk'], rulesOut: ['v1'], reason: 'passive / potential', grammarMeaning: 'passive / potential (can / be done)', chainTag: 'passive' },
  { kanaIn: 'こられる', kanaOut: 'くる', rulesIn: ['vk'], rulesOut: ['v1'], reason: 'passive / potential', grammarMeaning: 'passive / potential (can / be done)', chainTag: 'passive' },
  { kanaIn: '来られる', kanaOut: '来る', rulesIn: ['vk'], rulesOut: ['v1'], reason: 'passive / potential', grammarMeaning: 'passive / potential (can / be done)', chainTag: 'passive' },
  { kanaIn: 'させる', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },
  { kanaIn: 'させる', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },
  { kanaIn: 'こさせる', kanaOut: 'くる', rulesIn: ['vk'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },
  { kanaIn: '来させる', kanaOut: '来る', rulesIn: ['vk'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },
  { kanaIn: 'される', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['v1'], reason: 'passive', grammarMeaning: 'passive (be done)', chainTag: 'passive' },

  // Godan passive (-aれる) & causative (-aせる)
  { kanaIn: 'われる', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'passive', grammarMeaning: 'passive (be done)', chainTag: 'passive' },
  { kanaIn: 'かれる', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'passive', grammarMeaning: 'passive (be done)', chainTag: 'passive' },
  { kanaIn: 'がれる', kanaOut: 'ぐ', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'passive', grammarMeaning: 'passive (be done)', chainTag: 'passive' },
  { kanaIn: 'される', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'passive', grammarMeaning: 'passive (be done)', chainTag: 'passive' },
  { kanaIn: 'たれる', kanaOut: 'つ', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'passive', grammarMeaning: 'passive (be done)', chainTag: 'passive' },
  { kanaIn: 'なれる', kanaOut: 'ぬ', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'passive', grammarMeaning: 'passive (be done)', chainTag: 'passive' },
  { kanaIn: 'ばれる', kanaOut: 'ぶ', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'passive', grammarMeaning: 'passive (be done)', chainTag: 'passive' },
  { kanaIn: 'まれる', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'passive', grammarMeaning: 'passive (be done)', chainTag: 'passive' },
  { kanaIn: 'られる', kanaOut: 'る', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'passive', grammarMeaning: 'passive (be done)', chainTag: 'passive' },

  { kanaIn: 'わせる', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },
  { kanaIn: 'かせる', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },
  { kanaIn: 'がせる', kanaOut: 'ぐ', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },
  { kanaIn: 'させる', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },
  { kanaIn: 'たせる', kanaOut: 'つ', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },
  { kanaIn: 'なせる', kanaOut: 'ぬ', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },
  { kanaIn: 'ばせる', kanaOut: 'ぶ', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },
  { kanaIn: 'ませる', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },
  { kanaIn: 'らせる', kanaOut: 'る', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'causative', grammarMeaning: 'causative (make/let do)', chainTag: 'causative' },

  // Godan potential (-eる)
  { kanaIn: 'える', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'potential', grammarMeaning: 'potential (can do ~)', chainTag: 'potential' },
  { kanaIn: 'ける', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'potential', grammarMeaning: 'potential (can do ~)', chainTag: 'potential' },
  { kanaIn: 'げる', kanaOut: 'ぐ', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'potential', grammarMeaning: 'potential (can do ~)', chainTag: 'potential' },
  { kanaIn: 'せる', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'potential', grammarMeaning: 'potential (can do ~)', chainTag: 'potential' },
  { kanaIn: 'てる', kanaOut: 'つ', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'potential', grammarMeaning: 'potential (can do ~)', chainTag: 'potential' },
  { kanaIn: 'ねる', kanaOut: 'ぬ', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'potential', grammarMeaning: 'potential (can do ~)', chainTag: 'potential' },
  { kanaIn: 'べる', kanaOut: 'ぶ', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'potential', grammarMeaning: 'potential (can do ~)', chainTag: 'potential' },
  { kanaIn: 'める', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'potential', grammarMeaning: 'potential (can do ~)', chainTag: 'potential' },
  { kanaIn: 'れる', kanaOut: 'る', rulesIn: ['v5'], rulesOut: ['v1'], reason: 'potential', grammarMeaning: 'potential (can do ~)', chainTag: 'potential' },

  // --- Desiderative (-たい) ---
  { kanaIn: 'たい', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },
  { kanaIn: 'いたい', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },
  { kanaIn: 'きたい', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },
  { kanaIn: 'ぎたい', kanaOut: 'ぐ', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },
  { kanaIn: 'したい', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },
  { kanaIn: 'したい', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },
  { kanaIn: 'ちたい', kanaOut: 'つ', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },
  { kanaIn: 'にたい', kanaOut: 'ぬ', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },
  { kanaIn: 'びたい', kanaOut: 'ぶ', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },
  { kanaIn: 'みたい', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },
  { kanaIn: 'りたい', kanaOut: 'る', rulesIn: ['v5'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },
  { kanaIn: 'きたい', kanaOut: 'くる', rulesIn: ['vk'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },
  { kanaIn: '来たい', kanaOut: '来る', rulesIn: ['vk'], rulesOut: ['adj-i'], reason: 'desiderative', grammarMeaning: 'want to do ~', chainTag: 'want to' },

  // --- Conditional (-ば) ---
  { kanaIn: 'れば', kanaOut: 'る', rulesIn: ['v1', 'v5', 'vk'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'えば', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'けば', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'げば', kanaOut: 'ぐ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'せば', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'てば', kanaOut: 'つ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'ねば', kanaOut: 'ぬ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'べば', kanaOut: 'ぶ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'めば', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },
  { kanaIn: 'すれば', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['any'], reason: 'conditional', grammarMeaning: 'if / when ~', chainTag: 'if / when' },

  // --- Volitional (-よう / -おう) ---
  { kanaIn: 'よう', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },
  { kanaIn: 'おう', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },
  { kanaIn: 'こう', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },
  { kanaIn: 'ごう', kanaOut: 'ぐ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },
  { kanaIn: 'そう', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },
  { kanaIn: 'とう', kanaOut: 'つ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },
  { kanaIn: 'のう', kanaOut: 'ぬ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },
  { kanaIn: 'ぼう', kanaOut: 'ぶ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },
  { kanaIn: 'もう', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },
  { kanaIn: 'ろう', kanaOut: 'る', rulesIn: ['v5'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },
  { kanaIn: 'しよう', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },
  { kanaIn: 'こよう', kanaOut: 'くる', rulesIn: ['vk'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },
  { kanaIn: '来よう', kanaOut: '来る', rulesIn: ['vk'], rulesOut: ['any'], reason: 'volitional', grammarMeaning: "let's / volitional", chainTag: 'volitional' },

  // --- Simultaneous (-ながら) ---
  { kanaIn: 'ながら', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },
  { kanaIn: 'いながら', kanaOut: 'う', rulesIn: ['v5'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },
  { kanaIn: 'きながら', kanaOut: 'く', rulesIn: ['v5'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },
  { kanaIn: 'ぎながら', kanaOut: 'ぐ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },
  { kanaIn: 'しながら', kanaOut: 'す', rulesIn: ['v5'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },
  { kanaIn: 'しながら', kanaOut: 'する', rulesIn: ['vs'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },
  { kanaIn: 'ちながら', kanaOut: 'つ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },
  { kanaIn: 'にながら', kanaOut: 'ぬ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },
  { kanaIn: 'びながら', kanaOut: 'ぶ', rulesIn: ['v5'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },
  { kanaIn: 'みながら', kanaOut: 'む', rulesIn: ['v5'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },
  { kanaIn: 'りながら', kanaOut: 'る', rulesIn: ['v5'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },
  { kanaIn: 'きながら', kanaOut: 'くる', rulesIn: ['vk'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },
  { kanaIn: '来ながら', kanaOut: '来る', rulesIn: ['vk'], rulesOut: ['any'], reason: 'simultaneous', grammarMeaning: 'while doing ~ (simultaneous action)', chainTag: 'while doing ~' },

  // --- Evidential / Conjectural (-ようだ / -そうだ / -らしい) ---
  { kanaIn: 'ようだ', kanaOut: '', rulesIn: ['any'], rulesOut: ['any'], reason: 'evidential', grammarMeaning: 'seems like ~', chainTag: 'seems like' },
  { kanaIn: 'ようです', kanaOut: '', rulesIn: ['any'], rulesOut: ['any'], reason: 'evidential polite', grammarMeaning: 'seems like ~ (polite)', chainTag: 'seems like (polite)' },
  { kanaIn: 'そうだ', kanaOut: 'る', rulesIn: ['v1'], rulesOut: ['any'], reason: 'semblance', grammarMeaning: 'looks like ~', chainTag: 'looks like' },
  { kanaIn: 'そうだ', kanaOut: '', rulesIn: ['any'], rulesOut: ['any'], reason: 'hearsay', grammarMeaning: 'I heard that ~ (hearsay)', chainTag: 'hearsay' },
  { kanaIn: 'そうです', kanaOut: '', rulesIn: ['any'], rulesOut: ['any'], reason: 'hearsay polite', grammarMeaning: 'I heard that ~ (polite hearsay)', chainTag: 'hearsay (polite)' },
  { kanaIn: 'らしい', kanaOut: '', rulesIn: ['any'], rulesOut: ['adj-i'], reason: 'conjectural', grammarMeaning: 'apparently / seems ~', chainTag: 'apparently' },
];

function classesCompatible(producedClass: JapaneseWordClass, expectedClasses: JapaneseWordClass[]): boolean {
  if (producedClass === 'any' || expectedClasses.includes('any')) return true;
  return expectedClasses.includes(producedClass);
}

interface InternalStep {
  suffix: string;
  reason: string;
  grammarMeaning: string;
  chainTag: string;
  viaTeOut: boolean;
  isTeBridge: boolean;
}

function buildOrderedGrammar(reverseSteps: InternalStep[]): {
  steps: GrammarStep[];
  grammarMeaning: string;
} {
  // Reverse from outermost-peeled -> innermost-peeled into natural left-to-right morphological order
  const ordered = [...reverseSteps].reverse();

  // Filter out purely mechanical te-form bridges immediately preceding a -て/-で subsidiary step
  const cleaned: InternalStep[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const cur = ordered[i];
    const next = ordered[i + 1];
    if (cur.isTeBridge && next && next.viaTeOut) {
      continue;
    }
    cleaned.push(cur);
  }

  const finalSteps = cleaned.length > 0 ? cleaned : ordered;
  if (finalSteps.length === 0) {
    return { steps: [], grammarMeaning: '' };
  }

  if (finalSteps.length === 1) {
    return {
      steps: [{ suffix: finalSteps[0].suffix, meaning: finalSteps[0].grammarMeaning, kind: finalSteps[0].reason }],
      grammarMeaning: finalSteps[0].grammarMeaning,
    };
  }

  const steps: GrammarStep[] = finalSteps.map((s) => ({
    suffix: s.suffix,
    meaning: s.grammarMeaning,
    kind: s.reason,
  }));

  const grammarMeaning = finalSteps.map((s) => s.chainTag).join(' + ');
  return { steps, grammarMeaning };
}

/**
 * Standalone conjugations of する and できる so zero-stem fragments (します, しています, できた, etc.)
 * resolve cleanly to する / できる in both tokenizers and lookups.
 */
export const STANDALONE_SURU_DEKIRU: Record<
  string,
  { lemma: 'する' | 'できる'; suffix: string; meaning: string; reasons: string[]; wordClass: JapaneseWordClass }
> = {
  します: { lemma: 'する', suffix: '-ます', meaning: 'polite form', reasons: ['polite'], wordClass: 'vs' },
  しました: { lemma: 'する', suffix: '-ました', meaning: 'polite past', reasons: ['polite past'], wordClass: 'vs' },
  しません: { lemma: 'する', suffix: '-ません', meaning: 'polite negative', reasons: ['polite negative'], wordClass: 'vs' },
  しませんでした: { lemma: 'する', suffix: '-ませんでした', meaning: 'polite past negative', reasons: ['polite past negative'], wordClass: 'vs' },
  しましょう: { lemma: 'する', suffix: '-ましょう', meaning: "polite volitional (let's ~)", reasons: ['polite volitional'], wordClass: 'vs' },
  した: { lemma: 'する', suffix: '-た', meaning: 'past tense', reasons: ['past'], wordClass: 'vs' },
  して: { lemma: 'する', suffix: '-て', meaning: 'te-form (and / linking)', reasons: ['te-form'], wordClass: 'vs' },
  しない: { lemma: 'する', suffix: '-ない', meaning: 'negative', reasons: ['negative'], wordClass: 'vs' },
  しなかった: { lemma: 'する', suffix: '-なかった', meaning: 'past negative', reasons: ['negative', 'past'], wordClass: 'vs' },
  している: { lemma: 'する', suffix: '-ている', meaning: 'is doing / ongoing state', reasons: ['progressive'], wordClass: 'vs' },
  してる: { lemma: 'する', suffix: '-てる', meaning: 'is doing / ongoing state', reasons: ['progressive'], wordClass: 'vs' },
  しています: { lemma: 'する', suffix: '-ています', meaning: 'is doing / ongoing state (polite)', reasons: ['progressive polite'], wordClass: 'vs' },
  してます: { lemma: 'する', suffix: '-てます', meaning: 'is doing / ongoing state (polite)', reasons: ['progressive polite'], wordClass: 'vs' },
  していた: { lemma: 'する', suffix: '-ていた', meaning: 'was doing / past ongoing state', reasons: ['past progressive'], wordClass: 'vs' },
  していました: { lemma: 'する', suffix: '-ていました', meaning: 'was doing / past ongoing state (polite)', reasons: ['past progressive polite'], wordClass: 'vs' },
  していない: { lemma: 'する', suffix: '-ていない', meaning: 'is not doing (negative progressive)', reasons: ['negative progressive'], wordClass: 'vs' },
  してない: { lemma: 'する', suffix: '-てない', meaning: 'is not doing (negative progressive)', reasons: ['negative progressive'], wordClass: 'vs' },
  される: { lemma: 'する', suffix: '-される', meaning: 'passive (be done)', reasons: ['passive'], wordClass: 'vs' },
  された: { lemma: 'する', suffix: '-された', meaning: 'passive + past', reasons: ['passive', 'past'], wordClass: 'vs' },
  されない: { lemma: 'する', suffix: '-されない', meaning: 'passive + negative', reasons: ['passive', 'negative'], wordClass: 'vs' },
  されて: { lemma: 'する', suffix: '-されて', meaning: 'passive + te-form', reasons: ['passive', 'te-form'], wordClass: 'vs' },
  されています: { lemma: 'する', suffix: '-されています', meaning: 'passive + ongoing state (polite)', reasons: ['passive', 'progressive polite'], wordClass: 'vs' },
  させる: { lemma: 'する', suffix: '-させる', meaning: 'causative (make/let do)', reasons: ['causative'], wordClass: 'vs' },
  させられる: { lemma: 'する', suffix: '-させられる', meaning: 'causative + passive', reasons: ['causative', 'passive'], wordClass: 'vs' },
  しよう: { lemma: 'する', suffix: '-よう', meaning: "let's / volitional", reasons: ['volitional'], wordClass: 'vs' },
  すれば: { lemma: 'する', suffix: '-れば', meaning: 'if / when ~', reasons: ['conditional'], wordClass: 'vs' },
  したら: { lemma: 'する', suffix: '-たら', meaning: 'if / when ~', reasons: ['conditional'], wordClass: 'vs' },
  したい: { lemma: 'する', suffix: '-たい', meaning: 'want to do ~', reasons: ['desiderative'], wordClass: 'vs' },
  しながら: { lemma: 'する', suffix: '-ながら', meaning: 'while doing ~ (simultaneous action)', reasons: ['simultaneous'], wordClass: 'vs' },
  できます: { lemma: 'できる', suffix: '-ます', meaning: 'polite form', reasons: ['polite'], wordClass: 'v1' },
  できました: { lemma: 'できる', suffix: '-ました', meaning: 'polite past', reasons: ['polite past'], wordClass: 'v1' },
  できません: { lemma: 'できる', suffix: '-ません', meaning: 'polite negative', reasons: ['polite negative'], wordClass: 'v1' },
  できませんでした: { lemma: 'できる', suffix: '-ませんでした', meaning: 'polite past negative', reasons: ['polite past negative'], wordClass: 'v1' },
  できた: { lemma: 'できる', suffix: '-た', meaning: 'past tense', reasons: ['past'], wordClass: 'v1' },
  できて: { lemma: 'できる', suffix: '-て', meaning: 'te-form (and / linking)', reasons: ['te-form'], wordClass: 'v1' },
  できない: { lemma: 'できる', suffix: '-ない', meaning: 'negative', reasons: ['negative'], wordClass: 'v1' },
  できなかった: { lemma: 'できる', suffix: '-なかった', meaning: 'past negative', reasons: ['negative', 'past'], wordClass: 'v1' },
  できている: { lemma: 'できる', suffix: '-ている', meaning: 'is able to / completed state', reasons: ['progressive'], wordClass: 'v1' },
  できています: { lemma: 'できる', suffix: '-ています', meaning: 'is able to / completed state (polite)', reasons: ['progressive polite'], wordClass: 'v1' },
};

/**
 * Backward-chaining rule-based Japanese deinflector.
 * Resolves conjugated verbs/adjectives (e.g. "食べています", "食べられなかった", "食べさせられた")
 * back to dictionary lemmas ("食べる") with human-readable grammar explanations.
 */
export function deinflectJapanese(surface: string, maxDepth = 6): DeinflectionCandidate[] {
  const clean = surface.trim();
  if (!clean) return [];

  const results: DeinflectionCandidate[] = [
    { lemma: clean, reasons: [], steps: [], grammarMeaning: '', wordClass: 'any' },
  ];

  const standaloneSuru = STANDALONE_SURU_DEKIRU[clean];
  if (standaloneSuru) {
    results.push({
      lemma: standaloneSuru.lemma,
      reasons: standaloneSuru.reasons,
      steps: [
        {
          suffix: standaloneSuru.suffix.replace(/^-/, ''),
          meaning: standaloneSuru.meaning,
          kind: standaloneSuru.reasons[0],
        },
      ],
      grammarMeaning: standaloneSuru.meaning,
      wordClass: standaloneSuru.wordClass,
    });
  }

  const visited = new Map<string, number>();
  visited.set(`${clean}|any`, 0);

  const queue: Array<{
    term: string;
    reasons: string[];
    steps: InternalStep[];
    wordClass: JapaneseWordClass;
    depth: number;
  }> = [{ term: clean, reasons: [], steps: [], wordClass: 'any', depth: 0 }];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;

    for (const rule of DEINFLECT_RULES) {
      if (!classesCompatible(cur.wordClass, rule.rulesOut)) continue;
      if (!cur.term.endsWith(rule.kanaIn)) continue;

      const stemLen = cur.term.length - rule.kanaIn.length;
      if (stemLen <= 0) continue;
      if (stemLen + rule.kanaOut.length < 2 && !/[\u4e00-\u9faf]/.test(cur.term.slice(0, stemLen))) {
        // Avoid collapsing pure short kana particles like "て" into 1-char nonsense
        continue;
      }
      // Guard against bogus copula だった -> だう / だつ / だる godan stems
      if (
        (rule.kanaOut === 'う' || rule.kanaOut === 'つ' || rule.kanaOut === 'る') &&
        cur.term.slice(0, stemLen).endsWith('だ')
      ) {
        continue;
      }

      const nextTerm = cur.term.slice(0, stemLen) + rule.kanaOut;
      const nextReasons = [...cur.reasons, rule.reason];
      const nextStep: InternalStep = {
        suffix: rule.kanaIn,
        reason: rule.reason,
        grammarMeaning: rule.grammarMeaning,
        chainTag: rule.chainTag || rule.reason,
        viaTeOut: rule.kanaOut === 'て' || rule.kanaOut === 'で',
        isTeBridge: Boolean(rule.isTeBridge),
      };
      const nextSteps = [...cur.steps, nextStep];
      const ordered = buildOrderedGrammar(nextSteps);

      for (const nextClass of rule.rulesIn) {
        const key = `${nextTerm}|${nextClass}`;
        const prevDepth = visited.get(key);
        if (prevDepth !== undefined && prevDepth <= cur.depth + 1) continue;
        visited.set(key, cur.depth + 1);

        results.push({
          lemma: nextTerm,
          reasons: nextReasons,
          steps: ordered.steps,
          grammarMeaning: ordered.grammarMeaning,
          wordClass: nextClass,
        });

        queue.push({
          term: nextTerm,
          reasons: nextReasons,
          steps: nextSteps,
          wordClass: nextClass,
          depth: cur.depth + 1,
        });
      }
    }
  }

  // Deduplicate by lemma keeping shortest/cleanest reason chain
  const bestByLemma = new Map<string, DeinflectionCandidate>();
  for (const cand of results) {
    const existing = bestByLemma.get(cand.lemma);
    if (!existing || cand.reasons.length < existing.reasons.length) {
      bestByLemma.set(cand.lemma, cand);
    }
  }

  return Array.from(bestByLemma.values());
}

/**
 * Explains na-adjective attributive, adverbial, and copula suffixes (-な, -に, -だった, -ではない, -じゃない, etc.).
 */
export function explainNaAdjectiveSuffix(suffix: string): {
  grammarSuffix: string;
  grammarMeaning: string;
  stepMeaning: string;
} | null {
  const s = suffix.trim().replace(/^-/, '');
  switch (s) {
    case 'な':
      return {
        grammarSuffix: '-な',
        grammarMeaning: 'na-adjective modifier (turns noun/stem into a modifier before a noun)',
        stepMeaning: 'na-adjective modifier (turns noun/stem into a modifier before a noun)',
      };
    case 'に':
      return {
        grammarSuffix: '-に',
        grammarMeaning: 'adverbial form (-ly)',
        stepMeaning: 'adverbial form (-ly)',
      };
    case 'だった':
    case 'ではない':
    case 'じゃない':
    case 'ではなかった':
    case 'じゃなかった':
    case 'ではありません':
    case 'じゃありません':
    case 'でした':
      return {
        grammarSuffix: `-${s}`,
        grammarMeaning: 'past / negative copula',
        stepMeaning: 'past / negative copula',
      };
    case 'だ':
      return {
        grammarSuffix: '-だ',
        grammarMeaning: 'plain copula (is / are)',
        stepMeaning: 'plain copula (is / are)',
      };
    case 'です':
      return {
        grammarSuffix: '-です',
        grammarMeaning: 'polite copula (is / are)',
        stepMeaning: 'polite copula (is / are)',
      };
    case 'だろう':
      return {
        grammarSuffix: '-だろう',
        grammarMeaning: 'conjectural copula (probably is)',
        stepMeaning: 'conjectural copula (probably is)',
      };
    case 'なら':
      return {
        grammarSuffix: '-なら',
        grammarMeaning: 'conditional copula (if it is ~)',
        stepMeaning: 'conditional copula (if it is ~)',
      };
    default:
      return null;
  }
}

/**
 * Explains a suru-verb / dekiru-verb suffix attached to a vs noun.
 */
export function explainSuruVerbSuffix(verbSurface: string, baseVerb: 'する' | 'できる' = 'する'): {
  grammarSuffix: string;
  grammarMeaning: string;
  verbComponentMeaning: string;
  steps: GrammarStep[];
} {
  const s = verbSurface.trim();
  if (s === 'する') {
    return {
      grammarSuffix: '-する',
      grammarMeaning: '+ する (to do — verb form)',
      verbComponentMeaning: 'to do — turns noun into a verb',
      steps: [{ suffix: 'する', meaning: '+ する (to do — verb form)', kind: 'suru-verb' }],
    };
  }
  if (baseVerb === 'できる' || s.startsWith('でき')) {
    const exp = s === 'できる' ? undefined : explainJapaneseInflection(s, 'できる');
    const detail = exp?.grammarMeaning ? ` · ${exp.grammarMeaning}` : '';
    return {
      grammarSuffix: `-${s}`,
      grammarMeaning: `+ する (to do — verb form) · potential (can do)${detail}`,
      verbComponentMeaning: `to do — turns noun into a verb (can do${exp?.grammarMeaning ? ` · ${exp.grammarMeaning}` : ''})`,
      steps: [
        { suffix: s, meaning: `+ する (to do — verb form) · potential (can do)${detail}`, kind: 'suru-verb' },
      ],
    };
  }

  const exp = explainJapaneseInflection(s, 'する');
  const detail = exp?.grammarMeaning ? ` · ${exp.grammarMeaning}` : '';
  return {
    grammarSuffix: `-${s}`,
    grammarMeaning: `+ する (to do — verb form)${detail}`,
    verbComponentMeaning: exp?.grammarMeaning
      ? `to do — turns noun into a verb (${exp.grammarMeaning})`
      : 'to do — turns noun into a verb',
    steps: [
      { suffix: 'する', meaning: '+ する (to do — verb form)', kind: 'suru-verb' },
      ...(exp?.grammarSteps || []),
    ],
  };
}

/**
 * Computes surface suffix diff and chained grammar explanation for an inflected Japanese token/word.
 */
export function explainJapaneseInflection(
  surface: string,
  targetLemma?: string
): {
  lemma: string;
  grammarSuffix?: string;
  grammarMeaning?: string;
  grammarSteps: GrammarStep[];
  reasons: string[];
} {
  const cleanSurface = surface.trim();
  const cleanLemma = targetLemma?.trim();
  if (!cleanSurface) {
    return { lemma: cleanLemma || '', grammarSteps: [], reasons: [] };
  }

  // Handle na-adjective or suru-verb suffix when targetLemma is explicitly known
  if (cleanLemma && cleanSurface !== cleanLemma && cleanSurface.startsWith(cleanLemma)) {
    const rem = cleanSurface.slice(cleanLemma.length);
    const naExp = explainNaAdjectiveSuffix(rem);
    if (naExp) {
      return {
        lemma: cleanLemma,
        grammarSuffix: naExp.grammarSuffix,
        grammarMeaning: naExp.grammarMeaning,
        grammarSteps: [{ suffix: rem, meaning: naExp.grammarMeaning, kind: 'na-adj' }],
        reasons: ['na-adj'],
      };
    }
    if (rem === 'する' || STANDALONE_SURU_DEKIRU[rem] || rem === 'できる') {
      const baseVerb = rem.startsWith('でき') ? 'できる' : 'する';
      const suruExp = explainSuruVerbSuffix(rem, baseVerb);
      return {
        lemma: cleanLemma,
        grammarSuffix: suruExp.grammarSuffix,
        grammarMeaning: suruExp.grammarMeaning,
        grammarSteps: suruExp.steps,
        reasons: ['suru-verb'],
      };
    }
  }

  // Handle `<noun>する` lemma with conjugated suru form (`勉強しています` -> `勉強する`)
  if (cleanLemma && cleanLemma.endsWith('する') && cleanLemma.length > 2) {
    const nounStem = cleanLemma.slice(0, -2);
    if (cleanSurface.startsWith(nounStem)) {
      const rem = cleanSurface.slice(nounStem.length);
      if (rem === 'する') {
        return {
          lemma: cleanLemma,
          grammarSuffix: '-する',
          grammarMeaning: '+ する (to do — verb form)',
          grammarSteps: [{ suffix: 'する', meaning: '+ する (to do — verb form)', kind: 'suru-verb' }],
          reasons: ['suru-verb'],
        };
      }
      if (STANDALONE_SURU_DEKIRU[rem]) {
        const suruExp = explainSuruVerbSuffix(rem, STANDALONE_SURU_DEKIRU[rem].lemma);
        return {
          lemma: cleanLemma,
          grammarSuffix: suruExp.grammarSuffix,
          grammarMeaning: suruExp.grammarMeaning,
          grammarSteps: suruExp.steps,
          reasons: ['suru-verb'],
        };
      }
    }
  }

  const candidates = deinflectJapanese(cleanSurface).filter((c) => c.reasons.length > 0);
  let matched = cleanLemma
    ? candidates.find((c) => c.lemma === cleanLemma)
    : undefined;

  if (!matched && candidates.length > 0 && !cleanLemma) {
    matched = candidates[0];
  }

  const resolvedLemma = matched?.lemma || cleanLemma || cleanSurface;
  if (resolvedLemma === cleanSurface) {
    return { lemma: resolvedLemma, grammarSteps: [], reasons: [] };
  }

  // Compute visible inflected suffix via longest common prefix
  let prefixLen = 0;
  const maxPrefix = Math.min(cleanSurface.length, resolvedLemma.length);
  while (prefixLen < maxPrefix && cleanSurface[prefixLen] === resolvedLemma[prefixLen]) {
    prefixLen++;
  }
  const suffixRaw = cleanSurface.slice(prefixLen) || cleanSurface;
  const grammarSuffix = `-${suffixRaw}`;

  if (matched) {
    return {
      lemma: resolvedLemma,
      grammarSuffix,
      grammarMeaning: matched.grammarMeaning,
      grammarSteps: matched.steps,
      reasons: matched.reasons,
    };
  }

  return {
    lemma: resolvedLemma,
    grammarSuffix,
    grammarMeaning: undefined,
    grammarSteps: [],
    reasons: [],
  };
}

/**
 * Protected standalone 1–2 kana Japanese grammatical particles and copulas.
 * Prevents false kanji homonym matches (e.g. mapping "な" to 菜 "vegetables").
 */
export interface ProtectedJaGrammarInfo {
  word: string;
  reading: string;
  isCopula: boolean;
  badgeLabel: 'Grammar Particle' | 'Copula';
  meanings: string[];
  level: string;
  grammarNotes?: string[];
}

export const PROTECTED_JA_GRAMMAR_TOKENS: Record<string, ProtectedJaGrammarInfo> = {
  の: {
    word: 'の',
    reading: 'の',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ["possessive / noun-linking particle ('s / of)", 'nominalizer (one / doing)'],
    level: 'N5',
  },
  を: {
    word: 'を',
    reading: 'を',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['direct object marker', 'path / point of departure marker'],
    level: 'N5',
  },
  に: {
    word: 'に',
    reading: 'に',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['target / time / location particle (to / at / in)', 'indirect object marker (to / for)'],
    level: 'N5',
  },
  は: {
    word: 'は',
    reading: 'は (wa)',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['topic marker', 'contrast marker (as for ~)'],
    level: 'N5',
  },
  が: {
    word: 'が',
    reading: 'が',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['subject marker', 'but / however (conjunctive)'],
    level: 'N5',
  },
  で: {
    word: 'で',
    reading: 'で',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['location of action / means particle (at / by / with)'],
    level: 'N5',
  },
  と: {
    word: 'と',
    reading: 'と',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['and (exhaustive) / with / quoting particle'],
    level: 'N5',
  },
  も: {
    word: 'も',
    reading: 'も',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['also / too / even'],
    level: 'N5',
  },
  へ: {
    word: 'へ',
    reading: 'へ (e)',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['direction particle (toward / to)'],
    level: 'N5',
  },
  から: {
    word: 'から',
    reading: 'から',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['from / since / because'],
    level: 'N5',
  },
  まで: {
    word: 'まで',
    reading: 'まで',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['until / up to / as far as'],
    level: 'N5',
  },
  より: {
    word: 'より',
    reading: 'より',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['than (comparison) / from'],
    level: 'N4',
  },
  や: {
    word: 'や',
    reading: 'や',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['and (non-exhaustive list, such as ~)'],
    level: 'N5',
  },
  か: {
    word: 'か',
    reading: 'か',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['question marker / or'],
    level: 'N5',
  },
  ね: {
    word: 'ね',
    reading: 'ね',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ["sentence-ending particle (isn't it? / seeking agreement)"],
    level: 'N5',
  },
  よ: {
    word: 'よ',
    reading: 'よ',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: ['sentence-ending particle (emphasis / you know)'],
    level: 'N5',
  },
  な: {
    word: 'な',
    reading: 'な',
    isCopula: false,
    badgeLabel: 'Grammar Particle',
    meanings: [
      'na-adjective modifier / sentence-ending emphasis',
      "don't ~ (negative command after dictionary-form verb)",
    ],
    level: 'N5',
  },
  です: {
    word: 'です',
    reading: 'です',
    isCopula: true,
    badgeLabel: 'Copula',
    meanings: ['polite copula (is / am / are)'],
    level: 'N5',
  },
  だ: {
    word: 'だ',
    reading: 'だ',
    isCopula: true,
    badgeLabel: 'Copula',
    meanings: ['plain copula (is / am / are)'],
    level: 'N5',
  },
};

export const JA_DERIVATIONAL_SUFFIXES = new Set([
  '的', '性', '化', '風', '感', '者', '員', '力', '中', '上', '下', '内', '外',
]);

export const JA_DERIVATIONAL_SUFFIX_GLOSSES: Record<string, string> = {
  的: '-like / -al (forms na-adjective)',
  性: '-ness / -ity (nature / quality)',
  化: '-ization / turning into ~',
  風: '-style / manner',
  感: 'sense / feeling of ~',
  者: 'person who ~ (-er / -ist)',
  員: 'member / staff',
  力: 'power / ability / capability',
  中: 'during / in the middle of / inside',
  上: 'on / above / regarding',
  下: 'under / below',
  内: 'within / inside',
  外: 'outside / beyond',
};

/**
 * Concise English glosses for Japanese particles, auxiliaries, and bound suffixes
 * (used in the Breakdown tab and standalone particle fallback so no card lacks an English meaning).
 */
export const JAPANESE_COMPONENT_GLOSSES: Record<string, string> = {
  ...JA_DERIVATIONAL_SUFFIX_GLOSSES,

  // Conjunctive / Subsidiary / Aspect
  ながら: 'while doing ~ (simultaneous action)',
  て: 'te-form (and / linking)',
  ている: 'is doing / ongoing state',
  てる: 'is doing / ongoing state',
  てい: 'is doing / ongoing state',
  でいる: 'is doing / ongoing state',
  でる: 'is doing / ongoing state',
  でい: 'is doing / ongoing state',
  いる: 'ongoing state / to exist (animate)',
  い: 'ongoing state (~ている)',
  ある: 'resulting state (~てある) / to exist',
  おく: 'do ~ in advance (~ておく)',
  おい: 'do ~ in advance (~ておく)',
  しまう: 'end up doing / completely (~てしまう)',
  しまっ: 'end up doing / completely',
  しま: 'end up doing / completely',
  ちゃう: 'end up doing / completely (casual)',
  ちゃっ: 'end up doing / completely (casual)',
  じゃう: 'end up doing / completely (casual)',
  じゃっ: 'end up doing / completely (casual)',
  みる: 'try doing ~ (~てみる)',
  み: 'try doing ~ (~てみる)',
  くる: 'begin to / come to (~てくる)',
  いく: 'go on doing ~ (~ていく)',
  いっ: 'go on doing ~ (~ていく)',

  // Light Verbs (Suru / Dekiru)
  する: 'to do — turns noun into a verb',
  し: 'to do — turns noun into a verb',
  できる: 'can do — potential form of する',
  でき: 'can do — potential form of する',

  // Polite / Tense / Negative / Copula / Na-Adjective
  ます: 'polite form',
  まし: 'polite form',
  ませ: 'polite form (negative/imperative stem)',
  ません: 'polite negative',
  ました: 'polite past',
  ませんでした: 'polite past negative',
  ましょう: "polite volitional (let's ~)",
  まして: 'polite te-form',
  た: 'past tense',
  だ: 'plain copula (is / am / are)',
  だった: 'past copula (was / were)',
  だっ: 'past copula stem',
  です: 'polite copula (is / am / are)',
  でした: 'polite past copula',
  でし: 'polite past copula stem',
  だろう: 'conjectural copula (probably is)',
  だろ: 'conjectural copula stem',
  ではない: 'negative copula (is not)',
  じゃない: 'negative copula (is not, casual)',
  では: 'negative / contrast (~ではない)',
  じゃ: 'negative / contrast (~じゃない)',
  なら: 'conditional copula (if it is ~)',
  な: 'na-adjective modifier / sentence-ending particle',
  ない: 'negative',
  なか: 'negative stem',
  なかっ: 'negative (past stem)',
  なかった: 'past negative',
  なく: 'negative (adverbial)',
  なくて: 'negative te-form',
  ないで: 'without doing ~ (negative)',
  ず: 'without doing ~ (negative)',
  ぬ: 'negative (archaic / literary)',
  ん: 'negative / explanatory (~んだ)',

  // Voice / Modality / Conditional / Adjective
  られる: 'passive / potential (can / be done)',
  られ: 'passive / potential (can / be done)',
  れる: 'passive / potential (can / be done)',
  れ: 'passive / potential (can / be done)',
  させる: 'causative (make/let do)',
  させ: 'causative (make/let do)',
  せる: 'causative (make/let do)',
  せ: 'causative (make/let do)',
  たい: 'want to do ~',
  たかっ: 'wanted to do ~ (past)',
  たく: 'want to do ~ (adverbial)',
  ば: 'if / when ~ (conditional)',
  れば: 'if / when ~ (conditional)',
  たら: 'if / when ~ (conditional)',
  だら: 'if / when ~ (conditional)',
  たり: 'doing things like ~ (representative)',
  だり: 'doing things like ~ (representative)',
  よう: "let's / volitional; seems like",
  そうだ: 'looks like / hearsay',
  そう: 'looks like / hearsay',
  ようだ: 'seems like ~',
  らしい: 'apparently / seems ~',
  すぎる: 'too much ~ (excessive)',
  すぎ: 'too much ~ (excessive)',
  くない: 'negative adjective',
  かった: 'past adjective',
  くなかった: 'past negative adjective',
  くて: 'adjective te-form (and / linking)',
  く: 'adverbial (-ly)',

  // Case & Binding Particles
  は: 'topic marker (as for ~)',
  が: 'subject marker / but',
  を: 'direct object marker',
  に: 'to / at / in (target, time, location)',
  へ: 'toward (direction)',
  で: 'location of action / means particle (at / by / with)',
  と: 'and / with / quoting particle',
  の: "possessive / noun-linking particle ('s / of)",
  も: 'also / too / even',
  から: 'from / since / because',
  まで: 'until / up to',
  より: 'than / from',
  か: 'question marker / or',
  ね: "isn't it? (seeking agreement)",
  よ: 'you know (emphasis)',
  って: 'quoting / topic marker (casual)',
  ばかり: 'only / just finished ~',
  だけ: 'only / just',
  しか: 'only / nothing but (with negative)',
  ほど: 'to the extent of / about',
  くらい: 'about / approximately',
  ぐらい: 'about / approximately',
  など: 'and so on / etc.',
  でも: 'even / but',
  けど: 'but / although',
  けれど: 'but / although',
  けれども: 'but / although',
  ので: 'because / since',
  のに: 'even though / despite',
  や: 'and (non-exhaustive list)',
};

export function getJapaneseComponentMeaning(
  surface: string,
  basic?: string,
  pos?: string
): string | undefined {
  const s = surface.trim();
  const b = basic && basic !== '*' ? basic.trim() : '';

  // Distinguish conjunctive particle て/で inside verbs vs case particle で
  if (s === 'で' && pos && pos.includes('接続助詞')) {
    return 'te-form (and / linking)';
  }
  if (s === 'で' && pos && pos.includes('助動詞')) {
    return 'copula / te-form (being / and)';
  }
  if (s === 'に' && pos && (pos.includes('Na-adjective') || pos.includes('Adverbial') || pos.includes('形容動詞'))) {
    return 'adverbial form (-ly)';
  }
  if (s === 'な' && pos && (pos.includes('Na-adjective') || pos.includes('助動詞'))) {
    return 'na-adjective modifier (modifies following noun)';
  }

  if (JAPANESE_COMPONENT_GLOSSES[s]) return JAPANESE_COMPONENT_GLOSSES[s];
  if (b && JAPANESE_COMPONENT_GLOSSES[b]) return JAPANESE_COMPONENT_GLOSSES[b];

  // Try deinflecting the fragment if it's a sub-compound like なかっ / ていまし / られ / しています
  const deinf = deinflectJapanese(s).find((c) => c.reasons.length > 0 && c.grammarMeaning);
  if (deinf?.grammarMeaning) return deinf.grammarMeaning;

  return undefined;
}

