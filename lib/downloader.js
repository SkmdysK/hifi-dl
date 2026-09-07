'use strict'
const fs = require('fs')
const path = require('path')
const { parsePlaylist } = require('./playlist')
const { loadSourceScripts } = require('./source-loader')
const { LxSource } = require('./lx-host')
const { PLATFORMS } = require('./sdk/search')
const { scoreCandidate, ACCEPT_THRESHOLD } = require('./matcher')
const { request: proxyRequest } = require('./proxy-fetch')
const { getSongInfo } = require('./musicinfo')
const { writeTags } = require('./audio-tags')

// 注意：不包含 qdy 声明的 '24bit' —— 实测它实际返回 100kbps AAC（假高音质），
// 而它的 'flac' 档才是真无损。这里只保留已验证可靠的音质档位。
const QUALITY_ORDER = ['flac24bit', 'flac', '320k', '192k', '128k']

const EXT_RE = /\.(flac|mp3|m4a|ape|wav|ogg|aac|dsf|dff)(?:\?|$)/i
const CONTENT_TYPE_EXT = {
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
}

/** 检测音频真实格式（magic bytes）。第三方源常把有损文件冒充无损，需要实测校验 */
function detectAudioFormat(buf) {
  if (buf.length < 8) return 'unknown'
  if (buf.toString('ascii', 0, 4) === 'fLaC') return 'flac'
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav'
  if (buf.toString('ascii', 0, 4) === 'OggS') return 'ogg'
  if (buf.toString('ascii', 0, 4) === 'MAC ') return 'ape'
  if (buf.toString('ascii', 0, 4) === 'DSD ') return 'dsf'
  if (buf.toString('ascii', 0, 4) === 'FRM8') return 'dff'
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'm4a'
  if (buf.toString('ascii', 0, 4) === 'FORM' && buf.toString('ascii', 8, 12) === 'AIFF') return 'aiff'
  return 'unknown'
}

const LOSSLESS_FORMATS = new Set(['flac', 'wav', 'ape', 'dsf', 'dff', 'aiff'])

/** 文件名非法字符清理（兼容 Windows：非法字符、保留名、过长截断） */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
function sanitizeFilename(s) {
  let name = String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  if (WIN_RESERVED.test(name)) name = '_' + name
  if (name.length > 100) name = name.slice(0, 100)
  return name
}

function buildFileName(song, pattern) {
  // 命名模板：中文/英文 token 均可，{歌手}/{artist} {歌名}/{title} {专辑}/{album} {序号}/{no}
  const artist = sanitizeFilename(song.artist) || '未知歌手'
  const no = String((parseInt(song.idx, 10) || 0) + 1).padStart(2, '0')
  const map = {
    '{歌手}': artist, '{artist}': artist,
    '{歌名}': sanitizeFilename(song.name), '{title}': sanitizeFilename(song.name),
    '{专辑}': sanitizeFilename(song.album || ''), '{album}': sanitizeFilename(song.album || ''),
    '{序号}': no, '{no}': no,
  }
  let out = String(pattern || '{歌手} - {歌名}')
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v)
  out = out.replace(/\{(歌手|歌名|专辑|序号|artist|title|album|no)\}/g, '')
  return sanitizeFilename(out) || '未知歌曲'
}

/** 从 URL 或 content-type 判断扩展名 */
function guessExt(url, contentType) {
  const m = (url || '').match(EXT_RE)
  if (m) return m[1].toLowerCase()
  if (contentType && CONTENT_TYPE_EXT[contentType.split(';')[0].trim().toLowerCase()]) {
    return CONTENT_TYPE_EXT[contentType.split(';')[0].trim().toLowerCase()]
  }
  return 'mp3'
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

class Downloader {
  constructor(opts = {}) {
    this.opts = opts
    this.workDir = opts.workDir || process.cwd()
    this.outDir = opts.outDir || path.join(require('os').homedir(), 'Documents', 'music')
    this.playlistFile = opts.playlist || path.join(this.workDir, 'Ll.txt')
    this.sourcesFile = opts.sources || path.join(this.workDir, 'lxmusic.txt')
    this.sourceOrder = (opts.sourceOrder || 'kw,kg,tx,wy,mg').split(',').map(s => s.trim()).filter(Boolean)
    this.qualityPref = opts.quality === 'best' || !opts.quality ? QUALITY_ORDER : [opts.quality, ...QUALITY_ORDER.filter(q => q !== opts.quality)]
    this.concurrency = opts.concurrency || 3
    this.threshold = opts.threshold ?? ACCEPT_THRESHOLD
    this.force = !!opts.force
    this.limit = opts.limit
    this.skipUpdate = !!opts.skipUpdate
    this.quiet = !!opts.quiet
    this.losslessOnly = !!opts.losslessOnly
    // 下载增强：分组目录 / 命名模板 / 歌词歌词文件 / 封面内嵌 / 代理 / 多线程
    this.subDir = opts.subDir ? sanitizeFilename(opts.subDir) : ''
    this.saveDir = this.subDir ? path.join(this.outDir, this.subDir) : this.outDir
    this.filePattern = opts.filePattern || '{歌手} - {歌名}'
    this.saveLrc = opts.saveLrc !== false
    this.embedLyric = !!opts.embedLyric
    this.embedPic = !!opts.embedPic
    this.proxy = opts.proxy || ''
    if (this.losslessOnly) this.qualityPref = ['flac24bit', 'flac']
    this.onProgress = opts.onProgress || (() => {})
    this.onDownloadProgress = opts.onDownloadProgress || (() => {})
    this.lxSources = []
    this.failCount = new Map() // (脚本|平台) → 连续失败次数
    this.failThreshold = opts.failThreshold ?? 8
    this.report = { generatedAt: new Date().toISOString(), songs: [], summary: {} }
    this.reportFile = path.join(this.workDir, 'report.json')
    /** 任务控制器：暂停/恢复/取消 */
    this.control = {
      paused: false,
      songs: new Map(), // key → { state: 'running'|'paused'|'cancelled', controller }
      ctrlOf(key) {
        if (!this.songs.has(key)) this.songs.set(key, { state: 'running', controller: new AbortController() })
        return this.songs.get(key)
      },
      pause() {
        this.paused = true
        for (const c of this.songs.values()) {
          if (c.state === 'running') {
            c.state = 'paused'
            c.controller.abort()
          }
        }
      },
      resume() {
        this.paused = false
      },
      cancel(keys) {
        for (const k of keys) {
          const c = this.ctrlOf(k)
          c.state = 'cancelled'
          c.controller.abort()
        }
      },
    }
  }

  log(...args) {
    if (!this.quiet) console.log(...args)
  }

  async init() {
    fs.mkdirSync(this.saveDir, { recursive: true })
    const scripts = await loadSourceScripts(this.sourcesFile)
    this.log(`\n== 加载音源脚本 (${scripts.length} 个) ==`)
    for (const s of scripts) {
      this.log(`  - ${s.name || s.url} (${s.url})`)
      const lx = new LxSource(s.code, { label: s.name || s.url.split('/').slice(-2).join('/'), onLog: (...a) => this.log(...a) })
      try {
        await lx.init()
        const sources = Object.entries(lx.sources)
          .map(([key, v]) => `${key}(${(v.qualitys || []).join('/') || '-'})`)
          .join(' ')
        this.log(`    ✓ 初始化成功，声明源: ${sources || '(无)'}`)
        this.lxSources.push(lx)
      } catch (err) {
        this.log(`    ✗ 初始化失败: ${err.message}`)
      }
    }
    if (!this.lxSources.length) throw new Error('没有可用的音源脚本')
  }

  /** 多平台搜索，返回 { source, list }[] */
  async searchCandidates(name, artist) {
    const query = artist ? `${name} ${artist.split(/[&,]/)[0]}` : name
    const out = []
    for (const source of this.sourceOrder) {
      const platform = PLATFORMS[source]
      if (!platform) continue
      try {
        const result = await Promise.race([
          platform.search(query, 1, platform.limit),
          new Promise((_, reject) => setTimeout(() => reject(new Error('搜索超时')), 15_000)),
        ])
        if (result && result.list && result.list.length) out.push({ source, list: result.list })
      } catch (err) {
        this.log(`    [搜索] ${source} 失败: ${err.message}`)
      }
    }
    return out
  }

  /** 从候选里挑最佳匹配（分数接近时优先靠前的搜索平台） */
  pickBest(song, results) {
    let best = null
    const rank = new Map(this.sourceOrder.map((s, i) => [s, i]))
    for (const { source, list } of results) {
      for (const cand of list) {
        const { total } = scoreCandidate(song, cand)
        if (best == null) { best = { cand, score: total }; continue }
        const prev = best.score
        const prevRank = rank.get(best.cand.source) ?? 99
        const thisRank = rank.get(source) ?? 99
        if (total > prev + 10 || (Math.abs(total - prev) <= 10 && thisRank < prevRank)) {
          best = { cand, score: total }
        }
      }
    }
    if (best && best.score >= this.threshold) return best
    return null
  }

  /**
   * 依次尝试音源脚本 × 音质，返回候选直链数组（按优先级排序）。
   * 每个脚本取它能给的最好音质，收集所有脚本的结果作为下载兜底链。
   */
  async resolveUrls(cand) {
    const urls = []
    for (const lx of this.lxSources) {
      const key = `${lx.label}|${cand.source}`
      if ((this.failCount.get(key) || 0) >= this.failThreshold) continue // 连续失败熔断
      for (const q of this.qualityPref) {
        if (!lx.qualitysOf(cand.source).includes(q)) continue
        try {
          const url = await lx.musicUrl(cand.source, cand, q)
          if (typeof url === 'string' && /^https?:/.test(url)) {
            this.failCount.set(key, 0)
            urls.push({ url, quality: q, script: lx.label })
            break // 该脚本已拿到它的最好音质，换下一个脚本兜底
          }
          this.log(`    [取链] ${lx.label}/${cand.source}/${q} 返回无效: ${String(url).slice(0, 80)}`)
        } catch (err) {
          this.log(`    [取链] ${lx.label}/${cand.source}/${q} 失败: ${err.message}`)
        }
        this.failCount.set(key, (this.failCount.get(key) || 0) + 1)
      }
    }
    return urls
  }

  /** 检查歌曲任务是否被暂停/取消，是则抛错中断 */
  checkpoint(song) {
    const c = song._ctrl
    if (!c || c.state === 'running') return
    if (c.state === 'paused') throw new Error('paused')
    throw new Error('cancelled')
  }

  /** 单请求（带代理与超时控制） */
  fetchResp(url, signal, extraHeaders) {
    return proxyRequest(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', ...(extraHeaders || {}) },
      signal,
      proxy: this.proxy,
    })
  }

  /**
   * 下载音频到内存：服务器支持 Range 且文件较大时自动 4 段并发（多线程），否则整段流式下载。
   * 保留提前格式校验、进度回调、暂停/取消支持。
   */
  async downloadAudio(url, song, signal) {
    const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    // 用 1 字节 Range 探测总大小与分段下载支持
    const probe = await this.fetchResp(url, signal, { Range: 'bytes=0-0' })
    if (!probe.ok && probe.status !== 206) throw new Error(`HTTP ${probe.status}`)
    const contentType = (probe.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('text/html')) throw new Error('直链返回网页（可能为错误页），已跳过')
    const ext = guessExt(url, contentType)
    let total = 0
    let ranged = false
    if (probe.status === 206) {
      const m = (probe.headers.get('content-range') || '').match(/\/(\d+)\s*$/)
      total = m ? parseInt(m[1], 10) : 0
      ranged = total > 0
    } else {
      total = parseInt(probe.headers.get('content-length') || '0', 10)
    }
    if (total > 400 * 1024 * 1024) throw new Error('文件过大，疑似非音频')

    const report = received => {
      if (song) this.onDownloadProgress(song.idx, { received, total })
    }
    let buf
    // 多线程仅用于中等体积（>8MB 且 ≤200MB）：超大文件流式下载，避免内存暴涨
    const useMultiThread = ranged && total > 8 * 1024 * 1024 && total <= 200 * 1024 * 1024
    if (useMultiThread && probe.stream) probe.stream.resume() // 排空探测响应
    if (useMultiThread) {
      // 多线程：分 4 段并发拉取
      const n = 4
      const seg = Math.floor(total / n)
      const ranges = Array.from({ length: n }, (_, i) => [i * seg, i === n - 1 ? total - 1 : (i + 1) * seg - 1])
      const parts = new Array(n)
      let received = 0
      await Promise.all(ranges.map(async ([s, e], i) => {
        const r = await this.fetchResp(url, signal, { Range: `bytes=${s}-${e}` })
        if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`)
        const ab = await r.arrayBuffer()
        const part = Buffer.from(ab)
        parts[i] = part
        received += part.length
        report(received)
      }))
      buf = Buffer.concat(parts)
    } else {
      // 整段流式下载（带提前格式校验）。200 的探测响应直接复用为流；分段探测则重新发起完整请求
      const reuseProbe = !ranged && probe.status === 200
      const res = reuseProbe ? probe : await this.fetchResp(url, signal)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const chunks = []
      let bytes = 0
      let lastReport = 0
      let headerChecked = false
      for await (const chunk of res.body) {
        this.checkpoint(song)
        chunks.push(chunk)
        bytes += chunk.length
        if (bytes > 400 * 1024 * 1024) throw new Error('文件过大，疑似非音频')
        if (!headerChecked && bytes >= 16) {
          headerChecked = true
          if (detectAudioFormat(Buffer.concat(chunks)) === 'unknown') {
            throw new Error('下载内容头部非音频格式（可能为加密文件），提前跳过')
          }
        }
        const now = Date.now()
        if (song && (now - lastReport > 200 || bytes === total)) {
          lastReport = now
          report(bytes)
        }
      }
      this.checkpoint(song)
      buf = Buffer.concat(chunks)
    }
    if (buf.length < 10_000) throw new Error(`文件过小(${buf.length}B)，疑似无效直链`)
    const format = detectAudioFormat(buf)
    if (format === 'unknown') throw new Error('下载内容无法识别（可能为加密文件），已跳过')
    if (this.losslessOnly && !LOSSLESS_FORMATS.has(format)) {
      throw new Error(`直链实际为 ${format}（非无损），已跳过`)
    }
    return { buf, format, bytes: buf.length }
  }

  /** 下载直链到本地文件（带进度与暂停/取消支持） */
  async download(url, fileBase, song) {
    const ctrl = song && song._ctrl
    const timeoutSignal = AbortSignal.timeout(5 * 60_000)
    const signal = ctrl ? AbortSignal.any([ctrl.controller.signal, timeoutSignal]) : timeoutSignal
    try {
      const audio = await this.downloadAudio(url, song, signal)
      const filePath = path.join(this.saveDir, `${fileBase}.${audio.format}`)
      if (fs.existsSync(filePath) && !this.force) {
        if (song) this.onDownloadProgress(song.idx, { received: 0, total: 0, done: true })
        return { filePath, existed: true, bytes: fs.statSync(filePath).size, format: audio.format }
      }
      fs.writeFileSync(filePath, audio.buf)
      if (song) this.onDownloadProgress(song.idx, { received: audio.bytes, total: audio.bytes, done: true })
      return { filePath, existed: false, bytes: audio.bytes, format: audio.format }
    } catch (err) {
      // 暂停/取消产生的中断原样上抛，由 processSong 归类状态
      if (err && (err.message === 'paused' || err.message === 'cancelled' || (ctrl && ctrl.state !== 'running'))) {
        throw new Error(ctrl.state === 'paused' ? 'paused' : 'cancelled')
      }
      throw err
    }
  }

  /** 处理歌单歌曲 */
  async processSong(song) {
    const entry = {
      idx: song.idx,
      name: song.name,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      status: 'downloading',
    }
    this.report.songs.push(entry)
    const setStatus = status => {
      entry.status = status
      this.onProgress(song.idx, entry)
    }
    setStatus('downloading') // 初始状态同步给 UI
    try {
      const fileBase = buildFileName(song, this.filePattern)
      const existing = this.findExisting(fileBase)
      if (existing && !this.force) {
        entry.file = existing
        this.log(`  ✓ 已存在，跳过: ${fileBase}`)
        setStatus('existed')
        return entry
      }
      this.log(`\n▶ ${song.artist} - ${song.name}${song.album ? ` (${song.album})` : ''}${song.duration ? ` [${song.duration}s]` : ''}`)
      this.checkpoint(song)

      // 暂停重试时复用上次的匹配结果，避免重复搜索
      let best = song._best
      if (!best) {
        const results = await this.searchCandidates(song.name, song.artist)
        best = this.pickBest(song, results)
        if (!best) {
          this.log(`  ✗ 未找到匹配（搜索 ${results.map(r => `${r.source}:${r.list.length}`).join(' ') || '全部失败'}）`)
          setStatus('no_match')
          return entry
        }
        song._best = best
        entry.matched = {
          source: best.cand.source,
          name: best.cand.name,
          singer: best.cand.singer,
          album: best.cand.albumName,
          duration: best.cand._interval,
          score: best.score,
          types: Object.keys(best.cand._types || {}),
        }
        this.log(`  → 匹配: ${best.cand.singer} - ${best.cand.name} [${best.cand.source}] (${best.score}分, 音质: ${entry.matched.types.join('/') || '未知'})`)
      }
      this.checkpoint(song)

      const candidates = await this.resolveUrls(best.cand)
      if (!candidates.length) {
        this.log(`  ✗ ${this.losslessOnly ? '无可用无损直链' : '所有音源脚本取链失败'}`)
        setStatus(this.losslessOnly ? 'lossless_unavailable' : 'no_url')
        return entry
      }
      let dl = null
      let lastErr = null
      for (const c of candidates) {
        this.checkpoint(song)
        try {
          dl = await this.download(c.url, fileBase, song)
          dl.quality = c.quality
          dl.script = c.script
          break
        } catch (err) {
          if (err.message === 'paused' || err.message === 'cancelled') throw err
          lastErr = err
          this.log(`    [下载] ${c.script}/${c.quality} 失败: ${err.message}，尝试下一个候选`)
        }
      }
      if (!dl) {
        entry.error = lastErr ? lastErr.message : 'download failed'
        this.log(`  ✗ 所有候选直链下载失败`)
        setStatus(this.losslessOnly ? 'lossless_unavailable' : 'failed')
        return entry
      }
      entry.file = dl.filePath
      entry.bytes = dl.bytes
      entry.quality = dl.quality
      entry.realFormat = dl.format
      entry.resolved = { quality: dl.quality, script: dl.script }
      this.log(`  ✓ 下载完成 [${dl.quality}] ${path.basename(dl.filePath)} (${(dl.bytes / 1024 / 1024).toFixed(1)}MB)${dl.existed ? ' (已存在)' : ''}`)
      if (!dl.existed) await this.enrich(song, dl)
      setStatus('downloaded')
      return entry
    } catch (err) {
      // 暂停/取消：保留对应状态供外层重新入队或结算
      const c = song._ctrl
      if (err && (err.message === 'paused' || err.message === 'cancelled' || (c && c.state !== 'running'))) {
        const st = c && c.state === 'paused' ? 'paused' : 'cancelled'
        if (entry.status !== st) setStatus(st)
        return entry
      }
      entry.error = err.message
      this.log(`  ✗ 失败: ${err.message}`)
      setStatus(this.losslessOnly ? 'lossless_unavailable' : 'failed')
      return entry
    }
  }

  /** 处理搜索直下的歌曲（不经过歌单匹配） */
  async processRawSong(item) {
    const song = {
      idx: item.key,
      name: item.name,
      artist: item.artist,
      album: item.cand.albumName,
      duration: item.cand._interval,
      _ctrl: item._ctrl,
    }
    const entry = {
      idx: item.key,
      name: item.name,
      artist: item.artist,
      album: item.cand.albumName,
      status: 'downloading',
      matched: { source: item.cand.source, name: item.cand.name, singer: item.cand.singer, album: item.cand.albumName },
    }
    this.report.songs.push(entry)
    const setStatus = status => {
      entry.status = status
      this.onProgress(item.key, entry)
    }
    setStatus('downloading')
    try {
      const fileBase = buildFileName(song, this.filePattern)
      const existing = this.findExisting(fileBase)
      if (existing && !this.force) {
        entry.file = existing
        setStatus('existed')
        return entry
      }
      this.log(`\n▶ [搜索下载] ${item.cand.singer} - ${item.cand.name} [${item.cand.source}]`)
      this.checkpoint(song)
      const candidates = await this.resolveUrls(item.cand)
      if (!candidates.length) {
        setStatus(this.losslessOnly ? 'lossless_unavailable' : 'no_url')
        return entry
      }
      let dl = null
      let lastErr = null
      for (const c of candidates) {
        this.checkpoint(song)
        try {
          dl = await this.download(c.url, fileBase, song)
          dl.quality = c.quality
          dl.script = c.script
          break
        } catch (err) {
          if (err.message === 'paused' || err.message === 'cancelled') throw err
          lastErr = err
          this.log(`    [下载] ${c.script}/${c.quality} 失败: ${err.message}，尝试下一个候选`)
        }
      }
      if (!dl) {
        entry.error = lastErr ? lastErr.message : 'download failed'
        setStatus(this.losslessOnly ? 'lossless_unavailable' : 'failed')
        return entry
      }
      entry.file = dl.filePath
      entry.bytes = dl.bytes
      entry.quality = dl.quality
      entry.realFormat = dl.format
      entry.resolved = { quality: dl.quality, script: dl.script }
      if (!dl.existed) await this.enrich(song, dl)
      setStatus('downloaded')
      return entry
    } catch (err) {
      const c = song._ctrl
      if (err && (err.message === 'paused' || err.message === 'cancelled' || (c && c.state !== 'running'))) {
        const st = c && c.state === 'paused' ? 'paused' : 'cancelled'
        if (entry.status !== st) setStatus(st)
        return entry
      }
      entry.error = err.message
      setStatus(this.losslessOnly ? 'lossless_unavailable' : 'failed')
      return entry
    }
  }

  findExisting(fileBase) {
    for (const ext of ['flac', 'mp3', 'm4a', 'ape', 'wav', 'ogg', 'aac', 'dsf', 'dff', 'aiff']) {
      const p = path.join(this.saveDir, `${fileBase}.${ext}`)
      if (fs.existsSync(p)) return p
    }
    return null
  }

  /** 下载后增强：保存 .lrc 歌词文件、内嵌封面/歌词（失败不影响音频本身） */
  async enrich(song, dl) {
    if (!this.saveLrc && !this.embedLyric && !this.embedPic) return
    const ext = path.extname(dl.filePath || '').slice(1).toLowerCase()
    if (!['mp3', 'flac'].includes(ext)) {
      this.log(`    [标签] ${ext || '?'} 格式暂不支持写标签，跳过`)
      return
    }
    const info = await getSongInfo(song).catch(() => null)
    if (!info) {
      this.log('    [标签] 未匹配到封面/歌词信息，跳过')
      return
    }
    try {
      if (this.saveLrc && info.lyric) {
        const lrcPath = dl.filePath.replace(/\.(mp3|flac)$/i, '.lrc')
        fs.writeFileSync(lrcPath, info.lyric)
        this.log('    [歌词] 已保存 .lrc')
      }
      if (this.embedLyric || this.embedPic) {
        let cover = null
        let coverMime = 'image/jpeg'
        if (this.embedPic && info.coverUrl) {
          const res = await fetch(info.coverUrl, { signal: AbortSignal.timeout(15_000) })
          if (res.ok) {
            cover = Buffer.from(await res.arrayBuffer())
            const ct = (res.headers.get('content-type') || 'image/jpeg').split(';')[0]
            if (ct === 'image/png') coverMime = 'image/png'
          }
        }
        if (!cover && !this.embedLyric) return
        await writeTags(dl.filePath, {
          title: song.name,
          artist: song.artist,
          album: song.album || info.album,
          lyric: this.embedLyric ? info.lyric : null,
          cover,
          coverMime,
        })
        this.log(`    [标签] 已写入${cover ? '封面' : ''}${this.embedLyric && info.lyric ? '/歌词' : ''}`)
      }
    } catch (err) {
      this.log(`    [标签] 写入失败（不影响音频）: ${err.message}`)
    }
  }

  /**
   * 执行下载（队列 + 并发 + 可控）
   * @param runOpts { indices?: number[], limit?: number, songs?: Song[], rawItems?: [{key, cand, name, artist}] }
   */
  async run(runOpts = {}) {
    await this.init()
    let items
    if (runOpts.rawItems && runOpts.rawItems.length) {
      items = runOpts.rawItems
      this.log(`\n== 搜索下载任务: 共 ${items.length} 首 (并发 ${this.concurrency}) ==`)
    } else if (runOpts.songs && runOpts.songs.length) {
      items = runOpts.songs
      this.log(`\n== 歌单解析完成: 共 ${items.length} 首歌 ==`)
      this.log(`本次处理: ${items.length} 首 (并发 ${this.concurrency})\n`)
    } else {
      const songs = parsePlaylist(this.playlistFile)
      songs.forEach((s, i) => { s.idx = i })
      this.log(`\n== 歌单解析完成: 共 ${songs.length} 首歌 ==`)
      if (runOpts.indices) {
        const set = new Set(runOpts.indices)
        items = songs.filter(s => set.has(s.idx))
      } else {
        items = (runOpts.limit || this.limit) ? songs.slice(0, runOpts.limit || this.limit) : songs
      }
      this.log(`本次处理: ${items.length} 首 (并发 ${this.concurrency})\n`)
    }

    const queue = [...items]
    const worker = async () => {
      while (queue.length) {
        while (this.control.paused) await sleep(300)
        const song = queue.shift()
        if (!song) return
        const key = song.idx != null ? song.idx : song.key
        const ctrl = this.control.ctrlOf(key)
        song._ctrl = ctrl
        if (ctrl.state === 'cancelled') {
          this.onProgress(key, { status: 'cancelled' })
          continue
        }
        if (ctrl.state === 'paused') ctrl.state = 'running'
        const entry = runOpts.rawItems ? await this.processRawSong(song) : await this.processSong(song)
        if (entry.status === 'paused') queue.push(song) // 恢复后重试
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, items.length) }, worker))

    const count = {}
    for (const e of this.report.songs) count[e.status] = (count[e.status] || 0) + 1
    this.report.summary = count
    fs.writeFileSync(this.reportFile, JSON.stringify(this.report, null, 2))
    this.log('\n== 完成 ==')
    for (const [status, n] of Object.entries(count)) this.log(`  ${status}: ${n}`)
    this.log(`  报告已写入 ${this.reportFile}`)
    return this.report
  }
}

module.exports = { Downloader, QUALITY_ORDER }
