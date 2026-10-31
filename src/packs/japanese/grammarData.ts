import type { GrammarPoint } from '../../core/languagePack';

export const JAPANESE_GRAMMAR_DATABASE: GrammarPoint[] = [
  {
    id: 'jp-gram-1',
    title: '〜は (Topic Marker)',
    pattern: '[Noun] + は',
    level: 'N5',
    explanation: 'Marks the topic of the sentence. Pronounced "wa" instead of "ha".',
    examples: [
      {
        original: '私は学生です。',
        translation: 'I am a student.',
        reading: 'わたし は がくせい です。',
      },
    ],
  },
  {
    id: 'jp-gram-2',
    title: '〜を (Direct Object Marker)',
    pattern: '[Noun] + を + [Transitive Verb]',
    level: 'N5',
    explanation: 'Marks the direct object that the verb acts upon. Pronounced "o".',
    examples: [
      {
        original: '本を読みます。',
        translation: 'I read a book.',
        reading: 'ほん を よみます。',
      },
    ],
  },
  {
    id: 'jp-gram-3',
    title: '〜ている (Continuous Action / State)',
    pattern: '[Verb Te-form] + いる',
    level: 'N5',
    explanation: 'Expresses an action currently ongoing (e.g. studying, eating) or an ongoing state of being (e.g. living in Tokyo, knowing someone).',
    examples: [
      {
        original: '今、日本語を勉強しています。',
        translation: 'I am studying Japanese right now.',
      },
    ],
  },
  {
    id: 'jp-gram-4',
    title: '〜たことがある (Past Experience)',
    pattern: '[Verb Ta-form] + ことがある',
    level: 'N5',
    explanation: 'Expresses that the speaker has had the experience of doing something in the past.',
    examples: [
      {
        original: '日本に行ったことがありますか。',
        translation: 'Have you ever been to Japan?',
      },
    ],
  },
  {
    id: 'jp-gram-5',
    title: '〜ようにする (Making an effort to)',
    pattern: '[Verb Dictionary / Nai form] + ようにする',
    level: 'N3',
    explanation: 'Indicates a conscious habit or continuous effort to do or not do an action.',
    examples: [
      {
        original: '毎日野菜をたくさん食べるようにしています。',
        translation: 'I make an effort to eat lots of vegetables every day.',
      },
    ],
  },
  {
    id: 'jp-gram-6',
    title: '〜によって (Due to / By means of)',
    pattern: '[Noun] + によって',
    level: 'N2',
    explanation: 'Indicates the cause, means, method, or creator of something.',
    examples: [
      {
        original: 'インターネットによって世界が近くなりました。',
        translation: 'The world has grown closer thanks to the internet.',
      },
    ],
  },
];
