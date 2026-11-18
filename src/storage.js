/**
 * 本地存储：
 *   - 设置（API Key / baseUrl / model / 额外参数）放 localStorage：小、同步读、启动快
 *   - 会话与消息放 IndexedDB：大、异步、不怕 localStorage 5MB 上限
 *
 * 不依赖任何第三方库，手写一层薄封装。
 */

const DB_NAME = 'chatcell'
const DB_VERSION = 1
const STORE = 'sessions'
const SETTINGS_KEY = 'chatcell.settings.v1'

/* ------------------------------ settings ------------------------------ */

export const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  extraBody: '',
  temperature: '',
  sendOnEnter: true
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_SETTINGS, ...parsed }
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
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

  return dbPromise
}

function tx(mode) {
  return openDb().then((db) => db.transaction(STORE, mode).objectStore(STORE))
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
  const store = await tx('readonly')
  const all = await wrap(store.getAll())
  return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export async function getSession(id) {
  const store = await tx('readonly')
  return wrap(store.get(id))
}

export async function putSession(session) {
  const store = await tx('readwrite')
  await wrap(store.put(session))
  return session
}

export async function deleteSession(id) {
  const store = await tx('readwrite')
  await wrap(store.delete(id))
}

export async function clearAllSessions() {
  const store = await tx('readwrite')
  await wrap(store.clear())
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
