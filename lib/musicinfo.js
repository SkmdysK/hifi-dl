'use strict'
/**
 * 通过网易云音乐公开接口补充歌曲信息：封面图、歌词（原文/翻译/罗马音）。
 * 各音源脚本只提供取链能力，不提供歌词和封面，这里统一按「歌名+歌手」
 * 从网易云匹配补齐。任一环节失败都返回 null，由调用方决定降级行为。
 */

const CACHE = new Map() // key → { lyric, tlyric, rlyric, coverUrl, album }
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Referer: 'https://music.163.com/',
}

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function searchSongId(name, artist) {
  const query = [artist, name].filter(Boolean).join(' ').trim()
  if (!query) throw new Error('查询词为空')
  const data = await getJson(`https://music.163.com/api/search/get?s=${encodeURIComponent(query)}&type=1&limit=3`)
  const songs = data && data.result && data.result.songs
  if (!Array.isArray(songs) || !songs.length) throw new Error('没有匹配结果')
  return songs[0].id
}

async function fetchInfo(id) {
  // 歌词（原文 lv / 翻译 tv / 罗马音 rv）
  const lyric = await getJson(`https://music.163.com/api/song/lyric?id=${id}&lv=1&tv=-1&rv=-1`).catch(() => null)
  // 专辑封面
  const detail = await getJson(`https://music.163.com/api/song/detail?ids=%5B${id}%5D`).catch(() => null)
  const song = detail && Array.isArray(detail.songs) ? detail.songs[0] : null
  const picUrl = song && song.album && song.album.picUrl ? `${song.album.picUrl}?param=500y500` : null
  return {
    lyric: (lyric && lyric.lrc && lyric.lrc.lyric) || null,
    tlyric: (lyric && lyric.tlyric && lyric.tlyric.lyric) || null,
    rlyric: (lyric && lyric.rlyric && lyric.rlyric.lyric) || null,
    coverUrl: picUrl,
    album: (song && song.album && song.album.name) || null,
  }
}

/** 按歌名+歌手补齐 { lyric, tlyric, rlyric, coverUrl, album }，失败返回 null（带内存缓存） */
async function getSongInfo({ name, artist }) {
  const key = `${name || ''}|${artist || ''}`
  if (CACHE.has(key)) return CACHE.get(key)
  let info = null
  try {
    const id = await searchSongId(name, artist)
    info = await fetchInfo(id)
    if (!info.lyric && !info.coverUrl) info = null
  } catch (_) {
    info = null
  }
  CACHE.set(key, info)
  return info
}

module.exports = { getSongInfo }
