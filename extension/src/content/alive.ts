/**
 * Расширение обновили или перезагрузили, а страница осталась открытой: старая копия content script
 * продолжает работать, но любое обращение к chrome.* бросает «Extension context invalidated».
 * Такая копия должна тихо отключиться (новая подключится сама — см. background, onInstalled).
 */
export function extensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}
