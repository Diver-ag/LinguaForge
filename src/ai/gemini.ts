import { GoogleGenAI } from '@google/genai';
import { db } from '../db/db';
import { logEvent } from '../core/eventLogger';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

// In-memory cache for fast lookups
const aiCache = new Map<string, { result: any; timestamp: number }>();

export async function getStoredApiKey(): Promise<string> {
  try {
    const setting = await db.settings.get('geminiApiKey');
    const dbKey = setting?.value?.trim() || '';
    if (dbKey) return dbKey;

    // Check system environment variable if set (never displayed in UI)
    if (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) {
      return process.env.GEMINI_API_KEY.trim();
    }
    return '';
  } catch {
    return '';
  }
}

export async function setStoredApiKey(key: string): Promise<void> {
  await db.settings.put({ key: 'geminiApiKey', value: key.trim() });
  // Never log the key value
  await logEvent('api_key_updated', { hasKey: !!key.trim() });
}

export async function getStoredModel(): Promise<string> {
  try {
    const setting = await db.settings.get('geminiModel');
    return setting?.value?.trim() || DEFAULT_GEMINI_MODEL;
  } catch {
    return DEFAULT_GEMINI_MODEL;
  }
}

export async function setStoredModel(model: string): Promise<void> {
  const cleanModel = model.trim() || DEFAULT_GEMINI_MODEL;
  await db.settings.put({ key: 'geminiModel', value: cleanModel });
  await logEvent('gemini_model_updated', { model: cleanModel });
}

export interface ParsedGeminiError {
  isModelNotFound: boolean;
  message: string;
  statusCode?: number;
}

/**
 * Parses Gemini API error objects and raw JSON strings into human-readable messages.
 * Detects 404 NOT_FOUND model unavailability errors.
 */
export function parseGeminiError(err: any): ParsedGeminiError {
  if (!err) {
    return { isModelNotFound: false, message: 'An unknown error occurred with the AI service.' };
  }

  let rawMessage = typeof err === 'string' ? err : err.message || String(err);
  let status = err.status || err.code || err.statusCode;
  let errorObj: any = null;

  try {
    if (typeof err === 'object' && err.error) {
      errorObj = err.error;
    } else {
      const jsonMatch = rawMessage.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        errorObj = parsed.error || parsed;
      }
    }
  } catch {
    // Ignore JSON parsing errors
  }

  if (errorObj) {
    if (errorObj.code) status = errorObj.code;
    if (errorObj.status === 'NOT_FOUND') status = 404;
    if (errorObj.message) rawMessage = errorObj.message;
  }

  // Detect 404 NOT_FOUND or model retirement/unavailability
  const notFoundIndicators = [
    status === 404,
    errorObj?.status === 'NOT_FOUND',
    /not[ _]found/i.test(rawMessage),
    /is no longer available/i.test(rawMessage),
    /model.*is not found/i.test(rawMessage),
    /models\/.*not found/i.test(rawMessage),
  ];

  if (notFoundIndicators.some(Boolean)) {
    return {
      isModelNotFound: true,
      message: 'This model is unavailable. Pick another one in Settings',
      statusCode: 404,
    };
  }

  // Strip prefixes and unneeded wrapper text
  let cleanMsg = rawMessage
    .replace(/^ApiError:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();

  if (cleanMsg.startsWith('{') && cleanMsg.endsWith('}')) {
    try {
      const inner = JSON.parse(cleanMsg);
      if (inner.error?.message) {
        cleanMsg = inner.error.message;
      }
    } catch {
      // Keep cleanMsg
    }
  }

  return {
    isModelNotFound: false,
    message: cleanMsg || 'Could not reach AI service. Please check your network or try another model.',
    statusCode: status,
  };
}

/**
 * Calls ListModels endpoint (GET https://generativelanguage.googleapis.com/v1beta/models)
 * filters for models that support generateContent, and strips the "models/" prefix.
 */
export async function fetchAvailableModels(userApiKey?: string): Promise<string[]> {
  const apiKey = userApiKey || (await getStoredApiKey());
  if (!apiKey) {
    return [DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.1-flash-lite'];
  }

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!res.ok) {
      const text = await res.text();
      const parsed = parseGeminiError(text);
      throw new Error(parsed.message);
    }

    const data = await res.json();
    if (Array.isArray(data.models)) {
      const filtered = data.models
        .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m: any) => (m.name || '').replace(/^models\//, ''))
        .filter(Boolean);

      if (filtered.length > 0) {
        return filtered;
      }
    }

    return [DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.1-flash-lite'];
  } catch (err: any) {
    const parsed = parseGeminiError(err);
    throw new Error(parsed.message);
  }
}

export interface PhraseTranslationResult {
  phrase: string;
  literalTranslation: string;
  naturalTranslation: string;
  nuanceExplanation: string;
  breakdown: { component: string; meaning: string }[];
}

export async function translateAndExplainPhrase(
  phrase: string,
  surroundingSentence?: string,
  languageName = 'Japanese'
): Promise<PhraseTranslationResult> {
  const geminiModel = await getStoredModel();
  const cacheKey = `trans:${geminiModel}:${phrase}:${surroundingSentence || ''}`;
  const cached = aiCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 1000 * 60 * 60 * 24) {
    return cached.result;
  }

  const apiKey = await getStoredApiKey();
  if (!apiKey) {
    throw new Error('NO_API_KEY');
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('OFFLINE');
  }

  const prompt = `You are an expert language teacher and translator for ${languageName}.
Analyze the selected phrase: "${phrase}"
${surroundingSentence ? `Surrounding sentence context: "${surroundingSentence}"` : ''}

Respond ONLY with valid JSON in this exact structure without markdown backticks:
{
  "phrase": "${phrase.replace(/"/g, '\\"')}",
  "literalTranslation": "direct literal meaning",
  "naturalTranslation": "natural, contextual English translation",
  "nuanceExplanation": "concise explanation of cultural nuance, formality, or grammatical construct",
  "breakdown": [
    {"component": "sub-part", "meaning": "meaning of component"}
  ]
}`;

  let lastError: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: geminiModel,
        contents: prompt,
      });

      const rawText = response.text || '';
      const cleanJson = rawText.replace(/```json\n?|\n?```/g, '').trim();
      const parsed: PhraseTranslationResult = JSON.parse(cleanJson);

      aiCache.set(cacheKey, { result: parsed, timestamp: Date.now() });
      await logEvent('ai_phrase_translated', { phrase, model: geminiModel, success: true });

      return parsed;
    } catch (err: any) {
      lastError = err;
      const parsedErr = parseGeminiError(err);
      if (parsedErr.isModelNotFound) {
        // Do not retry 404 model errors
        break;
      }
      if ((err?.message?.includes('429') || err?.status === 429) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      break;
    }
  }

  const parsedErr = parseGeminiError(lastError);
  await logEvent('ai_phrase_translate_failed', { phrase, model: geminiModel, error: parsedErr.message });

  const customErr: any = new Error(parsedErr.message);
  customErr.isModelNotFound = parsedErr.isModelNotFound;
  customErr.statusCode = parsedErr.statusCode;
  throw customErr;
}
