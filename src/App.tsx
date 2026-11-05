import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAppStore } from './store/useAppStore';
import { Navbar } from './ui/Navbar';
import { OfflineIndicator } from './ui/OfflineIndicator';
import { ReaderView } from './features/reader/ReaderView';
import { LibraryView } from './features/library/LibraryView';
import { HistoryView } from './features/history/HistoryView';
import { LanguagePacksView } from './features/packs/LanguagePacksView';
import { SettingsView } from './features/settings/SettingsView';

import { backfillFlashcards } from './db/db';
import { tokenizeJapanese } from './packs/japanese/tokenizer';

export default function App() {
  const { loadInitialSettings } = useAppStore();

  useEffect(() => {
    loadInitialSettings();
    // One-time backfill for existing flashcards without readings or furigana
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
            <Route path="/history" element={<HistoryView />} />
            <Route path="/packs" element={<LanguagePacksView />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="*" element={<Navigate to="/library" replace />} />
          </Routes>
        </div>
        <OfflineIndicator />
      </div>
    </BrowserRouter>
  );
}
