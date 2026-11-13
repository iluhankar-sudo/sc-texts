/** Classifying chrome.tabCapture errors. */
export type CaptureErrorKind = 'busy' | 'notAllowed' | 'other';

/**
 * busy - someone else is already recording the tab (screen sharing of a "Chrome tab",
 * another extension or our previous capture): Chrome doesn't allow recording a tab twice.
 * notAllowed - a Chrome internal page, or the extension wasn't invoked on this tab.
 */
export function classifyCaptureError(err: unknown): CaptureErrorKind {
  const text = String((err as { message?: string })?.message ?? err);
  if (/active stream|already being captured|already captured/i.test(text)) return 'busy';
  if (/not been invoked|chrome pages|cannot be captured|activeTab/i.test(text)) return 'notAllowed';
  return 'other';
}
