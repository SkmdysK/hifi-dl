'use strict'

// ---------- 状态 ----------
const state = {
  songs: [],        // [{idx, name, artist, album, duration}]
  selected: new Set(),
  jobs: { playlist: null, lx: null, qobuz: null },
  job: null,        // 歌单任务兼容旧页面逻辑
  currentSlot: 'playlist',
  polling: null,
  failedIds: new Set(),
  pageSize: 20,
}

// ---------- 工具 ----------
const $ = sel => document.querySelector(sel)
const $$ = sel => document.querySelectorAll(sel)

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

let toastTimer
function toast(msg, isError = false) {
  const el = $('#toast')
  el.textContent = msg
  el.style.borderColor = isError ? 'var(--err)' : 'var(--border)'
  el.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200)
}

const STATUS_KEYS = {
  queued: 'st.queued',
  downloading: 'st.downloading',
  downloaded: 'st.downloaded',
  existed: 'st.existed',
  paused: 'st.paused',
  cancelled: 'st.cancelled',
  no_match: 'st.noMatch',
  no_url: 'st.noUrl',
  failed: 'st.failed',
  lossless_unavailable: 'st.lossless',
}
const statusText = s => t(STATUS_KEYS[s] || s)

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result.split(',')[1])
    r.onerror = () => reject(new Error('读取文件失败'))
    r.readAsDataURL(file)
  })
}

// ---------- Tab 切换 ----------
$$('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach(b => b.classList.remove('active'))
    $$('.tab-page').forEach(p => p.classList.remove('active'))
    btn.classList.add('active')
    $(`#tab-${btn.dataset.tab}`).classList.add('active')
    if (btn.dataset.tab === 'failed') renderFailed()
    if (btn.dataset.tab === 'downloading') renderDlPage(state.jobs[$('#dl-slot').value] || null)
    if (btn.dataset.tab === 'history') loadHistory()
  })
})

// ---------- 歌单导入 ----------
async function importPlaylistFile(file) {
  if (!file) return
  try {
    const base64 = await readFileAsBase64(file)
    toast(t('dyn.parsingPlaylist'))
    const data = await api('/api/playlist', { body: { base64, filename: file.name } })
    state.songs = data.songs
    state.selected = new Set(data.songs.map(s => s.idx))
    $('#parse-result').textContent = t('dyn.importedFile', { name: file.name, n: data.count })
    renderSongList()
    $('#list-card').classList.remove('hidden')
    toast(t('dyn.parseOk', { n: data.count }))
  } catch (err) {
    toast(t('dyn.importFail', { msg: err.message }), true)
  }
}

async function importPlaylistUrl() {
  const input = $('#playlist-url')
  const url = input.value.trim()
  if (!url) return toast(t('pl.needLink'), true)
  const button = $('#parse-url')
  button.disabled = true
  try {
    toast(t('dyn.readingOnline'))
    const data = await api('/api/playlist-url', { body: { url } })
    state.songs = data.songs
    state.selected = new Set(data.songs.map(s => s.idx))
    const name = [data.platformName, data.title].filter(Boolean).join(' · ')
    $('#parse-result').textContent = t('dyn.importedOnline', { name: name || '...', n: data.count })
    renderSongList()
    $('#list-card').classList.remove('hidden')
    toast(t('dyn.parseOk', { n: data.count }))
  } catch (err) {
    toast(t('dyn.parseUrlFail', { msg: err.message }), true)
  } finally {
    button.disabled = false
  }
}

$('#file-input').addEventListener('change', e => importPlaylistFile(e.target.files[0]))
$('#pick-file').addEventListener('click', () => $('#file-input').click())
$('#parse-url').addEventListener('click', importPlaylistUrl)
$('#playlist-url').addEventListener('keydown', e => { if (e.key === 'Enter') importPlaylistUrl() })
$('#drop-zone').addEventListener('click', e => {
  if (e.target.id !== 'pick-file' && e.target.id !== 'file-input') $('#file-input').click()
})
$('#drop-zone').addEventListener('dragover', e => { e.preventDefault(); $('#drop-zone').classList.add('dragover') })
$('#drop-zone').addEventListener('dragleave', () => $('#drop-zone').classList.remove('dragover'))
$('#drop-zone').addEventListener('drop', e => {
  e.preventDefault()
  $('#drop-zone').classList.remove('dragover')
  importPlaylistFile(e.dataTransfer.files[0])
})

// ---------- 歌单保存 / 恢复 ----------

async function loadSavedPlaylists() {
  try {
    const d = await api('/api/playlists')
    state.lastSavedPlaylists = d
    renderSavedPlaylists(d.playlists || [])
  } catch (_) {}
}

function renderSavedPlaylists(list) {
  const card = $('#saved-playlists-card')
  const grid = $('#saved-playlist-list')
  grid.innerHTML = ''
  card.classList.toggle('hidden', !list.length)
  $('#saved-playlists-count').textContent = t('pl.savedCount', { n: list.length })
  for (const pl of list) {
    const item = document.createElement('div')
    item.className = 'saved-item' + (state.openedPlaylist === pl.name ? ' active' : '')
    item.title = t('pl.openTip')
    const name = document.createElement('div')
    name.className = 'sp-name'
    name.textContent = pl.name
    const meta = document.createElement('div')
    meta.className = 'sp-meta'
    meta.textContent = t('pl.tracksCount', { n: pl.count }) + ' · ' + (pl.savedAt ? new Date(pl.savedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
    const del = document.createElement('button')
    del.className = 'sp-del'
    del.textContent = '×'
    del.title = t('pl.delete')
    del.addEventListener('click', async e => {
      e.stopPropagation()
      try {
        await api('/api/playlist/delete', { body: { name: pl.name } })
        if (state.openedPlaylist === pl.name) state.openedPlaylist = ''
        toast(t('pl.deleteOk'))
        loadSavedPlaylists()
      } catch (err) { toast(t('pl.deleteFail', { msg: err.message }), true) }
    })
    item.appendChild(name)
    item.appendChild(meta)
    item.appendChild(del)
    item.addEventListener('click', async () => {
      try {
        const d = await api('/api/playlist/open', { body: { name: pl.name } })
        state.songs = d.songs
        state.selected = new Set(d.songs.map(s => s.idx))
        state.openedPlaylist = pl.name
        $('#parse-result').textContent = t('pl.opened', { name: d.name, n: d.count })
        renderSongList()
        $('#list-card').classList.remove('hidden')
        $('#list-card').scrollIntoView({ behavior: 'smooth', block: 'start' })
        loadSavedPlaylists()
      } catch (err) {
        toast(t('pl.openFail', { msg: err.message }), true)
      }
    })
    grid.appendChild(item)
  }
}

$('#save-playlist').addEventListener('click', async () => {
  if (!state.songs.length) return toast(t('pl.needImport'), true)
  try {
    const data = await api('/api/playlist/save', { body: {} })
    toast(t('pl.saveOk', { name: data.name }))
    $('#parse-result').textContent = t('dyn.savedPlaylist', { title: data.name, n: data.count })
    loadSavedPlaylists()
  } catch (err) {
    toast(t('common.saveFail', { msg: err.message }), true)
  }
})

loadSavedPlaylists()

// ---------- 歌曲列表 ----------
// ---------- 通用分页 ----------
const pageState = {}
const pagerRerender = {
  song: () => renderSongList(),
  dl: () => renderDlPage(state.jobs[$('#dl-slot').value] || null),
  failed: () => renderFailed(),
  history: () => state.lastHistory && renderHistory(state.lastHistory),
  search: () => state.lastSearchData && renderSearchResults(state.lastSearchData),
  qobuzAlbum: () => state.lastQobuzData && state.lastQobuzMode === 'album' && renderQobuzAlbumResults(state.lastQobuzData),
  qobuz: () => state.lastQobuzData && state.lastQobuzMode === 'track' && renderQobuzResults(state.lastQobuzData),
}
function pageSizeNow() { return Number(state.pageSize) || 20 }
function renderPagedList(key, ulEl, items, renderItem) {
  const size = pageSizeNow()
  const pages = Math.max(1, Math.ceil(items.length / size))
  const st = pageState[key] || (pageState[key] = { page: 1, src: items })
  if (st.src !== items) { st.page = 1; st.src = items } // 数据源变化 → 回到第一页
  if (st.page > pages) st.page = pages
  const page = st.page
  items.slice((page - 1) * size, page * size).forEach((item, i) => renderItem(item, (page - 1) * size + i))
  const old = ulEl.nextElementSibling
  if (old && old.classList.contains('pager')) old.remove()
  if (pages > 1) {
    const pager = document.createElement('div')
    pager.className = 'pager'
    const mk = (label, dis, fn) => { const b = document.createElement('button'); b.className = 'btn small'; b.textContent = label; b.disabled = dis; b.addEventListener('click', fn); return b }
    const info = document.createElement('span')
    info.className = 'pg-info'
    info.textContent = t('pager.info', { page, pages })
    pager.append(mk('‹', page <= 1, () => { pageState[key].page--; pagerRerender[key]() }), info, mk('›', page >= pages, () => { pageState[key].page++; pagerRerender[key]() }))
    ulEl.after(pager)
  }
}

function renderSongList() {
  const list = $('#song-list')
  list.innerHTML = ''
  renderPagedList('song', list, state.songs, (s) => {
    const li = document.createElement('li')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = state.selected.has(s.idx)
    cb.addEventListener('change', () => {
      cb.checked ? state.selected.add(s.idx) : state.selected.delete(s.idx)
      updateToolbar()
    })
    const idx = document.createElement('span')
    idx.className = 'song-idx'
    idx.textContent = s.idx + 1
    const main = document.createElement('div')
    main.className = 'song-main'
    main.innerHTML = `<div class="song-name"></div><div class="song-sub"></div>`
    main.querySelector('.song-name').textContent = s.name
    main.querySelector('.song-sub').textContent = `${s.artist}${s.album ? ' · ' + s.album : ''}`
    const dur = document.createElement('span')
    dur.className = 'song-dur'
    dur.textContent = s.duration ? fmtDur(s.duration) : ''
    const st = document.createElement('span')
    st.className = 'status'
    st.dataset.idx = s.idx
    st.textContent = ''
    li.append(cb, idx, main, dur, st)
    // 点整行任意位置都能勾选/取消勾选（勾选框自己处理 change，避免双重切换）
    li.addEventListener('click', e => {
      if (e.target === cb) return
      cb.checked = !cb.checked
      cb.checked ? state.selected.add(s.idx) : state.selected.delete(s.idx)
      updateToolbar()
    })
    list.appendChild(li)
  })
  updateToolbar()
}

function fmtDur(sec) {
  sec = Math.round(sec) // 各平台时长可能带小数（如 203.776 秒），先取整避免显示 3:23.776…
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function updateToolbar() {
  $('#song-count').textContent = t('pl.countSel', { total: state.songs.length, sel: state.selected.size })
  $('#download-btn').disabled = state.selected.size === 0 || (state.job && state.job.running)
}

$('#select-all').addEventListener('click', () => { state.selected = new Set(state.songs.map(s => s.idx)); renderSongList() })
$('#select-invert').addEventListener('click', () => {
  state.selected = new Set(state.songs.filter(s => !state.selected.has(s.idx)).map(s => s.idx))
  renderSongList()
})
$('#select-none').addEventListener('click', () => { state.selected = new Set(); renderSongList() })

// ---------- 下载 ----------
$('#download-btn').addEventListener('click', async () => {
  if (!state.selected.size) return
  try {
    await api('/api/playlist/download', { body: { indices: [...state.selected] } })
    startPolling()
  } catch (err) {
    toast(`启动失败：${err.message}`, true)
  }
})

function startPolling() {
  stopPolling()
  $('#progress-bar-wrap').classList.remove('hidden')
  state.polling = setInterval(pollJobs, 700)
  pollJobs()
}

function stopPolling() {
  if (state.polling) { clearInterval(state.polling); state.polling = null }
}

async function pollJobs() {
  const slots = ['playlist', 'lx', 'qobuz']
  const results = await Promise.all(slots.map(async slot => {
    try { return [slot, await api(`/api/job?slot=${slot}`)] } catch { return [slot, null] }
  }))
  for (const [slot, job] of results) if (job) state.jobs[slot] = job
  state.job = state.jobs.playlist
  const job = state.job
  if (!job) return
  const total = job.total || 1
  $('#progress-fill').style.width = `${Math.round((job.done / total) * 100)}%`
  $('#progress-text').textContent = job.running
    ? (job.paused ? t('dl.pausedShort') + ' · ' : t('dl.downloading') + ' ') + `${job.done}/${job.total}`
    : t('dl.progressDone', { done: job.done, total: job.total }) + (job.error ? t('dl.errWrap', { err: job.error }) : '')
  for (const e of job.entries) {
    const el = $(`.status[data-idx="${e.idx}"]`)
    if (el) {
      const realFmt = e.realFormat && !(e.quality || '').includes(e.realFormat) ? ` (${e.realFormat})` : ''
      el.textContent = statusText(e.status) + (e.quality ? ` · ${e.quality}${realFmt}` : '')
      el.className = `status ${e.status}`
    }
  }
  renderDlPage(state.jobs[$('#dl-slot').value] || null)
  updateDlBadge(state.jobs)
  const anyRunning = Object.values(state.jobs).some(item => item && item.running)
  if (!anyRunning) {
    stopPolling()
    if (job && !job.running) { collectFailed(job); updateToolbar(); toast(t('dyn.taskDone', { done: job.done, total: job.total })) }
  }
}

function collectFailed(job) {
  const failed = job.entries.filter(e => ['no_match', 'no_url', 'failed', 'lossless_unavailable'].includes(e.status))
  state.failedIds = new Set(failed.map(e => e.idx))
  state.lastFailed = failed
  updateFailedBadge()
}

function updateFailedBadge() {
  const n = state.failedIds.size
  const badge = $('#failed-badge')
  badge.textContent = n
  badge.classList.toggle('hidden', n === 0)
  $('#retry-btn').disabled = n === 0
}

// ---------- 失败页 ----------
function renderFailed() {
  const list = $('#failed-list')
  list.innerHTML = ''
  const failed = state.lastFailed || []
  $('#failed-count').textContent = failed.length ? t('fail.count', { n: failed.length }) : t('fa.empty')
  renderPagedList('failed', list, failed, (e) => {
    const li = document.createElement('li')
    li.innerHTML = `
      <div class="song-main">
        <div class="song-name"></div>
        <div class="fail-reason"></div>
      </div>
      <span class="status ${e.status}">${statusText(e.status)}</span>`
    li.querySelector('.song-name').textContent = `${e.artist} - ${e.name}`
    li.querySelector('.fail-reason').textContent = e.error
      ? t('fail.err', { msg: e.error })
      : (e.matched ? t('fail.matched', { m: `${e.matched.singer} - ${e.matched.name} [${e.matched.source}]` }) : t('fail.noMatch'))
    list.appendChild(li)
  })
}

$('#retry-btn').addEventListener('click', async () => {
  if (!state.failedIds.size) return
  try {
    await api('/api/playlist/download', { body: { indices: [...state.failedIds], force: true } })
    document.querySelector('.tab[data-tab="playlist"]').click()
    toast(t('fa.retryToast'))
    startPolling()
  } catch (err) {
    toast(t('search.startFail', { msg: err.message }), true)
  }
})

$('#clear-failed').addEventListener('click', () => {
  state.failedIds = new Set()
  state.lastFailed = []
  updateFailedBadge()
  renderFailed()
})

// ---------- 下载页 ----------

function fmtBytes(n) {
  if (n == null) return ''
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB'
  if (n > 1024) return (n / 1024).toFixed(0) + 'KB'
  return n + 'B'
}

function renderDlPage(job) {
  const list = $('#dl-list')
  const isActive = $('#tab-downloading').classList.contains('active')
  if (!isActive) return // 只在下载页可见时渲染，避免大量 DOM 重绘
  const entries = (job && job.entries) || []
  $('#dl-summary').textContent = job
    ? `${job.paused ? t('dl.pausedShort') : (job.running ? t('dl.downloading') : t('dyn.done'))} · ${job.done}/${job.total}${job.error ? ' · ' + job.error : ''}`
    : t('dl.empty')
  if (job && job.total) {
    $('#dl-progress-bar-wrap').classList.remove('hidden')
    $('#dl-progress-fill').style.width = `${Math.round((job.done / job.total) * 100)}%`
  } else {
    $('#dl-progress-bar-wrap').classList.add('hidden')
  }
  const running = entries.some(e => e.status === 'downloading' || e.status === 'queued' || e.status === 'paused')
  $('#dl-pause').disabled = !job || !job.running || job.paused
  $('#dl-pause').classList.toggle('hidden', job && job.paused)
  $('#dl-resume').disabled = !job || !job.paused
  $('#dl-resume').classList.toggle('hidden', !job || !job.paused)
  $('#dl-cancel').disabled = !running

  list.innerHTML = ''
  renderPagedList('dl', list, entries, (e) => {
    const li = document.createElement('li')
    const cancelable = ['queued', 'downloading', 'paused'].includes(e.status)
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.dataset.key = e.idx
    cb.disabled = !cancelable
    cb.style.visibility = cancelable ? 'visible' : 'hidden'
    const main = document.createElement('div')
    main.className = 'song-main'
    const pct = e.dlTotal ? Math.round((e.dlBytes / e.dlTotal) * 100) : null
    const progressHtml = e.status === 'downloading'
      ? `<div class="dl-row-bar"><i style="width:${pct ?? 0}%"></i></div>`
      : ''
    main.innerHTML = `<div class="song-name"></div><div class="song-sub"></div>${progressHtml}`
    main.querySelector('.song-name').textContent = `${e.artist} - ${e.name}`
    const subBits = []
    if (e.album) subBits.push(e.album)
    if (e.matched) subBits.push(`→ ${e.matched.singer} - ${e.matched.name} [${e.matched.source}]`)
    if (e.error) subBits.push(t('fail.err', { msg: e.error }))
    main.querySelector('.song-sub').textContent = subBits.join(' · ')
    const st = document.createElement('span')
    st.className = `status ${e.status}`
    st.textContent = statusText(e.status) + (e.quality ? ` · ${e.quality}` : '')
    const prog = document.createElement('span')
    prog.className = 'dl-progress'
    if (e.status === 'downloading' && e.dlBytes != null) {
      prog.textContent = `${pct ?? '?'}% ${fmtBytes(e.dlBytes)}${e.dlTotal ? '/' + fmtBytes(e.dlTotal) : ''}`
    } else if (e.status === 'downloaded' && e.bytes) {
      prog.textContent = fmtBytes(e.bytes)
    }
    li.append(cb, main, st, prog)
    list.appendChild(li)
  })
}

function updateDlBadge(jobs) {
  const n = Object.values(jobs || {}).reduce((sum, job) => sum + (job ? job.entries.filter(e => e.status === 'downloading' || e.status === 'queued').length : 0), 0)
  const badge = $('#downloading-badge')
  badge.textContent = n
  const anyRunning = Object.values(jobs || {}).some(job => job && job.running)
  badge.classList.toggle('hidden', !anyRunning || n === 0)
}

$('#dl-slot').addEventListener('change', () => renderDlPage(state.jobs[$('#dl-slot').value] || null))

$('#dl-pause').addEventListener('click', async () => {
  try {
    await api(`/api/job/pause?slot=${$('#dl-slot').value}`, { body: {} })
    toast(t('dl.pausedToast'))
  } catch (err) { toast(t('dl.pauseFail', { msg: err.message }), true) }
})

$('#dl-resume').addEventListener('click', async () => {
  try {
    await api(`/api/job/resume?slot=${$('#dl-slot').value}`, { body: {} })
    toast(t('dl.resumeToast'))
    startPolling()
  } catch (err) { toast(t('dl.resumeFail', { msg: err.message }), true) }
})

$('#dl-cancel').addEventListener('click', async () => {
  const keys = [...document.querySelectorAll('#dl-list input[type=checkbox]:checked')].map(cb => cb.dataset.key)
  if (!keys.length) return toast(t('dl.cancelPrompt'), true)
  try {
    await api('/api/job/cancel', { body: { keys, slot: $('#dl-slot').value } })
    toast(t('dl.cancelToast', { n: keys.length }))
  } catch (err) { toast(t('dl.cancelFail', { msg: err.message }), true) }
})

// ---------- 搜索页 ----------

$('#search-btn').addEventListener('click', runSearch)
$('#search-name').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch() })
$('#search-artist').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch() })

async function runSearch() {
  const name = $('#search-name').value.trim()
  const artist = $('#search-artist').value.trim()
  if (!name && !artist) return toast(t('search.needQuery'), true)
  const btn = $('#search-btn')
  btn.disabled = true
  btn.textContent = t('common.searching')
  $('#search-status').textContent = ''
  try {
    const data = await api('/api/search', { body: { name, artist, source: $('#search-source').value } })
    renderSearchResults(data)
  } catch (err) {
    toast(t('search.fail', { msg: err.message }), true)
  } finally {
    btn.disabled = false
    btn.textContent = t('common.search')
  }
}

const LX_SOURCE_NAMES = () => ({ kw: t('kw.kw'), kg: t('kw.kg'), tx: t('kw.tx'), wy: t('kw.wy'), mg: t('kw.mg') })

function renderSearchResults(data) {
  const list = $('#search-results')
  list.innerHTML = ''
  const failedText = (data.failed || []).map(s => LX_SOURCE_NAMES()[s] || s).join('、')
  const failedSuffix = failedText ? t('search.noResp', { names: failedText }) : ''
  $('#search-status').textContent = data.results.length
    ? t('search.found', { q: data.query, n: data.results.length }) + failedSuffix
    : t('search.none', { q: data.query }) + failedSuffix
  state.lastSearchData = data
  renderPagedList('search', list, data.results, (r) => {
    const li = document.createElement('li')
    const main = document.createElement('div')
    main.className = 'song-main'
    main.innerHTML = `<div class="song-name"></div><div class="song-sub"></div>`
    main.querySelector('.song-name').textContent = `${r.singer} - ${r.name}`
    main.querySelector('.song-sub').innerHTML = `${r.albumName || ''} · ${r.interval || ''} · <span class="sr-types">${r.types.join('/') || t('qz.qualityUnknown')}</span>`
    const src = document.createElement('span')
    src.className = 'sr-source'
    src.textContent = r.source
    const btn = document.createElement('button')
    btn.className = 'btn primary sr-btn'
    btn.textContent = t('common.download')
    btn.addEventListener('click', async () => {
      btn.disabled = true
      btn.textContent = t('common.submitting')
      try {
        await api('/api/download-search', { body: { items: [r] } })
        state.currentSlot = 'lx'
        setSelect($('#dl-slot'), 'lx')
        document.querySelector('.tab[data-tab="downloading"]').click()
        toast(t('search.added', { name: `${r.singer} - ${r.name}` }))
        startPolling()
      } catch (err) {
        toast(t('search.startFail', { msg: err.message }), true)
        btn.disabled = false
        btn.textContent = t('common.download')
      }
    })
    li.append(src, main, btn)
    list.appendChild(li)
  })
}

// ---------- Qobuz 搜索页 ----------

$('#qobuz-search-btn').addEventListener('click', runQobuzSearch)
$('#qobuz-search-name').addEventListener('keydown', e => { if (e.key === 'Enter') runQobuzSearch() })
$('#qobuz-search-artist').addEventListener('keydown', e => { if (e.key === 'Enter') runQobuzSearch() })

async function runQobuzSearch() {
  const name = $('#qobuz-search-name').value.trim()
  const artist = $('#qobuz-search-artist').value.trim()
  if (!name && !artist) return toast(t('search.needQuery'), true)
  const type = $('#qobuz-search-type').value
  const btn = $('#qobuz-search-btn')
  btn.disabled = true
  btn.textContent = t('common.searching')
  $('#qobuz-search-status').textContent = ''
  try {
    const data = type === 'album'
      ? await api('/api/qobuz/search-albums', { body: { name, artist } })
      : await api('/api/qobuz/search', { body: { name, artist } })
    type === 'album' ? renderQobuzAlbumResults(data) : renderQobuzResults(data)
  } catch (err) {
    toast(t('qzs.fail', { msg: err.message }), true)
  } finally {
    btn.disabled = false
    btn.textContent = t('common.search')
  }
}

// 搜索类型切换：单曲 / 专辑，占位提示跟随变化
$('#qobuz-search-type').addEventListener('change', () => {
  const album = $('#qobuz-search-type').value === 'album'
  $('#qobuz-search-name').placeholder = album ? t('qz.namePhAlbum') : t('qz.namePh')
  $('#qobuz-search-artist').placeholder = album ? t('qz.artistPhAlbum') : t('qz.artistPh')
})

function renderQobuzAlbumResults(data) {
  const list = $('#qobuz-search-results')
  list.innerHTML = ''
  const results = data.results || []
  state.lastQobuzData = data
  state.lastQobuzMode = 'album'
  $('#qobuz-search-status').textContent = results.length ? t('qzs.foundAlbums', { q: data.query, n: results.length }) : t('qzs.noneAlbums', { q: data.query })
  renderPagedList('qobuzAlbum', list, results, (r) => {
    const li = document.createElement('li')
    const main = document.createElement('div')
    main.className = 'song-main'
    main.innerHTML = '<div class="song-name"></div><div class="song-sub"></div>'
    main.querySelector('.song-name').textContent = `${r.singer} - ${r.name}`
    const quality = r.hires ? 'Hi-Res' : 'Lossless'
    main.querySelector('.song-sub').textContent = [r.year, `${r.tracksCount || '?'} ${t('qz.tracksUnit')}`, quality].join(' · ')
    const src = document.createElement('span')
    src.className = 'sr-source'
    src.textContent = t('qz.typeAlbum')
    const btn = document.createElement('button')
    btn.className = 'btn primary sr-btn'
    btn.textContent = t('qz.downloadAlbum')
    btn.addEventListener('click', async () => {
      btn.disabled = true
      btn.textContent = t('qurl.parsing')
      try {
        const dl = await api('/api/qobuz/download-url', { body: { url: r.url } })
        state.currentSlot = 'qobuz'
        setSelect($('#dl-slot'), 'qobuz')
        document.querySelector('.tab[data-tab="downloading"]').click()
        toast(t('qzs.added', { name: dl.name, n: dl.total }))
        startPolling()
      } catch (err) {
        toast(t('qzs.parseFail', { msg: err.message }), true)
        btn.disabled = false
        btn.textContent = t('qz.downloadAlbum')
      }
    })
    li.append(src, main, btn)
    list.appendChild(li)
  })
}

function renderQobuzResults(data) {
  const list = $('#qobuz-search-results')
  list.innerHTML = ''
  const results = data.results || []
  state.lastQobuzData = data
  state.lastQobuzMode = 'track'
  $('#qobuz-search-status').textContent = results.length ? t('search.found', { q: data.query, n: results.length }) : t('search.none', { q: data.query })
  renderPagedList('qobuz', list, results, (r) => {
    const li = document.createElement('li')
    const main = document.createElement('div')
    main.className = 'song-main'
    main.innerHTML = '<div class="song-name"></div><div class="song-sub"></div>'
    main.querySelector('.song-name').textContent = `${r.singer} - ${r.name}`
    const quality = r.hires ? 'Hi-Res' : 'Lossless / MP3'
    main.querySelector('.song-sub').textContent = `${r.album || t('qz.unknownAlbum')} · ${r.duration ? fmtDur(r.duration) : ''} · ${quality}`
    const src = document.createElement('span')
    src.className = 'sr-source'
    src.textContent = 'Qobuz'
    const btn = document.createElement('button')
    btn.className = 'btn primary sr-btn'
    btn.textContent = t('common.download')
    btn.addEventListener('click', async () => {
      btn.disabled = true
      btn.textContent = t('common.submitting')
      try {
        await api('/api/qobuz/download', { body: { items: [{ ...r, key: `q${r.id}` }] } })
        state.currentSlot = 'qobuz'
        setSelect($('#dl-slot'), 'qobuz')
        document.querySelector('.tab[data-tab="downloading"]').click()
        toast(t('qzs.addedTrack', { name: `${r.singer} - ${r.name}` }))
        startPolling()
      } catch (err) {
        toast(t('search.startFail', { msg: err.message }), true)
        btn.disabled = false
        btn.textContent = t('common.download')
      }
    })
    li.append(src, main, btn)
    list.appendChild(li)
  })
}

// ---------- Qobuz 链接下载 ----------

async function downloadQobuzUrl() {
  const url = $('#qobuz-url').value.trim()
  if (!url) return toast(t('qurl.needed'), true)
  const btn = $('#qobuz-url-btn')
  btn.disabled = true
  btn.textContent = t('qurl.parsing')
  $('#qobuz-url-status').textContent = ''
  try {
    const data = await api('/api/qobuz/download-url', { body: { url } })
    $('#qobuz-url').value = ''
    const errSuffix = (data.errors || []).length ? t('qurl.errSuffix', { n: data.errors.length }) : ''
    $('#qobuz-url-status').textContent = t('qurl.addedOk', { name: data.name, n: data.total }) + errSuffix
    state.currentSlot = 'qobuz'
    setSelect($('#dl-slot'), 'qobuz')
    document.querySelector('.tab[data-tab="downloading"]').click()
    toast(t('qzs.added', { name: data.name, n: data.total }))
    startPolling()
  } catch (err) {
    $('#qobuz-url-status').textContent = t('qurl.fail', { msg: err.message })
    toast(t('qzs.parseFail', { msg: err.message }), true)
  } finally {
    btn.disabled = false
    btn.textContent = t('qz.join')
  }
}

function readUrlFile(file) {
  if (!file) return
  const r = new FileReader()
  r.onload = () => {
    const text = String(r.result || '').trim()
    if (!text) return toast(t('qurl.needed'), true)
    $('#qobuz-url').value = text
    const n = text.split(/\r?\n/).filter(l => l.trim()).length
    toast(t('dyn.urlFileLoaded', { name: file.name, n }))
  }
  r.onerror = () => toast(t('qz.urlFileFail', { msg: 'read error' }), true)
  r.readAsText(file)
}

$('#qobuz-url-file-btn').addEventListener('click', () => $('#qobuz-url-file').click())
$('#qobuz-url-file').addEventListener('change', e => readUrlFile(e.target.files[0]))

const qzUrlCard = $('#qobuz-url-card')
qzUrlCard.addEventListener('dragover', e => { e.preventDefault(); qzUrlCard.classList.add('dragover') })
qzUrlCard.addEventListener('dragleave', () => qzUrlCard.classList.remove('dragover'))
qzUrlCard.addEventListener('drop', e => {
  e.preventDefault()
  qzUrlCard.classList.remove('dragover')
  readUrlFile(e.dataTransfer.files[0])
})

$('#qobuz-url-btn').addEventListener('click', downloadQobuzUrl)
$('#qobuz-url').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) downloadQobuzUrl() })

// ---------- 下载记录 ----------

async function loadHistory() {
  try {
    const data = await api('/api/history')
    state.lastHistory = data
    renderHistory(data)
  } catch (err) {
    toast(t('hi.readFail', { msg: err.message }), true)
  }
}

function renderHistory(data) {
  const filter = $('#history-filter').value
  const all = (data && data.entries) || []
  if (state._histData !== data || state._histFilter !== filter || !state._histList) {
    state._histData = data
    state._histFilter = filter
    state._histList = all.filter(e => !filter || e.source === filter)
  }
  const entries = state._histList
  const s = data && data.summary || {}
  const bits = [t('hi.total', { n: s.total || 0 })]
  if (s.lx) bits.push(`LX ${s.lx}`)
  if (s.qobuz) bits.push(`Qobuz ${s.qobuz}`)
  if (s.failed) bits.push(t('hi.failedBit', { n: s.failed }))
  $('#history-summary').textContent = bits.join(' · ')
  const list = $('#history-list')
  list.innerHTML = ''
  if (!entries.length) {
    const empty = document.createElement('li')
    empty.className = 'muted'
    empty.style.justifyContent = 'center'
    empty.textContent = filter ? t('hi.noneFiltered') : t('hi.none')
    list.appendChild(empty)
    return
  }
  renderPagedList('history', list, entries, (e) => {
    const li = document.createElement('li')
    const src = document.createElement('span')
    src.className = 'sr-source'
    src.textContent = e.source === 'qobuz' ? 'Qobuz' : 'LX'
    const main = document.createElement('div')
    main.className = 'song-main'
    main.innerHTML = '<div class="song-name"></div><div class="song-sub"></div>'
    main.querySelector('.song-name').textContent = `${e.artist || ''} - ${e.name || ''}`.trim() || t('qz.unknownTrack')
    const sub = [e.playlist, e.quality, e.realFormat, e.error ? t('fail.err', { msg: e.error }) : ''].filter(Boolean).join(' · ')
    main.querySelector('.song-sub').textContent = sub
    const time = document.createElement('span')
    time.className = 'hist-time'
    if (e.time) time.textContent = new Date(e.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    const st = document.createElement('span')
    st.className = `status ${e.status || ''}`
    st.textContent = statusText(e.status)
    li.append(src, main, time, st)
    list.appendChild(li)
  })
}

$('#history-filter').addEventListener('change', () => renderHistory(state.lastHistory))

$('#clear-history').addEventListener('click', async () => {
  try {
    await api('/api/history/clear', { body: {} })
    toast(t('hi.cleared'))
    loadHistory()
  } catch (err) {
    toast(t('hi.clearFail', { msg: err.message }), true)
  }
})

// ---------- 退出服务 ----------
$('#exit-btn').addEventListener('click', () => {
  const running = state.job && state.job.running
  $('#exit-modal-text').textContent = running
    ? t('modal.confirmRunning')
    : t('modal.confirm')
  $('#exit-modal').classList.remove('hidden')
})
$('#exit-cancel').addEventListener('click', () => $('#exit-modal').classList.add('hidden'))
$('#exit-modal').addEventListener('click', e => {
  if (e.target === $('#exit-modal')) $('#exit-modal').classList.add('hidden')
})
$('#exit-confirm').addEventListener('click', async () => {
  $('#exit-confirm').disabled = true
  $('#exit-confirm').textContent = t('common.exiting')
  try {
    await api('/api/exit', { body: {} })
  } catch { /* 服务已退出，请求失败属正常 */ }
  stopPolling()
  // 替换页面为退出提示页，并尝试自动关闭
  // 注：浏览器安全策略只允许脚本打开的窗口自关，被阻止时用户会看到提示页
  const isMac = navigator.platform.toUpperCase().includes('MAC')
  document.body.innerHTML = `
    <div class="bye-screen">
      <div class="bye-icon">👋</div>
      <div class="bye-title">${t('exit.done')}</div>
      <div class="bye-sub">${t('exit.closing')}${t('exit.closeHint', { key: isMac ? '⌘W' : 'Ctrl+W' })}</div>
    </div>`
  window.close()
  setTimeout(() => window.close(), 400)
})

// ---------- 设置页 ----------
async function loadSettings() {
  const s = await api('/api/settings')
  $('#out-dir').value = s.outDir
  document.querySelector(`input[name=quality][value="${s.qualityMode}"]`).checked = true
  document.querySelector(`input[name=playlist-priority][value="${s.playlistPriority || 'lx'}"]`).checked = true
  $('#concurrency').value = s.concurrency || 3
  $('#history-enabled').checked = s.downloadHistory !== false
  $('#page-size').value = String(s.listPageSize || 20)
  state.pageSize = s.listPageSize || 20
  // 语言：已保存 > 本地缓存 > 系统语言；首次自动保存系统语言
  const savedLang = s.lang || ''
  const lang = savedLang || localStorage.getItem('mu-lang') || detectLang()
  localStorage.setItem('mu-lang', lang)
  $('#lang-select').value = lang
  setLang(lang)
  if (!savedLang) api('/api/settings', { body: { lang } }).catch(() => {})
  $('#qobuz-quality').value = String(s.qobuzQuality || 'auto')
  $('#qobuz-embed').checked = !!s.qobuzEmbed
  $('#qobuz-keep-cover').checked = s.qobuzKeepCoverFile !== false
  $('#qobuz-dedup').checked = s.qobuzDedup !== false
  $('#qobuz-save-layout').value = s.qobuzSaveLayout || 'album'
  $('#qobuz-track-name').value = s.qobuzTrackName || 'default'
  $('#lx-file-pattern').value = PATTERN_DEFAULTS.includes(s.lxFilePattern || '') ? t('lx.patternPh') : (s.lxFilePattern || t('lx.patternPh'))
  $('#lx-group-by-list').checked = !!s.lxGroupByList
  $('#lx-save-lrc').checked = s.lxSaveLrc !== false
  $('#lx-embed-pic').checked = s.lxEmbedPic !== false
  $('#lx-embed-lyric').checked = s.lxEmbedLyric !== false
  $('#lx-proxy').value = s.lxProxy || ''
  const src = await api('/api/sources')
  $('#sources-text').value = src.urls.join('\n')
  refreshQobuzStatus()
}

async function refreshQobuzStatus() {
  try {
    const status = await api('/api/qobuz/status')
    if (!status.available) {
      $('#qobuz-login-status').textContent = t('qz.statusMissing')
      $('#qobuz-login').disabled = true
      $('#qobuz-logout').disabled = true
      return
    }
    $('#qobuz-login-status').textContent = status.loggedIn ? t('qz.statusOk') : t('qz.statusNo')
    $('#qobuz-login').disabled = false
    $('#qobuz-logout').disabled = !status.loggedIn
  } catch (err) {
    $('#qobuz-login-status').textContent = t('qz.statusError', { msg: err.message })
    $('#qobuz-login').disabled = true
    $('#qobuz-logout').disabled = true
  }
}

$('#qobuz-login').addEventListener('click', async () => {
  try {
    await api('/api/qobuz/login', { body: {} })
    toast(t('qz.loginToast'))
    setTimeout(refreshQobuzStatus, 3000)
  } catch (err) { toast(t('qz.loginFail', { msg: err.message }), true) }
})

$('#qobuz-logout').addEventListener('click', async () => {
  try { await api('/api/qobuz/logout', { body: {} }); toast(t('qz.logoutToast')); refreshQobuzStatus() }
  catch (err) { toast(t('qz.logoutFail', { msg: err.message }), true) }
})

function collectSettingsBody() {
  return {
    outDir: $('#out-dir').value.trim(),
    qualityMode: document.querySelector('input[name=quality]:checked').value,
    playlistPriority: document.querySelector('input[name=playlist-priority]:checked').value,
    concurrency: Math.min(10, Math.max(1, parseInt($('#concurrency').value, 10) || 3)),
    downloadHistory: $('#history-enabled').checked,
    listPageSize: Number($('#page-size').value) || 20,
    lxFilePattern: $('#lx-file-pattern').value.trim(),
    lxGroupByList: $('#lx-group-by-list').checked,
    lxSaveLrc: $('#lx-save-lrc').checked,
    lxEmbedPic: $('#lx-embed-pic').checked,
    lxEmbedLyric: $('#lx-embed-lyric').checked,
    lxProxy: $('#lx-proxy').value.trim(),
    qobuzQuality: $('#qobuz-quality').value,
    qobuzEmbed: $('#qobuz-embed').checked,
    qobuzKeepCoverFile: $('#qobuz-keep-cover').checked,
    qobuzDedup: $('#qobuz-dedup').checked,
    qobuzSaveLayout: $('#qobuz-save-layout').value,
    qobuzTrackName: $('#qobuz-track-name').value,
  }
}

function reapplyPageSize() {
  state.pageSize = Number($('#page-size').value) || 20
  Object.keys(pageState).forEach(k => { pageState[k].page = 1 })
  renderSongList()
  renderDlPage(state.jobs[$('#dl-slot').value] || null)
  if (state.lastSearchData) renderSearchResults(state.lastSearchData)
  if (state.lastQobuzData) (state.lastQobuzMode === 'album' ? renderQobuzAlbumResults(state.lastQobuzData) : renderQobuzResults(state.lastQobuzData))
  if (state.lastHistory) renderHistory(state.lastHistory)
  if (state.lastFailed) renderFailed()
}

$('#save-settings').addEventListener('click', async () => {
  try {
    await api('/api/settings', { body: collectSettingsBody() })
    reapplyPageSize()
    toast(t('common.saved'))
  } catch (err) {
    toast(t('common.saveFail', { msg: err.message }), true)
  }
})

$('#qobuz-save').addEventListener('click', async () => {
  try {
    await api('/api/settings', { body: collectSettingsBody() })
    $('#qobuz-msg').textContent = t('common.savedMark')
    toast(t('common.savedQz'))
    setTimeout(() => { $('#qobuz-msg').textContent = '' }, 2500)
  } catch (err) {
    toast(t('common.saveFail', { msg: err.message }), true)
  }
})

$('#lx-save').addEventListener('click', async () => {
  try {
    await api('/api/settings', { body: collectSettingsBody() })
    $('#lx-msg').textContent = t('common.savedMark')
    toast(t('common.savedLx'))
    setTimeout(() => { $('#lx-msg').textContent = '' }, 2500)
  } catch (err) {
    toast(t('common.saveFail', { msg: err.message }), true)
  }
})

$('#pick-folder').addEventListener('click', async () => {
  try {
    const { path } = await api('/api/folder-pick', { body: {} })
    $('#out-dir').value = path
  } catch (err) {
    toast(err.message, true)
  }
})

$('#import-sources').addEventListener('click', () => $('#sources-file-input').click())
$('#sources-file-input').addEventListener('change', async e => {
  const file = e.target.files[0]
  if (!file) return
  try {
    const base64 = await readFileAsBase64(file)
    const data = await api('/api/sources', { body: { base64 } })
    $('#sources-text').value = data.urls.join('\n')
    toast(t('src.imported', { n: data.urls.length }))
  } catch (err) {
    toast(t('dyn.importFail', { msg: err.message }), true)
  }
})

$('#save-sources').addEventListener('click', async () => {
  try {
    const data = await api('/api/sources', { body: { content: $('#sources-text').value } })
    toast(t('src.saved', { n: data.urls.length }))
  } catch (err) {
    toast(t('common.saveFail', { msg: err.message }), true)
  }
})

$('#clear-sources').addEventListener('click', async () => {
  try {
    const data = await api('/api/sources', { body: { clear: true } })
    // 删除上传的音源文件后，文本框回显内置音源，保持所见即所得
    $('#sources-text').value = data.urls.join('\n')
    toast('已清空自定义音乐源，恢复为内置音源')
  } catch (err) {
    toast(t('hi.clearFail', { msg: err.message }), true)
  }
})

// ---------- 自定义下拉框（网页内置渲染，不用系统样式） ----------

// 程序化改值统一走这里：更新值并触发 change，让自定义下拉的文案同步刷新
function setSelect(select, value) {
  if (select.value === value) return
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function closeAllCsMenus() {
  document.querySelectorAll('.cs-menu').forEach(m => m.classList.add('hidden'))
  document.querySelectorAll('.cs-trigger.open').forEach(t => t.classList.remove('open'))
}

function initCustomSelects() {
  document.querySelectorAll('select.slot-select').forEach(select => {
    if (select.dataset.csInit) return
    select.dataset.csInit = '1'
    const wrap = document.createElement('span')
    wrap.className = 'cs'
    select.parentNode.insertBefore(wrap, select)
    wrap.appendChild(select)
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'cs-trigger'
    const menu = document.createElement('span')
    menu.className = 'cs-menu hidden'
    const build = () => {
      const current = select.options[select.selectedIndex]
      trigger.innerHTML = ''
      const label = document.createElement('span')
      label.className = 'cs-label'
      label.textContent = current ? current.textContent : ''
      const arrow = document.createElement('span')
      arrow.className = 'cs-arrow'
      arrow.textContent = '▾'
      trigger.append(label, arrow)
      menu.innerHTML = ''
      Array.from(select.options).forEach(opt => {
        const item = document.createElement('span')
        item.className = 'cs-option' + (opt.selected ? ' active' : '')
        item.textContent = opt.textContent
        item.addEventListener('click', () => {
          closeAllCsMenus()
          if (select.value === opt.value) return
          select.value = opt.value
          build()
          select.dispatchEvent(new Event('change', { bubbles: true }))
        })
        menu.appendChild(item)
      })
    }
    trigger.addEventListener('click', () => {
      const opening = menu.classList.contains('hidden')
      closeAllCsMenus()
      if (opening) { menu.classList.remove('hidden'); trigger.classList.add('open') }
    })
    document.addEventListener('click', e => {
      if (!wrap.contains(e.target)) { menu.classList.add('hidden'); trigger.classList.remove('open') }
    })
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { menu.classList.add('hidden'); trigger.classList.remove('open') }
    })
    select.addEventListener('change', build)
    select.addEventListener('mu:rebuild', build)
    build()
    wrap.append(trigger, menu)
  })
}

// ---------- 启动 ----------
initCustomSelects()

// 语言：中文系统 → 中文；英文及其他所有语言 → 英文（首次打开后保存）
function detectLang() {
  return (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
setLang(localStorage.getItem('mu-lang') || detectLang())
document.addEventListener('langchange', () => {
  updateToolbar()
  document.querySelectorAll('select.slot-select').forEach(s => s.dispatchEvent(new Event('mu:rebuild')))
  $('#qobuz-search-type').dispatchEvent(new Event('change'))
  // 命名模板若仍是默认值，跟随语言显示对应写法
  const patternEl = $('#lx-file-pattern')
  if (PATTERN_DEFAULTS.includes(patternEl.value)) patternEl.value = t('lx.patternPh')
  if (state.lastHistory && document.querySelector('.tab[data-tab=history]').classList.contains('active')) renderHistory(state.lastHistory)
  if (state.lastSavedPlaylists && !document.querySelector('#saved-playlists-card').classList.contains('hidden')) renderSavedPlaylists(state.lastSavedPlaylists)
})
const PATTERN_DEFAULTS = ['{歌手} - {歌名}', '{artist} - {title}']
$('#lang-select').addEventListener('change', async () => {
  const lang = $('#lang-select').value
  localStorage.setItem('mu-lang', lang)
  setLang(lang)
  try { await api('/api/settings', { body: { lang } }) } catch (_) {}
})

// ---------- 回到顶部 ----------
const backTopBtn = $('#back-top')
window.addEventListener('scroll', () => {
  backTopBtn.classList.toggle('hidden', window.scrollY < 400)
}, { passive: true })
backTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }))

loadSettings().catch(() => {})
loadSavedPlaylists()
updateToolbar()
