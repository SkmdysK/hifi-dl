'use strict'

const crypto = require('crypto')

/**
 * 在线歌单解析器。
 *
 * 这里不依赖第三方包：短链先由 fetch 跟随跳转，网易云和 QQ 音乐走公开接口，
 * 酷狗按 LX Music 的短码/collection 流程解析，Apple Music 则尝试公开
 * catalog 接口和网页内嵌数据。所有平台最终统一为 Apple 导出歌单使用的字段。
 */

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
  Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
}

const PLATFORM_NAMES = {
  kugou: '酷狗音乐',
  netease: '网易云音乐',
  qq: 'QQ 音乐',
  apple: 'Apple Music',
}

function asUrl(value) {
  const text = String(value || '').trim()
  if (!text) throw new Error('请输入歌单链接')
  let url
  try { url = new URL(text) } catch { throw new Error('歌单链接格式不正确') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('歌单链接必须使用 http 或 https')
  return url
}

function detectPlaylistPlatform(value) {
  const url = asUrl(value)
  const host = url.hostname.toLowerCase()
  if (host === 'music.apple.com' || host.endsWith('.music.apple.com')) return 'apple'
  if (host === '163cn.tv' || host.endsWith('.163cn.tv') || host === 'music.163.com' || host.endsWith('.music.163.com') || host === 'y.music.163.com') return 'netease'
  if (host === 'kugou.com' || host.endsWith('.kugou.com')) return 'kugou'
  if (host === 'y.qq.com' || host.endsWith('.y.qq.com') || host === 'qqmusic.qq.com') return 'qq'
  throw new Error('暂不支持该平台的歌单链接（目前支持酷狗、网易云、QQ 音乐、Apple Music）')
}

function htmlDecode(value) {
  return String(value || '')
    .replace(/&#(\d+);|&#x([0-9a-fA-F]+);/g, (_, dec, hex) => String.fromCodePoint(parseInt(dec || hex, dec ? 10 : 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

function clean(value) {
  return htmlDecode(String(value == null ? '' : value)).replace(/\s+/g, ' ').trim()
}

function numberOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function normalizeSong({ name, artist, album, duration, source }) {
  const song = {
    name: clean(name),
    artist: clean(artist),
    album: clean(album),
    duration: numberOrNull(duration),
  }
  if (source) song.source = source
  return song
}

function uniqueSongs(songs) {
  const seen = new Set()
  return songs.filter(song => {
    if (!song.name) return false
    const key = `${song.name}\u0000${song.artist}\u0000${song.album}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function responseText(response) {
  if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : '请求失败'}`)
  return response.text()
}

async function request(url, options = {}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 不支持网络请求')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeout || 20_000)
  try {
    const requestOptions = {
      redirect: 'follow',
      ...options,
      headers: { ...DEFAULT_HEADERS, ...(options.headers || {}) },
      signal: options.signal || controller.signal,
    }
    if (requestOptions.body && typeof requestOptions.body === 'object' && !(requestOptions.body instanceof ArrayBuffer) && !(requestOptions.body instanceof URLSearchParams) && !Buffer.isBuffer(requestOptions.body)) {
      requestOptions.body = JSON.stringify(requestOptions.body)
      if (!Object.keys(requestOptions.headers).some(key => key.toLowerCase() === 'content-type')) {
        requestOptions.headers['Content-Type'] = 'application/json'
      }
    }
    const response = await fetchImpl(url, requestOptions)
    return response
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('请求超时')
    throw new Error(`网络请求失败: ${err.message}`)
  } finally {
    clearTimeout(timer)
  }
}

async function requestJson(url, options, fetchImpl) {
  const response = await request(url, options, fetchImpl)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  try {
    const text = await response.text()
    const trimmed = text.trim()
    const jsonText = trimmed
      .replace(/^(?:try\s*\{)?\s*[\w$.]+\s*\(/, '')
      .replace(/\);?\s*(?:\} catch[\s\S]*)?$/, '')
      .trim()
    return JSON.parse(jsonText)
  } catch { throw new Error('接口返回不是有效 JSON') }
}

async function expandUrl(url, fetchImpl) {
  const response = await request(url, {}, fetchImpl)
  const finalUrl = response.url || url
  let body = ''
  try { body = await response.text() } catch (_) {}
  return { url: finalUrl, body }
}

function idFromNeteaseUrl(url, body = '') {
  const candidates = [url, url.replace(/#/, '&')]
  for (const value of candidates) {
    try {
      const parsed = new URL(value)
      const id = parsed.searchParams.get('id') || parsed.searchParams.get('playlistId')
      if (/^\d+$/.test(id || '')) return id
      const match = `${parsed.pathname}${parsed.hash}`.match(/(?:playlist|songlist)[^\d]*(\d{3,})/i)
      if (match) return match[1]
    } catch (_) {}
  }
  const match = String(body).match(/(?:playlist|songlist)[^\d]{0,30}(\d{3,})|[?&#]id=(\d{3,})/i)
  return match ? (match[1] || match[2]) : null
}

function idFromQqUrl(url, body = '') {
  const values = [url, body]
  for (const value of values) {
    try {
      const parsed = new URL(value)
      const id = parsed.searchParams.get('id') || parsed.searchParams.get('disstid') || parsed.searchParams.get('playlistId')
      if (/^\d+$/.test(id || '')) return id
      const match = `${parsed.pathname}${parsed.hash}`.match(/\/(?:playlist|playsquare)\/(\d+)/i)
      if (match) return match[1]
    } catch (_) {}
  }
  const match = String(body).match(/(?:disstid|playlistId|[?&#]id)\s*["'=:\s]+(\d{3,})|\/(?:playlist|playsquare)\/(\d{3,})/i)
  return match ? (match[1] || match[2]) : null
}

function normalizeNeteaseTrack(item) {
  const track = item && (item.simpleSong || item)
  if (!track) return null
  const artists = track.ar || track.artists || []
  const album = track.al || track.album || {}
  const rawDuration = Number(track.dt || track.duration || 0)
  return normalizeSong({
    name: track.name,
    artist: Array.isArray(artists) ? artists.map(a => a.name).filter(Boolean).join('、') : artists.name || artists,
    album: album.name,
    duration: rawDuration / (rawDuration > 10_000 ? 1000 : 1),
    source: 'netease',
  })
}

async function parseNeteasePlaylist(url, fetchImpl) {
  const expanded = await expandUrl(url, fetchImpl)
  const id = idFromNeteaseUrl(expanded.url, expanded.body)
  if (!id) throw new Error('无法从网易云链接中识别歌单 ID，请使用公开歌单链接')

  // /api/v6/playlist/detail currently returns the full track ID list. The older
  // endpoint can return only a small preview of tracks even for public playlists.
  const detailEndpoints = [
    `https://music.163.com/api/v6/playlist/detail?id=${id}`,
    `https://music.163.com/api/v3/playlist/detail?id=${id}&n=1000`,
    `https://music.163.com/api/playlist/detail?id=${id}&limit=1000`,
  ]
  let data
  let lastError
  for (const endpoint of detailEndpoints) {
    try {
      const candidate = await requestJson(endpoint, { headers: { Referer: 'https://music.163.com/' } }, fetchImpl)
      if (candidate.code === 200 && candidate.playlist) {
        data = candidate
        break
      }
      lastError = new Error(candidate.msg || '网易云歌单不可访问，可能未公开')
    } catch (err) {
      lastError = err
    }
  }
  if (!data) throw lastError || new Error('网易云歌单不可访问，可能未公开')

  const title = clean(data.playlist.name)
  const trackIds = (data.playlist.trackIds || []).map(item => String(item && (item.id || item))).filter(id => /^\d+$/.test(id))
  let tracks = data.playlist.tracks || []
  if (trackIds.length > tracks.length) {
    tracks = []
    for (let offset = 0; offset < trackIds.length; offset += 200) {
      const ids = trackIds.slice(offset, offset + 200)
      const query = encodeURIComponent(JSON.stringify(ids.map(id => ({ id: Number(id) }))))
      const songsData = await requestJson(`https://music.163.com/api/v3/song/detail?c=${query}`, { headers: { Referer: 'https://music.163.com/' } }, fetchImpl)
      if (songsData.code !== 200 || !Array.isArray(songsData.songs)) throw new Error(songsData.msg || '网易云歌曲详情读取失败')
      tracks.push(...songsData.songs)
    }
  }
  const songs = tracks.map(normalizeNeteaseTrack).filter(Boolean)
  const result = uniqueSongs(songs)
  if (!result.length) throw new Error('网易云歌单中没有可解析的歌曲')
  return { platform: 'netease', platformName: PLATFORM_NAMES.netease, title, songs: result, url: expanded.url }
}

function normalizeQqTrack(item) {
  if (!item || typeof item !== 'object') return null
  const singers = item.singer || item.singers || item.artist || []
  const album = item.album || item.albuminfo || {}
  const rawDuration = Number(item.interval || item.duration || item.interval_ms || 0)
  return normalizeSong({
    name: item.title || item.songname || item.name,
    artist: Array.isArray(singers) ? singers.map(s => s.name || s).filter(Boolean).join('、') : singers.name || singers,
    album: album.name || album.album_name || album.title,
    duration: item.interval_ms ? rawDuration / 1000 : rawDuration,
    source: 'qq',
  })
}

function findQqSongs(value) {
  const list = value && value.cdlist && value.cdlist[0] && value.cdlist[0].songlist
  return uniqueSongs((Array.isArray(list) ? list : []).map(normalizeQqTrack).filter(Boolean))
}

async function parseQqPlaylist(url, fetchImpl) {
  const expanded = await expandUrl(url, fetchImpl)
  const id = idFromQqUrl(expanded.url, expanded.body) || idFromQqUrl(url)
  if (!id) throw new Error('无法从 QQ 音乐链接中识别歌单 ID，请使用公开歌单链接')

  const endpoint = `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?${new URLSearchParams({
    type: '1', json: '1', utf8: '1', onlysong: '0', new_format: '1', disstid: id,
    loginUin: '0', hostUin: '0', format: 'json', inCharset: 'utf8', outCharset: 'utf-8',
    notice: '0', platform: 'yqq.json', needNewCode: '0',
  })}`
  const data = await requestJson(endpoint, {
    headers: {
      Origin: 'https://y.qq.com',
      Referer: `https://y.qq.com/n/ryqq/playlist/${id}`,
    },
  }, fetchImpl)
  if (Number(data.code) !== 0 || !data.cdlist || !data.cdlist[0]) {
    throw new Error(data.message || 'QQ 音乐歌单不可访问，可能未公开')
  }
  const cd = data.cdlist[0]
  const songs = findQqSongs(data)
  if (!songs.length) throw new Error('QQ 音乐歌单中没有可解析的歌曲')
  return { platform: 'qq', platformName: PLATFORM_NAMES.qq, title: clean(cd.dissname || cd.name), songs, url: expanded.url }
}

function kugouIdsFromUrl(url, body = '') {
  const text = `${url}\n${body}`
  let specialId = null
  const specialIdPatterns = [
    /\/special\/single\/(\d+)/i,
    /\/(?:playlist|songlist|list)\/(\d+)/i,
    /\/special\/(\d+)/i,
    /[?&#](?:specialid|special_id|listid)=(\d+)/i,
    /(?:specialid|special_id|listid)["'=: ]+(\d{3,})/i,
  ]
  for (const pattern of specialIdPatterns) {
    const match = text.match(pattern)
    if (match) {
      specialId = match[1]
      break
    }
  }
  const collectionMatch = text.match(/(?:global_collection_id|collection_id)["'\\:= ]+((?:collection_|gcid_)[A-Za-z0-9_]+)/i) || text.match(/\b((?:collection_|gcid_)[A-Za-z0-9_]+)\b/i)
  return { specialId, globalCollectionId: collectionMatch ? collectionMatch[1] : null }
}

function kugouShareCode(url) {
  try {
    const parsed = new URL(url)
    if (!/(^|\.)t1\.kugou\.com$/i.test(parsed.hostname)) return null
    const code = parsed.pathname.split('/').filter(Boolean)[0]
    return /^[A-Za-z0-9]{6,}$/.test(code || '') ? code : null
  } catch (_) {
    return null
  }
}

function kugouSignature(params, platform = 'android', body = '') {
  const query = typeof params === 'string'
    ? params.split('&').sort().join('')
    : Object.entries(params).map(([key, value]) => `${key}=${value}`).sort().join('')
  const key = platform === 'web' ? 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt' : 'OIlwieks28dk2k092lksi2UIkp'
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body)
  return crypto.createHash('md5').update(`${key}${query}${bodyText}${key}`).digest('hex')
}

function kugouGatewayUrl(globalCollectionId, page) {
  const params = {
    appid: 1001,
    clientver: 10246,
    global_collection_id: globalCollectionId,
    module: 'NONE',
    page,
    pagesize: 300,
    plat: 3,
    type: 1,
  }
  const search = new URLSearchParams(params)
  search.set('signature', kugouSignature(params, 'android'))
  return `https://pubsongscdn.kugou.com/v2/get_other_list_file?${search}`
}

function kugouOfficialInfoUrl(globalCollectionId) {
  const params = `appid=1058&specialid=0&global_specialid=${globalCollectionId}&format=jsonp&srcappid=2919&clientver=20000&clienttime=1586163242519&mid=1586163242519&uuid=1586163242519&dfid=-`
  return `https://mobiles.kugou.com/api/v5/special/info_v2?${params}&signature=${kugouSignature(params, 'web')}`
}

function kugouOfficialSongsUrl(globalCollectionId, page, pagesize) {
  const params = `appid=1058&global_specialid=${globalCollectionId}&specialid=0&plat=0&version=8000&page=${page}&pagesize=${pagesize}&srcappid=2919&clientver=20000&clienttime=1586163263991&mid=1586163263991&uuid=1586163263991&dfid=-`
  return `https://mobiles.kugou.com/api/v5/special/song_v2?${params}&signature=${kugouSignature(params, 'web')}`
}

async function kugouDecodeGcid(gcid, fetchImpl) {
  const params = 'dfid=-&appid=1005&mid=0&clientver=20109&clienttime=640612895&uuid=-'
  const body = { ret_info: 1, data: [{ id: gcid, id_type: 2 }] }
  const endpoint = `https://t.kugou.com/v1/songlist/batch_decode?${params}&signature=${kugouSignature(params, 'android', JSON.stringify(body))}`
  const data = await requestJson(endpoint, {
    method: 'POST',
    headers: { Referer: 'https://m.kugou.com/' },
    body,
  }, fetchImpl)
  const result = data && data.data ? data.data : data
  const item = result && Array.isArray(result.list) ? result.list[0] : result && result[0]
  return item && (item.global_collection_id || item.global_specialid)
}

async function kugouResolveShareCode(code, fetchImpl) {
  const body = {
    appid: 1001,
    clientver: 9020,
    mid: '21511157a05844bd085308bc76ef3343',
    clienttime: 640612895,
    key: '36164c4015e704673c588ee202b9ecb8',
    data: code,
  }
  const data = await requestJson('https://t.kugou.com/command/', {
    method: 'POST',
    headers: { 'KG-RC': '1', 'KG-THash': 'network_super_call.cpp:3676261689:379' },
    body,
  }, fetchImpl)
  const root = data && data.data ? data.data : data
  const info = root && root.info ? root.info : root
  return info || null
}

function normalizeKugouSong(item) {
  if (!item || typeof item !== 'object') return null
  const singer = item.singername || item.singerName || item.SingerName || item.singer || item.artist
  const duration = item.timelength != null ? Number(item.timelength) / 1000 : Number(item.duration || item.Duration || item.timelen)
  return normalizeSong({
    name: item.songname || item.songName || item.SongName || item.filename || item.name,
    artist: Array.isArray(singer) ? singer.map(s => s.name || s).join('、') : singer,
    album: item.album_name || item.albumName || item.AlbumName || item.album,
    duration,
    source: 'kugou',
  })
}

function findKugouSongs(value) {
  const found = []
  const walk = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      const mapped = node.map(normalizeKugouSong).filter(song => song && song.name)
      if (mapped.length) found.push(...mapped)
      node.forEach(walk)
      return
    }
    Object.values(node).forEach(walk)
  }
  walk(value)
  return uniqueSongs(found)
}

function extractJsonScripts(html) {
  const values = []
  const re = /<script(?:[^>]*type=["']application\/(?:ld\+)?json["'][^>]*)?[^>]*>([\s\S]*?)<\/script>/gi
  let match
  while ((match = re.exec(html))) {
    const text = htmlDecode(match[1]).trim()
    if (!text) continue
    try { values.push(JSON.parse(text)) } catch (_) {}
  }
  return values
}

async function parseKugouPlaylist(url, fetchImpl) {
  let expanded = await expandUrl(url, fetchImpl)
  let ids = kugouIdsFromUrl(expanded.url, expanded.body)
  const code = kugouShareCode(url)
  if (code) {
    try {
      const info = await kugouResolveShareCode(code, fetchImpl)
      const resolvedId = info && (info.global_collection_id || info.global_specialid)
      if (resolvedId) ids.globalCollectionId = resolvedId
      if (!ids.specialId && info && info.type === 2 && info.id) ids.specialId = String(info.id)
      if (!expanded.body && info && info.name) expanded.body = JSON.stringify(info)
    } catch (_) {}
  }
  if (!ids.globalCollectionId && !ids.specialId) throw new Error('无法从酷狗链接中识别歌单 ID，请使用公开歌单链接')
  let songs = []
  let title = ''
  if (ids.globalCollectionId) {
    let globalId = ids.globalCollectionId
    if (/^gcid_/i.test(globalId)) globalId = await kugouDecodeGcid(globalId, fetchImpl)
    if (!globalId) throw new Error('酷狗歌单短码解码失败')
    try {
      const info = await requestJson(kugouOfficialInfoUrl(globalId), {
        headers: { Referer: 'https://m3ws.kugou.com/share/index.php' },
      }, fetchImpl)
      const infoData = info && info.data ? info.data : info
      title = clean(infoData && (infoData.specialname || infoData.name))
      const count = Number(infoData && infoData.songcount)
      const total = Number.isFinite(count) && count > 0 ? count : Infinity
      for (let page = 1; page <= 100 && songs.length < total; page++) {
        const pagesize = Number.isFinite(count) ? Math.min(300, count - songs.length) : 300
        if (pagesize <= 0) break
        const data = await requestJson(kugouOfficialSongsUrl(globalId, page, pagesize), {
          headers: { Referer: 'https://m3ws.kugou.com/share/index.php' },
        }, fetchImpl)
        const raw = data && data.data ? data.data : data
        const pageSongs = findKugouSongs(raw && (raw.info || raw.list) ? raw.info || raw.list : raw)
        songs.push(...pageSongs)
        if (!pageSongs.length || pageSongs.length < pagesize) break
      }
    } catch (_) {
      // Keep the older CDN endpoint as a compatibility fallback for old links.
      for (let page = 1; page <= 10; page++) {
      try {
        const data = await requestJson(kugouGatewayUrl(globalId, page), {
          headers: {
            'User-Agent': 'Android9-AndroidPhone-10246-18-0-playlist-wifi',
            'x-router': 'pubsongscdn.kugou.com',
          },
        }, fetchImpl)
        const pageSongs = findKugouSongs(data.data && (data.data.info || data.data.lists) ? data.data.info || data.data.lists : data)
        songs.push(...pageSongs)
        title = title || clean(data.data && (data.data.specialname || data.data.name || data.data.listname))
        const count = Number(data.data && data.data.count)
        if (!pageSongs.length || !Number.isFinite(count) || songs.length >= count) break
      } catch (_) {
        break
      }
      }
    }
  }
  const endpoints = ids.specialId ? [
    `https://mobilecdn.kugou.com/api/v3/special/song?specialid=${ids.specialId}&page=1&pagesize=1000&plat=0&version=8352&with_res_tag=1`,
    `https://www.kugou.com/yy/index.php?r=play/getdata&specialid=${ids.specialId}`,
  ] : []
  for (const endpoint of endpoints) {
    if (songs.length) break
    try {
      const data = await requestJson(endpoint, { headers: { Referer: `https://www.kugou.com/yy/special/single/${ids.specialId}.html` } }, fetchImpl)
      songs = findKugouSongs(data)
      title = clean(data.data && (data.data.specialname || data.data.name))
      if (songs.length) break
    } catch (_) {}
  }
  if (!songs.length) {
    songs = findKugouSongs(extractJsonScripts(expanded.body))
    const titleMatch = expanded.body.match(/(?:specialname|specialName|"title")["'\s:=]+([^,"'<>]{1,100})/i)
    title = title || (titleMatch && clean(titleMatch[1]))
  }
  if (!songs.length) throw new Error('酷狗歌单不可访问，或页面没有公开歌曲列表')
  return { platform: 'kugou', platformName: PLATFORM_NAMES.kugou, title, songs, url: expanded.url }
}

function idFromAppleUrl(url) {
  const match = String(url).match(/\/(pl\.[A-Za-z0-9-]+)/i)
  return match ? match[1] : null
}

function storefrontFromAppleUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    return /^[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0] || '') ? parts[0].toLowerCase() : 'us'
  } catch { return 'us' }
}

function normalizeAppleTrack(item) {
  const attr = item && (item.attributes || item)
  if (!attr) return null
  return normalizeSong({
    name: attr.name || attr.trackName,
    artist: attr.artistName || attr.artist,
    album: attr.albumName || attr.collectionName,
    duration: (attr.durationInMillis || attr.trackTimeMillis || attr.duration || 0) / (attr.durationInMillis || attr.trackTimeMillis ? 1000 : 1),
    source: 'apple',
  })
}

function findAppleTracks(value) {
  let best = []
  const walk = node => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      const mapped = node.map(normalizeAppleTrack).filter(song => song && song.name && song.artist)
      if (mapped.length > best.length) best = mapped
      node.forEach(walk)
      return
    }
    Object.values(node).forEach(walk)
  }
  walk(value)
  return uniqueSongs(best)
}

function appleAssetUrls(html, baseUrl) {
  const urls = []
  const re = /<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi
  let match
  while ((match = re.exec(html)) && urls.length < 8) {
    try {
      const url = new URL(match[1], baseUrl)
      const host = url.hostname.toLowerCase()
      if (url.protocol === 'https:' && (host === 'music.apple.com' || host.endsWith('.music.apple.com'))) urls.push(url.href)
    } catch (_) {}
  }
  return urls
}

function appleDeveloperToken(value) {
  const match = String(value || '').match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}/)
  return match ? match[0] : null
}

async function fetchAppleDeveloperToken(html, baseUrl, fetchImpl) {
  const fromPage = appleDeveloperToken(html)
  if (fromPage) return fromPage
  for (const assetUrl of appleAssetUrls(html, baseUrl)) {
    try {
      const body = await responseText(await request(assetUrl, {}, fetchImpl))
      const token = appleDeveloperToken(body)
      if (token) return token
    } catch (_) {}
  }
  return null
}

async function parseApplePlaylist(url, fetchImpl) {
  const expanded = await expandUrl(url, fetchImpl)
  const id = idFromAppleUrl(expanded.url) || idFromAppleUrl(url)
  if (!id) throw new Error('无法从 Apple Music 链接中识别歌单 ID')
  const storefront = storefrontFromAppleUrl(expanded.url || url)
  let songs = []
  let title = ''
  try {
    const token = await fetchAppleDeveloperToken(expanded.body, expanded.url || url, fetchImpl)
    if (!token) throw new Error('未找到 Apple Music 公开访问令牌')
    for (let offset = 0; offset < 10; offset++) {
      const data = await requestJson(`https://amp-api.music.apple.com/v1/catalog/${storefront}/playlists/${id}/tracks?limit=100&offset=${offset * 100}`, {
        headers: {
          Origin: 'https://music.apple.com',
          Referer: 'https://music.apple.com/',
          Authorization: `Bearer ${token}`,
        },
      }, fetchImpl)
      const page = findAppleTracks(data.data || data)
      songs.push(...page)
      if (!data.next || page.length < 100) break
    }
    songs = uniqueSongs(songs)
  } catch (_) {}
  if (!songs.length) {
    const values = extractJsonScripts(expanded.body)
    for (const value of values) {
      songs = findAppleTracks(value)
      if (songs.length) break
    }
  }
  const titleMatch = expanded.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  title = titleMatch ? clean(titleMatch[1].replace(/\s*[-|].*$/, '')) : ''
  if (!songs.length) throw new Error('Apple Music 歌单没有公开歌曲列表，或当前页面暂未返回歌曲数据')
  return { platform: 'apple', platformName: PLATFORM_NAMES.apple, title, songs, url: expanded.url }
}

async function parseOnlinePlaylist(input, options = {}) {
  const platform = detectPlaylistPlatform(input)
  if (platform === 'kugou') return parseKugouPlaylist(input, options.fetchImpl)
  if (platform === 'netease') return parseNeteasePlaylist(input, options.fetchImpl)
  if (platform === 'qq') return parseQqPlaylist(input, options.fetchImpl)
  return parseApplePlaylist(input, options.fetchImpl)
}

module.exports = {
  detectPlaylistPlatform,
  parseOnlinePlaylist,
  parseNeteasePlaylist,
  parseQqPlaylist,
  parseKugouPlaylist,
  parseApplePlaylist,
  normalizeNeteaseTrack,
  normalizeQqTrack,
  normalizeKugouSong,
  normalizeAppleTrack,
  findAppleTracks,
  findKugouSongs,
  kugouIdsFromUrl,
  kugouGatewayUrl,
  kugouOfficialInfoUrl,
  kugouOfficialSongsUrl,
  kugouDecodeGcid,
  kugouSignature,
}
