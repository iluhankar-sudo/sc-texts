/**
 * The extension was updated or reloaded while the page stayed open: the old content script copy
 * keeps running, but any chrome.* call throws "Extension context invalidated".
 * Such a copy must quietly shut down (the new one connects itself - see background, onInstalled).
 */
export function extensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}
