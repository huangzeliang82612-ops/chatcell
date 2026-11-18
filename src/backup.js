/**
 * 会话导入 / 导出。
 *
 * 导出：写进应用缓存目录 → 调系统分享面板（可以存到文件管理器、发微信、发邮件…）
 * 导入：由调用方用 <input type="file"> 读出文本，再交给 parseBackupText 解析
 *       （Capacitor 的 WebView 已实现 onShowFileChooser，原生文件选择器可以正常弹出）
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { newId } from './storage.js'

const BACKUP_APP = 'chatcell'
const BACKUP_VERSION = 1

/** 组装备份对象 */
export function buildBackup(sessions) {
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    count: sessions.length,
    sessions
  }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  )
}

/**
 * 导出全部会话，弹系统分享面板。
 * @returns {Promise<{filename:string, count:number}>}
 */
export async function exportSessions(sessions) {
  if (!sessions || sessions.length === 0) {
    throw new Error('还没有任何会话可以导出')
  }

  const payload = buildBackup(sessions)
  const json = JSON.stringify(payload, null, 2)
  const filename = 'chatcell-backup-' + stamp() + '.json'

  const written = await Filesystem.writeFile({
    path: filename,
    data: json,
    directory: Directory.Cache,
    encoding: Encoding.UTF8
  })

  await Share.share({
    title: 'ChatCell 会话备份',
    text: '共 ' + sessions.length + ' 个会话',
    url: written.uri,
    dialogTitle: '保存备份文件'
  })

  return { filename, count: sessions.length }
}

/**
 * 解析备份文本，返回规范化后的会话数组。
 * 兼容三种输入：
 *   1. { app, version, sessions: [...] }   本程序导出的格式
 *   2. [...]                                裸数组
 *   3. { sessions: [...] }                  只有 sessions 字段
 */
export function parseBackupText(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文件')
  }

  const list = Array.isArray(data) ? data : data && data.sessions
  if (!Array.isArray(list)) {
    throw new Error('文件里找不到会话数据（缺少 sessions 字段）')
  }

  const now = Date.now()
  const normalized = []

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const messages = Array.isArray(raw.messages) ? raw.messages : []
    const cleanMessages = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({
        id: m.id || newId(),
        role: m.role,
        content: m.content,
        reasoning: typeof m.reasoning === 'string' ? m.reasoning : '',
        createdAt: typeof m.createdAt === 'number' ? m.createdAt : now
      }))

    if (cleanMessages.length === 0) continue

    normalized.push({
      id: raw.id || newId(),
      title: typeof raw.title === 'string' && raw.title ? raw.title : '导入的会话',
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
      messages: cleanMessages
    })
  }

  if (normalized.length === 0) {
    throw new Error('文件里没有可用的会话（消息都是空的）')
  }

  return normalized
}
