#!/usr/bin/env node
'use strict'
/**
 * GUI 服务端：本地 HTTP 服务 + Web 界面
 * 零依赖实现（Node 内置 http），浏览器打开 http://127.0.0.1:8978 使用
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { Downloader } = require('./lib/downloader')
const { parsePlaylist } = require('./lib/playlist')
const { parseOnlinePlaylist } = require('./lib/online-playlist')
const { parseSourceList } = require('./lib/source-loader')
const { PLATFORMS } = require('./lib/sdk/search')
const { QobuzJob, available: qobuzAvailable, isLoggedIn, login: startQobuzLogin, runBridge: qobuzBridge, expand: qobuzExpand, searchAlbums: qobuzSearchAlbums } = require('./lib/qobuz')

const WORK_DIR = __dirname
const CACHE_DIR = path.join(WORK_DIR, 'cache')
const SETTINGS_FILE = path.join(WORK_DIR, 'settings.json')
const UPLOAD_PLAYLIST = path.join(CACHE_DIR, 'upload_playlist.txt')
const UPLOAD_SOURCES = path.join(CACHE_DIR, 'upload_sources.txt')
const PORT = parseInt(process.env.PORT || '8978', 10)
const FINAL_STATUS = new Set(['downloaded', 'existed', 'no_match', 'no_url', 'failed', 'lossless_unavailable', 'cancelled'])
const SEARCH_ORDER = ['kw', 'kg', 'wy', 'mg', 'tx']
const LX_SOURCE_NAMES = { kw: '酷我', kg: '酷狗', tx: 'QQ音乐', wy: '网易云', mg: '咪咕' }

// ---------- 设置 ----------

const DEFAULT_SETTINGS = {
  outDir: path.join(require('os').homedir(), 'Documents', 'music'),
  qualityMode: 'all', // 'all' 都下（优先无损） | 'lossless' 仅无损
  concurrency: 3,    // 同时下载歌曲数
  playlistPriority: 'lx', // 歌单综合下载优先使用 lx 或 qobuz
  qobuzQuality: 'auto',    // 'auto' 跟随 qualityMode | '5' | '6' | '7' | '27'
  qobuzEmbed: true,        // 把专辑封面内嵌到每一首歌
  qobuzDedup: true,        // 用本地数据库跳过已下载过的曲目
  qobuzSaveLayout: 'album', // 'album' 专辑文件夹 | 'flat' 平铺不建文件夹
  qobuzKeepCoverFile: true, // 在专辑文件夹里保留 cover.jpg 封面文件
  qobuzTrackName: 'default', // 'default' 曲号. 歌名 | 'artist-title' 歌手 - 歌名 | 'title' 歌名
  lxFilePattern: '{歌手} - {歌名}', // LX 文件命名模板：{歌手} {歌名} {专辑} {序号}
  lxGroupByList: false,    // 按歌单名分组保存
  lxSaveLrc: true,         // 同时保存 .lrc 歌词文件
  lxEmbedPic: true,        // 内嵌封面到音频
  lxEmbedLyric: true,      // 内嵌歌词到音频
  lxProxy: '',             // LX 下载代理，如 http://127.0.0.1:7897，空 = 直连
  downloadHistory: true,   // 记录下载历史（侧边栏可查看）
  listPageSize: 20,        // 列表每页显示条数（20/50/100）
  lang: '',                // 界面语言：'' 首次打开按系统语言自动保存 | 'zh' | 'en'
}

function loadSettings() {
  try {
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }
    // 从 Mac 拷贝到 Windows 时，旧设置里的 Mac 路径无效，自动重置为当前系统默认
    if (process.platform === 'win32' && /^\/Users\//.test(s.outDir)) {
      s.outDir = DEFAULT_SETTINGS.outDir
    }
    return s
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2))
}

// ---------- 下载任务 ----------

const jobs = { playlist: null, lx: null, qobuz: null }
const controls = { playlist: null, lx: null, qobuz: null }
let importedSongs = null // 当前界面导入的歌单，支持 Apple txt 和在线歌单
let importedListTitle = '' // 当前歌单标题（用于按歌单分组保存）

function setImportedSongs(songs) {
  importedSongs = songs.map((song, idx) => ({ ...song, idx }))
  return importedSongs
}

// ---------- 下载历史 ----------

const HISTORY_FILE = path.join(CACHE_DIR, 'download-history.jsonl')

function recordHistory(entry) {
  if (!loadSettings().downloadHistory) return
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.appendFileSync(HISTORY_FILE, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n')
  } catch (_) {}
}

function readHistory() {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').reverse()
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
  } catch {
    return []
  }
}

// ---------- 歌单保存（多歌单，按名字存取） ----------

const PLAYLISTS_DIR = path.join(CACHE_DIR, 'playlists')

function safePlaylistName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名歌单'
}

function playlistPath(name) {
  return path.join(PLAYLISTS_DIR, `${safePlaylistName(name)}.json`)
}

function listSavedPlaylists() {
  try {
    return fs.readdirSync(PLAYLISTS_DIR).filter(f => f.endsWith('.json')).map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(PLAYLISTS_DIR, f), 'utf8'))
        return { name: d.name, count: (d.songs || []).length, savedAt: d.savedAt }
      } catch (_) { return null }
    }).filter(Boolean)
  } catch (_) {
    return []
  }
}

async function startLxJob({ slot = 'playlist', indices, rawItems, force = false } = {}) {
  if (jobs[slot] && jobs[slot].running) throw new Error(`${slot === 'lx' ? 'LX' : '歌单'}已有下载任务进行中`)
  const settings = loadSettings()
  const playlistFile = fs.existsSync(UPLOAD_PLAYLIST) ? UPLOAD_PLAYLIST : path.join(WORK_DIR, 'Ll.txt')
  const sourcesFile = fs.existsSync(UPLOAD_SOURCES) ? UPLOAD_SOURCES : path.join(WORK_DIR, 'lxmusic.txt')

  let entries, runOpts
  if (rawItems && rawItems.length) {
    entries = rawItems.map((item, i) => ({
      idx: item.key,
      name: item.name,
      artist: item.artist,
      status: 'queued',
    }))
    runOpts = { rawItems }
  } else {
    const songs = importedSongs || setImportedSongs(parsePlaylist(playlistFile))
    const targetSet = new Set(indices)
    const targets = songs.filter((s, i) => targetSet.has(i))
    if (!targets.length) throw new Error('未选中任何歌曲')
    entries = targets.map(s => ({
      idx: s.idx,
      name: s.name,
      artist: s.artist,
      album: s.album,
      duration: s.duration,
      status: 'queued',
    }))
    runOpts = { songs: targets }
  }

  const job = {
    source: 'lx',
    kind: slot,
    running: true,
    total: entries.length,
    done: 0,
    entries,
    error: null,
  }
  jobs[slot] = job
  const byIdx = new Map(job.entries.map(e => [e.idx, e]))

  const activeDownloader = new Downloader({
    workDir: WORK_DIR,
    outDir: settings.outDir,
    playlistFile,
    sourcesFile,
    losslessOnly: settings.qualityMode === 'lossless',
    concurrency: settings.concurrency || 3,
    force,
    onProgress: (idx, entry) => {
      const e = byIdx.get(idx)
      if (!e) return
      Object.assign(e, entry)
      if (FINAL_STATUS.has(entry.status) && !e._counted) {
        e._counted = true
        job.done++
        recordHistory({ source: 'lx', kind: slot, name: e.name, artist: e.artist, album: e.album, status: entry.status, quality: entry.quality, realFormat: entry.realFormat, error: entry.error, playlist: slot === 'playlist' ? importedListTitle : undefined })
      }
    },
    onDownloadProgress: (idx, p) => {
      const e = byIdx.get(idx)
      if (!e) return
      e.dlBytes = p.received
      e.dlTotal = p.total
    },
  })
  controls[slot] = activeDownloader
  activeDownloader.run(runOpts).then(() => {
    job.running = false
  }).catch(err => {
    job.running = false
    job.error = err.message
    for (const e of job.entries) {
      if (!FINAL_STATUS.has(e.status)) { e.status = 'failed'; e.error = err.message }
    }
  })
  return job
}

// ---------- Qobuz 下载参数 ----------

const QOBUZ_QUALITIES = new Set(['auto', '5', '6', '7', '27'])

function qobuzQualityOf(settings) {
  if (QOBUZ_QUALITIES.has(String(settings.qobuzQuality)) && settings.qobuzQuality !== 'auto') {
    return parseInt(settings.qobuzQuality, 10)
  }
  return settings.qualityMode === 'lossless' ? 6 : 27
}

// 命名模板不能包含系统禁用字符（与 qobuz-dlp 规则一致）
function cleanFormat(value) {
  const v = String(value || '').trim()
  if (/[/:<>]/.test(v)) throw new Error('命名模板不能包含 / : < > 字符')
  return v
}

function qobuzExtraArgs(settings) {
  const args = []
  if (settings.qobuzEmbed) args.push('-e')
  if (!settings.qobuzDedup) args.push('--no-db')
  if (settings.qobuzTrackName === 'artist-title') args.push('-tf', '{artist} - {tracktitle}')
  else if (settings.qobuzTrackName === 'title') args.push('-tf', '{tracktitle}')
  if (settings.qobuzKeepCoverFile === false && !settings.qobuzEmbed) args.push('--no-cover')
  return args
}

async function startQobuzJob({ slot = 'qobuz', songs, force = false, playlistName = '' } = {}) {
  if (!isLoggedIn()) throw new Error('请先登录 Qobuz')
  if (jobs[slot] && jobs[slot].running) throw new Error('Qobuz 已有下载任务进行中')
  const settings = loadSettings()
  const items = songs.map((s, i) => ({ ...s, idx: s.idx ?? `q${i}` }))
  const qjob = new QobuzJob({
    songs: items,
    outDir: settings.outDir,
    quality: qobuzQualityOf(settings),
    extraArgs: qobuzExtraArgs(settings),
    flatten: settings.qobuzSaveLayout === 'flat',
    embedPic: settings.qobuzEmbed !== false,
    keepCoverFile: settings.qobuzKeepCoverFile !== false,
    playlistName,
    concurrency: settings.concurrency,
    onProgress: patch => {
      const e = qjob.entries.find(item => item.idx === patch.idx)
      if (!e) return
      Object.assign(e, patch)
      if (FINAL_STATUS.has(e.status) && !e._counted) {
        e._counted = true
        qjob.done++
        recordHistory({ source: 'qobuz', kind: slot, name: e.name, artist: e.artist, album: e.album, status: e.status, quality: qjob.quality, error: e.error })
      }
    },
  })
  qjob.source = 'qobuz'
  qjob.kind = slot
  jobs[slot] = qjob
  controls[slot] = qjob
  qjob.start().catch(err => { qjob.error = err.message; qjob.running = false })
  return qjob
}

function updateCompositeDone(job) {
  job.done = job.entries.filter(entry => FINAL_STATUS.has(entry.status)).length
}

async function runPlaylistLxPhase(job, songs, settings, force) {
  const playlistFile = fs.existsSync(UPLOAD_PLAYLIST) ? UPLOAD_PLAYLIST : path.join(WORK_DIR, 'Ll.txt')
  const sourcesFile = fs.existsSync(UPLOAD_SOURCES) ? UPLOAD_SOURCES : path.join(WORK_DIR, 'lxmusic.txt')
  const byIdx = new Map(job.entries.map(entry => [entry.idx, entry]))
  const downloader = new Downloader({
    workDir: WORK_DIR,
    outDir: settings.outDir,
    playlistFile,
    sourcesFile,
    losslessOnly: settings.qualityMode === 'lossless',
    concurrency: settings.concurrency || 3,
    force,
    filePattern: settings.lxFilePattern,
    subDir: settings.lxGroupByList && importedListTitle ? importedListTitle : '',
    saveLrc: settings.lxSaveLrc !== false,
    embedLyric: settings.lxEmbedLyric !== false,
    embedPic: settings.lxEmbedPic !== false,
    proxy: settings.lxProxy || '',
    onProgress: (idx, patch) => {
      const entry = byIdx.get(idx)
      if (!entry) return
      Object.assign(entry, patch, { provider: 'lx' })
      if (FINAL_STATUS.has(entry.status) && !entry._hist) {
        entry._hist = true
        recordHistory({ source: 'lx', kind: 'playlist', name: entry.name, artist: entry.artist, album: entry.album, status: entry.status, quality: entry.quality, realFormat: entry.realFormat, error: entry.error, playlist: importedListTitle || undefined })
      }
      updateCompositeDone(job)
    },
    onDownloadProgress: (idx, progress) => {
      const entry = byIdx.get(idx)
      if (!entry) return
      entry.dlBytes = progress.received
      entry.dlTotal = progress.total
    },
  })
  controls.playlist = downloader
  await downloader.run({ songs })
}

async function runPlaylistQobuzPhase(job, songs, settings) {
  if (!songs.length) return
  if (!isLoggedIn()) throw new Error('请先登录 Qobuz，无法使用 Qobuz 备选下载')
  const byIdx = new Map(job.entries.map(entry => [entry.idx, entry]))
  let qjob
  qjob = new QobuzJob({
    songs,
    outDir: settings.outDir,
    quality: qobuzQualityOf(settings),
    extraArgs: qobuzExtraArgs(settings),
    flatten: settings.qobuzSaveLayout === 'flat',
    embedPic: settings.qobuzEmbed !== false,
    keepCoverFile: settings.qobuzKeepCoverFile !== false,
    playlistName: importedListTitle,
    concurrency: settings.concurrency,
    onProgress: patch => {
      const entry = byIdx.get(patch.idx)
      if (!entry) return
      Object.assign(entry, patch, { provider: 'qobuz' })
      if (FINAL_STATUS.has(entry.status) && !entry._hist) {
        entry._hist = true
        recordHistory({ source: 'qobuz', kind: 'playlist', name: entry.name, artist: entry.artist, album: entry.album, status: entry.status, error: entry.error, playlist: importedListTitle || undefined })
      }
      updateCompositeDone(job)
    },
  })
  controls.playlist = qjob
  await qjob.start()
  if (qjob.error) throw new Error(qjob.error)
}

async function startPlaylistJob({ indices, force = false } = {}) {
  if (jobs.playlist && jobs.playlist.running) throw new Error('歌单已有下载任务进行中')
  const settings = loadSettings()
  const playlistFile = fs.existsSync(UPLOAD_PLAYLIST) ? UPLOAD_PLAYLIST : path.join(WORK_DIR, 'Ll.txt')
  if (!importedSongs && !fs.existsSync(playlistFile)) throw new Error('请先在「我的歌单」导入歌单')
  const songs = importedSongs || setImportedSongs(parsePlaylist(playlistFile))
  const targetSet = new Set(indices)
  const targets = songs.filter(song => targetSet.has(song.idx))
  if (!targets.length) throw new Error('未选中任何歌曲')

  const job = {
    source: 'playlist',
    kind: 'playlist',
    provider: settings.playlistPriority,
    running: true,
    paused: false,
    total: targets.length,
    done: 0,
    entries: targets.map(song => ({
      idx: song.idx,
      name: song.name,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      status: 'queued',
      provider: settings.playlistPriority,
    })),
    error: null,
  }
  jobs.playlist = job
  controls.playlist = null

  const preferred = settings.playlistPriority === 'qobuz' ? 'qobuz' : 'lx'
  const fallback = preferred === 'qobuz' ? 'lx' : 'qobuz'
  const phaseSongs = targets.map(song => ({ ...song }))

  ;(async () => {
    try {
      if (preferred === 'qobuz' && !isLoggedIn()) {
        job.provider = 'lx'
        for (const song of phaseSongs) {
          const entry = job.entries.find(item => item.idx === song.idx)
          entry.status = 'queued'
          entry.provider = 'lx'
        }
        await runPlaylistLxPhase(job, phaseSongs, settings, force)
      } else {
        await (preferred === 'qobuz'
          ? runPlaylistQobuzPhase(job, phaseSongs, settings)
          : runPlaylistLxPhase(job, phaseSongs, settings, force))
      }

      const failedSongs = phaseSongs.filter(song => {
        const entry = job.entries.find(item => item.idx === song.idx)
        return entry && ['no_match', 'no_url', 'failed', 'lossless_unavailable'].includes(entry.status)
      })
      if (failedSongs.length && fallback === 'qobuz' && isLoggedIn()) {
        job.provider = `${preferred}+qobuz`
        for (const song of failedSongs) {
          const entry = job.entries.find(item => item.idx === song.idx)
          entry.status = 'queued'
          entry.error = ''
          entry._hist = false
          entry.provider = 'qobuz'
        }
        updateCompositeDone(job)
        await runPlaylistQobuzPhase(job, failedSongs, settings)
      } else if (failedSongs.length && fallback === 'lx') {
        job.provider = `${preferred}+lx`
        for (const song of failedSongs) {
          const entry = job.entries.find(item => item.idx === song.idx)
          entry.status = 'queued'
          entry.error = ''
          entry._hist = false
          entry.provider = 'lx'
        }
        updateCompositeDone(job)
        await runPlaylistLxPhase(job, failedSongs, settings, force)
      }
      updateCompositeDone(job)
    } catch (err) {
      job.error = err.message
      for (const e of job.entries) {
        if (!FINAL_STATUS.has(e.status)) { e.status = 'failed'; e.error = err.message }
      }
      updateCompositeDone(job)
    } finally {
      job.running = false
      controls.playlist = null
      updateCompositeDone(job)
    }
  })()
  return job
}

function publicJob(slot) {
  const job = jobs[slot]
  if (!job) return { source: slot === 'qobuz' ? 'qobuz' : 'lx', kind: slot, running: false, paused: false, total: 0, done: 0, error: null, entries: [] }
  return {
    source: job.source,
    kind: job.kind,
    running: !!job.running,
    paused: !!(job.paused || controls[slot]?.paused || controls[slot]?.control?.paused),
    total: job.total ?? job.entries.length,
    done: job.done || 0,
    error: job.error || null,
    entries: job.entries,
  }
}

// ---------- 搜索（歌单之外的歌） ----------

async function searchMusic(query, sourceFilter) {
  // sourceFilter 为空搜所有通道，指定则只搜单个通道
  const order = SEARCH_ORDER.includes(sourceFilter) ? [sourceFilter] : SEARCH_ORDER
  // 多通道时每个通道限取前几条并轮流合并，避免首个通道独占全部结果
  const perChannelCap = order.length === 1 ? 30 : 10
  const seen = new Set()
  const failed = []
  // 并行搜索，总耗时 ≈ 最慢的通道，而不是各通道耗时之和
  const lists = await Promise.all(order.map(async source => {
    const platform = PLATFORMS[source]
    if (!platform) return [source, []]
    try {
      const r = await Promise.race([
        platform.search(query, 1, platform.limit),
        new Promise((_, reject) => setTimeout(() => reject(new Error('搜索超时')), 15_000)),
      ])
      return [source, (r.list || []).slice(0, perChannelCap)]
    } catch (err) {
      failed.push(source) // 单平台失败不影响其他平台
      return [source, []]
    }
  }))
  // 轮流从各通道取一条合并，保证每个通道的结果交错出现
  const results = []
  for (let i = 0; results.length < 30; i++) {
    let added = false
    for (const [, list] of lists) {
      const cand = list[i]
      if (!cand) continue
      const id = `${cand.source}|${cand.songmid || cand.hash || cand.songId}`
      if (seen.has(id)) continue
      seen.add(id)
      results.push({
        source: cand.source,
        name: cand.name,
        singer: cand.singer,
        albumName: cand.albumName,
        interval: cand.interval,
        _interval: cand._interval,
        types: Object.keys(cand._types || {}),
        songmid: cand.songmid,
        hash: cand.hash,
        songId: cand.songId,
        copyrightId: cand.copyrightId,
        strMediaMid: cand.strMediaMid,
        albumMid: cand.albumMid,
        cand: cand, // 原样保留给下载接口用
      })
      added = true
      if (results.length >= 30) break
    }
    if (!added) break
  }
  return { results, failed }
}

// ---------- HTTP 工具 ----------

function readJsonBody(req, limit = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' }

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1)
  const file = path.join(WORK_DIR, 'web', rel)
  if (!file.startsWith(path.join(WORK_DIR, 'web'))) { sendJson(res, 403, { error: 'forbidden' }); return }
  fs.readFile(file, (err, buf) => {
    if (err) { sendJson(res, 404, { error: 'not found' }); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
    res.end(buf)
  })
}

function pickFolder() {
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择音乐下载位置")'], (err, stdout) => {
        if (err) return reject(new Error('已取消或无法打开文件夹选择器'))
        resolve(stdout.trim())
      })
    } else if (process.platform === 'win32') {
      const ps = 'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "选择音乐下载位置"; if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }'
      execFile('powershell', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true }, (err, stdout) => {
        const p = (stdout || '').trim()
        if (err || !p) return reject(new Error('已取消或无法打开文件夹选择器'))
        resolve(p)
      })
    } else {
      reject(new Error('当前系统不支持文件夹选择器，请手动输入路径'))
    }
  })
}

function openBrowser(url) {
  if (process.platform === 'darwin') {
    execFile('open', [url], () => {})
  } else if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {})
  }
}

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname
  try {
    if (req.method === 'GET' && (p === '/' || p.startsWith('/web/') || /\.(html|js|css|ttf|otf|woff|woff2)$/.test(p))) {
      return serveStatic(res, p === '/' ? '/' : p.replace(/^\/web/, ''))
    }

    if (p === '/api/settings' && req.method === 'GET') return sendJson(res, 200, loadSettings())

    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readJsonBody(req, 1024 * 1024)
      const s = loadSettings()
      if (typeof body.outDir === 'string' && body.outDir.trim()) s.outDir = body.outDir.trim()
      if (body.qualityMode === 'all' || body.qualityMode === 'lossless') s.qualityMode = body.qualityMode
      if (Number.isInteger(body.concurrency) && body.concurrency >= 1 && body.concurrency <= 10) s.concurrency = body.concurrency
      if (body.playlistPriority === 'lx' || body.playlistPriority === 'qobuz') s.playlistPriority = body.playlistPriority
      if (QOBUZ_QUALITIES.has(String(body.qobuzQuality))) s.qobuzQuality = String(body.qobuzQuality)
      if (typeof body.qobuzEmbed === 'boolean') s.qobuzEmbed = body.qobuzEmbed
      if (typeof body.qobuzDedup === 'boolean') s.qobuzDedup = body.qobuzDedup
      if (body.qobuzSaveLayout === 'album' || body.qobuzSaveLayout === 'flat') s.qobuzSaveLayout = body.qobuzSaveLayout
      if (['default', 'artist-title', 'title'].includes(body.qobuzTrackName)) s.qobuzTrackName = body.qobuzTrackName
      if (typeof body.qobuzKeepCoverFile === 'boolean') s.qobuzKeepCoverFile = body.qobuzKeepCoverFile
      if (typeof body.lxFilePattern === 'string') s.lxFilePattern = body.lxFilePattern.trim().slice(0, 120) || '{歌手} - {歌名}'
      if (typeof body.lxGroupByList === 'boolean') s.lxGroupByList = body.lxGroupByList
      if (typeof body.lxSaveLrc === 'boolean') s.lxSaveLrc = body.lxSaveLrc
      if (typeof body.lxEmbedPic === 'boolean') s.lxEmbedPic = body.lxEmbedPic
      if (typeof body.lxEmbedLyric === 'boolean') s.lxEmbedLyric = body.lxEmbedLyric
      if (typeof body.lxProxy === 'string') s.lxProxy = body.lxProxy.trim().slice(0, 200)
      if (typeof body.downloadHistory === 'boolean') s.downloadHistory = body.downloadHistory
      if ([20, 50, 100].includes(Number(body.listPageSize))) s.listPageSize = Number(body.listPageSize)
      if (['zh', 'en'].includes(body.lang)) s.lang = body.lang
      saveSettings(s)
      return sendJson(res, 200, s)
    }

    if (p === '/api/folder-pick' && req.method === 'POST') {
      const folder = await pickFolder()
      return sendJson(res, 200, { path: folder })
    }

    if (p === '/api/playlist' && req.method === 'POST') {
      const body = await readJsonBody(req)
      // 歌单可能是 UTF-16 编码，base64 上传时按原始字节落盘，交给 parsePlaylist 识别编码
      const buf = typeof body.content === 'string'
        ? Buffer.from(body.content, 'utf8')
        : Buffer.from(body.base64 || '', 'base64')
      if (!buf.length) throw new Error('内容为空')
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      fs.writeFileSync(UPLOAD_PLAYLIST, buf)
      const songs = setImportedSongs(parsePlaylist(UPLOAD_PLAYLIST))
      if (!songs.length) throw new Error('未能解析出歌曲（请确认为 Apple Music 导出的 txt 歌单）')
      importedListTitle = path.basename(body.filename || '') ? path.basename(body.filename).replace(/\.txt$/i, '') : '导入的歌单'
      return sendJson(res, 200, {
        count: songs.length,
        songs: songs.map((s, i) => ({ idx: i, name: s.name, artist: s.artist, album: s.album, duration: s.duration })),
      })
    }

    if (p === '/api/playlist-url' && req.method === 'POST') {
      const body = await readJsonBody(req, 1024 * 1024)
      const playlist = await parseOnlinePlaylist(body.url)
      const songs = setImportedSongs(playlist.songs)
      importedListTitle = playlist.title || '在线歌单'
      return sendJson(res, 200, {
        count: songs.length,
        platform: playlist.platform,
        platformName: playlist.platformName,
        title: playlist.title,
        url: playlist.url,
        songs: songs.map(s => ({ idx: s.idx, name: s.name, artist: s.artist, album: s.album, duration: s.duration })),
      })
    }

    if (p === '/api/sources' && req.method === 'GET') {
      const file = fs.existsSync(UPLOAD_SOURCES) ? UPLOAD_SOURCES : path.join(WORK_DIR, 'lxmusic.txt')
      const urls = fs.existsSync(file) ? parseSourceList(file) : []
      return sendJson(res, 200, { urls })
    }

    if (p === '/api/sources' && req.method === 'POST') {
      const body = await readJsonBody(req)
      // 清空音乐源：删除上传的音源文件，恢复为内置 lxmusic.txt
      if (body.clear) {
        try { fs.unlinkSync(UPLOAD_SOURCES) } catch (err) { if (err.code !== 'ENOENT') throw err }
        const builtin = path.join(WORK_DIR, 'lxmusic.txt')
        const urls = fs.existsSync(builtin) ? parseSourceList(builtin) : []
        return sendJson(res, 200, { urls, cleared: true })
      }
      const buf = typeof body.content === 'string'
        ? Buffer.from(body.content, 'utf8')
        : Buffer.from(body.base64 || '', 'base64')
      // 空内容视为"清空音乐源"，恢复为内置 lxmusic.txt，避免空文件遮蔽内置音源
      if (!buf.length) {
        try { fs.unlinkSync(UPLOAD_SOURCES) } catch (err) { if (err.code !== 'ENOENT') throw err }
        const urls = parseSourceList(path.join(WORK_DIR, 'lxmusic.txt'))
        return sendJson(res, 200, { urls, cleared: true })
      }
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      fs.writeFileSync(UPLOAD_SOURCES, buf)
      const urls = parseSourceList(UPLOAD_SOURCES)
      return sendJson(res, 200, { urls })
    }

    if (p === '/api/search' && req.method === 'POST') {
      const body = await readJsonBody(req, 1024 * 1024)
      const query = [body.name, body.artist].filter(Boolean).join(' ')
      if (!query.trim()) throw new Error('请输入歌名或歌手')
      const { results, failed } = await searchMusic(query.trim(), String(body.source || '').trim())
      return sendJson(res, 200, { query, results, failed })
    }

    if (p === '/api/qobuz/status' && req.method === 'GET') {
      return sendJson(res, 200, { available: qobuzAvailable(), loggedIn: qobuzAvailable() && isLoggedIn() })
    }

    if (p === '/api/qobuz/login' && req.method === 'POST') {
      return sendJson(res, 200, await startQobuzLogin())
    }

    if (p === '/api/qobuz/logout' && req.method === 'POST') {
      try { fs.unlinkSync(require('./lib/qobuz').TOKEN_FILE) } catch (err) { if (err.code !== 'ENOENT') throw err }
      return sendJson(res, 200, { ok: true, loggedIn: false })
    }

    if (p === '/api/qobuz/search' && req.method === 'POST') {
      const body = await readJsonBody(req, 1024 * 1024)
      const name = String(body.name || '').trim()
      const artist = String(body.artist || '').trim()
      if (!name && !artist) throw new Error('请输入歌名或歌手')
      return sendJson(res, 200, await qobuzBridge('search', [artist, name]))
    }

    if (p === '/api/qobuz/search-albums' && req.method === 'POST') {
      const body = await readJsonBody(req, 1024 * 1024)
      const name = String(body.name || '').trim()
      const artist = String(body.artist || '').trim()
      if (!name && !artist) throw new Error('请输入专辑名或歌手')
      return sendJson(res, 200, await qobuzSearchAlbums(artist, name))
    }

    if (p === '/api/download' && req.method === 'POST') {
      const body = await readJsonBody(req, 10 * 1024 * 1024)
      const indices = Array.isArray(body.indices) ? body.indices : []
      await startPlaylistJob({ indices, force: !!body.force })
      return sendJson(res, 200, { ok: true, total: jobs.playlist.total })
    }

    if (p === '/api/download-search' && req.method === 'POST') {
      const body = await readJsonBody(req, 10 * 1024 * 1024)
      const items = (Array.isArray(body.items) ? body.items : []).map((it, i) => ({
        key: `s${i}`,
        cand: it.cand,
        name: it.name || it.cand.name,
        artist: it.artist || it.cand.singer,
      }))
      if (!items.length) throw new Error('未选择任何歌曲')
      await startLxJob({ slot: 'lx', rawItems: items, force: !!body.force })
      return sendJson(res, 200, { ok: true, total: jobs.lx.total })
    }

    if (p === '/api/qobuz/download' && req.method === 'POST') {
      const body = await readJsonBody(req, 10 * 1024 * 1024)
      const songs = Array.isArray(body.items) ? body.items.map((it, i) => ({
        idx: it.key || `q${i}`,
        name: it.name || it.title || '',
        artist: it.artist || it.singer || '',
        album: it.album || it.albumName || '',
        duration: it.duration || it._interval || 0,
        qobuzUrl: it.url,
      })) : []
      if (!songs.length) throw new Error('未选择任何歌曲')
      await startQobuzJob({ songs, slot: 'qobuz' })
      return sendJson(res, 200, { ok: true, total: jobs.qobuz.total })
    }

    if (p === '/api/qobuz/download-url' && req.method === 'POST') {
      const body = await readJsonBody(req, 1024 * 1024)
      // 支持多行：每行一个链接（专辑/歌单/单曲/歌手/厂牌/last.fm），单个失败不影响其他
      const lines = [...new Set(String(body.url || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean))]
      if (!lines.length) throw new Error('请粘贴 Qobuz 链接')
      if (!isLoggedIn()) throw new Error('请先登录 Qobuz')
      if (lines.length > 50) throw new Error('一次最多支持 50 个链接')
      const songs = []
      const names = []
      const errors = []
      let seq = 0
      let playlistName = ''
      let lastKind = ''
      for (const line of lines) {
        try {
          const info = await qobuzExpand(line)
          lastKind = info.kind
          names.push(info.name || line)
          if (info.tracks && info.tracks.length) {
            for (const tr of info.tracks) {
              songs.push({ idx: `u${seq++}`, name: tr.name || '', artist: tr.singer || '', album: tr.album || '', duration: tr.duration || 0, qobuzUrl: tr.url })
            }
          } else {
            // 歌手/厂牌/last.fm：整体交给 CLI 下载，作为单条任务展示进度日志
            songs.push({ idx: `u${seq++}`, name: info.name || line, artist: '', album: '', duration: 0, qobuzUrl: line })
          }
          if (info.kind === 'playlist' && !playlistName) playlistName = info.name
        } catch (err) {
          errors.push(`${line}：${err.message}`)
        }
      }
      if (!songs.length) throw new Error(errors[0] || '没有解析出可下载的内容')
      // 只有单个歌单链接时才生成 m3u（多链接混合时不生成）
      const singlePlaylist = lines.length === 1 && lastKind === 'playlist' ? playlistName : ''
      await startQobuzJob({ songs, playlistName: singlePlaylist })
      return sendJson(res, 200, { ok: true, total: jobs.qobuz.total, kind: lines.length > 1 ? 'batch' : lastKind, name: names.join('、'), errors })
    }

    if (p === '/api/playlist/save' && req.method === 'POST') {
      const body = await readJsonBody(req, 1024 * 1024)
      if (!importedSongs || !importedSongs.length) throw new Error('先导入歌单再保存')
      const name = safePlaylistName(String(body.name || '') || importedListTitle)
      fs.mkdirSync(PLAYLISTS_DIR, { recursive: true })
      fs.writeFileSync(playlistPath(name), JSON.stringify({ name, savedAt: new Date().toISOString(), songs: importedSongs }, null, 2))
      return sendJson(res, 200, { ok: true, name, count: importedSongs.length, playlists: listSavedPlaylists() })
    }

    if (p === '/api/playlists' && req.method === 'GET') {
      return sendJson(res, 200, { playlists: listSavedPlaylists() })
    }

    if (p === '/api/playlist/open' && req.method === 'POST') {
      const body = await readJsonBody(req, 1024 * 1024)
      const file = playlistPath(String(body.name || ''))
      if (!fs.existsSync(file)) throw new Error('歌单不存在或已被删除')
      const d = JSON.parse(fs.readFileSync(file, 'utf8'))
      setImportedSongs(d.songs)
      importedListTitle = d.name
      return sendJson(res, 200, { ok: true, name: d.name, count: d.songs.length, songs: d.songs })
    }

    if (p === '/api/playlist/delete' && req.method === 'POST') {
      const body = await readJsonBody(req, 1024 * 1024)
      const file = playlistPath(String(body.name || ''))
      if (fs.existsSync(file)) fs.unlinkSync(file)
      return sendJson(res, 200, { ok: true, playlists: listSavedPlaylists() })
    }

    if (p === '/api/history' && req.method === 'GET') {
      const entries = readHistory()
      const summary = { total: entries.length }
      for (const e of entries) {
        summary[e.source] = (summary[e.source] || 0) + 1
        summary[e.status] = (summary[e.status] || 0) + 1
      }
      return sendJson(res, 200, { entries, summary })
    }

    if (p === '/api/history/clear' && req.method === 'POST') {
      try { fs.unlinkSync(HISTORY_FILE) } catch (err) { if (err.code !== 'ENOENT') throw err }
      return sendJson(res, 200, { ok: true })
    }

    if (p === '/api/playlist/download' && req.method === 'POST') {
      const body = await readJsonBody(req, 10 * 1024 * 1024)
      const indices = Array.isArray(body.indices) ? body.indices : []
      if (!indices.length) throw new Error('未选中任何歌曲')
      await startPlaylistJob({ indices, force: !!body.force })
      return sendJson(res, 200, { ok: true, total: jobs.playlist.total, provider: jobs.playlist.provider })
    }

    if (p === '/api/job/pause' && req.method === 'POST') {
      const slot = new URL(req.url, `http://127.0.0.1:${PORT}`).searchParams.get('slot') || 'playlist'
      const controller = controls[slot]
      if (!controller) throw new Error('没有运行中的任务')
      controller.control ? controller.control.pause() : controller.pause()
      if (jobs[slot]) jobs[slot].paused = true
      return sendJson(res, 200, { ok: true })
    }

    if (p === '/api/job/resume' && req.method === 'POST') {
      const slot = new URL(req.url, `http://127.0.0.1:${PORT}`).searchParams.get('slot') || 'playlist'
      const controller = controls[slot]
      if (!controller) throw new Error('没有运行中的任务')
      controller.control ? controller.control.resume() : controller.resume()
      if (jobs[slot]) jobs[slot].paused = false
      return sendJson(res, 200, { ok: true })
    }

    if (p === '/api/job/cancel' && req.method === 'POST') {
      const body = await readJsonBody(req, 1024 * 1024)
      const keys = Array.isArray(body.keys) ? body.keys : []
      if (!keys.length) throw new Error('未选择要取消的歌曲')
      const slot = body.slot || 'playlist'
      const controller = controls[slot]
      if (controller) controller.control ? controller.control.cancel(keys) : controller.cancel(keys)
      // 任务已结束的（无 activeDownloader），直接改状态
      const current = jobs[slot]
      if (current && !current.running) {
        for (const e of current.entries) {
          if (keys.includes(e.idx) && !FINAL_STATUS.has(e.status)) {
            e.status = 'cancelled'
          }
        }
      }
      return sendJson(res, 200, { ok: true })
    }

    if (p === '/api/exit' && req.method === 'POST') {
      sendJson(res, 200, { ok: true })
      // macOS：用 AppleScript 关闭打开着本界面的浏览器标签（首次使用会请求系统自动化权限）
      if (process.platform === 'darwin') {
        const as = `
          try
            if application "Safari" is running then
              tell application "Safari"
                repeat with w in windows
                  repeat with t in tabs of w
                    if URL of t contains "127.0.0.1:${PORT}" then close t
                  end repeat
                end repeat
              end tell
            end if
          end try
          try
            if application "Google Chrome" is running then
              tell application "Google Chrome"
                repeat with w in windows
                  repeat with t in tabs of w
                    if URL of t contains "127.0.0.1:${PORT}" then close t
                  end repeat
                end repeat
              end tell
            end if
          end try`
        execFile('osascript', ['-e', as], () => {})
      }
      // 延迟退出，确保响应先送达浏览器
      setTimeout(() => {
        console.log('收到退出指令，服务已停止')
        server.close()
        process.exit(0)
      }, 300)
      return
    }

    if (p === '/api/job' && req.method === 'GET') {
      const slot = url.searchParams.get('slot') || 'playlist'
      return sendJson(res, 200, publicJob(slot))
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { error: err.message })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  LX Music 批量下载器已启动`)
  console.log(`  界面地址: http://127.0.0.1:${PORT}`)
  console.log(`  按 Ctrl+C 退出\n`)
  if (!process.argv.includes('--no-open')) {
    openBrowser(`http://127.0.0.1:${PORT}`)
  }
})
