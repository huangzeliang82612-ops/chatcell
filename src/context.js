/**
 * 上下文管理：滑动窗口 + 摘要压缩。
 *
 * 思路：
 *   消息不多时 —— 全量发送（cutIndex = 0）
 *   消息超阈值 —— 把"早期那一段"压缩成一段摘要，存进 session.summary，
 *                 之后每轮只发送 [摘要] + [最近 CONTEXT_KEEP 条消息]
 *
 * 这样既不丢关键信息，也不会让每轮请求无限膨胀。
 * 摘要调用失败时退化成纯滑动窗口，保证不会超限报错。
 */

import { completeOnce } from './api.js'

/** 保留最近多少条消息原样发送 */
export const CONTEXT_KEEP = 20

/** 超过多少条消息就触发压缩 */
export const CONTEXT_TRIGGER = 30

const SUMMARY_SYSTEM = `你是一个对话摘要助手。请把用户提供的对话记录压缩成一段简洁的中文摘要，不超过 300 字。

必须保留：
- 关键事实与背景信息
- 用户的偏好、要求、约定
- 已经得出的结论、做出的决定
- 尚未解决的问题

只输出摘要正文，不要任何解释、标题或前缀。`

/** 是否需要压缩 */
export function needsCompaction(messages) {
  return Array.isArray(messages) && messages.length > CONTEXT_TRIGGER
}

/**
 * 压缩早期对话。
 * @param {object} opts
 * @param {object|null} opts.summary  之前的摘要 { text, upTo }
 * @param {Array} opts.messages       当前全部消息
 * @returns {Promise<{summary: object|null, changed: boolean}>}
 */
export async function compactSession(opts) {
  const { apiKey, baseUrl, model, summary, messages } = opts

  const prevText = summary && typeof summary.text === 'string' ? summary.text : ''
  const prevUpTo = summary && typeof summary.upTo === 'number' ? summary.upTo : 0

  // 只压缩"最近 CONTEXT_KEEP 条"之前的部分
  const cut = Math.max(0, messages.length - CONTEXT_KEEP)

  // 没有新的可压缩内容
  if (cut <= prevUpTo) {
    return { summary: summary || null, changed: false }
  }

  const slice = messages.slice(prevUpTo, cut)
  if (slice.length === 0) {
    return { summary: summary || null, changed: false }
  }

  const transcript = slice
    .map((m) => (m.role === 'user' ? '用户：' : '助手：') + String(m.content || ''))
    .join('\n\n')

  const input =
    (prevText ? '【已有摘要】\n' + prevText + '\n\n' : '') +
    '【新对话】\n' +
    transcript

  const text = await completeOnce({
    apiKey,
    baseUrl,
    model,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: input }
    ],
    maxTokens: 500,
    temperature: 0.3
  })

  return {
    summary: { text, upTo: cut, updatedAt: Date.now() },
    changed: true
  }
}
