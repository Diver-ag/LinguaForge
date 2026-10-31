import { create } from 'zustand';
import { db, type DocumentItem, type WordStatusType } from '../db/db';
import { getLanguagePack } from '../packs/registry';
import { logEvent } from '../core/eventLogger';
import { DEFAULT_GEMINI_MODEL, getStoredModel, setStoredModel } from '../ai/gemini';

export type FuriganaMode = 'always' | 'hover' | 'never';
export type FontSize = 'sm' | 'md' | 'lg' | 'xl';
export type AppTheme = 'dark' | 'light' | 'system';

interface AppState {
  activeLanguageId: string;
  theme: AppTheme;
  furiganaMode: FuriganaMode;
  colorCodingEnabled: boolean;
  fontSize: FontSize;
  activeDocumentId: number | null;
  activeDocument: DocumentItem | null;
  wordStatuses: Record<string, WordStatusType>;
  isLoadingStatuses: boolean;

  geminiModel: string;

  // Actions
  setActiveLanguage: (langId: string) => Promise<void>;
  setTheme: (theme: AppTheme) => Promise<void>;
  setFuriganaMode: (mode: FuriganaMode) => Promise<void>;
  setColorCodingEnabled: (enabled: boolean) => Promise<void>;
  setFontSize: (size: FontSize) => Promise<void>;
  setGeminiModel: (model: string) => Promise<void>;
  setActiveDocument: (doc: DocumentItem | null) => void;
  loadInitialSettings: () => Promise<void>;
  loadWordStatuses: (langId?: string) => Promise<void>;
  setWordStatus: (word: string, status: WordStatusType) => Promise<void>;
  recordLookup: (word: string, reading?: string, meaning?: string, docId?: number, docTitle?: string, sentence?: string) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  activeLanguageId: 'ja',
  theme: 'dark',
  furiganaMode: 'always',
  colorCodingEnabled: true,
  fontSize: 'md',
  activeDocumentId: null,
  activeDocument: null,
  wordStatuses: {},
  isLoadingStatuses: false,
  geminiModel: DEFAULT_GEMINI_MODEL,

  setActiveLanguage: async (langId: string) => {
    set({ activeLanguageId: langId });
    await db.settings.put({ key: 'activeLanguageId', value: langId });
    await get().loadWordStatuses(langId);
    await logEvent('language_changed', { langId });
  },

  setTheme: async (theme: AppTheme) => {
    set({ theme });
    await db.settings.put({ key: 'theme', value: theme });
    applyThemeToDocument(theme);
    await logEvent('theme_changed', { theme });
  },

  setFuriganaMode: async (mode: FuriganaMode) => {
    set({ furiganaMode: mode });
    await db.settings.put({ key: 'furiganaMode', value: mode });
    await logEvent('furigana_mode_changed', { mode });
  },

  setColorCodingEnabled: async (enabled: boolean) => {
    set({ colorCodingEnabled: enabled });
    await db.settings.put({ key: 'colorCodingEnabled', value: enabled });
  },

  setFontSize: async (fontSize: FontSize) => {
    set({ fontSize });
    await db.settings.put({ key: 'fontSize', value: fontSize });
  },

  setGeminiModel: async (model: string) => {
    const cleanModel = model.trim() || DEFAULT_GEMINI_MODEL;
    set({ geminiModel: cleanModel });
    await setStoredModel(cleanModel);
  },

  setActiveDocument: (doc: DocumentItem | null) => {
    set({
      activeDocument: doc,
      activeDocumentId: doc?.id ?? null,
    });
  },

  loadInitialSettings: async () => {
    try {
      const langSetting = await db.settings.get('activeLanguageId');
      const themeSetting = await db.settings.get('theme');
      const furiganaSetting = await db.settings.get('furiganaMode');
      const colorSetting = await db.settings.get('colorCodingEnabled');
      const fontSetting = await db.settings.get('fontSize');
      const storedModel = await getStoredModel();

      const activeLang = langSetting?.value || 'ja';
      const activeTheme = themeSetting?.value || 'dark';
      const activeFurigana = furiganaSetting?.value || 'always';
      const activeColor = colorSetting?.value !== undefined ? colorSetting.value : true;
      const activeFont = fontSetting?.value || 'md';

      set({
        activeLanguageId: activeLang,
        theme: activeTheme,
        furiganaMode: activeFurigana,
        colorCodingEnabled: activeColor,
        fontSize: activeFont,
        geminiModel: storedModel || DEFAULT_GEMINI_MODEL,
      });

      applyThemeToDocument(activeTheme);
      await get().loadWordStatuses(activeLang);
    } catch (err) {
      console.error('Failed to load initial settings:', err);
    }
  },

  loadWordStatuses: async (langId?: string) => {
    const targetLang = langId || get().activeLanguageId;
    set({ isLoadingStatuses: true });
    try {
      const items = await db.wordStatuses.where('languageId').equals(targetLang).toArray();
      const statusMap: Record<string, WordStatusType> = {};
      for (const item of items) {
        statusMap[item.word] = item.status;
      }
      set({ wordStatuses: statusMap, isLoadingStatuses: false });
    } catch {
      set({ isLoadingStatuses: false });
    }
  },

  setWordStatus: async (word: string, status: WordStatusType) => {
    const langId = get().activeLanguageId;
    await db.wordStatuses.put({
      word,
      languageId: langId,
      status,
      updatedAt: Date.now(),
    });

    set((state) => ({
      wordStatuses: {
        ...state.wordStatuses,
        [word]: status,
      },
    }));

    await logEvent('word_status_updated', { word, status, langId });
  },

  recordLookup: async (word: string, reading?: string, meaning?: string, docId?: number, docTitle?: string, sentence?: string) => {
    const langId = get().activeLanguageId;
    const existing = await db.lookups.where({ word, languageId: langId }).first();

    if (existing && existing.id) {
      await db.lookups.update(existing.id, {
        count: existing.count + 1,
        timestamp: Date.now(),
        documentId: docId || existing.documentId,
        documentTitle: docTitle || existing.documentTitle,
        surroundingSentence: sentence || existing.surroundingSentence,
      });
    } else {
      await db.lookups.add({
        word,
        reading,
        meaning,
        languageId: langId,
        documentId: docId,
        documentTitle: docTitle,
        surroundingSentence: sentence,
        timestamp: Date.now(),
        count: 1,
      });
    }

    // Automatically mark as 'learning' if not known
    const currentStatus = get().wordStatuses[word];
    if (!currentStatus || currentStatus === 'new') {
      await get().setWordStatus(word, 'learning');
    }

    await logEvent('word_lookup', { word, docId });
  },
}));

function applyThemeToDocument(theme: AppTheme) {
  const root = document.documentElement;
  const isDark =
    theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}
