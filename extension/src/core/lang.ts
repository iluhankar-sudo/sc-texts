/** Detecting a line's language by alphabet (the project supports Russian and English). */
export function detectScriptLang(text: string): 'ru' | 'en' | null {
  const cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  if (!cyr && !lat) return null;
  return cyr >= lat ? 'ru' : 'en';
}

/** Base browser language code: "ru-RU" → "ru". */
export function baseLang(tag: string | undefined | null): string {
  return (tag || 'en').split(/[-_]/)[0]!.toLowerCase();
}

/** Language name for the UI (in Russian) and for the model prompt (in English). */
export function langName(code: string, locale = 'ru'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
