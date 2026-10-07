/* dsh-go-game standalone page — a thin vanilla view over the host routes.
   All rules live on the host; this file only renders and posts intent. */
(function () {
  'use strict'

  var ID = 'page-' + Math.random().toString(36).slice(2, 10)
  var S = null
  var deadMode = false
  var dead = []
  var estimate = null
  var suggestion = null
  var busy = false
  var editing = false

  var el = function (id) { return document.getElementById(id) }

  function banner(text, isErr) {
    var b = el('banner')
    if (!text) { b.style.display = 'none'; return }
    b.textContent = text
    b.className = isErr ? 'err' : ''
    b.style.display = 'block'
  }

  function api(path, body) {
    var opts = { method: body === undefined ? 'GET' : 'POST' }
    if (body !== undefined) {
      opts.headers = { 'content-type': 'application/json' }
      opts.body = JSON.stringify(body)
    }
    return fetch('/dsh-go-game' + path, opts).then(function (r) { return r.json() })
  }

  function apply(state) {
    S = state
    dead = (state.dead || []).slice()
    if (!editing) {
      el('selSize').value = String(state.size)
      el('inKomi').value = String(state.komi)
      el('inHandicap').value = String(state.handicap)
      if (state.level) el('selLevel').value = state.level
      el('selAiSide').value = state.aiSide || ''
      if (state.engine) el('selEngine').value = state.engine
    }
    if (state.engine === 'katago' && state.aiFallback) {
      banner('引擎出錯（' + state.aiFallback + '）—— 這一手由內建 AI 代打', true)
    } else if (state.engine === 'katago' && state.engineInfo && !state.engineInfo.available) {
      banner('未找到 KataGo（' + state.engineInfo.reason + '）—— 這一局由內建 AI 代打', true)
    }
    render()
  }

  function readForm() {
    return {
      size: Number(el('selSize').value),
      komi: Number(el('inKomi').value),
      handicap: Number(el('inHandicap').value),
      level: el('selLevel').value,
      aiSide: el('selAiSide').value || null,
      engine: el('selEngine').value,
    }
  }

  function withBusy(promise) {
    busy = true
    render()
    return promise.finally(function () { busy = false; render() })
  }

  // ------------------------------------------------------------------ render

  function render() {
    renderBoard()
    renderStatus()
    renderButtons()
  }

  function renderButtons() {
    el('btnPass').disabled = busy || !S || S.over
    el('btnUndo').disabled = busy || !S || !S.canUndo
    el('btnResign').disabled = busy || !S || S.over
    el('btnAi').disabled = busy || !S || S.over
    el('btnEstimate').disabled = busy || !S
    el('btnReview').disabled = busy || !S
    el('btnNew').disabled = busy
    el('btnSave').disabled = busy || !S
    el('btnLoad').disabled = busy
    el('btnDead').className = deadMode ? 'on' : ''
    el('btnDead').disabled = busy || !S
  }

  function renderStatus() {
    var dot = el('turnDot')
    if (!S) { el('turnText').textContent = '未開始'; return }
    dot.className = 'dot ' + (S.turn === 1 ? 'b' : 'w')
    var text = S.turn === 1 ? '輪到黑方' : '輪到白方'
    if (S.over) {
      if (S.endReason === 'resign') text = (S.winner === 1 ? '黑方' : '白方') + '中盤勝（對方認輸）'
      else if (S.result) {
        text = '終局：' + (S.result.winnerName === 'black' ? '黑勝' : S.result.winnerName === 'white' ? '白勝' : '和棋') +
          (S.result.margin == null ? '' : ' ' + S.result.margin + ' 目')
      } else text = '終局'
    }
    el('turnText').textContent = text + (busy ? ' · 思考中…' : '')
    el('stMoves').textContent = String(S.moveCount)
    el('stCaps').textContent = S.captures.black + ' / ' + S.captures.white
    el('stResult').textContent = text
  }

  function renderBoard() {
    var svg = el('board')
    if (!S) { svg.innerHTML = ''; return }
    var size = S.size
    var unit = 1
    var pad = 1
    var span = (size - 1) * unit
    var ns = 'http://www.w3.org/2000/svg'
    var out = []
    var W = size + 2 * pad - 1

    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + W)

    function cx(x) { return pad + x * unit }
    function cy(y) { return pad + y * unit }

    out.push('<rect x="0" y="0" width="' + W + '" height="' + W + '" fill="#d9b483"/>')

    for (var i = 0; i < size; i++) {
      out.push('<line x1="' + cx(0) + '" y1="' + cy(i) + '" x2="' + cx(size - 1) + '" y2="' + cy(i) + '" stroke="#6b5537" stroke-width="0.045"/>')
      out.push('<line x1="' + cx(i) + '" y1="' + cy(0) + '" x2="' + cx(i) + '" y2="' + cy(size - 1) + '" stroke="#6b5537" stroke-width="0.045"/>')
    }

    ;(S.stars || []).forEach(function (p) {
      out.push('<circle cx="' + cx(p.x) + '" cy="' + cy(p.y) + '" r="0.085" fill="#4a3b25"/>')
    })

    // coordinate labels
    var letters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
    for (var k = 0; k < size; k++) {
      out.push('<text x="' + cx(k) + '" y="' + (pad - 0.42) + '" font-size="0.42" text-anchor="middle" fill="#5b4a30">' + letters[k] + '</text>')
      out.push('<text x="' + (pad - 0.5) + '" y="' + (cy(k) + 0.15) + '" font-size="0.42" text-anchor="middle" fill="#5b4a30">' + (size - k) + '</text>')
    }

    // stones
    for (var idx = 0; idx < S.board.length; idx++) {
      var v = S.board[idx]
      if (!v) continue
      var x = idx % size
      var y = Math.floor(idx / size)
      var isDead = dead.indexOf(idx) !== -1
      var fill = v === 1 ? '#14161c' : '#f4f4f0'
      var stroke = v === 1 ? '#000' : '#b9b9b0'
      out.push('<circle cx="' + cx(x) + '" cy="' + cy(y) + '" r="0.46" fill="' + fill + '" stroke="' + stroke + '" stroke-width="0.04"' + (isDead ? ' opacity="0.35"' : '') + '/>')
      if (isDead) {
        out.push('<line x1="' + (cx(x) - 0.3) + '" y1="' + (cy(y) - 0.3) + '" x2="' + (cx(x) + 0.3) + '" y2="' + (cy(y) + 0.3) + '" stroke="#d05c5c" stroke-width="0.09"/>')
        out.push('<line x1="' + (cx(x) + 0.3) + '" y1="' + (cy(y) - 0.3) + '" x2="' + (cx(x) - 0.3) + '" y2="' + (cy(y) + 0.3) + '" stroke="#d05c5c" stroke-width="0.09"/>')
      }
    }

    // last move marker
    if (S.lastMove >= 0 && S.board[S.lastMove]) {
      var lx = S.lastMove % size
      var ly = Math.floor(S.lastMove / size)
      out.push('<circle cx="' + cx(lx) + '" cy="' + cy(ly) + '" r="0.14" fill="none" stroke="' + (S.board[S.lastMove] === 1 ? '#f0c060' : '#c05050') + '" stroke-width="0.08"/>')
    }

    // ownership overlay after an estimate
    if (estimate && estimate.owner) {
      for (var oi = 0; oi < estimate.owner.length; oi++) {
        var own = estimate.owner[oi]
        if (!own || S.board[oi]) continue
        var ox = oi % size
        var oy = Math.floor(oi / size)
        out.push('<rect x="' + (cx(ox) - 0.5) + '" y="' + (cy(oy) - 0.5) + '" width="' + unit + '" height="' + unit + '" fill="' + (own === 1 ? '#14161c' : '#f4f4f0') + '" opacity="0.28"/>')
      }
    }

    // clickable cells last so they own the pointer; ghost preview on hover
    var me = S.turn === 1 ? 1 : 2
    for (var ci = 0; ci < S.board.length; ci++) {
      var cxx = ci % size
      var cyy = Math.floor(ci / size)
      var ghost = ''
      if (!S.board[ci] && !S.over) {
        ghost = '<circle class="ghost" cx="' + cx(cxx) + '" cy="' + cy(cyy) + '" r="0.46" fill="' + (me === 1 ? '#14161c' : '#f4f4f0') + '"/>'
      }
      out.push('<g class="cell" data-i="' + ci + '">' +
        '<rect x="' + (cx(cxx) - 0.5) + '" y="' + (cy(cyy) - 0.5) + '" width="' + unit + '" height="' + unit + '" fill="transparent" style="cursor:crosshair"/>' +
        ghost + '</g>')
    }

    svg.innerHTML = out.join('')
    void ns
    void span
  }

  // ------------------------------------------------------------------ actions

  function post(path, body) {
    return withBusy(api(path, body).then(function (r) {
      if (r && r.state) { apply(r.state); return r }
      if (r && r.ok === false && r.error) { banner('操作失敗：' + r.error, true); return r }
      if (r && r.board) { apply(r); return r }
      if (r && r.sgf) return r
      return r
    }).catch(function (err) {
      banner('連線失敗：' + err.message, true)
    }))
  }

  function move(point) {
    if (!S || S.over) return
    // the host plays the AI reply itself when it is the AI's turn
    post('/move', { id: ID, point: point, autoAi: Boolean(S.aiSide), level: S.level })
  }

  function newGame() {
    editing = true
    deadMode = false
    estimate = null
    suggestion = null
    el('suggestion').textContent = ''
    var form = readForm()
    post('/new', { id: ID, size: form.size, komi: form.komi, handicap: form.handicap, level: form.level, aiSide: form.aiSide, engine: form.engine })
      .then(function () { editing = false })
  }

  // -------------------------------------------------------------------- wire

  el('board').addEventListener('click', function (ev) {
    // walk up to the <g class="cell" data-i="..."> that owns the clicked
    // point: the hit rect and the ghost circle are themselves SVG elements
    // (so they always have getAttribute), hence the test is on data-i, not
    // on the mere presence of getAttribute.
    var node = ev.target
    var i = null
    while (node && node !== this) {
      if (node.getAttribute && node.getAttribute('data-i') != null) {
        i = node.getAttribute('data-i')
        break
      }
      node = node.parentNode
    }
    if (i === null || i === undefined || !S) return
    var idx = Number(i)
    if (deadMode) {
      post('/dead', { id: ID, point: idx })
      return
    }
    if (S.board[idx] || S.over) return
    move(idx)
  })

  el('btnPass').onclick = function () { post('/pass', { id: ID, autoAi: Boolean(S && S.aiSide), level: S && S.level }) }
  el('btnUndo').onclick = function () { post('/undo', { id: ID, steps: 1 }) }
  el('btnResign').onclick = function () { post('/resign', { id: ID }) }
  el('btnAi').onclick = function () { post('/ai', { id: ID, level: S && S.level, budgetMs: 1800 }) }
  el('btnNew').onclick = newGame
  el('btnDead').onclick = function () {
    if (deadMode) { post('/dead', { id: ID, clear: true }); deadMode = false; banner(''); }
    else { deadMode = true; banner('標記死子模式：點棋子可切換死活，完成後再按一次結束。') }
    render()
  }

  el('btnEstimate').onclick = function () {
    withBusy(api('/estimate', { id: ID, playouts: 48, budgetMs: 2500 }).then(function (r) {
      if (!r || !r.ok) { banner('形勢判斷失敗', true); return }
      estimate = r.estimate
      apply(r)
      el('review').textContent =
        '本地模擬數子（' + r.estimate.playouts + ' 局、' + r.estimate.elapsedMs + 'ms）：黑 ' + r.estimate.blackScore +
        ' 目，白 ' + r.estimate.whiteScore + ' 目，' +
        (r.estimate.winner === 1 ? '黑領先' : r.estimate.winner === 2 ? '白領先' : '和棋') +
        ' ' + r.estimate.margin + ' 目。'
    }))
  }

  el('btnReview').onclick = function () {
    el('review').textContent = '請模型講評中…（首次可能需要十數秒）'
    withBusy(api('/review', { id: ID }).then(function (r) {
      if (!r) return
      el('review').textContent = r.text || ('覆盤失敗：' + (r.message || r.error || 'unknown'))
      suggestion = r.suggestion || null
      if (suggestion && suggestion.point >= 0) {
        var v = document.createElement('button')
        v.textContent = '跟隨建議落子 ' + suggestion.vertex
        v.onclick = function () { move(suggestion.point) }
        el('suggestion').innerHTML = ''
        el('suggestion').appendChild(v)
      } else if (suggestion) {
        el('suggestion').textContent = '建議：' + suggestion.vertex
      } else {
        el('suggestion').textContent = ''
      }
    }))
  }

  el('btnSave').onclick = function () {
    var name = window.prompt('存檔名稱', 'game-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'))
    if (!name) return
    post('/save', { id: ID, name: name }).then(function (r) {
      if (r && r.ok) banner('已存檔：' + r.name + '.sgf')
    })
  }

  el('btnLoad').onclick = function () {
    withBusy(api('/games').then(function (r) {
      var games = (r && r.games) || []
      if (!games.length) { banner('沒有已存檔的棋局', true); return }
      var name = window.prompt('讀取哪一局？\n' + games.join('\n'), games[games.length - 1])
      if (!name) return
      return post('/load', { id: ID, name: name })
    }))
  }

  el('selLevel').onchange = function () { if (S) post('/ai', { id: ID, level: this.value, budgetMs: 200 }) }
  el('selAiSide').onchange = function () { if (S && this.value && !S.over) post('/ai', { id: ID, level: el('selLevel').value }) }
  el('selSize').onchange = el('inKomi').onchange = el('inHandicap').onchange = function () { editing = true }
  el('selEngine').onchange = function () { newGame() }

  // -------------------------------------------------------------------- boot

  api('/status').then(function (r) {
    if (r && r.ok) el('conn').textContent = '已連線 · 引擎 ' + r.rules + ' · ' + (r.llm ? '模型可用' : '未配置模型')
    else el('conn').textContent = '插件未載入'
  }).catch(function () { el('conn').textContent = '無法連線主機' })

  post('/new', { id: ID, size: 19, komi: 7.5, handicap: 0, level: 'medium', aiSide: 'white' })
})()
