/**
 * dsh-go-game client half — the DSH panel.
 *
 * A thin React view over the host routes: the rules, the AI and the dead-stone
 * estimator all live in lib/index.js. Registered in the frame-wide
 * `shell.overlay` slot (click-through layer, so the root sets pointerEvents).
 */
window.__ModuleLoader__.load({
  id: 'dsh-go-game',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const el = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const CSS = [
      '.dsh-go-root{position:fixed;inset:0;pointer-events:none;z-index:250;}',
      '.dsh-go-pill{position:absolute;right:262px;bottom:104px;pointer-events:auto;touch-action:none;user-select:none;display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 4px 18px rgba(0,0,0,.22);cursor:pointer;font:12px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans TC",sans-serif;}',
      '.dsh-go-pill:hover{border-color:var(--dsw-alias-border-l2);}',
      '.dsh-go-panel{position:absolute;pointer-events:auto;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.32);padding:0;color:var(--dsw-alias-label-primary);font:12.5px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans TC",sans-serif;}',
      '.dsh-go-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px;}',
      '.dsh-go-grip{position:absolute;right:3px;bottom:3px;width:18px;height:18px;cursor:nwse-resize;pointer-events:auto;touch-action:none;opacity:.5;color:var(--dsw-alias-label-secondary);background:radial-gradient(circle,currentColor 1.1px,transparent 1.2px) 0 0/6px 6px;border-bottom-right-radius:12px;}',
      '.dsh-go-grip:hover{opacity:.95;}',
      '.dsh-go-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px;cursor:grab;user-select:none;touch-action:none;}',
      '.dsh-go-head:active{cursor:grabbing;}',
      '.dsh-go-head b{font-size:13px;}',
      '.dsh-go-head span{color:var(--dsw-alias-label-secondary);font-size:11px;margin-right:auto;}',
      '.dsh-go-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:15px;line-height:1;padding:2px 6px;border-radius:6px;}',
      '.dsh-go-x:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.dsh-go-board{border-radius:10px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(0,0,0,.25);}',
      '.dsh-go-board svg{display:block;width:100%;height:auto;touch-action:manipulation;}',
      '.dsh-go-ghost{opacity:0;transition:opacity .08s;}',
      '.dsh-go-cell:hover .dsh-go-ghost{opacity:.42;}',
      '.dsh-go-status{display:flex;align-items:center;gap:8px;margin:9px 0 6px;font-weight:600;}',
      '.dsh-go-dot{width:12px;height:12px;border-radius:50%;display:inline-block;box-shadow:0 0 0 1px rgba(0,0,0,.35);}',
      '.dsh-go-dot.b{background:#14161c;}',
      '.dsh-go-dot.w{background:#f4f4f0;}',
      '.dsh-go-note{font-weight:400;color:var(--dsw-alias-label-secondary);font-size:11px;margin-left:auto;}',
      '.dsh-go-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}',
      '.dsh-go-row+.dsh-go-row{margin-top:6px;}',
      '.dsh-go-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:4px 9px;cursor:pointer;font:inherit;font-size:11.5px;}',
      '.dsh-go-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);}',
      '.dsh-go-btn:disabled{opacity:.45;cursor:not-allowed;}',
      '.dsh-go-btn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.dsh-go-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#0c1119;font-weight:600;}',
      '.dsh-go-sel,.dsh-go-num{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:3px 6px;font:inherit;font-size:11.5px;}',
      '.dsh-go-num{width:56px;}',
      '.dsh-go-label{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:11px;}',
      '.dsh-go-stats{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:11.5px;margin-top:8px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-go-stats b{font-weight:600;color:var(--dsw-alias-label-primary);justify-self:end;font-variant-numeric:tabular-nums;}',
      '.dsh-go-review{margin-top:9px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;font-size:11.5px;white-space:pre-wrap;word-break:break-word;max-height:170px;overflow:auto;color:var(--dsw-alias-label-primary);}',
      '.dsh-go-review.empty{color:var(--dsw-alias-label-secondary);}',
      '.dsh-go-sug{margin-top:7px;color:var(--dsw-alias-label-secondary);font-size:11px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;}',
      '.dsh-go-err{margin-top:7px;color:#e07a7a;font-size:11px;}',
      '.dsh-go-engine{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-go-engine.warn{color:#e0a05a;}',
    ].join('')

    const API = '/dsh-go-game'

    // ---- draggable anchors -------------------------------------------------
    // The pill remembers a right/bottom offset. The panel remembers a full
    // left/top/width/height box so it can be moved anywhere on screen and
    // resized by dragging its bottom-right grip.
    const PILL_KEY = 'dsh-go-game:pill'
    const PANEL_KEY = 'dsh-go-game:panel'
    const PILL_DEFAULT = { right: 262, bottom: 104 }
    const PANEL_MIN_W = 320
    const PANEL_MIN_H = 260
    const PANEL_DEFAULT_W = 520
    const PANEL_DEFAULT_H = 620

    /** Default panel box: bottom-right-ish, clamped into the viewport. */
    function defaultBox() {
      const vw = typeof window === 'undefined' ? 1200 : window.innerWidth
      const vh = typeof window === 'undefined' ? 800 : window.innerHeight
      const w = Math.max(PANEL_MIN_W, Math.min(PANEL_DEFAULT_W, vw - 40))
      const h = Math.max(PANEL_MIN_H, Math.min(PANEL_DEFAULT_H, vh - 40))
      const right = Math.min(148, Math.max(16, vw - w - 16))
      const bottom = Math.min(148, Math.max(16, vh - h - 16))
      return { left: Math.max(8, vw - right - w), top: Math.max(8, vh - bottom - h), w, h }
    }

    /** Keep a box inside the viewport (used on every render, so a window
     *  resize can never leave the panel out of reach). */
    function fitBox(box, vw, vh) {
      const w = Math.min(Math.max(PANEL_MIN_W, box.w), Math.max(PANEL_MIN_W, vw - 16))
      const h = Math.min(Math.max(PANEL_MIN_H, box.h), Math.max(PANEL_MIN_H, vh - 16))
      return {
        w,
        h,
        left: Math.min(Math.max(8, box.left), Math.max(8, vw - w - 8)),
        top: Math.min(Math.max(8, box.top), Math.max(8, vh - h - 8)),
      }
    }

    function loadPos(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw) {
          const v = JSON.parse(raw)
          if (v && typeof v.right === 'number' && typeof v.bottom === 'number') return v
        }
      } catch (err) {
        /* first run, or storage unavailable — fall through to the default */
      }
      return fallback
    }

    function loadBox() {
      try {
        const raw = window.localStorage.getItem(PANEL_KEY)
        if (raw) {
          const v = JSON.parse(raw)
          if (v && typeof v.left === 'number' && typeof v.top === 'number') {
            return {
              left: v.left,
              top: v.top,
              w: typeof v.w === 'number' ? v.w : PANEL_DEFAULT_W,
              h: typeof v.h === 'number' ? v.h : PANEL_DEFAULT_H,
            }
          }
          // migrate a box saved under the old right/bottom scheme
          if (v && typeof v.right === 'number' && typeof v.bottom === 'number') {
            return fitBox(
              {
                left: window.innerWidth - v.right - PANEL_DEFAULT_W,
                top: window.innerHeight - v.bottom - PANEL_DEFAULT_H,
                w: PANEL_DEFAULT_W,
                h: PANEL_DEFAULT_H,
              },
              window.innerWidth,
              window.innerHeight,
            )
          }
        }
      } catch (err) {
        /* fall through to the default box */
      }
      return defaultBox()
    }

    function saveJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch (err) {
        /* storage unavailable — the position simply will not persist */
      }
    }

    function request(path, body) {
      const opts = { method: body === undefined ? 'GET' : 'POST' }
      if (body !== undefined) {
        opts.headers = { 'content-type': 'application/json' }
        opts.body = JSON.stringify(body)
      }
      return fetch(API + path, opts).then((r) => r.json())
    }

    const LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'

    function Board(props) {
      const s = props.state
      const dead = props.dead || []
      const estimate = props.estimate
      const onPoint = props.onPoint
      const size = s.size
      const pad = 1
      const width = size + 2 * pad - 1
      const cx = (x) => pad + x
      const cy = (y) => pad + y
      const me = s.turn
      const nodes = []

      nodes.push(el('rect', { key: 'bg', x: 0, y: 0, width: width, height: width, fill: '#d9b483' }))
      for (let i = 0; i < size; i++) {
        nodes.push(el('line', { key: 'h' + i, x1: cx(0), y1: cy(i), x2: cx(size - 1), y2: cy(i), stroke: '#6b5537', strokeWidth: 0.045 }))
        nodes.push(el('line', { key: 'v' + i, x1: cx(i), y1: cy(0), x2: cx(i), y2: cy(size - 1), stroke: '#6b5537', strokeWidth: 0.045 }))
      }
      ;(s.stars || []).forEach((p, i) => {
        nodes.push(el('circle', { key: 's' + i, cx: cx(p.x), cy: cy(p.y), r: 0.085, fill: '#4a3b25' }))
      })
      for (let k = 0; k < size; k++) {
        nodes.push(el('text', { key: 'lc' + k, x: cx(k), y: pad - 0.4, fontSize: 0.4, textAnchor: 'middle', fill: '#5b4a30' }, LETTERS[k]))
        nodes.push(el('text', { key: 'ln' + k, x: pad - 0.48, y: cy(k) + 0.14, fontSize: 0.4, textAnchor: 'middle', fill: '#5b4a30' }, String(size - k)))
      }

      for (let i = 0; i < s.board.length; i++) {
        const v = s.board[i]
        if (!v) continue
        const x = i % size
        const y = Math.floor(i / size)
        const isDead = dead.indexOf(i) !== -1
        nodes.push(el('circle', {
          key: 'st' + i,
          cx: cx(x), cy: cy(y), r: 0.46,
          fill: v === 1 ? '#14161c' : '#f4f4f0',
          stroke: v === 1 ? '#000' : '#b9b9b0',
          strokeWidth: 0.04,
          opacity: isDead ? 0.35 : 1,
        }))
        if (isDead) {
          nodes.push(el('line', { key: 'dx' + i, x1: cx(x) - 0.3, y1: cy(y) - 0.3, x2: cx(x) + 0.3, y2: cy(y) + 0.3, stroke: '#d05c5c', strokeWidth: 0.09 }))
          nodes.push(el('line', { key: 'dy' + i, x1: cx(x) + 0.3, y1: cy(y) - 0.3, x2: cx(x) - 0.3, y2: cy(y) + 0.3, stroke: '#d05c5c', strokeWidth: 0.09 }))
        }
      }

      if (s.lastMove >= 0 && s.board[s.lastMove]) {
        const lx = s.lastMove % size
        const ly = Math.floor(s.lastMove / size)
        nodes.push(el('circle', { key: 'lm', cx: cx(lx), cy: cy(ly), r: 0.14, fill: 'none', stroke: s.board[s.lastMove] === 1 ? '#f0c060' : '#c05050', strokeWidth: 0.08 }))
      }

      if (estimate && estimate.owner) {
        for (let i = 0; i < estimate.owner.length; i++) {
          const own = estimate.owner[i]
          if (!own || s.board[i]) continue
          nodes.push(el('rect', {
            key: 'ow' + i,
            x: cx(i % size) - 0.5, y: cy(Math.floor(i / size)) - 0.5,
            width: 1, height: 1,
            fill: own === 1 ? '#14161c' : '#f4f4f0',
            opacity: 0.28,
          }))
        }
      }

      for (let i = 0; i < s.board.length; i++) {
        const x = i % size
        const y = Math.floor(i / size)
        const kids = [
          el('rect', {
            key: 'hit',
            x: cx(x) - 0.5, y: cy(y) - 0.5, width: 1, height: 1,
            fill: 'transparent', style: { cursor: s.over ? 'default' : 'crosshair' },
          }),
        ]
        if (!s.board[i] && !s.over) {
          kids.push(el('circle', {
            key: 'gh',
            className: 'dsh-go-ghost',
            cx: cx(x), cy: cy(y), r: 0.46,
            fill: me === 1 ? '#14161c' : '#f4f4f0',
          }))
        }
        nodes.push(el('g', { key: 'c' + i, className: 'dsh-go-cell', onClick: () => onPoint(i) }, kids))
      }

      return el('div', { className: 'dsh-go-board' },
        el('svg', { viewBox: '0 0 ' + width + ' ' + width, xmlns: 'http://www.w3.org/2000/svg' }, nodes))
    }

    function Panel() {
      const [open, setOpen] = useState(false)
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [deadMode, setDeadMode] = useState(false)
      const [dead, setDead] = useState([])
      const [estimate, setEstimate] = useState(null)
      const [review, setReview] = useState('')
      const [suggestion, setSuggestion] = useState(null)
      const [levels, setLevels] = useState({ level: 'medium', aiSide: 'white', size: 19, komi: 7.5, handicap: 0, engine: 'builtin' })
      const idRef = useRef('panel-' + Math.random().toString(36).slice(2, 10))
      const started = useRef(false)

      // ---- draggable pill / panel ------------------------------------------
      const pillRef = useRef(null)
      const panelRef = useRef(null)
      const [pillPos, setPillPos] = useState(() => loadPos(PILL_KEY, PILL_DEFAULT))
      const [panelBox, setPanelBox] = useState(() => loadBox())
      const pillPosRef = useRef(pillPos)
      const panelBoxRef = useRef(panelBox)
      pillPosRef.current = pillPos
      panelBoxRef.current = panelBox
      const dragRef = useRef(null)
      const movedRef = useRef(false)

      const vh = () => (typeof window === 'undefined' ? 800 : window.innerHeight)

      const onDragMove = useCallback((ev) => {
        const d = dragRef.current
        if (!d) return
        const dx = ev.clientX - d.x0
        const dy = ev.clientY - d.y0
        if (!d.moved && Math.abs(dx) + Math.abs(dy) < 6) return
        d.moved = true
        const vw = window.innerWidth
        const vh = window.innerHeight
        let next
        if (d.which === 'pill') {
          next = {
            right: Math.min(Math.max(8, vw - d.w - 8), Math.max(8, d.right0 - dx)),
            bottom: Math.min(Math.max(8, vh - d.h - 8), Math.max(8, d.bottom0 - dy)),
          }
          setPillPos(next)
        } else if (d.which === 'size') {
          next = {
            left: d.box.left,
            top: d.box.top,
            w: Math.min(Math.max(PANEL_MIN_W, d.box.w + dx), Math.max(PANEL_MIN_W, vw - d.box.left - 8)),
            h: Math.min(Math.max(PANEL_MIN_H, d.box.h + dy), Math.max(PANEL_MIN_H, vh - d.box.top - 8)),
          }
          setPanelBox(next)
        } else {
          next = {
            left: Math.min(Math.max(8, d.box.left + dx), Math.max(8, vw - d.box.w - 8)),
            top: Math.min(Math.max(8, d.box.top + dy), Math.max(8, vh - d.box.h - 8)),
            w: d.box.w,
            h: d.box.h,
          }
          setPanelBox(next)
        }
        d.last = next
      }, [])

      const stopDrag = useCallback(() => {
        const d = dragRef.current
        dragRef.current = null
        window.removeEventListener('pointermove', onDragMove)
        window.removeEventListener('pointerup', stopDrag)
        window.removeEventListener('pointercancel', stopDrag)
        if (!d) return
        if (d.moved) {
          // swallow the click that follows a drag on the pill
          movedRef.current = true
          if (d.last) saveJson(d.which === 'pill' ? PILL_KEY : PANEL_KEY, d.last)
        }
      }, [onDragMove])

      const startDrag = useCallback((which, ev) => {
        if (ev.button !== undefined && ev.button !== 0) return
        // Never start a panel drag from an interactive control inside the
        // handle (the close button, a select, an input). Otherwise the panel
        // would move out from under the pointer and the browser would never
        // fire the click, so e.g. the close button would look dead. The pill
        // is itself a button, so this guard applies to the panel handle only.
        const target = ev.target
        if (which === 'panel' && target && typeof target.closest === 'function' && target.closest('button,select,input,textarea,a')) return
        const node = which === 'pill' ? pillRef.current : panelRef.current
        if (!node) return
        const common = {
          which,
          x0: ev.clientX,
          y0: ev.clientY,
          w: node.offsetWidth || 120,
          h: node.offsetHeight || 36,
          moved: false,
          last: null,
        }
        if (which === 'pill') {
          const pos = pillPosRef.current
          dragRef.current = { ...common, right0: pos.right, bottom0: pos.bottom }
        } else {
          dragRef.current = { ...common, box: panelBoxRef.current }
        }
        window.addEventListener('pointermove', onDragMove)
        window.addEventListener('pointerup', stopDrag)
        window.addEventListener('pointercancel', stopDrag)
      }, [onDragMove, stopDrag])

      const consumeDrag = useCallback(() => {
        if (!movedRef.current) return false
        movedRef.current = false
        return true
      }, [])

      useEffect(() => () => {
        window.removeEventListener('pointermove', onDragMove)
        window.removeEventListener('pointerup', stopDrag)
        window.removeEventListener('pointercancel', stopDrag)
      }, [onDragMove, stopDrag])

      // Esc closes the panel, so the close button is never the only way out.
      useEffect(() => {
        if (!open) return undefined
        const onKey = (ev) => {
          if (ev.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const applyState = useCallback((s) => {
        if (!s || !s.board) return s
        setState(s)
        setDead(s.dead || [])
        return s
      }, [])

      const call = useCallback((path, body, after) => {
        setBusy(true)
        setError('')
        return request(path, body)
          .then((r) => {
            if (r && r.error && r.ok === false) setError(String(r.error))
            if (after) after(r)
            return r
          })
          .catch((err) => {
            setError(String((err && err.message) || err))
            return null
          })
          .then((r) => {
            setBusy(false)
            return r
          })
      }, [])

      useEffect(() => {
        if (!open || started.current) return
        started.current = true
        call('/status').then((status) => {
          if (!status || !status.ok) setError('插件未載入主機')
        })
        call('/new', {
          id: idRef.current,
          size: levels.size,
          komi: levels.komi,
          handicap: levels.handicap,
          level: levels.level,
          aiSide: levels.aiSide,
          engine: levels.engine,
        }, applyState)
      }, [open, call, levels, applyState])

      const onPoint = useCallback((i) => {
        if (!state) return
        if (deadMode) {
          call('/dead', { id: idRef.current, point: i }, applyState)
          return
        }
        if (state.board[i] || state.over) return
        call('/move', { id: idRef.current, point: i, autoAi: Boolean(state.aiSide), level: state.level }, applyState)
      }, [state, deadMode, call, applyState])

      const newGame = useCallback((overrides) => {
        const next = { ...levels, ...(overrides || {}) }
        setLevels(next)
        setEstimate(null)
        setReview('')
        setSuggestion(null)
        setDeadMode(false)
        call('/new', {
          id: idRef.current,
          size: next.size,
          komi: next.komi,
          handicap: next.handicap,
          level: next.level,
          aiSide: next.aiSide,
          engine: next.engine,
        }, applyState)
      }, [levels, call, applyState])

      if (!open) {
        return el('div', { className: 'dsh-go-root' },
          el('button', {
            className: 'dsh-go-pill',
            ref: pillRef,
            style: { right: pillPos.right + 'px', bottom: pillPos.bottom + 'px' },
            onPointerDown: (ev) => startDrag('pill', ev),
            onClick: () => { if (consumeDrag()) return; setOpen(true) },
            title: '圍棋 · 中國規則數子（按住可拖動）',
          },
            el('span', { style: { fontSize: '14px' } }, '⚫'),
            el('span', null, '圍棋'),
          ))
      }

      const s = state
      const turnText = !s
        ? '載入中…'
        : s.over
          ? s.endReason === 'resign'
            ? (s.winner === 1 ? '黑方' : '白方') + '中盤勝'
            : '終局 ' + (s.result ? (s.result.winnerName === 'black' ? '黑勝' : s.result.winnerName === 'white' ? '白勝' : '和棋') + (s.result.margin == null ? '' : ' ' + s.result.margin + ' 目') : '')
          : (s.turn === 1 ? '輪到黑方' : '輪到白方')

      const renderReview = () => {
        const text = review || '按「覆盤」請模型講評（需已配置模型），或按「形勢」用本地模擬數子。'
        return el('div', { className: 'dsh-go-review' + (review ? '' : ' empty') }, text)
      }

      const box = fitBox(panelBox, typeof window === 'undefined' ? 1200 : window.innerWidth, vh())
      return el('div', { className: 'dsh-go-root' },
        el('div', {
          className: 'dsh-go-panel',
          ref: panelRef,
          style: {
            left: box.left + 'px',
            top: box.top + 'px',
            width: box.w + 'px',
            height: box.h + 'px',
          },
        },
          el('div', { className: 'dsh-go-body' },
          el('div', {
            className: 'dsh-go-head',
            onPointerDown: (ev) => startDrag('panel', ev),
            title: '按住可拖動整個視窗',
          },
            el('b', null, '圍棋'),
            el('span', null, s ? s.size + ' 路 · 貼 ' + s.komi + ' 目 · 中國規則' : ''),
            el('button', { className: 'dsh-go-x', onClick: () => setPanelBox(defaultBox()), title: '重設位置與大小' }, '\u2316'),
            el('button', { className: 'dsh-go-x', onClick: () => setOpen(false), title: '收起' }, '\u00d7'),
          ),

          s ? el(Board, { state: s, dead, estimate, onPoint }) : null,

          el('div', { className: 'dsh-go-status' },
            el('span', { className: 'dsh-go-dot ' + (s && s.turn === 2 ? 'w' : 'b') }),
            el('span', null, turnText),
            el('span', { className: 'dsh-go-note' }, s ? '提子 黑 ' + s.captures.black + ' · 白 ' + s.captures.white : ''),
          ),

          s && s.engine === 'katago'
            ? el('div', { className: 'dsh-go-engine' + (s.engineInfo && s.engineInfo.available && !s.aiFallback ? '' : ' warn') },
                s.aiFallback
                  ? '⚠ 引擎出錯（' + s.aiFallback + '）—— 這一手由內建 AI 代打'
                  : s.engineInfo && s.engineInfo.available
                    ? '引擎：KataGo ' + (s.engineInfo.selected || '') +
                      (s.engineInfo.running ? ' · 運行中' : ' · 首次落子要載入模型，可能要十幾秒')
                    : '⚠ 未找到 KataGo（' + ((s.engineInfo && s.engineInfo.reason) || 'unknown') + '）—— 這一局由內建 AI 代打')
            : null,

          el('div', { className: 'dsh-go-row' },
            el('button', { className: 'dsh-go-btn', disabled: busy || !s || s.over, onClick: () => call('/pass', { id: idRef.current, autoAi: Boolean(s.aiSide), level: s.level }, applyState) }, '虛手'),
            el('button', { className: 'dsh-go-btn', disabled: busy || !s || !s.canUndo, onClick: () => call('/undo', { id: idRef.current, steps: 1 }, applyState) }, '悔棋'),
            el('button', { className: 'dsh-go-btn', disabled: busy || !s || s.over, onClick: () => call('/resign', { id: idRef.current }, applyState) }, '認輸'),
            el('button', { className: 'dsh-go-btn', disabled: busy || !s || s.over, onClick: () => call('/ai', { id: idRef.current, level: s.level, budgetMs: 1800 }, applyState) }, 'AI 落子'),
          ),

          el('div', { className: 'dsh-go-row' },
            el('button', { className: 'dsh-go-btn' + (deadMode ? ' on' : ''), disabled: busy || !s, onClick: () => {
              if (deadMode) {
                setDeadMode(false)
                call('/dead', { id: idRef.current, clear: true }, applyState)
              } else setDeadMode(true)
            } }, deadMode ? '完成標記' : '標記死子'),
            el('button', { className: 'dsh-go-btn', disabled: busy || !s, onClick: () => call('/estimate', { id: idRef.current, playouts: 48, budgetMs: 2500 }, (r) => {
              if (r && r.ok) {
                setEstimate(r.estimate)
                setReview('本地模擬數子（' + r.estimate.playouts + ' 局 / ' + r.estimate.elapsedMs + 'ms）：黑 ' + r.estimate.blackScore + ' 目，白 ' + r.estimate.whiteScore + ' 目，' + (r.estimate.winner === 1 ? '黑領先' : r.estimate.winner === 2 ? '白領先' : '和棋') + ' ' + r.estimate.margin + ' 目。')
              }
            }) }, '形勢'),
            el('button', { className: 'dsh-go-btn', disabled: busy || !s, onClick: () => {
              setReview('請模型講評中…（首次可能需要十數秒）')
              call('/review', { id: idRef.current }, (r) => {
                setReview((r && r.text) || ('覆盤失敗：' + ((r && (r.message || r.error)) || 'unknown')))
                setSuggestion(r && r.suggestion ? r.suggestion : null)
              })
            } }, '覆盤'),
            el('button', { className: 'dsh-go-btn', disabled: busy || !s, onClick: () => {
              const v = call('/sgf', { id: idRef.current })
              window.open('/dsh-go-game/', '_blank')
              void v
            } }, '全頁版'),
          ),

          el('div', { className: 'dsh-go-row' },
            el('label', { className: 'dsh-go-label' }, '棋力',
              el('select', { className: 'dsh-go-sel', value: levels.level, disabled: busy, onChange: (e) => newGame({ level: e.target.value }) },
                el('option', { value: 'easy' }, '入門'),
                el('option', { value: 'medium' }, '中級'),
                el('option', { value: 'hard' }, '進階'),
              )),
            el('label', { className: 'dsh-go-label' }, 'AI 執',
              el('select', { className: 'dsh-go-sel', value: levels.aiSide || '', disabled: busy, onChange: (e) => newGame({ aiSide: e.target.value || null }) },
                el('option', { value: '' }, '無（雙人）'),
                el('option', { value: 'white' }, '白'),
                el('option', { value: 'black' }, '黑'),
              )),
            el('label', { className: 'dsh-go-label' }, '縱橫',
              el('select', { className: 'dsh-go-sel', value: String(levels.size), disabled: busy, onChange: (e) => newGame({ size: Number(e.target.value) }) },
                el('option', { value: '19' }, '19'),
                el('option', { value: '13' }, '13'),
                el('option', { value: '9' }, '9'),
              )),
            el('label', { className: 'dsh-go-label' }, '引擎',
              el('select', { className: 'dsh-go-sel', value: levels.engine || 'builtin', disabled: busy, onChange: (e) => newGame({ engine: e.target.value }) },
                el('option', { value: 'builtin' }, '內建（快）'),
                el('option', { value: 'katago' }, 'KataGo（強）'),
              )),
            el('label', { className: 'dsh-go-label' }, '讓子',
              el('input', { className: 'dsh-go-num', type: 'number', min: 0, max: 9, value: levels.handicap, disabled: busy, onChange: (e) => newGame({ handicap: Number(e.target.value) }) })),
            el('button', { className: 'dsh-go-btn primary', disabled: busy, onClick: () => newGame() }, '新局'),
          ),

          renderReview(),

          suggestion
            ? el('div', { className: 'dsh-go-sug' },
                'AI 建議：' + suggestion.vertex,
                suggestion.point >= 0
                  ? el('button', { className: 'dsh-go-btn', disabled: busy || !s || s.over || s.board[suggestion.point] !== 0, onClick: () => onPoint(suggestion.point) }, '落子')
                  : null)
            : null,

          error ? el('div', { className: 'dsh-go-err' }, error) : null,
          el('div', { className: 'dsh-go-stats' },
            el('span', null, '手數'), el('b', null, s ? s.moveCount : 0),
            el('span', null, '狀態'), el('b', null, s ? (s.over ? '已終局' : busy ? '思考中…' : '進行中') : '—'),
          ),
          ),
          el('div', {
            className: 'dsh-go-grip',
            onPointerDown: (ev) => startDrag('size', ev),
            title: '拖曳可調整視窗大小',
          }),
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(() => {
        const styleEl = document.createElement('style')
        styleEl.setAttribute('data-plugin', 'dsh-go-game')
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
        return () => {
          if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
        }
      })

      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'dsh-go-game-overlay', order: 62, label: '圍棋 Go' },
        () => el(Panel),
      ))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
