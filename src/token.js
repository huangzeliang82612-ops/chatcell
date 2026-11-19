/**
 * 粗糙的 token 估算。
 *
 * 目的不是精确（精确要上 tokenizer，几十 KB 的包有点重），
 * 而是给用户一个量级参考：这一轮大概占了多少上下文。
 *
 * 规则：
 *   CJK 字符（中日韩）按 1 字 ≈ 1 token
 *   其余字符 按 4 字符 ≈ 1 token
 * 每条消息再补一点角色/分隔开销。
 */

export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  let other = 0

  for (const ch of String(text)) {
    const code = ch.codePointAt(0)
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // 中日韩统一表意文字
      (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
      (code >= 0x3040 && code <= 0x30ff) || // 日文假名
      (code >= 0xac00 && code <= 0xd7af) // 韩文
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }

  return Math.ceil(cjk + other / 4)
}

/** 估算一组消息的 token 总量（只算 content，reasoning 不参与下一轮） */
export function estimateMessagesTokens(messages) {
  let total = 0
  for (const m of messages || []) {
    total += estimateTokens(m && m.content) + 4
  }
  return total
}

/** 把数字格式化成 1.2k / 168k / 850 这种 */
export function formatTokens(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v < 1000) return String(Math.round(v))
  const k = v / 1000
  return (k < 10 ? k.toFixed(1) : String(Math.round(k))) + 'k'
}
