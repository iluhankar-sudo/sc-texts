/** Определение языка строки по алфавиту (проект поддерживает русский и английский). */
export function detectScriptLang(text: string): 'ru' | 'en' | null {
  const cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  if (!cyr && !lat) return null;
  return cyr >= lat ? 'ru' : 'en';
}

/** Базовый код языка браузера: "ru-RU" → "ru". */
export function baseLang(tag: string | undefined | null): string {
  return (tag || 'en').split(/[-_]/)[0]!.toLowerCase();
}

/** Название языка для интерфейса (на русском) и для подсказки модели (на английском). */
export function langName(code: string, locale = 'ru'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
