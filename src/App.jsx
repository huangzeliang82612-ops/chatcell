import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { streamChat, pingApi, DEFAULT_BASE_URL, DEFAULT_MODEL } from './api.js'
import {
  bulkPutSessions,
  clearAllSessions,
  createSession,
  deleteBackgroundBlob,
  deleteSession,
  deriveTitle,
  getActivePersona,
  listSessions,
  loadBackgroundBlob,
  loadSettings,
  newId,
  putSession,
  saveBackgroundBlob,
  saveSettings
} from './storage.js'
import { exportSessions, parseBackupText } from './backup.js'
import { renderMarkdown } from './markdown.js'
import { estimateMessagesTokens, estimateTokens, formatTokens } from './token.js'

/* ------------------------------- 工具函数 ------------------------------- */

/** 版本号由 vite.config.js 在构建时注入（来自 package.json） */
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

/** 读文件为文本（file.text() 在旧 WebView 上不一定有，兜一层 FileReader） */
function readFileAsText(file) {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsText(file)
  })
}

/** 压缩图片，最长边限制在 maxSide 以内，输出 jpeg Blob */
async function compressImage(file, maxSide = 1600, quality = 0.85) {
  let bitmap = null

  if (typeof createImageBitmap === 'function') {
    try {
      bitmap = await createImageBitmap(file)
    } catch {
      bitmap = null
    }
  }

  // 老 WebView 可能没有 createImageBitmap，退回 Image + objectURL
  if (!bitmap) {
    const url = URL.createObjectURL(file)
    try {
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('图片读不出来，换一张试试'))
        img.src = url
      })
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 3000)
    }
  }

  const srcW = bitmap.width || bitmap.naturalWidth
  const srcH = bitmap.height || bitmap.naturalHeight
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH))
  const w = Math.max(1, Math.round(srcW * scale))
  const h = Math.max(1, Math.round(srcH * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, w, h)
  if (typeof bitmap.close === 'function') bitmap.close()

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  if (!blob) throw new Error('图片处理失败')
  return blob
}

/* ------------------------------- 消息组件 ------------------------------- */

function MessageItem({ msg }) {
  const isUser = msg.role === 'user'
  const html = useMemo(() => {
    if (isUser) return null
    return renderMarkdown(msg.content)
  }, [msg.content, isUser])

  const [showReasoning, setShowReasoning] = useState(false)

  return (
    <div className={'msg ' + (isUser ? 'msg-user' : 'msg-ai')}>
      {!isUser && msg.reasoning ? (
        <div className="reasoning">
          <button className="reasoning-toggle" onClick={() => setShowReasoning((v) => !v)}>
            {showReasoning ? '▾ 收起思考过程' : '▸ 思考过程'}
          </button>
          {showReasoning ? <div className="reasoning-body">{msg.reasoning}</div> : null}
        </div>
      ) : null}

      {isUser ? (
        <div className="bubble bubble-user">{msg.content}</div>
      ) : (
        <div className="bubble bubble-ai">
          {html ? (
            <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <div className="markdown plain">{msg.content}</div>
          )}
          {msg.pending ? <span className="caret" /> : null}
        </div>
      )}
    </div>
  )
}

/* ------------------------------- 设置面板 ------------------------------- */

function SettingsSheet(props) {
  const {
    open,
    onClose,
    settings,
    onSave,
    onUpdateSetting,
    hasBackground,
    bgPreviewUrl,
    onPickBackground,
    onClearBackground,
    importInputRef,
    onExport,
    dataBusy,
    dataMsg
  } = props

  const [draft, setDraft] = useState(settings)
  const [showKey, setShowKey] = useState(false)
  const [testState, setTestState] = useState({ busy: false, msg: '' })
  const [editing, setEditing] = useState(null) // { id?, name, prompt } | null

  // 只在面板打开的那一刻同步一次 draft。
  // 如果依赖 settings，切换主题/选中人格时会把用户正在输入的内容冲掉。
  useEffect(() => {
    if (open) {
      setDraft(settings)
      setTestState({ busy: false, msg: '' })
      setEditing(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const update = (key, value) => setDraft((d) => ({ ...d, [key]: value }))
  const personas = Array.isArray(settings.personas) ? settings.personas : []

  const handleSave = () => {
    const extra = draft.extraBody
    if (extra && extra.trim()) {
      try {
        JSON.parse(extra)
      } catch {
        setTestState({ busy: false, msg: '⚠ 额外参数不是合法 JSON' })
        return
      }
    }
    onSave(draft)
    onClose()
  }

  const handleTest = async () => {
    setTestState({ busy: true, msg: '' })
    try {
      await pingApi({
        apiKey: draft.apiKey.trim(),
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim() || DEFAULT_MODEL
      })
      setTestState({ busy: false, msg: '✓ 连接成功，API Key 可用' })
    } catch (err) {
      setTestState({ busy: false, msg: '✗ ' + (err.message || String(err)) })
    }
  }

  /* ---- 人格操作 ---- */

  const savePersona = () => {
    if (!editing) return
    const name = (editing.name || '').trim()
    const prompt = (editing.prompt || '').trim()
    if (!name) {
      setTestState({ busy: false, msg: '⚠ 人格名称不能为空' })
      return
    }
    if (!prompt) {
      setTestState({ busy: false, msg: '⚠ 人格内容不能为空' })
      return
    }
    const list = personas.slice()
    if (editing.id) {
      const idx = list.findIndex((p) => p.id === editing.id)
      if (idx >= 0) list[idx] = { ...list[idx], name, prompt }
      onUpdateSetting('personas', list)
    } else {
      // 新建后自动启用，避免"建好了但没选中"这种坑
      const created = { id: newId(), name, prompt }
      list.push(created)
      onUpdateSetting('personas', list)
      onUpdateSetting('activePersonaId', created.id)
    }
    setEditing(null)
    setTestState({ busy: false, msg: '' })
  }

  const removePersona = (id) => {
    if (!confirm('删除这个人格？')) return
    const list = personas.filter((p) => p.id !== id)
    onUpdateSetting('personas', list)
    if (settings.activePersonaId === id) onUpdateSetting('activePersonaId', '')
    if (editing && editing.id === id) setEditing(null)
  }

  const togglePersona = (id) => {
    onUpdateSetting('activePersonaId', settings.activePersonaId === id ? '' : id)
  }

  return (
    <div className="sheet-mask" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>设置</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        {/* ---------------- 接口 ---------------- */}

        <label className="field">
          <span>API Key</span>
          <div className="row">
            <input
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck="false"
              placeholder="sk-..."
              onChange={(e) => update('apiKey', e.target.value)}
            />
            <button className="mini-btn" onClick={() => setShowKey((v) => !v)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          <small>只存在这台手机的本地存储里，不会上传到任何地方。</small>
        </label>

        <label className="field">
          <span>接口地址</span>
          <input
            type="url"
            value={draft.baseUrl}
            autoCapitalize="off"
            spellCheck="false"
            placeholder={DEFAULT_BASE_URL}
            onChange={(e) => update('baseUrl', e.target.value)}
          />
        </label>

        <label className="field">
          <span>模型</span>
          <input
            type="text"
            value={draft.model}
            autoCapitalize="off"
            spellCheck="false"
            placeholder={DEFAULT_MODEL}
            onChange={(e) => update('model', e.target.value)}
          />
          <small>填你账号实际可用的模型名，例如 deepseek-chat。</small>
        </label>

        <label className="field">
          <span>模型最大上下文（tokens）</span>
          <input
            type="text"
            inputMode="numeric"
            value={draft.contextLimit}
            placeholder="64000"
            onChange={(e) => update('contextLimit', e.target.value.replace(/[^0-9]/g, ''))}
          />
          <small>
            填你所用模型的上下文窗口大小，只用于顶栏的用量显示（例如 64000、128000、1000000）。
          </small>
        </label>

        <label className="field">
          <span>温度（可留空）</span>
          <input
            type="text"
            inputMode="decimal"
            value={draft.temperature}
            placeholder="例如 0.7"
            onChange={(e) => update('temperature', e.target.value)}
          />
        </label>

        <label className="field">
          <span>额外请求参数（JSON，可留空）</span>
          <textarea
            rows={3}
            value={draft.extraBody}
            spellCheck="false"
            placeholder='例如 {"thinking": {"type": "enabled"}}'
            onChange={(e) => update('extraBody', e.target.value)}
          />
        </label>

        <div className="sheet-actions">
          <button className="ghost-btn" onClick={handleTest} disabled={testState.busy}>
            {testState.busy ? '测试中…' : '测试连接'}
          </button>
          <button className="primary-btn" onClick={handleSave}>
            保存
          </button>
        </div>
        {testState.msg ? <div className="test-msg">{testState.msg}</div> : null}

        {/* ---------------- 主题 ---------------- */}

        <div className="section">
          <p className="section-title">主题</p>
          <div className="segment">
            <button
              className={settings.theme !== 'light' ? 'on' : ''}
              onClick={() => onUpdateSetting('theme', 'dark')}
            >
              🌙 黑色
            </button>
            <button
              className={settings.theme === 'light' ? 'on' : ''}
              onClick={() => onUpdateSetting('theme', 'light')}
            >
              ☀️ 白色
            </button>
          </div>
          <small className="data-tip">切换后立即生效，不需要点保存。</small>
        </div>

        {/* ---------------- 会话背景 ---------------- */}

        <div className="section">
          <p className="section-title">会话背景</p>
          <div className="bg-row">
            <div
              className="bg-preview"
              style={bgPreviewUrl ? { backgroundImage: 'url("' + bgPreviewUrl + '")' } : undefined}
            />
            <div className="grow">
              <button className="mini-btn" onClick={onPickBackground}>
                {hasBackground ? '更换图片' : '选择图片'}
              </button>
              {hasBackground ? (
                <button className="mini-btn" onClick={onClearBackground}>
                  清除背景
                </button>
              ) : null}
            </div>
          </div>
          <small className="data-tip">
            图片只铺在聊天消息区，会自动压暗/压亮一层保证文字看得清。大图会自动压缩到 1600px 以内。
          </small>
        </div>

        {/* ---------------- 人格预设 ---------------- */}

        <div className="section">
          <p className="section-title">人格预设（全局生效，单选）</p>

          {personas.length === 0 && !editing ? (
            <p className="persona-empty">
              还没有人格。加一个之后，它会被作为 system 提示词插到每轮对话最前面。
            </p>
          ) : null}

          <div className="persona-list">
            {personas.map((p) => (
              <div
                key={p.id}
                className={'persona-item' + (settings.activePersonaId === p.id ? ' on' : '')}
                onClick={() => togglePersona(p.id)}
              >
                <span className="persona-radio" />
                <div className="persona-main">
                  <div className="persona-name">{p.name}</div>
                  <div className="persona-desc">{p.prompt}</div>
                </div>
                <button
                  className="persona-act"
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditing({ id: p.id, name: p.name, prompt: p.prompt })
                  }}
                >
                  编辑
                </button>
                <button
                  className="persona-act"
                  onClick={(e) => {
                    e.stopPropagation()
                    removePersona(p.id)
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>

          {editing ? (
            <div className="persona-form">
              <label className="field">
                <span>人格名称</span>
                <input
                  type="text"
                  value={editing.name}
                  placeholder="例如：毒舌助手"
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>人格内容（system 提示词）</span>
                <textarea
                  rows={4}
                  value={editing.prompt}
                  placeholder="例如：你是一个说话极简、喜欢冷幽默的助手，回答不超过三句话。"
                  onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
                />
              </label>
              <div className="persona-form-actions">
                <button className="ghost-btn" onClick={() => setEditing(null)}>
                  取消
                </button>
                <button className="primary-btn" onClick={savePersona}>
                  保存人格
                </button>
              </div>
            </div>
          ) : (
            <button
              className="mini-btn"
              onClick={() => setEditing({ id: '', name: '', prompt: '' })}
            >
              ＋ 新建人格
            </button>
          )}

          <small className="data-tip">
            选中的人格对所有会话生效；再点一次取消，点选立即生效。
            <br />
            <br />
            ⚠️ 人格是每一轮作为 system 提示词发出去的，但模型会优先模仿已有对话的语气——
            <b>在历史消息很多的旧会话里，人格可能被"带偏"而看不出效果</b>。
            切换人格后建议新建一个对话，效果最干净。
          </small>
        </div>

        {/* ---------------- 数据 ---------------- */}

        <div className="section">
          <p className="section-title">会话备份</p>
          <div className="data-actions">
            <button className="mini-btn" onClick={onExport} disabled={dataBusy}>
              导出全部
            </button>
            <button
              className="mini-btn"
              onClick={() => importInputRef.current && importInputRef.current.click()}
              disabled={dataBusy}
            >
              导入
            </button>
          </div>
          {dataMsg ? <div className="test-msg">{dataMsg}</div> : null}
          <small className="data-tip">
            导出会生成一个 JSON 文件并弹出系统分享面板，可以存到文件管理器或发给别人。导入是「追加」，不会覆盖现有会话。
          </small>
        </div>

        {/* ---------------- 危险区 ---------------- */}

        <div className="danger-zone">
          <button
            className="danger-btn"
            onClick={async () => {
              if (!confirm('确定清空这台手机上的全部会话记录？此操作不可恢复。')) return
              await clearAllSessions()
              location.reload()
            }}
          >
            清空全部会话
          </button>
        </div>

        <div className="app-version">
          ChatCell v{APP_VERSION}
        </div>
      </div>
    </div>
  )
}

/* --------------------------------- App --------------------------------- */

export default function App() {
  const [settings, setSettings] = useState(() => loadSettings())
  const [sessions, setSessions] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')

  const [bgUrl, setBgUrl] = useState('')
  const [dataBusy, setDataBusy] = useState(false)
  const [dataMsg, setDataMsg] = useState('')
  const [kbOpen, setKbOpen] = useState(false)

  const abortRef = useRef(null)
  const scrollRef = useRef(null)
  const textareaRef = useRef(null)
  const bgFileRef = useRef(null)
  const importInputRef = useRef(null)
  const bgUrlRef = useRef('')

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) || null,
    [sessions, activeId]
  )
  const messages = active ? active.messages || [] : []

  // 会话列表按「最后使用时间」实时排序。
  // 之前只在启动时排过一次，所以发送消息后列表顺序不变，必须重启才更新。
  const sortedSessions = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
      ),
    [sessions]
  )

  // 顶栏的上下文用量：人格提示词 + 当前会话全部消息（reasoning 不回传，不计入）
  const activePersona = useMemo(() => getActivePersona(settings), [settings])
  const contextLimit = Number(settings.contextLimit) || 64000
  const usedTokens = useMemo(() => {
    let total = 0
    if (activePersona && activePersona.prompt) total += estimateTokens(activePersona.prompt)
    total += estimateMessagesTokens(messages)
    return total
  }, [messages, activePersona])

  /* ---------------- 主题 ---------------- */

  useEffect(() => {
    const theme = settings.theme === 'light' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', theme)
  }, [settings.theme])

  /* ---------------- 首次加载会话 ---------------- */

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const list = await listSessions()
        if (!alive) return
        setSessions(list)
        if (list.length) setActiveId(list[0].id)
      } catch (err) {
        if (alive) setError('读取本地会话失败：' + (err.message || String(err)))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /* ---------------- 键盘遮挡处理 ---------------- */
  // 策略：让 Android 完全不要插手（Keyboard.resize = "none" → adjustNothing），
  // 由前端自己算高度：
  //   1. 优先用 @capacitor/keyboard 的 keyboardWillShow 事件，它直接给出键盘高度
  //   2. 插件不可用时（浏览器调试）退回 visualViewport
  useEffect(() => {
    const setH = (px) => {
      document.documentElement.style.setProperty('--app-h', Math.round(px) + 'px')
    }
    setH(window.innerHeight || 0)

    let pluginActive = false
    const listeners = []
    let cancelled = false

    import('@capacitor/keyboard')
      .then(async ({ Keyboard }) => {
        if (cancelled) return
        try {
          const show = await Keyboard.addListener('keyboardWillShow', (info) => {
            pluginActive = true
            setKbOpen(true)
            const kb = (info && info.keyboardHeight) || 0
            setH(Math.max(200, window.innerHeight - kb))
          })
          const hide = await Keyboard.addListener('keyboardWillHide', () => {
            pluginActive = true
            setKbOpen(false)
            setH(window.innerHeight)
          })
          listeners.push(show, hide)
        } catch {
          /* Web 环境下插件未实现，忽略 */
        }
      })
      .catch(() => {
        /* 模块不存在，忽略 */
      })

    const vv = window.visualViewport
    const applyFallback = () => {
      if (pluginActive) return
      const h = vv && vv.height ? vv.height : window.innerHeight
      setH(h)
      setKbOpen(!!vv && vv.height < window.innerHeight - 120)
    }
    if (vv) {
      vv.addEventListener('resize', applyFallback)
      vv.addEventListener('scroll', applyFallback)
    }
    applyFallback()

    const onOrient = () => {
      setKbOpen(false)
      if (!pluginActive) setH(window.innerHeight)
    }
    window.addEventListener('orientationchange', onOrient)

    return () => {
      cancelled = true
      if (vv) {
        vv.removeEventListener('resize', applyFallback)
        vv.removeEventListener('scroll', applyFallback)
      }
      window.removeEventListener('orientationchange', onOrient)
      listeners.forEach((l) => {
        try {
          l.remove()
        } catch {
          /* ignore */
        }
      })
    }
  }, [])

  /* ---------------- 背景图 ---------------- */

  const refreshBackground = useCallback(async () => {
    try {
      const blob = await loadBackgroundBlob()
      if (bgUrlRef.current) {
        URL.revokeObjectURL(bgUrlRef.current)
        bgUrlRef.current = ''
      }
      if (blob) {
        const url = URL.createObjectURL(blob)
        bgUrlRef.current = url
        setBgUrl(url)
      } else {
        setBgUrl('')
      }
    } catch (err) {
      console.warn('加载背景失败', err)
    }
  }, [])

  useEffect(() => {
    refreshBackground()
    return () => {
      if (bgUrlRef.current) URL.revokeObjectURL(bgUrlRef.current)
    }
  }, [refreshBackground])

  const handleBgFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    try {
      const blob = await compressImage(file, 1600)
      await saveBackgroundBlob(blob)
      await refreshBackground()
    } catch (err) {
      setError('背景图保存失败：' + (err.message || String(err)))
    }
  }

  const handleClearBackground = async () => {
    if (!confirm('清除当前会话背景？')) return
    await deleteBackgroundBlob()
    await refreshBackground()
  }

  /* ---------------- 滚动 ---------------- */

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceToBottom < 160) el.scrollTop = el.scrollHeight
  }, [active, activeId])

  /* ---------------- 输入框自适应 ---------------- */

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
  }, [input])

  /* ---------------- 即时设置（主题 / 人格） ---------------- */

  const updateSetting = useCallback((key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value }
      saveSettings(next)
      return next
    })
  }, [])

  const handleSaveSettings = (draft) => {
    const next = { ...settings, ...draft }
    setSettings(next)
    saveSettings(next)
  }

  /* ---------------- 导出 / 导入 ---------------- */

  const handleExport = async () => {
    setDataBusy(true)
    setDataMsg('')
    try {
      const r = await exportSessions(sessions)
      setDataMsg('✓ 已导出 ' + r.count + ' 个会话（' + r.filename + '）')
    } catch (err) {
      const msg = err && err.message ? err.message : String(err)
      // 用户取消分享面板不算错误
      if (/cancel/i.test(msg)) {
        setDataMsg('已取消')
      } else {
        setDataMsg('✗ ' + msg)
      }
    } finally {
      setDataBusy(false)
    }
  }

  const handleImportFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setDataBusy(true)
    setDataMsg('')
    try {
      const text = await readFileAsText(file)
      const imported = parseBackupText(text)
      await bulkPutSessions(imported)
      const list = await listSessions()
      setSessions(list)
      if (!activeId && list.length) setActiveId(list[0].id)
      setDataMsg('✓ 已导入 ' + imported.length + ' 个会话')
    } catch (err) {
      setDataMsg('✗ ' + (err.message || String(err)))
    } finally {
      setDataBusy(false)
    }
  }

  /* ---------------- 会话操作 ---------------- */

  const newChat = useCallback(() => {
    const s = createSession()
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setDrawerOpen(false)
    setError('')
    setInput('')
    setTimeout(() => textareaRef.current?.focus(), 60)
  }, [])

  const openSession = useCallback((id) => {
    setActiveId(id)
    setDrawerOpen(false)
    setError('')
    // 刻意不更新 updatedAt：
    // 排序只在「会话内容真正变化」（用户或 AI 发消息）时才动，
    // 仅仅点开看看不该把列表顺序搞乱。
  }, [])

  const renameSession = useCallback(
    async (id, currentTitle) => {
      const input = prompt('重命名会话', currentTitle)
      if (input === null) return
      const title = input.trim()
      if (!title || title === currentTitle) return
      const target = sessions.find((s) => s.id === id)
      if (!target) return
      const updated = { ...target, title, updatedAt: Date.now() }
      setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)))
      try {
        await putSession(updated)
      } catch (err) {
        setError('重命名保存失败：' + (err.message || String(err)))
      }
    },
    [sessions]
  )

  const removeSession = useCallback(
    async (id) => {
      if (!confirm('删除这个会话？')) return
      await deleteSession(id)
      setSessions((prev) => {
        const rest = prev.filter((s) => s.id !== id)
        if (id === activeId) setActiveId(rest.length ? rest[0].id : null)
        return rest
      })
    },
    [activeId]
  )

  const stop = useCallback(() => {
    if (abortRef.current) abortRef.current.abort()
  }, [])

  /* ---------------- 发送 ---------------- */

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return

    if (!settings.apiKey) {
      setError('先在设置里填一个 API Key')
      setSettingsOpen(true)
      return
    }

    setError('')

    let session = active
    if (!session) {
      session = createSession(deriveTitle(text))
      setSessions((prev) => [session, ...prev])
      setActiveId(session.id)
    }
    const sid = session.id

    const baseMessages = session.messages || []
    const userMsg = { id: newId(), role: 'user', content: text, createdAt: Date.now() }
    const aiMsg = {
      id: newId(),
      role: 'assistant',
      content: '',
      reasoning: '',
      pending: true,
      createdAt: Date.now()
    }

    setInput('')
    setBusy(true)
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sid
          ? {
              ...s,
              title: baseMessages.length === 0 ? deriveTitle(text) : s.title,
              updatedAt: Date.now(),
              messages: [...baseMessages, userMsg, aiMsg]
            }
          : s
      )
    )

    /* 组装给 API 的消息：人格作为 system 插在最前面，历史全量发送（不做压缩） */
    const apiMessages = []
    const persona = getActivePersona(settings)
    if (persona && persona.prompt && persona.prompt.trim()) {
      apiMessages.push({ role: 'system', content: persona.prompt.trim() })
    }
    for (const m of [...baseMessages, userMsg]) {
      apiMessages.push({ role: m.role, content: m.content })
    }

    const controller = new AbortController()
    abortRef.current = controller

    let accContent = ''
    let accReasoning = ''

    const paint = (pending = true) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sid
            ? {
                ...s,
                updatedAt: Date.now(),
                messages: s.messages.map((m) =>
                  m.id === aiMsg.id
                    ? { ...m, content: accContent, reasoning: accReasoning, pending }
                    : m
                )
              }
            : s
        )
      )
    }

    const persist = async (extra) => {
      const finalMessages = [
        ...baseMessages,
        userMsg,
        { ...aiMsg, content: accContent, reasoning: accReasoning, pending: false, ...(extra || {}) }
      ]
      // 丢弃旧版本遗留的 summary 字段（压缩功能已取消）
      const { summary: _legacySummary, ...sessionRest } = session
      const finalSession = {
        ...sessionRest,
        title: baseMessages.length === 0 ? deriveTitle(text) : session.title,
        updatedAt: Date.now(),
        messages: finalMessages
      }
      setSessions((prev) => prev.map((s) => (s.id === sid ? finalSession : s)))
      try {
        await putSession(finalSession)
      } catch (err) {
        setError('保存到本地失败：' + (err.message || String(err)))
      }
    }

    let raf = 0
    const schedulePaint = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        paint()
      })
    }

    try {
      const extraBody =
        settings.extraBody && settings.extraBody.trim() ? JSON.parse(settings.extraBody) : null
      const temperature =
        settings.temperature && settings.temperature.trim() ? Number(settings.temperature) : null

      for await (const chunk of streamChat({
        apiKey: settings.apiKey.trim(),
        baseUrl: settings.baseUrl,
        model: settings.model || DEFAULT_MODEL,
        messages: apiMessages,
        signal: controller.signal,
        extraBody,
        temperature: Number.isFinite(temperature) ? temperature : null
      })) {
        if (chunk.type === 'content') accContent += chunk.text
        else if (chunk.type === 'reasoning') accReasoning += chunk.text
        else continue
        schedulePaint()
      }

      await persist()
    } catch (err) {
      const isAbort = err && (err.name === 'AbortError' || controller.signal.aborted)
      if (!isAbort) {
        const msg = err.message || String(err)
        setError(msg)
        accContent = accContent || '⚠ ' + msg
      }
      await persist(isAbort ? { aborted: true } : { failed: true })
    } finally {
      if (raf) cancelAnimationFrame(raf)
      abortRef.current = null
      setBusy(false)
      paint(false)
      setTimeout(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, 30)
    }
  }, [active, busy, input, settings])

  const onKeyDown = (e) => {
    if (e.key !== 'Enter') return
    if (e.nativeEvent && e.nativeEvent.isComposing) return
    if (settings.sendOnEnter && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  /* ---------------- 渲染 ---------------- */

  return (
    <div className={'app' + (kbOpen ? ' kb-open' : '')}>
      <header className="topbar">
        <button className="icon-btn" onClick={() => setDrawerOpen(true)} aria-label="会话列表">
          ☰
        </button>
        <div className="title">
          <div className="title-main">{active ? active.title : 'ChatCell'}</div>
          <div className="title-sub">
            <span className={usedTokens > contextLimit ? 'ctx-over' : undefined}>
              {formatTokens(usedTokens)}/{formatTokens(contextLimit)}
            </span>
            {activePersona ? ' · ' + activePersona.name : ''}
          </div>
        </div>
        <button className="icon-btn" onClick={newChat} aria-label="新对话">
          ＋
        </button>
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="设置">
          ⚙
        </button>
      </header>

      {error ? (
        <div className="error-bar">
          <span>{error}</span>
          <button onClick={() => setError('')}>✕</button>
        </div>
      ) : null}

      <main
        className={'chat' + (bgUrl ? ' has-bg' : '')}
        ref={scrollRef}
        style={bgUrl ? { '--chat-bg-image': 'url("' + bgUrl + '")' } : undefined}
      >
        {messages.length === 0 ? (
          <div className="empty">
            <div className="empty-logo">🐋</div>
            <p>在下面输入点什么，就能开始聊天。</p>
            <p className="empty-hint">
              {settings.apiKey ? 'API Key 已配置好，直接说话吧。' : '第一次用，先去右上角 ⚙ 填 API Key。'}
            </p>
          </div>
        ) : (
          messages.map((m) => <MessageItem key={m.id} msg={m} />)
        )}
      </main>

      <footer className="composer">
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          placeholder={busy ? '正在回复…' : '说点什么'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button className="send-btn stop" onClick={stop}>
            停止
          </button>
        ) : (
          <button className="send-btn" onClick={send} disabled={!input.trim()}>
            发送
          </button>
        )}
      </footer>

      {drawerOpen ? (
        <div className="drawer-mask" onClick={() => setDrawerOpen(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <span>会话</span>
              <button className="mini-btn" onClick={newChat}>
                ＋ 新对话
              </button>
            </div>
            <div className="drawer-list">
              {sortedSessions.length === 0 ? (
                <p className="drawer-empty">还没有会话</p>
              ) : (
                sortedSessions.map((s) => (
                  <div
                    key={s.id}
                    className={'drawer-item' + (s.id === activeId ? ' active' : '')}
                    onClick={() => openSession(s.id)}
                  >
                    <div className="drawer-item-main">
                      <div className="drawer-item-title">{s.title}</div>
                      <div className="drawer-item-sub">
                        {(s.messages || []).length} 条 ·{' '}
                        {new Date(s.updatedAt || s.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      className="edit-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        renameSession(s.id, s.title)
                      }}
                      aria-label="重命名"
                    >
                      ✎
                    </button>
                    <button
                      className="del-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeSession(s.id)
                      }}
                      aria-label="删除"
                    >
                      🗑
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>
        </div>
      ) : null}

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
        onUpdateSetting={updateSetting}
        hasBackground={!!bgUrl}
        bgPreviewUrl={bgUrl}
        onPickBackground={() => bgFileRef.current && bgFileRef.current.click()}
        onClearBackground={handleClearBackground}
        importInputRef={importInputRef}
        onExport={handleExport}
        dataBusy={dataBusy}
        dataMsg={dataMsg}
      />

      {/* 隐藏的原生文件选择器 */}
      <input
        ref={bgFileRef}
        className="hidden-input"
        type="file"
        accept="image/*"
        onChange={handleBgFile}
      />
      <input
        ref={importInputRef}
        className="hidden-input"
        type="file"
        accept=".json,application/json"
        onChange={handleImportFile}
      />
    </div>
  )
}
