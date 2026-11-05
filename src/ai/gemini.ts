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

