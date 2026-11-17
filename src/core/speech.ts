/**
 * Browser Web Speech API helper for Listening flashcards, word/sentence audio,
 * offline local-voice preference, chunked playback, and Anki TTS syntax.
 *
 * Note: Intentionally does NOT cache TTS audio bytes; relies solely on live
 * browser speechSynthesis voices and reports failures visibly to the UI.
 */

export interface SpeechVoiceOption {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
  isDefault: boolean;
  voice: SpeechSynthesisVoice;
}

export interface SelectVoiceResult {
  voice: SpeechVoiceOption | null;
  compatibleVoices: SpeechVoiceOption[];
  localVoices: SpeechVoiceOption[];
  offlineBlocked: boolean;
  usedLocalFallback: boolean;
  reason?: string;
}

export interface SpeakOptions {
  text: string;
  ttsCode: string;
  preferredVoiceId?: string;
  rate?: number;
  isOnline?: boolean;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

export const VOICE_INSTALL_GUIDES = {
  android: {
    title: 'Android',
    steps: [
      'Open device Settings → System → Languages & input → Text-to-speech output.',
      'Tap the gear icon next to Speech Recognition & Synthesis from Google.',
      'Tap Install voice data, choose the language, and download a voice for offline use.',
    ],
  },
  windows: {
    title: 'Windows 10 / 11',
    steps: [
      'Open Settings → Time & language → Speech (or Language & region → Add a language).',
      'Under Manage voices, select Add voices and pick the language.',
      'After download finishes, restart your browser so the new offline voice appears.',
    ],
  },
};

/**
 * Retains active SpeechSynthesisUtterance references until playback completes or
 * errors. Prevents Chromium / WebKit garbage collection from dropping `onend`.
 */
const activeUtterances = new Set<SpeechSynthesisUtterance>();
let activePlaybackToken = 0;
let activeCleanupFn: (() => void) | null = null;

export function isSpeechSynthesisSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.speechSynthesis?.speak === 'function' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

export function getBrowserOnlineStatus(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

export function normalizeLangTag(tag: string): string {
  return (tag || '').trim().replace(/_/g, '-').toLowerCase();
}

export function getPrimaryLangSubtag(tag: string): string {
  const norm = normalizeLangTag(tag);
  return norm.split('-')[0] || '';
}

export function toSpeechVoiceOption(voice: SpeechSynthesisVoice): SpeechVoiceOption {
  return {
    voiceURI: voice.voiceURI || voice.name,
    name: voice.name,
    lang: voice.lang || '',
    localService: Boolean(voice.localService),
    isDefault: Boolean(voice.default),
    voice,
  };
}

/**
 * Reads available voices from speechSynthesis, awaiting `voiceschanged` if the
 * initial synchronous list is empty (Chrome/Edge load voices asynchronously).
 */
export function loadAvailableVoices(timeoutMs = 1500): Promise<SpeechVoiceOption[]> {
  if (!isSpeechSynthesisSupported()) {
    return Promise.resolve([]);
  }

  const synth = window.speechSynthesis;
  const initial = synth.getVoices();
  if (initial && initial.length > 0) {
    return Promise.resolve(initial.map(toSpeechVoiceOption));
  }

  return new Promise((resolve) => {
    let settled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timerId !== null) clearTimeout(timerId);
      if (pollId !== null) clearInterval(pollId);
      if (typeof synth.removeEventListener === 'function') {
        synth.removeEventListener('voiceschanged', onVoicesChanged);
      }
      const list = synth.getVoices() || [];
      resolve(list.map(toSpeechVoiceOption));
    };

    const onVoicesChanged = () => {
      const list = synth.getVoices();
      if (list && list.length > 0) {
        finish();
      }
    };

    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', onVoicesChanged);
    }

    // Some mobile WebViews populate getVoices() without firing voiceschanged reliably
    pollId = setInterval(() => {
      const list = synth.getVoices();
      if (list && list.length > 0) {
        finish();
      }
    }, 150);

    timerId = setTimeout(finish, timeoutMs);
  });
}

/**
 * Filters and sorts voices matching the target language (exact locale first, then
 * primary language subtag, preferring local/offline voices over network voices).
 */
export function getVoicesForLanguage(
  voices: SpeechVoiceOption[],
  ttsCode: string
): SpeechVoiceOption[] {
  const targetFull = normalizeLangTag(ttsCode);
  const targetPrimary = getPrimaryLangSubtag(ttsCode);
  if (!targetPrimary) return [];

  const compatible = voices.filter((v) => {
    const vFull = normalizeLangTag(v.lang);
    const vPrimary = getPrimaryLangSubtag(v.lang);
    return vFull === targetFull || vPrimary === targetPrimary;
  });

  return [...compatible].sort((a, b) => {
    const aExact = normalizeLangTag(a.lang) === targetFull ? 0 : 1;
    const bExact = normalizeLangTag(b.lang) === targetFull ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    // Prefer local voices before network voices
    if (a.localService !== b.localService) return a.localService ? -1 : 1;

    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Selects the best voice for playback given user preference and online state.
 * When offline (`isOnline === false`), prefers `localService` voices and flags
 * `offlineBlocked: true` if only network voices exist for the language.
 */
export function selectVoiceForSpeech(params: {
  voices: SpeechVoiceOption[];
  ttsCode: string;
  preferredVoiceId?: string;
  isOnline?: boolean;
}): SelectVoiceResult {
  const { voices, ttsCode, preferredVoiceId, isOnline = true } = params;
  const compatibleVoices = getVoicesForLanguage(voices, ttsCode);
  const localVoices = compatibleVoices.filter((v) => v.localService);

  if (compatibleVoices.length === 0) {
    return {
      voice: null,
      compatibleVoices: [],
      localVoices: [],
      offlineBlocked: false,
      usedLocalFallback: false,
      reason: `No TTS voice is installed for ${ttsCode}. Install a voice on your device in Settings → Speech.`,
    };
  }

  const preferred = preferredVoiceId
    ? compatibleVoices.find(
        (v) => v.voiceURI === preferredVoiceId || v.name === preferredVoiceId
      ) || null
    : null;

  if (!isOnline) {
    if (localVoices.length === 0) {
      return {
        voice: null,
        compatibleVoices,
        localVoices,
        offlineBlocked: true,
        usedLocalFallback: false,
        reason:
          'You are offline and only network-based TTS voices are available for this language, so audio cannot play offline. Connect to the internet or install an offline device voice.',
      };
    }

    if (preferred && preferred.localService) {
      return {
        voice: preferred,
        compatibleVoices,
        localVoices,
        offlineBlocked: false,
        usedLocalFallback: false,
      };
    }

    return {
      voice: localVoices[0],
      compatibleVoices,
      localVoices,
      offlineBlocked: false,
      usedLocalFallback: Boolean(preferred && !preferred.localService),
    };
  }

  return {
    voice: preferred || compatibleVoices[0],
    compatibleVoices,
    localVoices,
    offlineBlocked: false,
    usedLocalFallback: false,
  };
}

/**
 * Splits long text into <= maxLen chunks on natural sentence/clause boundaries
 * to prevent Chrome and Android TTS engines from truncating or hanging on long strings.
 */
export function chunkSpeechText(text: string, maxLen = 150): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxLen) return [cleaned];

  const chunks: string[] = [];
  let remaining = cleaned;

  while (remaining.length > maxLen) {
    const windowSlice = remaining.slice(0, maxLen);

    // 1. Prefer sentence-ending punctuation
    let splitIdx = -1;
    const sentencePunctMatches = Array.from(windowSlice.matchAll(/[。！？.!?]+/g));
    if (sentencePunctMatches.length > 0) {
      const last = sentencePunctMatches[sentencePunctMatches.length - 1];
      if (last.index !== undefined) {
        splitIdx = last.index + last[0].length;
      }
    }

    // 2. Fallback to clause punctuation / comma / whitespace
    if (splitIdx <= 0) {
      const clauseMatches = Array.from(windowSlice.matchAll(/[、，,;；:\s]+/g));
      if (clauseMatches.length > 0) {
        const last = clauseMatches[clauseMatches.length - 1];
        if (last.index !== undefined && last.index > 0) {
          splitIdx = last.index + last[0].length;
        }
      }
    }

    // 3. Hard split as last resort if unbroken string
    if (splitIdx <= 0) {
      splitIdx = maxLen;
    }

    const part = remaining.slice(0, splitIdx).trim();
    if (part) chunks.push(part);
    remaining = remaining.slice(splitIdx).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function mapSpeechSynthesisErrorCode(errorCode?: string): string {
  switch (errorCode) {
    case 'not-allowed':
      return 'Browser blocked automatic audio playback. Tap Play to listen.';
    case 'audio-busy':
    case 'audio-hardware':
      return 'Audio output is currently busy or unavailable.';
    case 'network':
      return 'Network voice failed to load. Check your connection or switch to a local offline voice.';
    case 'synthesis-unavailable':
    case 'synthesis-failed':
      return 'Text-to-speech engine failed to synthesize this phrase.';
    case 'language-unavailable':
    case 'voice-unavailable':
      return 'No compatible voice is currently available for this language.';
    case 'canceled':
    case 'interrupted':
      return 'Playback was interrupted.';
    default:
      return errorCode
        ? `Speech playback failed (${errorCode}).`
        : 'Speech playback failed.';
  }
}

export function stopActiveSpeech(): void {
  activePlaybackToken++;
  if (activeCleanupFn) {
    const fn = activeCleanupFn;
    activeCleanupFn = null;
    fn();
  }
  activeUtterances.clear();
  if (isSpeechSynthesisSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore cancel exceptions from uninitialized WebViews
    }
  }
}

/**
 * Speaks text reliably using Web Speech API:
 * - Awaits voice population when voices load asynchronously
 * - Prefers local voices offline and fails clearly if only network voices exist
 * - Chunks long text safely
 * - Keeps utterance refs alive in `activeUtterances`
 * - Reports interruptions on tab hide and errors visibly via `onError`
 * Returns a cancel function.
 */
export function speakWithReliability(options: SpeakOptions): () => void {
  const {
    text,
    ttsCode,
    preferredVoiceId,
    rate = 1.0,
    isOnline = getBrowserOnlineStatus(),
    onStart,
    onEnd,
    onError,
  } = options;

  stopActiveSpeech();
  const token = ++activePlaybackToken;

  const trimmed = (text || '').trim();
  if (!trimmed) {
    onError?.('Nothing to speak on this card.');
    return () => {};
  }

  if (!isSpeechSynthesisSupported()) {
    onError?.(
      'Text-to-speech is not supported in this browser, so listening audio cannot play.'
    );
    return () => {};
  }

  const chunks = chunkSpeechText(trimmed, 150);
  const clampedRate = Math.max(0.5, Math.min(2.0, Number.isFinite(rate) ? rate : 1.0));
  let cancelled = false;
  let started = false;
  let visibilityHandler: (() => void) | null = null;

  const cleanupListeners = () => {
    if (visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = null;
    }
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    cleanupListeners();
    activeUtterances.clear();
    if (token === activePlaybackToken && isSpeechSynthesisSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore
      }
    }
  };

  activeCleanupFn = cleanupListeners;

  if (typeof document !== 'undefined') {
    visibilityHandler = () => {
      if (document.visibilityState === 'hidden' && !cancelled && token === activePlaybackToken) {
        cancelled = true;
        cleanupListeners();
        try {
          window.speechSynthesis.cancel();
        } catch {
          // Ignore
        }
        activeUtterances.clear();
        onError?.('Playback paused when the tab went to the background. Tap Retry to play.');
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }

  void (async () => {
    const voices = await loadAvailableVoices(1200);
    if (cancelled || token !== activePlaybackToken) return;

    const selection =
      voices.length > 0
        ? selectVoiceForSpeech({
            voices,
            ttsCode,
            preferredVoiceId,
            isOnline,
          })
        : {
            voice: null,
            compatibleVoices: [],
            localVoices: [],
            offlineBlocked: false,
            usedLocalFallback: false,
          };

    if (selection.offlineBlocked) {
      cleanupListeners();
      onError?.(selection.reason || 'Offline: network-only TTS voice cannot play offline.');
      return;
    }

    if (voices.length > 0 && selection.compatibleVoices.length === 0) {
      cleanupListeners();
      onError?.(
        selection.reason ||
          `No TTS voice is installed for ${ttsCode}. Install a voice in Settings → Speech.`
      );
      return;
    }

    const synth = window.speechSynthesis;
    try {
      synth.cancel();
    } catch {
      // Ignore
    }

    const speakChunkAt = (index: number) => {
      if (cancelled || token !== activePlaybackToken) return;
      if (index >= chunks.length) {
        cleanupListeners();
        activeUtterances.clear();
        onEnd?.();
        return;
      }

      const utterance = new window.SpeechSynthesisUtterance(chunks[index]);
      utterance.lang = selection.voice?.lang || ttsCode;
      if (selection.voice) {
        utterance.voice = selection.voice.voice;
      }
      utterance.rate = clampedRate;
      activeUtterances.add(utterance);

      utterance.onstart = () => {
        if (cancelled || token !== activePlaybackToken) return;
        if (!started) {
          started = true;
          onStart?.();
        }
      };

      utterance.onend = () => {
        activeUtterances.delete(utterance);
        if (cancelled || token !== activePlaybackToken) return;
        speakChunkAt(index + 1);
      };

      utterance.onerror = (ev: SpeechSynthesisErrorEvent) => {
        activeUtterances.delete(utterance);
        if (cancelled || token !== activePlaybackToken) return;
        const errCode = (ev as any)?.error as string | undefined;
        // If user explicitly called cancel/stop elsewhere, don't report error
        if (errCode === 'canceled' && cancelled) return;
        cancelled = true;
        cleanupListeners();
        onError?.(mapSpeechSynthesisErrorCode(errCode));
      };

      try {
        synth.speak(utterance);
      } catch (err: any) {
        activeUtterances.delete(utterance);
        cancelled = true;
        cleanupListeners();
        onError?.(err?.message || 'Unable to start speech synthesis.');
      }
    };

    speakChunkAt(0);
  })();

  return cancel;
}

/**
 * Formats an Anki 2.1.20+ {{tts ...}} field tag using underscore locale format,
 * e.g. `ja-JP` -> `{{tts ja_JP:AudioText}}`.
 */
export function formatAnkiTtsTag(ttsCode: string, fieldName = 'AudioText'): string {
  const normalized = (ttsCode || 'ja-JP').trim().replace(/-/g, '_');
  return `{{tts ${normalized}:${fieldName}}}`;
}
