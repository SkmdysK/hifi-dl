'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn, execFile, execFileSync } = require('child_process')

// 优先使用项目内置的 vendor/qobuz-dl（随项目整体拷贝/迁移），可用环境变量 QOBUZ_DL_DIR 覆盖
const LOCAL_QOBUZ_DIR = path.join(__dirname, '..', 'vendor', 'qobuz-dl')
const PROJECT_DIR = process.env.QOBUZ_DL_DIR || LOCAL_QOBUZ_DIR
const BRIDGE = path.join(__dirname, 'qobuz_bridge.py')
const TOKEN_FILE = path.join(os.homedir(), '.config', 'qobuz-dl', '.qobuz_dl.oauth.txt')

// 跨平台查找系统 Python（需 3.10+）：Windows: python / python3 / py 启动器；macOS/Linux: python3 / python
// 找到的解释器配合内置的 pylibs 纯 Python 依赖库（vendor/qobuz-dl/pylibs），无需 pip install
let _pythonCmd = null
function pythonVersionOk(cmd, args) {
  try {
    const out = execFileSync(cmd, [...args, '--version'], { timeout: 10_000, stdio: 'pipe' }).toString()
    const m = out.match(/Python (\d+)\.(\d+)/)
    return !!m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10))
  } catch (_) {
    return false
  }
}

function pythonCmd() {
  if (_pythonCmd) return _pythonCmd
  const cands = process.platform === 'win32'
    ? [{ cmd: 'python', args: [] }, { cmd: 'python3', args: [] }, { cmd: 'py', args: ['-3'] }]
    : [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }, { cmd: 'python3.13', args: [] }, { cmd: 'python3.12', args: [] }, { cmd: 'python3.11', args: [] }, { cmd: 'python3.10', args: [] }]
  for (const c of cands) {
    if (pythonVersionOk(c.cmd, c.args)) { _pythonCmd = c; break }
  }
  return _pythonCmd
}

function pylibsDir() {
  return path.join(PROJECT_DIR, 'pylibs')
}

function available() {
  return fs.existsSync(BRIDGE) && fs.existsSync(pylibsDir()) && !!pythonCmd()
}

function isLoggedIn() {
  try { return fs.statSync(TOKEN_FILE).size > 10 } catch { return false }
}

function runBridge(command, args = [], timeout = 30_000) {
  return new Promise((resolve, reject) => {
    if (!available()) return reject(new Error(`Qobuz 需要系统安装 Python 3.10+ 并在 PATH 中（未检测到可用解释器）`))
    const py = pythonCmd()
    execFile(py.cmd, [...py.args, BRIDGE, command, ...args], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).trim().split('\n').slice(-1)[0]))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error((stderr || stdout || 'Qobuz 返回格式错误').trim().slice(-300))) }
    })
  })
}

// 把专辑/歌单等链接展开成单曲列表；歌手/厂牌/last.fm 返回空列表（由 CLI 整体下载）
function expand(url) {
  return runBridge('expand', [url], 120_000)
}

// 搜索专辑（返回专辑列表，配合链接下载可整张入队）
function searchAlbums(artist, keyword) {
  return runBridge('search_albums', [artist || '', keyword || ''], 30_000)
}

function login() {
  return new Promise((resolve, reject) => {
    if (!available()) return reject(new Error(`Qobuz 需要系统安装 Python 3.10+ 并在 PATH 中（未检测到可用解释器）`))
    const py = pythonCmd()
    const child = spawn(py.cmd, [...py.args, BRIDGE, 'login'], { detached: true, stdio: 'ignore' })
    child.unref()
    resolve({ started: true })
  })
}

class QobuzJob {
  constructor({ songs, outDir, quality = 27, concurrency = 3, extraArgs = [], flatten = false, embedPic = false, keepCoverFile = true, playlistName = '', onProgress }) {
    this.songs = songs
    this.outDir = outDir
    this.quality = quality
    this.extraArgs = extraArgs
    this.flatten = flatten
    this.embedPic = embedPic
    this.keepCoverFile = keepCoverFile
    this.playlistName = playlistName
    this.startedAt = Date.now()
    this.concurrency = Math.max(1, Math.min(10, concurrency || 3))
    this.onProgress = onProgress || (() => {})
    this.running = true
    this.paused = false
    this.error = null
    this.done = 0
    this.entries = songs.map(song => ({
      idx: song.idx,
      name: song.name,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      status: 'queued',
      source: 'qobuz',
    }))
    this.queue = [...songs]
    this.children = new Map()
    this.failed = []
  }

  async start() {
    const workers = Array.from({ length: Math.min(this.concurrency, this.queue.length) }, () => this.worker())
    await Promise.all(workers)
    this.running = false
    if (!this.keepCoverFile) this.removeCoverFiles()
    if (this.flatten) this.flattenFolders()
    if (this.playlistName) this.generateM3u()
    return this
  }

  sanitizeName(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'playlist'
  }

  /** 不保留封面文件：删除本次下载产生的 cover.jpg/png（内嵌后冗余），清空后顺带移除空目录 */
  removeCoverFiles() {
    try {
      for (const name of fs.readdirSync(this.outDir)) {
        const dir = path.join(this.outDir, name)
        let st
        try { st = fs.statSync(dir) } catch { continue }
        if (!st.isDirectory() || st.mtimeMs < this.startedAt) continue
        for (const file of fs.readdirSync(dir)) {
          if (!/^cover\.(jpe?g|png)$/i.test(file)) continue
          const p = path.join(dir, file)
          try { if (fs.statSync(p).mtimeMs >= this.startedAt) fs.unlinkSync(p) } catch (_) {}
        }
        try { fs.rmdirSync(dir) } catch (_) {} // 非空则保留
      }
    } catch (_) {}
  }

  /** 歌单下载完成后生成 {歌单名}.m3u（按歌单顺序，文件相对路径） */
  generateM3u() {
    try {
      const files = []
      const walk = (dir, depth) => {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name)
          let st
          try { st = fs.statSync(p) } catch { continue }
          if (st.isDirectory()) { if (depth < 2) walk(p, depth + 1); continue }
          if (name.startsWith('.')) continue
          if (/\.(mp3|flac|m4a|wav|ogg|aac)$/i.test(name)) files.push({ p, name, mtime: st.mtimeMs })
        }
      }
      walk(this.outDir, 0)
      files.sort((a, b) => b.mtime - a.mtime) // 同名时优先最新
      const norm = s => s.toLowerCase().replace(/\s+/g, '')
      const pool = [...files]
      const lines = ['#EXTM3U']
      for (const song of this.songs) {
        const title = norm(song.name || '')
        if (!title) continue
        const idx = pool.findIndex(f => norm(f.name).includes(title))
        if (idx === -1) continue
        const f = pool.splice(idx, 1)[0]
        lines.push(path.relative(this.outDir, f.p).split(path.sep).join('/'))
      }
      if (lines.length <= 1) return
      const m3uPath = path.join(this.outDir, `${this.sanitizeName(this.playlistName)}.m3u`)
      fs.writeFileSync(m3uPath, lines.join('\n') + '\n')
    } catch (_) {}
  }

  /** 平铺模式：把本次下载产生的专辑子文件夹里的文件收进下载目录（目录按修改时间识别，不动旧文件） */
  flattenFolders() {
    try {
      for (const name of fs.readdirSync(this.outDir)) {
        const dir = path.join(this.outDir, name)
        let st
        try { st = fs.statSync(dir) } catch { continue }
        if (!st.isDirectory() || st.mtimeMs < this.startedAt) continue
        for (const file of fs.readdirSync(dir)) {
          const src = path.join(dir, file)
          if (!fs.statSync(src).isFile()) continue
          let target = path.join(this.outDir, file)
          // 封面文件：已内嵌则删除；未内嵌则改名为「专辑文件夹名.jpg」后保留
          if (/^cover\./i.test(file)) {
            if (this.embedPic) { fs.unlinkSync(src); continue }
            target = path.join(this.outDir, `${name}.${file.split('.').pop()}`)
          }
          if (fs.existsSync(target)) target = path.join(this.outDir, `${name} - ${file}`)
          fs.renameSync(src, target)
        }
        try { fs.rmdirSync(dir) } catch (_) {} // 非空则保留
      }
    } catch (_) {}
  }

  async worker() {
    while (this.queue.length) {
      while (this.paused && this.running) await new Promise(r => setTimeout(r, 200))
      const song = this.queue.shift()
      if (!song) return
      const entry = this.entries.find(e => e.idx === song.idx)
      if (!entry || entry.status === 'cancelled') continue
      await this.process(song, entry)
    }
  }

  async process(song, entry) {
    entry.status = 'downloading'
    this.onProgress(entry)
    try {
      const search = song.qobuzUrl ? null : await runBridge('search', [song.artist || '', song.name || ''])
      const result = song.qobuzUrl
        ? { url: song.qobuzUrl, name: song.name, singer: song.artist, album: song.album, score: 100 }
        : search.results && search.results[0]
      if (!result) throw new Error('Qobuz 没有匹配结果')
      entry.matched = { source: 'qobuz', name: result.name, singer: result.singer, album: result.album, score: result.score }
      entry.qobuzUrl = result.url
      this.onProgress(entry)
      await this.spawnDownload(result.url, entry)
      entry.status = 'downloaded'
    } catch (err) {
      if (entry.status === 'cancelled' || entry.status === 'paused') return
      entry.error = err.message
      entry.status = 'failed'
      this.failed.push(song)
    }
    this.onProgress(entry)
  }

  spawnDownload(url, entry) {
    return new Promise((resolve, reject) => {
      const py = pythonCmd()
      const args = [...py.args, BRIDGE, 'download', url, this.outDir, String(this.quality), ...this.extraArgs]
      const child = spawn(py.cmd, args, { cwd: PROJECT_DIR, env: { ...process.env, QOBUZ_DL_DIR: PROJECT_DIR } })
      this.children.set(entry.idx, child)
      let output = ''
      child.stdout.on('data', buf => { output += buf.toString(); this.onProgress({ ...entry, log: output.slice(-500) }) })
      child.stderr.on('data', buf => { output += buf.toString(); this.onProgress({ ...entry, log: output.slice(-500) }) })
      child.on('error', reject)
      child.on('close', code => {
        this.children.delete(entry.idx)
        if (code === 0) resolve()
        else reject(new Error(output.trim().split('\n').slice(-1)[0] || `Qobuz 下载退出码 ${code}`))
      })
    })
  }

  pause() {
    this.paused = true
    for (const child of this.children.values()) child.kill('SIGTERM')
    for (const entry of this.entries) if (entry.status === 'downloading') entry.status = 'paused'
  }

  resume() {
    this.paused = false
    for (const song of this.songs) {
      const entry = this.entries.find(e => e.idx === song.idx)
      if (entry && entry.status === 'paused') { entry.status = 'queued'; this.queue.push(song); this.onProgress(entry) }
    }
  }

  cancel(keys) {
    for (const key of keys) {
      const entry = this.entries.find(e => String(e.idx) === String(key))
      if (!entry) continue
      entry.status = 'cancelled'
      const child = this.children.get(entry.idx)
      if (child) child.kill('SIGTERM')
      this.onProgress(entry)
    }
  }
}

module.exports = { QobuzJob, available, isLoggedIn, login, runBridge, expand, searchAlbums, PROJECT_DIR, TOKEN_FILE }
