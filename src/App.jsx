import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { streamChat, pingApi, DEFAULT_BASE_URL, DEFAULT_MODEL } from './api.js'
import {
  clearAllSessions,
  createSession,
  deleteSession,
  deriveTitle,
  listSessions,
  loadSettings,
  newId,
  putSession,
  saveSettings
} from './storage.js'
import { renderMarkdown } from './markdown.js'

/* ------------------------------- 小组件 ------------------------------- */

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

function SettingsSheet({ open, onClose, settings, onSave }) {
  const [draft, setDraft] = useState(settings)
  const [showKey, setShowKey] = useState(false)
  const [testState, setTestState] = useState({ busy: false, msg: '' })

  useEffect(() => {
    if (open) {
      setDraft(settings)
      setTestState({ busy: false, msg: '' })
    }
  }, [open, settings])

  if (!open) return null

  const update = (key, value) => setDraft((d) => ({ ...d, [key]: value }))

  const handleSave = () => {
    let extra = draft.extraBody
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

  return (
    <div className="sheet-mask" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>设置</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

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
            rows={4}
            value={draft.extraBody}
            spellCheck="false"
            placeholder='例如 {"thinking": {"type": "enabled"}}&#10;具体字段以 DeepSeek API 文档为准'
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

  const abortRef = useRef(null)
  const scrollRef = useRef(null)
  const textareaRef = useRef(null)

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) || null,
    [sessions, activeId]
  )
  const messages = active ? active.messages || [] : []

  /* 首次加载：从 IndexedDB 取会话 */
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

  /* 新消息自动滚到底；但如果用户正在往上翻历史，就别硬拽回来 */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceToBottom < 160) el.scrollTop = el.scrollHeight
  }, [active, activeId])

  /* 输入框自适应高度 */
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
  }, [input])

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
  }, [])

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

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return

    if (!settings.apiKey) {
      setError('先在设置里填一个 API Key')
      setSettingsOpen(true)
      return
    }

    setError('')

    /* 当前没有会话就现场建一个 */
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

    /* 组装给 API 的消息（不含空占位） */
    const apiMessages = [...baseMessages, userMsg].map((m) => ({
      role: m.role,
      content: m.content
    }))

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
      const finalSession = {
        ...session,
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

    /* 节流重绘，避免每个 token 都触发一次 React 重渲染 */
    let raf = 0
    const schedulePaint = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        paint()
      })
    }

    try {
      const extraBody = settings.extraBody && settings.extraBody.trim()
        ? JSON.parse(settings.extraBody)
        : null
      const temperature =
        settings.temperature && settings.temperature.trim()
          ? Number(settings.temperature)
          : null

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
    if (e.nativeEvent && e.nativeEvent.isComposing) return // 中文输入法正在选词
    if (settings.sendOnEnter && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const handleSaveSettings = (draft) => {
    const next = { ...settings, ...draft }
    setSettings(next)
    saveSettings(next)
  }

  return (
    <div className="app">
      {/* 顶栏 */}
      <header className="topbar">
        <button className="icon-btn" onClick={() => setDrawerOpen(true)} aria-label="会话列表">
          ☰
        </button>
        <div className="title">
          <div className="title-main">{active ? active.title : 'ChatCell'}</div>
          <div className="title-sub">{settings.model || DEFAULT_MODEL}</div>
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

      {/* 消息区 */}
      <main className="chat" ref={scrollRef}>
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

      {/* 输入区 */}
      <footer className="composer">
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          placeholder={busy ? '正在回复…' : '说点什么（Enter 发送，Shift+Enter 换行）'}
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

      {/* 会话抽屉 */}
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
              {sessions.length === 0 ? (
                <p className="drawer-empty">还没有会话</p>
              ) : (
                sessions.map((s) => (
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
      />
    </div>
  )
}
