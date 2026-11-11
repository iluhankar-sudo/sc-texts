import { normalizeConfig } from './core/config.ts';
import { applyI18n, t } from './core/i18n.ts';

applyI18n();
document.title = t('optTitle');

const ids = ['mode', 'apiUrl', 'apiKey', 'apiModel', 'elevenKey', 'audioshakeKey', 'openaiKey', 'deepseekKey', 'deepseekModel', 'translateModel', 'serverUrl', 'language', 'windowSec', 'overlapSec', 'syncOffsetMs', 'linkSpeed', 'simpleMode', 'uncensored', 'slang', 'customWords'] as const;
const el = (id: string) => document.getElementById(id) as HTMLInputElement;

async function load() {
  const cfg = normalizeConfig(await chrome.storage.local.get(null));
  // Своя модель (не из списка) — добавляем её в выпадающий список, чтобы не потерять.
  const sel = document.getElementById('apiModel') as HTMLSelectElement;
  if (![...sel.options].some((o) => o.value === cfg.apiModel)) sel.add(new Option(cfg.apiModel, cfg.apiModel));
  for (const id of ids) el(id).value = String(cfg[id]);
}

async function save() {
  const raw: Record<string, unknown> = {};
  for (const id of ids) raw[id] = el(id).value;
  const cfg = normalizeConfig(raw);
  await chrome.storage.local.set(cfg);
  for (const id of ids) el(id).value = String(cfg[id]);
  const badge = document.getElementById('saved')!;
  badge.classList.add('on');
  setTimeout(() => badge.classList.remove('on'), 1500);
}

document.getElementById('save')!.addEventListener('click', () => {
  // AudioShake отдаёт результат ссылками на своё хранилище — просим доступ сразу в обработчике клика.
  if (el('audioshakeKey').value.trim()) chrome.permissions?.request({ origins: ['https://*/*'] }).catch(() => {});
  void save();
});

// Отчёт для разработчика: журнал последнего распознавания + настройки без ключей.
document.getElementById('report')!.addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const msg = document.getElementById('reportMsg')!;
  const log = typeof all.debugLog === 'string' ? all.debugLog : '';
  if (!log && typeof all.lookupLog !== 'string') {
    msg.textContent = t('optReportEmpty');
    return;
  }
  const cfg = normalizeConfig(all) as unknown as Record<string, unknown>;
  for (const k of ['apiKey', 'elevenKey', 'audioshakeKey', 'openaiKey', 'deepseekKey']) cfg[k] = cfg[k] ? '(задан)' : '(нет)';
  const text = [
    `sc texts ${chrome.runtime.getManifest().version} · ${navigator.userAgent}`,
    `настройки: ${JSON.stringify(cfg)}`,
    typeof all.lookupLog === 'string' ? all.lookupLog : '',
    '--- журнал ---',
    log,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    msg.textContent = t('optReportCopied');
  } catch {
    msg.textContent = text.slice(0, 200);
  }
});
void load();
