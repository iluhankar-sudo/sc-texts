import type { Config, Language, Mode } from './types.ts';

export const DEFAULT_CONFIG: Config = {
  mode: 'cloud',
  apiUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  apiModel: 'whisper-large-v3',
  elevenKey: '',
  audioshakeKey: '',
  openaiKey: '',
  deepseekKey: '',
  deepseekModel: 'deepseek-flash',
  translateModel: 'llama-3.3-70b-versatile',
  serverUrl: 'http://127.0.0.1:8000',
  language: 'auto',
  windowSec: 20,
  overlapSec: 4,
  syncOffsetMs: 0,
  linkSpeed: 0,
  simpleMode: false,
  uncensored: true,
  slang: true,
  customWords: '',
};

// The default key is substituted at build time (build.mjs, the DEFAULT_API_KEY variable); it's not in the sources.
declare const __DEFAULT_API_KEY__: string;
const BUILT_IN_KEY = typeof __DEFAULT_API_KEY__ !== 'undefined' ? __DEFAULT_API_KEY__ : '';

// The proxy (a Cloudflare Worker with the owner's key) is also substituted at build time
// (the PROXY_URL and APP_TOKEN variables). Users without their own key go through it.
declare const __PROXY_URL__: string;
declare const __APP_TOKEN__: string;
export const PROXY_URL = (typeof __PROXY_URL__ !== 'undefined' ? __PROXY_URL__ : '').replace(/\/+$/, '');
const APP_TOKEN = typeof __APP_TOKEN__ !== 'undefined' ? __APP_TOKEN__ : '';

/**
 * Where to send Groq requests (recognition, translation, correction):
 * own key (in settings or embedded) - directly; otherwise via the proxy; otherwise nowhere (null).
 */
export function groqEndpoint(cfg: Pick<Config, 'apiUrl' | 'apiKey'>): { url: string; headers: Record<string, string>; viaProxy: boolean } | null {
  if (cfg.apiKey) return { url: cfg.apiUrl, headers: { Authorization: `Bearer ${cfg.apiKey}` }, viaProxy: false };
  if (PROXY_URL) return { url: `${PROXY_URL}/v1`, headers: APP_TOKEN ? { 'X-SC-Texts': APP_TOKEN } : {}, viaProxy: true };
  return null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function num(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

/** Normalizes arbitrary saved settings into a valid shape. */
export function normalizeConfig(raw?: Record<string, unknown> | null): Config {
  const r = raw ?? {};
  const mode: Mode = r.mode === 'local' || r.mode === 'cloud' ? (r.mode as Mode) : DEFAULT_CONFIG.mode;
  const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d);
  const apiUrl = str(r.apiUrl, DEFAULT_CONFIG.apiUrl).replace(/\/+$/, '');
  const apiKey = typeof r.apiKey === 'string' && r.apiKey.trim() ? r.apiKey.trim() : BUILT_IN_KEY;
  const apiModel = str(r.apiModel, DEFAULT_CONFIG.apiModel);
  const elevenKey = typeof r.elevenKey === 'string' ? r.elevenKey.trim() : '';
  const audioshakeKey = typeof r.audioshakeKey === 'string' ? r.audioshakeKey.trim() : '';
  const openaiKey = typeof r.openaiKey === 'string' ? r.openaiKey.trim() : '';
  const deepseekKey = typeof r.deepseekKey === 'string' ? r.deepseekKey.trim() : '';
  const deepseekModel = str(r.deepseekModel, DEFAULT_CONFIG.deepseekModel);
  const translateModel = str(r.translateModel, DEFAULT_CONFIG.translateModel);
  const language: Language =
    r.language === 'ru' || r.language === 'en' || r.language === 'auto'
      ? (r.language as Language)
      : DEFAULT_CONFIG.language;
  let serverUrl =
    typeof r.serverUrl === 'string' && r.serverUrl.trim() ? r.serverUrl.trim() : DEFAULT_CONFIG.serverUrl;
  serverUrl = serverUrl.replace(/\/+$/, '');
  const windowSec = clamp(num(r.windowSec, DEFAULT_CONFIG.windowSec), 6, 30);
  const overlapSec = clamp(num(r.overlapSec, DEFAULT_CONFIG.overlapSec), 1, windowSec / 2);
  const linkSpeed = Math.round(clamp(num(r.linkSpeed, DEFAULT_CONFIG.linkSpeed), 0, 8));
  const simpleMode = r.simpleMode === true || r.simpleMode === 'true';
  const uncensored = !(r.uncensored === false || r.uncensored === 'false');
  const slang = !(r.slang === false || r.slang === 'false');
  const customWords = typeof r.customWords === 'string' ? r.customWords.slice(0, 2000) : '';
  const syncOffsetMs = clamp(num(r.syncOffsetMs, DEFAULT_CONFIG.syncOffsetMs), -3000, 3000);
  return { mode, apiUrl, apiKey, apiModel, elevenKey, audioshakeKey, openaiKey, deepseekKey, deepseekModel, translateModel, serverUrl, language, windowSec, overlapSec, syncOffsetMs, linkSpeed, simpleMode, uncensored, slang, customWords };
}
