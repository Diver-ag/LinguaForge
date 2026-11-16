import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAppStore } from './store/useAppStore';
import { Navbar } from './ui/Navbar';
import { OfflineIndicator } from './ui/OfflineIndicator';
import { PWAUpdateBanner } from './ui/PWAUpdateBanner';
import { ReaderView } from './features/reader/ReaderView';
import { LibraryView } from './features/library/LibraryView';
import { HistoryView } from './features/history/HistoryView';
import { LanguagePacksView } from './features/packs/LanguagePacksView';
import { SettingsView } from './features/settings/SettingsView';
import { CardsView } from './features/cards/CardsView';
import { ImportCardsView } from './features/cards/ImportCardsView';
import { ExportView } from './features/cards/ExportView';
import { ReviewView } from './features/review/ReviewView';
import { StatsView } from './features/stats/StatsView';

import { backfillFlashcards } from './db/db';
import { ensureAllDefaultDecks } from './db/cards';
import { tokenizeJapanese } from './packs/japanese/tokenizer';

export default function App() {
  const { loadInitialSettings } = useAppStore();

  useEffect(() => {
    loadInitialSettings();
    ensureAllDefaultDecks().catch(console.error);
    // One-time backfill for existing cards without readings or furigana
    backfillFlashcards(tokenizeJapanese).catch(console.error);
  }, [loadInitialSettings]);

  return (
    <BrowserRouter>
      <div className="min-h-screen bg-[var(--background)] text-[var(--text)] font-sans antialiased flex flex-col selection:bg-indigo-500 selection:text-white transition-colors duration-150">
        <Navbar />
        <div className="flex-1">
          <Routes>
            <Route path="/" element={<Navigate to="/library" replace />} />
            <Route path="/library" element={<LibraryView />} />
            <Route path="/reader" element={<ReaderView />} />
            <Route path="/cards" element={<CardsView />} />
            <Route path="/cards/import" element={<ImportCardsView />} />
            <Route path="/import" element={<Navigate to="/cards/import" replace />} />
            <Route path="/export" element={<ExportView />} />
            <Route path="/review" element={<ReviewView />} />
            <Route path="/stats" element={<StatsView />} />
            <Route path="/history" element={<HistoryView />} />
            <Route path="/packs" element={<LanguagePacksView />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="*" element={<Navigate to="/library" replace />} />
          </Routes>
        </div>
        <OfflineIndicator />
        <PWAUpdateBanner />
      </div>
    </BrowserRouter>
  );
}
