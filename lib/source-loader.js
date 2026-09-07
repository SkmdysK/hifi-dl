'use strict'
const fs = require('fs')
const path = require('path')

const CACHE_DIR = path.join(__dirname, '..', 'cache')
const SCRIPTS_DIR = path.join(CACHE_DIR, 'scripts')

/** 读取 lxmusic.txt，返回音源脚本 URL 列表（忽略空行与 # 注释） */
function parseSourceList(filePath) {
  if (!fs.existsSync(filePath)) return []
  const text = fs.readFileSync(filePath, 'utf8')
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
}

/**
 * 下载音源脚本。
 * 若 URL 直链 404（如 sixyin/latest.js 在部分网络下不可达），
 * 尝试用 GitHub API 列出同目录版本号文件，取最大版本作为回退。
 */
async function fetchScript(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'lx-music-downloader/1.0' },
    signal: AbortSignal.timeout(20_000),
  })
  if (res.ok) return await res.text()
  if (res.status === 404) {
    const m = url.match(/^(https?:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+)\/(.+)\/([^/]+)$/)
    if (m && m[3].toLowerCase() === 'latest.js') {
      const [, rawBase, dir, , ] = m
      const apiUrl = url.replace(rawBase, 'https://api.github.com/repos')
        .replace(/\/raw\//, '/').replace(/\/main\//, '/').replace(new RegExp('/' + dir + '/latest\\.js$'), '/contents/' + dir)
      const apiRes = await fetch(apiUrl, {
        headers: { 'User-Agent': 'lx-music-downloader/1.0' },
        signal: AbortSignal.timeout(15_000),
      })
      if (apiRes.ok) {
        const list = await apiRes.json()
        const versions = (Array.isArray(list) ? list : [])
          .map(item => item.name)
          .filter(name => /^\d+(\.\d+)*\.js$/.test(name))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        if (versions.length) {
          const fallbackUrl = url.replace(/latest\.js$/, versions[0])
          const res2 = await fetch(fallbackUrl, {
            headers: { 'User-Agent': 'lx-music-downloader/1.0' },
            signal: AbortSignal.timeout(20_000),
          })
          if (res2.ok) {
            console.log(`  [源] ${url} 不可用(404)，回退到 ${versions[0]}`)
            return await res2.text()
          }
        }
      }
    }
  }
  throw new Error(`下载音源脚本失败: ${url} (HTTP ${res.status})`)
}

/** 下载 lxmusic.txt 里列出的所有音源脚本并缓存到 cache/scripts/
 * 缓存优先：6 小时内的缓存直接使用（不阻塞启动），过期缓存在后台静默刷新。
 * 只有首次运行（无缓存）才会同步联网下载。 */
const CACHE_TTL = 6 * 60 * 60 * 1000 // 6 小时

async function loadSourceScripts(sourceListFile) {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
  const urls = parseSourceList(sourceListFile)
  if (!urls.length) return []
  const loadOne = async url => {
    const cacheFile = path.join(SCRIPTS_DIR, url.split('/').slice(-2).join('_'))
    try {
      const stat = fs.statSync(cacheFile)
      const code = fs.readFileSync(cacheFile, 'utf8')
      if (Date.now() - stat.mtimeMs < CACHE_TTL) return code // 缓存新鲜，直接用
      // 缓存过期：先用缓存，后台刷新（不阻塞）
      console.log(`  [源] 缓存已过期，后台静默更新: ${url}`)
      fetchScript(url).then(c => fs.writeFileSync(cacheFile, c)).catch(() => {})
      return code
    } catch {
      // 无缓存：同步下载（仅首次运行需要联网等待）
      try {
        const code = await fetchScript(url)
        fs.writeFileSync(cacheFile, code)
        return code
      } catch (err) {
        console.error(`  [源] ${url} 下载失败且无缓存，跳过`)
        return null
      }
    }
  }
  const codes = await Promise.all(urls.map(loadOne))
  const scripts = []
  urls.forEach((url, i) => {
    const code = codes[i]
    if (!code) return
    // 解析脚本头部注释获取信息
    const header = code.match(/\/\*!?[\s\S]*?@name\s+([^\n*]+)[\s\S]*?\*\//)
    scripts.push({ url, code, name: header ? header[1].trim() : url })
  })
  return scripts
}

module.exports = { parseSourceList, fetchScript, loadSourceScripts }
