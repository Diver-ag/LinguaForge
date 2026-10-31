import Dexie, { type Table } from 'dexie';

export type WordStatusType = 'new' | 'learning' | 'known' | 'ignored';

export interface DocumentItem {
  id?: number;
  title: string;
  content: string;
  rawType: 'txt' | 'epub' | 'srt' | 'vtt' | 'pdf' | 'paste';
  languageId: string;
  createdAt: number;
  updatedAt: number;
  lastReadPosition?: number;
  wordCount?: number;
  uniqueWordCount?: number;
  estimatedLevel?: string;
  chapters?: { title: string; content: string }[];
}

export interface WordStatusItem {
  id?: number;
  word: string;
  languageId: string;
  status: WordStatusType;
  updatedAt: number;
}

export interface LookupItem {
  id?: number;
  word: string;
  reading?: string;
  meaning?: string;
  languageId: string;
  documentId?: number;
  documentTitle?: string;
  surroundingSentence?: string;
  timestamp: number;
  count: number;
}

export interface EventLogItem {
  id?: number;
  type: string;
  payload?: any;
  timestamp: number;
}

export interface SettingItem {
  key: string;
  value: any;
}

export interface FlashcardItem {
  id?: number;
  word: string;
  reading: string;
  meaning: string;
  sentence?: string;
  languageId: string;
  sourceDocTitle?: string;
  level?: string;
  status: 'new' | 'learning' | 'review' | 'mastered';
  createdAt: number;
  nextReviewDate?: number;
}

export interface DownloadedPackAsset {
  packId: string;
  assetId: string;
  name: string;
  version: string;
  sizeBytes: number;
  installedAt: number;
}

export class LinguaForgeDatabase extends Dexie {
  documents!: Table<DocumentItem, number>;
  wordStatuses!: Table<WordStatusItem, number>;
  lookups!: Table<LookupItem, number>;
  eventLogs!: Table<EventLogItem, number>;
  settings!: Table<SettingItem, string>;
  flashcards!: Table<FlashcardItem, number>;
  downloadedAssets!: Table<DownloadedPackAsset, string>;

  constructor() {
    super('LinguaForgeDB');
    this.version(1).stores({
      documents: '++id, languageId, title, createdAt, updatedAt',
      wordStatuses: '++id, [word+languageId], word, languageId, status, updatedAt',
      lookups: '++id, [word+languageId], word, languageId, timestamp, count, documentId',
      eventLogs: '++id, type, timestamp',
      settings: 'key',
      flashcards: '++id, word, languageId, status, nextReviewDate, createdAt',
      downloadedAssets: '[packId+assetId], packId, assetId',
    });
  }
}

export const db = new LinguaForgeDatabase();
