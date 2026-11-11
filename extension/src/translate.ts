import { groqEndpoint } from './core/config.ts';
/**
 * Перевод строк песни на язык браузера.
 * 1) Встроенный переводчик Chrome (Translator API, Chrome 138+): работает на устройстве.
 * 2) Запасной вариант: чат-модель Groq/OpenAI-совместимого API с тем же ключом.
 */
import { detectScriptLang, langName } from './core/lang.ts';
import type { Config } from './core/types.ts';
import { t } from './core/i18n.ts';

interface TranslatorLike {
  translate(text: string): Promise<string>;
}
interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(o: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }): Promise<TranslatorLike>;
}

const builtins = new Map<string, Promise<TranslatorLike | null>>();

function getBuiltin(src: string, tgt: string, onProgress?: (p: number) => void): Promise<TranslatorLike | null> {
  const key = `${src}>${tgt}`;
  let p = builtins.get(key);
  if (!p) {
    p = (async () => {
      const T = (globalThis as unknown as { Translator?: TranslatorStatic }).Translator;
      if (!T?.create) return null;
      try {
        if ((await T.availability({ sourceLanguage: src, targetLanguage: tgt })) === 'unavailable') return null;
        return await T.create({
          sourceLanguage: src,
          targetLanguage: tgt,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => onProgress?.((e as unknown as { loaded: number }).loaded));
          },
        });
      } catch {
        return null;
      }
    })();
    builtins.set(key, p);
    // Неудачу не запоминаем: модель могла не скачаться без клика пользователя.
    void p.then((t) => {
      if (!t) builtins.delete(key);
    });
  }
  return p;
}

async function translateViaApi(texts: string[], tgt: string, cfg: Config): Promise<string[]> {
  const groq = cfg.mode === 'cloud' ? groqEndpoint(cfg) : null;
  if (!groq) throw new Error(t('noTranslator'));
  const target = langName(tgt, 'en');
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += 40) {
    const batch = texts.slice(i, i + 40);
    const r = await fetch(`${groq.url}/chat/completions`, {
      method: 'POST',
      headers: { ...groq.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.translateModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              `You translate song lyrics line by line into ${target}. Keep the meaning, tone and slang natural; ` +
              `do not explain or add anything. The user sends a JSON array of lines. ` +
              `Reply only with JSON {"t": [...]} containing exactly ${batch.length} translated lines in the same order.`,
          },
          { role: 'user', content: JSON.stringify(batch) },
        ],
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    const parsed = JSON.parse(j?.choices?.[0]?.message?.content ?? '{}') as { t?: unknown };
    const lines = Array.isArray(parsed.t) ? parsed.t.map((x) => String(x ?? '')) : [];
    if (lines.length !== batch.length) throw new Error(t('partialTranslation'));
    out.push(...lines);
  }
  return out;
}

/** Переводит строки, которые не на языке tgt. Возвращает карту «оригинал → перевод». */
export async function translateLines(
  texts: string[],
  tgt: string,
  cfg: Config,
  onProgress?: (p: number) => void,
): Promise<Map<string, string>> {
  const groups = new Map<string, string[]>();
  for (const t of new Set(texts)) {
    const src = detectScriptLang(t);
    if (!src || src === tgt) continue;
    const g = groups.get(src) ?? [];
    g.push(t);
    groups.set(src, g);
  }
  const result = new Map<string, string>();
  for (const [src, items] of groups) {
    const tr = await getBuiltin(src, tgt, onProgress);
    if (tr) {
      for (const t of items) result.set(t, (await tr.translate(t)).trim());
    } else {
      const translated = await translateViaApi(items, tgt, cfg);
      items.forEach((t, i) => result.set(t, translated[i]!.trim()));
    }
  }
  return result;
}
