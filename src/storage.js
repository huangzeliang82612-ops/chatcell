/**
 * 本地存储：
 *   - 设置（API Key / baseUrl / model / 主题 / 人格 / 额外参数）放 localStorage：小、同步读、启动快
 *   - 会话、消息、背景图放 IndexedDB：大、异步、不怕 localStorage 5MB 上限
 *
 * 不依赖任何第三方库，手写一层薄封装。
 */

const DB_NAME = 'chatcell'
const DB_VERSION = 2
const STORE_SESSIONS = 'sessions'
const STORE_ASSETS = 'assets'
const SETTINGS_KEY = 'chatcell.settings.v1'
const BACKGROUND_KEY = 'chat-background'

/* ------------------------------ settings ------------------------------ */

export const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  extraBody: '',
  temperature: '',
  sendOnEnter: true,
  /* 'dark' | 'light' */
  theme: 'dark',
  /* [{ id, name, prompt }] */
  personas: [],
  /* 当前生效的人格 id，空字符串表示不启用 */
  activePersonaId: ''
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw)
    const merged = { ...DEFAULT_SETTINGS, ...parsed }
    // 防御：老数据可能没有 personas 或格式不对
    if (!Array.isArray(merged.personas)) merged.personas = []
    if (merged.theme !== 'light') merged.theme = 'dark'
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch (err) {
    console.warn('保存设置失败', err)
  }
}

/** 取当前生效的人格对象，没有就返回 null */
export function getActivePersona(settings) {
  if (!settings || !settings.activePersonaId) return null
  const list = Array.isArray(settings.personas) ? settings.personas : []
  return list.find((p) => p.id === settings.activePersonaId) || null
}

/* ------------------------------ IndexedDB ------------------------------ */

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const store = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt')
      }
      if (!db.objectStoreNames.contains(STORE_ASSETS)) {
        db.createObjectStore(STORE_ASSETS)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

  return dbPromise
}

function store(name, mode) {
  return openDb().then((db) => db.transaction(name, mode).objectStore(name))
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** 会话对象结构：
 * { id, title, createdAt, updatedAt, messages: [{id, role, content, reasoning, createdAt}] }
 */

export async function listSessions() {
  const s = await store(STORE_SESSIONS, 'readonly')
  const all = await wrap(s.getAll())
  return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export async function getSession(id) {
  const s = await store(STORE_SESSIONS, 'readonly')
  return wrap(s.get(id))
}

export async function putSession(session) {
  const s = await store(STORE_SESSIONS, 'readwrite')
  await wrap(s.put(session))
  return session
}

export async function deleteSession(id) {
  const s = await store(STORE_SESSIONS, 'readwrite')
  await wrap(s.delete(id))
}

export async function clearAllSessions() {
  const s = await store(STORE_SESSIONS, 'readwrite')
  await wrap(s.clear())
}

/** 批量写入（导入用）。会合并同名 id 覆盖。 */
export async function bulkPutSessions(sessions) {
  const s = await store(STORE_SESSIONS, 'readwrite')
  for (const item of sessions) {
    if (!item || !item.id) continue
    await wrap(s.put(item))
  }
}

/* ------------------------------ 背景图 ------------------------------ */

/** 存背景图，接受 Blob */
export async function saveBackgroundBlob(blob) {
  const s = await store(STORE_ASSETS, 'readwrite')
  await wrap(s.put(blob, BACKGROUND_KEY))
}

/** 取背景图 Blob，没有则返回 null */
export async function loadBackgroundBlob() {
  try {
    const s = await store(STORE_ASSETS, 'readonly')
    const v = await wrap(s.get(BACKGROUND_KEY))
    return v || null
  } catch {
    return null
  }
}

/** 删除背景图 */
export async function deleteBackgroundBlob() {
  const s = await store(STORE_ASSETS, 'readwrite')
  await wrap(s.delete(BACKGROUND_KEY))
}

/* ------------------------------ helpers ------------------------------ */

export function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

export function createSession(title) {
  const now = Date.now()
  return {
    id: newId(),
    title: title || '新对话',
    createdAt: now,
    updatedAt: now,
    messages: []
  }
}

/** 用第一条用户消息生成标题 */
export function deriveTitle(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim()
  if (!t) return '新对话'
  return t.length > 18 ? t.slice(0, 18) + '…' : t
}
