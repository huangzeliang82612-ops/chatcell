/**
 * DeepSeek API 流式对话封装。
 *
 * 设计要点：
 * 1. 浏览器/WebView 直连，不经过任何中间服务器。
 * 2. 用 fetch + ReadableStream 手动解析 SSE，不用 EventSource
 *    （EventSource 只能发 GET，无法带 body 和 Authorization）。
 * 3. 支持 AbortSignal，实现"停止生成"。
 * 4. 同时吐出 content 与 reasoning_content（深度思考），由上层决定怎么展示。
 */

export const DEFAULT_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_MODEL = 'deepseek-chat'

/** 归一化 baseUrl：去掉结尾斜杠，补齐 /v1 由调用方负责 */
export function normalizeBaseUrl(baseUrl) {
  return (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
}

/**
 * 拼出 chat/completions 地址。
 * 兼容三种写法：
 *   https://api.deepseek.com            -> https://api.deepseek.com/chat/completions
 *   https://api.deepseek.com/v1         -> https://api.deepseek.com/v1/chat/completions
 *   https://api.deepseek.com/v1/chat/completions -> 原样使用
 */
export function buildEndpoint(baseUrl) {
  const base = normalizeBaseUrl(baseUrl)
  if (/\/chat\/completions$/.test(base)) return base
  return base + '/chat/completions'
}

/**
 * 流式请求。
 * @returns {AsyncGenerator<{type:'content'|'reasoning'|'usage', text?:string, usage?:object}>}
 */
export async function* streamChat(options) {
  const {
    apiKey,
    baseUrl,
    model,
    messages,
    signal,
    extraBody = null,
    temperature = null
  } = options

  if (!apiKey) {
    throw new Error('还没有填 API Key，点右上角设置填一个吧')
  }

  const body = {
    model: model || DEFAULT_MODEL,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true
  }

  if (typeof temperature === 'number') body.temperature = temperature

  // 允许用户塞自定义参数（例如深度思考开关），原样合并
  if (extraBody && typeof extraBody === 'object') {
    Object.assign(body, extraBody)
  }

  let response
  try {
    response = await fetch(buildEndpoint(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify(body),
      signal
    })
  } catch (err) {
    if (err && err.name === 'AbortError') return
    // 网络层失败最常见的原因：CORS 被拦、代理不通、飞行模式
    throw new Error(
      '请求发不出去：' +
        (err && err.message ? err.message : String(err)) +
        '（如果是刚装好第一次用，先确认手机能上网；若是浏览器里调试，注意 CORS 可能被拦）'
    )
  }

  if (!response.ok) {
    let detail = ''
    try {
      const text = await response.text()
      try {
        const json = JSON.parse(text)
        detail = json?.error?.message || text
      } catch {
        detail = text
      }
    } catch {
      detail = '(无法读取响应体)'
    }
    const hint =
      response.status === 401
        ? 'API Key 不对或已失效'
        : response.status === 402
          ? '账户余额不足'
          : response.status === 429
            ? '请求太频繁，稍等一下'
            : '服务端返回错误'
    throw new Error(hint + ' [' + response.status + '] ' + detail.slice(0, 500))
  }

  if (!response.body) {
    throw new Error('这个 WebView 不支持流式响应，请升级 Android System WebView')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE 以空行分帧；这里按行处理，遇到半截行就留在 buffer 里
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)

        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith(':')) continue // SSE 注释/心跳
        if (!line.startsWith('data:')) continue

        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return

        let json
        try {
          json = JSON.parse(payload)
        } catch {
          continue // 半截 JSON，丢掉这一帧
        }

        if (json.usage) {
          yield { type: 'usage', usage: json.usage }
        }

        const choice = json.choices && json.choices[0]
        if (!choice) continue
        const delta = choice.delta || {}

        if (delta.reasoning_content) {
          yield { type: 'reasoning', text: delta.reasoning_content }
        }
        if (delta.content) {
          yield { type: 'content', text: delta.content }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
}

/** 非流式，用来做"测试连接"按钮 */
export async function pingApi({ apiKey, baseUrl, model }) {
  const res = await fetch(buildEndpoint(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    })
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error('[' + res.status + '] ' + t.slice(0, 300))
  }
  return true
}
