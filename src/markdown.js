import { marked } from 'marked'

marked.setOptions({
  gfm: true,
  breaks: true
})

/** 极简消毒：干掉脚本、内联事件、javascript: 链接 */
function sanitize(html) {
  if (typeof DOMParser === 'undefined') return html
  try {
    const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html')
    const root = doc.getElementById('r')
    if (!root) return html

    root.querySelectorAll('script,style,iframe,object,embed,form,link,meta').forEach((el) => {
      el.remove()
    })

    root.querySelectorAll('*').forEach((el) => {
      // 去掉所有 on* 事件属性
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase()
        const value = (attr.value || '').trim().toLowerCase()
        if (name.startsWith('on')) el.removeAttribute(attr.name)
        if ((name === 'href' || name === 'src') && value.startsWith('javascript:')) {
          el.removeAttribute(attr.name)
        }
      })
    })

    return root.innerHTML
  } catch {
    return html
  }
}

export function renderMarkdown(md) {
  const text = md || ''
  try {
    const out = marked.parse(text)
    // marked 在同步模式下返回 string；万一返回 Promise 就退回纯文本
    if (typeof out !== 'string') return null
    return sanitize(out)
  } catch {
    return null
  }
}
