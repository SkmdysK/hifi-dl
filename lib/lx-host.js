'use strict'
/**
 * LX Music 自定义源脚本宿主环境
 * 按官方规范 https://lxmusic.toside.cn/desktop/custom-source 实现 globalThis.lx，
 * 在 Node vm 沙箱中运行音源脚本，并代理 musicUrl 请求。
 */
const vm = require('vm')
const crypto = require('crypto')
const zlib = require('zlib')
const { constants: cryptoConstants } = crypto

const API_VERSION = '1.2.0'
const EVENT_NAMES = Object.freeze({
  inited: 'inited',
  request: 'request',
  updateAlert: 'updateAlert',
})

/** 解析脚本头部注释（@name 等） */
function parseScriptInfo(code) {
  const info = { name: '', description: '', version: '', author: '', homepage: '', rawScript: code }
  const header = code.match(/\/\*!?[\s\S]*?\*\//)
  if (!header) return info
  const text = header[0]
  const pick = rx => {
    const m = text.match(rx)
    return m ? m[1].trim() : ''
  }
  info.name = pick(/@name\s+([^\n*]+)/)
  info.description = pick(/@description\s+([^\n*]+)/)
  info.version = pick(/@version\s+([^\n*]+)/)
  info.author = pick(/@author\s+([^\n*]+)/)
  info.homepage = pick(/@homepage\s+([^\n*]+)/)
  return info
}

/** 工具：AES 加密（与 lx-music 桌面端实现一致） */
function aesEncrypt(buffer, mode, key, iv) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer))
  let keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key))
  let ivBuf = iv == null || iv === '' ? null : (Buffer.isBuffer(iv) ? iv : Buffer.from(String(iv)))
  if (/ecb/i.test(mode)) ivBuf = null
  const cipher = crypto.createCipheriv(mode, keyBuf, ivBuf)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/** 工具：RSA 加密 */
function rsaEncrypt(buffer, key) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer))
  let pemKey = String(key)
  if (!pemKey.includes('-----BEGIN')) {
    // 裸 base64/hex 公钥 → 补成 PEM
    pemKey = `-----BEGIN PUBLIC KEY-----\n${pemKey}\n-----END PUBLIC KEY-----`
  }
  return crypto.publicEncrypt({ key: pemKey, padding: cryptoConstants.RSA_PKCS1_PADDING }, data)
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 给第三方脚本用的安全 fetch：不抛出未捕获异常，失败返回拒绝 Promise（由调用方处理） */
function safeFetch(...args) {
  return globalThis.fetch(...args).catch(err => {
    // 抛出一个普通 Error，避免 undici 内部错误直接把进程带崩
    throw new Error(`fetch failed: ${err && (err.cause ? err.cause.message : err.message)}`)
  })
}

class LxSource {
  constructor(code, { label = 'source', onLog = () => {} } = {}) {
    this.code = code
    this.label = label
    this.onLog = onLog
    this.scriptInfo = parseScriptInfo(code)
    this.sources = null // inited 时声明的源
    this.handlers = new Map()
    this._initedResolve = null
    this._initedPromise = new Promise(resolve => { this._initedResolve = resolve })
    this.ctx = null
  }

  log(...args) {
    this.onLog(`[${this.label}]`, ...args)
  }

  /** 初始化：在 vm 沙箱中执行脚本，等待 inited 事件 */
  async init({ timeoutMs = 30_000 } = {}) {
    const self = this
    const fakeConsole = {
      log: (...a) => self.log(...a),
      info: (...a) => self.log(...a),
      warn: (...a) => self.log('[warn]', ...a),
      error: (...a) => self.log('[error]', ...a),
      group: (...a) => self.log('[group]', ...a),
      groupEnd: () => {},
      trace: (...a) => self.log('[trace]', ...a),
      debug: (...a) => self.log(...a),
    }

    const lx = {
      version: API_VERSION,
      env: 'desktop',
      currentScriptInfo: { ...this.scriptInfo },
      EVENT_NAMES,

      on(eventName, handler) {
        self.handlers.set(eventName, handler)
      },

      send(eventName, data) {
        if (eventName === EVENT_NAMES.inited) {
          self.sources = data.sources || {}
          self.openDevTools = !!data.openDevTools
          self._initedResolve(true)
        } else if (eventName === EVENT_NAMES.updateAlert) {
          self.log('[updateAlert]', data && data.log)
        }
      },

      request(url, options, callback) {
        const controller = new AbortController()
        const timeoutMs = (options && options.timeout) || 30_000
        const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs)
        const headers = { ...((options && options.headers) || {}) }
        let bodyData
        if (options) {
          if (options.body != null) {
            if (typeof options.body === 'object' && !Buffer.isBuffer(options.body)) {
              bodyData = JSON.stringify(options.body)
              if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
            } else {
              bodyData = options.body
            }
          } else if (options.form) {
            bodyData = new URLSearchParams(options.form).toString()
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
          } else if (options.formData) {
            const fd = new FormData()
            for (const [k, v] of Object.entries(options.formData)) fd.append(k, v)
            bodyData = fd
          }
        }
        const done = (err, resp, body) => {
          clearTimeout(timer)
          if (typeof callback === 'function') callback(err, resp, body)
        }
        ;(async () => {
          try {
            const res = await fetch(url, {
              method: (options && options.method) || 'GET',
              headers,
              body: bodyData,
              signal: controller.signal,
              redirect: 'follow',
            })
            const raw = Buffer.from(await res.arrayBuffer())
            let body = raw.toString()
            try { body = JSON.parse(body) } catch (_) {}
            const respHeaders = Object.fromEntries(res.headers.entries())
            if (typeof res.headers.getSetCookie === 'function') {
              const cookies = res.headers.getSetCookie()
              if (cookies.length) respHeaders['set-cookie'] = cookies
            }
            const resp = {
              statusCode: res.status,
              statusMessage: res.statusText,
              headers: respHeaders,
              raw,
              body,
            }
            done(null, resp, body)
          } catch (err) {
            done(err, null, null)
          }
        })()
        return () => controller.abort()
      },

      utils: {
        buffer: {
          from: (...a) => Buffer.from(...a),
          bufToString: (buffer, format) => buffer.toString(format),
          alloc: (...a) => Buffer.alloc(...a),
          concat: list => Buffer.concat(list),
        },
        crypto: {
          aesEncrypt: (buffer, mode, key, iv) => aesEncrypt(buffer, mode, key, iv),
          md5: str => crypto.createHash('md5').update(str).digest('hex'),
          randomBytes: size => crypto.randomBytes(size),
          rsaEncrypt: (buffer, key) => rsaEncrypt(buffer, key),
        },
        zlib: {
          inflate: buffer => new Promise((resolve, reject) => {
            zlib.inflate(buffer, (err, data) => err ? reject(err) : resolve(data))
          }),
          deflate: buffer => new Promise((resolve, reject) => {
            zlib.deflate(buffer, (err, data) => err ? reject(err) : resolve(data))
          }),
        },
      },
    }

    const sandbox = {
      console: fakeConsole,
      lx,
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      queueMicrotask,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      atob,
      btoa,
      fetch: safeFetch,
      crypto: globalThis.crypto,
      Buffer,
      performance,
      // 部分脚本会探测浏览器环境，给个无害的最小实现
      window: null,
      location: { hostname: 'lxmusic.local', href: 'https://lxmusic.local/', protocol: 'https:' },
      navigator: { userAgent: 'lx-music-desktop' },
    }
    sandbox.window = sandbox
    sandbox.globalThis = sandbox

    this.ctx = vm.createContext(sandbox, { name: `lx-source:${this.label}` })
    const script = new vm.Script(this.code, { filename: `${this.label}.js` })
    script.runInContext(this.ctx, { timeout: 30_000 })

    // 等 inited（一般脚本同步发送；少数异步，最多等 3 秒）
    for (let i = 0; i < 30; i++) {
      if (this.sources) break
      await wait(100)
    }
    if (!this.sources) throw new Error(`脚本 ${this.label} 未发送 inited 事件`)
    return this
  }

  /** 该脚本对某平台声明支持的音质 */
  qualitysOf(source) {
    const s = this.sources[source]
    if (!s) return []
    return Array.isArray(s.qualitys) ? s.qualitys : []
  }

  /** 代理一次请求事件（如 musicUrl），返回 handler 的 Promise 结果 */
  async emit({ action, source, info }, timeoutMs = 60_000) {
    const handler = this.handlers.get(EVENT_NAMES.request)
    if (!handler) throw new Error(`脚本 ${this.label} 未注册 request 事件`)
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`请求超时(${timeoutMs}ms): ${action} ${source}`)), timeoutMs)
    })
    try {
      return await Promise.race([handler({ action, source, info }), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** 获取音乐直链：音质不支持时返回 null */
  async musicUrl(source, musicInfo, quality) {
    if (!this.qualitysOf(source).includes(quality)) return null
    return this.emit({
      action: 'musicUrl',
      source,
      info: { type: quality, musicInfo },
    })
  }
}

module.exports = { LxSource, EVENT_NAMES, parseScriptInfo }
