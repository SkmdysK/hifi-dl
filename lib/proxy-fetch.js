'use strict'
/**
 * 支持 HTTP(S) 代理的请求封装（零依赖）。
 * - 不配置代理时等价于普通请求
 * - http 目标：向代理发绝对 URI 请求
 * - https 目标：向代理发 CONNECT 建隧道，再走 TLS
 * 返回简化版 Response：{ ok, status, headers.get(), arrayBuffer(), body(异步迭代) }
 */

const http = require('http')
const https = require('https')

function parseProxy(proxy) {
  try {
    const u = new URL(proxy)
    if (!['http:', 'https:'].includes(u.protocol)) return null
    return {
      host: u.hostname,
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null,
    }
  } catch {
    return null
  }
}

function request(targetUrl, { method = 'GET', headers = {}, signal, proxy } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl)
    const isHttps = u.protocol === 'https:'
    let settled = false
    let currentReq = null
    const finish = (fn, val) => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      fn(val)
    }
    const onAbort = () => {
      if (currentReq) currentReq.destroy(new Error('cancelled'))
      finish(reject, new Error('cancelled'))
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const handle = res => {
      const headersLower = {}
      for (const [k, v] of Object.entries(res.headers)) headersLower[k.toLowerCase()] = String(v)
      const body = async function* () {
        for await (const chunk of res) yield chunk
      }
      const arrayBuffer = () => new Promise((rs, rj) => {
        const parts = []
        res.on('data', c => parts.push(c))
        res.on('end', () => rs(Buffer.concat(parts)))
        res.on('error', rj)
      })
      finish(resolve, {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: { get: k => headersLower[String(k).toLowerCase()] ?? '' },
        body: body(),
        arrayBuffer,
      })
    }

    const p = proxy ? parseProxy(proxy) : null
    if (proxy && !p) return finish(reject, new Error(`代理地址无效: ${proxy}`))

    if (!p) {
      const mod = isHttps ? https : http
      currentReq = mod.request(targetUrl, { method, headers }, handle)
    } else if (!isHttps) {
      // http 目标：代理直接转发绝对 URI
      const proxyHeaders = { Host: u.host }
      if (p.auth) proxyHeaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(p.auth).toString('base64')
      currentReq = http.request(
        { host: p.host, port: p.port, method, path: targetUrl, headers: { ...proxyHeaders, ...headers } },
        handle,
      )
    } else {
      // https 目标：CONNECT 隧道
      const proxyHeaders = { Host: `${u.hostname}:${u.port || 443}` }
      if (p.auth) proxyHeaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(p.auth).toString('base64')
      currentReq = http.request({ host: p.host, port: p.port, method: 'CONNECT', path: `${u.hostname}:${u.port || 443}`, headers: proxyHeaders })
      currentReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy()
          return finish(reject, new Error(`代理 CONNECT 失败: ${res.statusCode}`))
        }
        const tlsReq = https.request(
          { host: u.hostname, port: u.port || 443, method, path: u.pathname + u.search, headers, socket, agent: false },
          handle,
        )
        tlsReq.on('error', e => finish(reject, e))
        if (signal) signal.addEventListener('abort', () => socket.destroy(new Error('cancelled')), { once: true })
        tlsReq.end()
      })
    }
    currentReq.on('error', e => finish(reject, e))
    currentReq.end()
  })
}

module.exports = { request }
