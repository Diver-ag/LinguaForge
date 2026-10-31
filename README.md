# LinguaForge (Offline-First Language Learning PWA)

LinguaForge is an offline-first, local-first language learning Progressive Web App built with React 19, TypeScript, Vite, Tailwind CSS, Dexie (IndexedDB), and Zustand. It is designed to be installable on Windows (Edge/Chrome), Android (Chrome), and iOS Safari, and architected for seamless packaging into Capacitor or Tauri.

---

## Architecture Overview

### 1. Local-First Storage (`/src/db`)
- **No cloud database, no user accounts required.** All documents, lookups, word comprehension states, flashcards, and settings live directly in the browser's IndexedDB via **Dexie.js**.
- **Full JSON Backup & Restore** (`/src/core/backup.ts`): Export snapshots of all local tables into a standalone JSON file and restore it with validation.
- **Analytics Event Log** (`/src/core/eventLogger.ts`): Tracks user interactions locally in IndexedDB for personalized comprehension analytics.

### 2. Offline-First PWA (`vite-plugin-pwa`)
- Service worker precaches application shell assets (`.js`, `.css`, `.html`, icons, fonts).
- Once language pack assets and reading materials are cached, the reader, dictionary, history, and stats work 100% offline.
- **Offline Morphological Analyzer (Kuromoji)**: For development and preview, Kuromoji dictionary files (`*.dat.gz`) load from `https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/`. For 100% offline use with no internet connection, these dictionary files must be copied into `public/dict/` and cached by the service worker as part of the Japanese language pack asset manifest download.
- Features automatic offline detection (`useOnlineStatus`) with a non-intrusive status indicator and in-app install prompt (`PWAInstallButton`).

### 3. Language-Agnostic Pack Interface (`/src/core/languagePack.ts`)
No Japanese-specific concepts are hardcoded in the core reader or database. All linguistic logic is encapsulated behind the `LanguagePack` interface:
```typescript
interface LanguagePack {
  id: string;
  name: string;
  nativeName: string;
  flagEmoji: string;
  ocrCode: string;
  sttCode: string;
  ttsCode: string;
  levelSystem: DifficultyLevelSystem; // Pluggable (JLPT, CEFR, HSK, TOPIK)
  assetsManifest: PackAssetManifestItem[];

  tokenize(text: string): Promise<Token[]>;
  lookup(word: string): Promise<DictionaryEntry | null>;
  searchDictionary(query: string, limit?: number): Promise<DictionaryEntry[]>;
  getFrequency(word: string): number | null;
  getLevel(word: string): string | null;
  getReading(token: Token | string): { displayReading?: string; furiganaSegments?: FuriganaSegment[]; romanization?: string };
  lookupKanji?(character: string): Promise<KanjiDetail | null>;
  lookupGrammar(query: string): Promise<GrammarPoint[]>;
}
```

### 4. Progressive AI Enhancement (`/src/ai/gemini.ts`)
- Features use the Gemini API with a user-supplied API key saved in local IndexedDB settings.
- If offline or no key is supplied, a friendly status message is displayed and core reading/lookup features remain fully functional.
- API requests feature automatic exponential backoff retry and 24-hour local response caching.

---

## Folder Structure

```
/src
  /ai         # Gemini client wrapper, prompt engineering, retries, and caching
  /core       # LanguagePack interfaces, event logger, JSON backup/restore
  /db         # Dexie database schema and table definitions
  /features
    /library  # Document manager, upload parsers (.txt, .epub, .srt, .vtt, .pdf), sample stories
    /reader   # Interactive smart reader, furigana toggle, word popup, text stats
    /history  # Lookups log, occurrence counters, context sentences, CSV export
    /packs    # Language pack manager and asset download manager
    /settings # API key config, preferences, backup/restore, analytics inspector
  /packs
    /japanese # Japanese pack (Intl.Segmenter + morphological heuristics, JMdict, KANJIDIC2, Tatoeba)
    registry.ts # Pluggable language pack registry
  /store      # Zustand global state (active language, theme, font size, furigana mode, word statuses)
  /ui         # Reusable UI components (Navbar, PWAInstallButton, OfflineIndicator)
```

---

## How to Add a New Language Pack

Adding a new language requires **zero core code changes**:

1. Create a new directory in `/src/packs/<language_id>` (e.g. `/src/packs/mandarin`).
2. Define the language pack implementing `LanguagePack`:
   - Set up the level system (e.g., HSK 1–6 or CEFR A1–C2).
   - Implement `tokenize(text)`: use `Intl.Segmenter(lang, { granularity: 'word' })` or a language-specific WASM/JS tokenizer.
   - Implement `lookup(word)` with dictionary entries and meanings.
   - Specify OCR, STT, and TTS language tags.
3. Register the pack in `/src/packs/registry.ts`:
   ```typescript
   import { MandarinLanguagePack } from './mandarin';
   registry.set(MandarinLanguagePack.id, MandarinLanguagePack);
   ```
4. The pack will instantly appear in the top language dropdown and in the Language Packs manager!

---

## How to Build and Deploy as a PWA

### 1. Build the Production Bundle
```bash
npm run build
```
This generates the service worker (`dist/sw.js`) and precaches all assets according to `vite.config.ts`.

### 2. Preview Locally
```bash
npm run preview
```

### 3. Wrap with Capacitor or Tauri (Future Native Packaging)
- **Capacitor**:
  ```bash
  npm install @capacitor/core @capacitor/cli @capacitor/android
  npx cap init LinguaForge app.linguaforge
  npx cap add android
  npm run build && npx cap copy
  ```
- **Tauri**:
  ```bash
  cargo tauri init
  cargo tauri build
  ```

---

## Phase 1 Status Summary

### Fully Built & Polished:
1. **App Shell & Responsive Layout**: Desktop top bar + mobile thumb-friendly bottom navigation, dark/light theme switching, and PWA install buttons for Android/Windows/iOS Safari.
2. **Local-First Database (Dexie)**: Document library, word status tracker (new, learning, known, ignored), persistent lookup history, flashcard scaffolding, and settings.
3. **Language Pack Manager**: Pluggable registry, Japanese pack with JLPT N5–N1 levels, asset manifest with simulated streaming download progress bars and local cache management.
4. **Rich Interactive Reader**:
   - Tokenization via morphological/segmenter rules.
   - Furigana toggling (`always`, `hover`, `never`).
   - Word status highlighting (Known, Learning, New, Ignored).
   - Word Popup: readings, meanings, POS, JLPT badge, frequency rank, kanji breakdown with stroke counts/radicals, Tatoeba examples, TTS audio playback, "Mark as Known", and "Add to Flashcards".
   - Multi-word phrase selection with Gemini AI translation, literal breakdown, and nuance explanation (with offline & missing API key fallbacks).
   - File parsers supporting `.txt`, `.epub` (via JSZip), `.srt`, `.vtt`, and `.pdf` (via pdfjs-dist).
5. **Comprehension Stats**: % of words known, difficulty estimation, status distribution bar, and interactive unknown-words list.
6. **Lookup History**: Persistent timestamped logs, lookup frequency counters, surrounding sentence context, and CSV export.
7. **Backup & Restore**: Instant full JSON export and restore.
