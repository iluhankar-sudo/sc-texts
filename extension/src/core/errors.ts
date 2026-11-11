/** Разбор ошибок chrome.tabCapture. */
export type CaptureErrorKind = 'busy' | 'notAllowed' | 'other';

/**
 * busy — вкладку уже записывает кто-то ещё (демонстрация экрана «вкладка Chrome»,
 * другое расширение или наш прошлый захват): Chrome не даёт записывать вкладку дважды.
 * notAllowed — служебная страница Chrome или расширение не вызвано на этой вкладке.
 */
export function classifyCaptureError(err: unknown): CaptureErrorKind {
  const text = String((err as { message?: string })?.message ?? err);
  if (/active stream|already being captured|already captured/i.test(text)) return 'busy';
  if (/not been invoked|chrome pages|cannot be captured|activeTab/i.test(text)) return 'notAllowed';
  return 'other';
}
