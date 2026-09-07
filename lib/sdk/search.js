'use strict'
/**
 * 移植自 lx-music-desktop 的 src/renderer/utils/musicSdk/（MIT License）
 * 只保留"搜索"相关逻辑，把 needle 请求层换成 Node 原生 fetch，
 * 其余加密/签名逻辑与上游保持一致。
 * 平台：kw(酷我) kg(酷狗) tx(QQ音乐) wy(网易云) mg(咪咕)
 */
const crypto = require('crypto')
const { createCipheriv, createDecipheriv, publicEncrypt, randomBytes, createHash, constants } = crypto

// ---------- 通用工具（对应上游 utils/index.ts、musicSdk/utils.js） ----------

const toMD5 = str => crypto.createHash('md5').update(str).digest('hex')

/** 对应上游 decodeName：HTML 实体解码 */
const decodeName = (str = '') => {
  if (!str) return ''
  return String(str)
    .replace(/&#(\d+);|&#x([0-9a-fA-F]+);/g, (_, dec, hex) => String.fromCodePoint(parseInt(dec || hex, dec ? 10 : 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** 对应上游 formatPlayTime：秒 → mm:ss */
const formatPlayTime = time => {
  if (time == null || Number.isNaN(time)) return ''
  let m = String(parseInt(time / 60))
  let s = String(parseInt(time % 60))
  return m.padStart(2, '0') + ':' + s.padStart(2, '0')
}

/** 对应上游 sizeFormate：字节 → 可读大小 */
const sizeFormate = size => {
  if (size == null) return ''
  if (size > 1024 * 1024 * 1024) return `${(size / (1024 * 1024 * 1024)).toFixed(2)}GB`
  if (size > 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)}MB`
  if (size > 1024) return `${(size / 1024).toFixed(2)}KB`
  return `${size}B`
}

const formatSinger = rawData => rawData.replace(/&/g, '、')

const formatSingerName = (singers, nameKey = 'name', join = '、') => {
  if (Array.isArray(singers)) {
    const singer = []
    singers.forEach(item => {
      let name = item[nameKey]
      if (!name) return
      singer.push(name)
    })
    return decodeName(singer.join(join))
  }
  return decodeName(String(singers ?? ''))
}

// ---------- HTTP 请求层（对应上游 request.js，needle 语义） ----------

function httpFetch(url, options = {}) {
  const controller = new AbortController()
  const timeoutMs = options.timeout ?? 15_000
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs)
  const headers = { ...(options.headers || {}) }
  let bodyData
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
  const promise = (async () => {
    let res
    try {
      res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: bodyData,
        signal: controller.signal,
        redirect: 'follow',
      })
    } catch (err) {
      const e = new Error(err.name === 'AbortError' ? `request timeout(${timeoutMs}ms): ${url}` : `${err.message}: ${url}`)
      e.cause = err
      throw e
    } finally {
      clearTimeout(timer)
    }
    const raw = Buffer.from(await res.arrayBuffer())
    let body = raw.toString()
    try { body = JSON.parse(body) } catch (_) {}
    const respHeaders = Object.fromEntries(res.headers.entries())
    // fetch 会把多条 set-cookie 合并，这里按 needle 语义恢复成数组
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
    return resp
  })()
  return { promise, cancelHttp: () => controller.abort() }
}

// ---------- 酷我 kw ----------

const kw = {
  limit: 30,
  regExps: {
    mInfo: /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/,
  },
  musicSearch(str, page, limit) {
    return httpFetch(`http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(str)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`).promise
  },
  handleResult(rawData) {
    const result = []
    if (!rawData) return result
    for (let i = 0; i < rawData.length; i++) {
      const info = rawData[i]
      let songId = info.MUSICRID.replace('MUSIC_', '')
      if (!info.N_MINFO) return null
      const types = []
      const _types = {}
      let infoArr = info.N_MINFO.split(';')
      for (let item of infoArr) {
        item = item.match(this.regExps.mInfo)
        if (item) {
          switch (item[2]) {
            case '4000':
              types.push({ type: 'flac24bit', size: item[4] })
              _types.flac24bit = { size: item[4].toLocaleUpperCase() }
              break
            case '2000':
              types.push({ type: 'flac', size: item[4] })
              _types.flac = { size: item[4].toLocaleUpperCase() }
              break
            case '320':
              types.push({ type: '320k', size: item[4] })
              _types['320k'] = { size: item[4].toLocaleUpperCase() }
              break
            case '128':
              types.push({ type: '128k', size: item[4] })
              _types['128k'] = { size: item[4].toLocaleUpperCase() }
              break
          }
        }
      }
      types.reverse()
      let interval = parseInt(info.DURATION)
      result.push({
        name: decodeName(info.SONGNAME),
        singer: formatSinger(decodeName(info.ARTIST)),
        source: 'kw',
        songmid: songId,
        albumId: decodeName(info.ALBUMID || ''),
        interval: Number.isNaN(interval) ? 0 : formatPlayTime(interval),
        _interval: Number.isNaN(interval) ? null : interval,
        albumName: info.ALBUM ? decodeName(info.ALBUM) : '',
        lrc: null,
        img: null,
        types,
        _types,
        typeUrl: {},
      })
    }
    return result
  },
  async search(str, page = 1, limit = this.limit, retryNum = 0) {
    if (retryNum > 2) throw new Error('try max num')
    const { body: result } = await this.musicSearch(str, page, limit)
    if (!result || (result.TOTAL !== '0' && result.SHOW === '0')) return kw.search(str, page, limit, retryNum + 1)
    const list = this.handleResult(result.abslist)
    if (list == null) return kw.search(str, page, limit, retryNum + 1)
    const total = parseInt(result.TOTAL)
    return {
      list,
      allPage: Math.ceil(total / limit),
      total,
      limit,
      source: 'kw',
    }
  },
}

// ---------- 酷狗 kg ----------

const kg = {
  limit: 30,
  musicSearch(str, page, limit) {
    return httpFetch(`https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(str)}&page=${page}&pagesize=${limit}&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`).promise.then(({ body }) => body)
  },
  filterData(rawData) {
    const types = []
    const _types = {}
    if (rawData.FileSize !== 0) {
      types.push({ type: '128k', size: sizeFormate(rawData.FileSize), hash: rawData.FileHash })
      _types['128k'] = { size: sizeFormate(rawData.FileSize), hash: rawData.FileHash }
    }
    if (rawData.HQFileSize !== 0) {
      types.push({ type: '320k', size: sizeFormate(rawData.HQFileSize), hash: rawData.HQFileHash })
      _types['320k'] = { size: sizeFormate(rawData.HQFileSize), hash: rawData.HQFileHash }
    }
    if (rawData.SQFileSize !== 0) {
      types.push({ type: 'flac', size: sizeFormate(rawData.SQFileSize), hash: rawData.SQFileHash })
      _types.flac = { size: sizeFormate(rawData.SQFileSize), hash: rawData.SQFileHash }
    }
    if (rawData.ResFileSize !== 0) {
      types.push({ type: 'flac24bit', size: sizeFormate(rawData.ResFileSize), hash: rawData.ResFileHash })
      _types.flac24bit = { size: sizeFormate(rawData.ResFileSize), hash: rawData.ResFileHash }
    }
    return {
      singer: decodeName(formatSingerName(rawData.Singers, 'name')),
      name: decodeName(rawData.SongName),
      albumName: decodeName(rawData.AlbumName),
      albumId: rawData.AlbumID,
      songmid: rawData.Audioid,
      source: 'kg',
      interval: formatPlayTime(rawData.Duration),
      _interval: rawData.Duration,
      img: null,
      lrc: null,
      hash: rawData.FileHash,
      types,
      _types,
      typeUrl: {},
    }
  },
  handleResult(rawData) {
    let ids = new Set()
    const list = []
    rawData.forEach(item => {
      const key = item.Audioid + item.FileHash
      if (ids.has(key)) return
      ids.add(key)
      list.push(this.filterData(item))
      for (const childItem of item.Grp) {
        const key = item.Audioid + item.FileHash
        if (ids.has(key)) continue
        ids.add(key)
        list.push(this.filterData(childItem))
      }
    })
    return list
  },
  async search(str, page = 1, limit = this.limit, retryNum = 0) {
    if (++retryNum > 3) throw new Error('try max num')
    const result = await this.musicSearch(str, page, limit)
    if (!result || result.error_code !== 0) return kg.search(str, page, limit, retryNum)
    const list = this.handleResult(result.data.lists)
    if (list == null) return kg.search(str, page, limit, retryNum)
    const total = result.data.total
    return {
      list,
      allPage: Math.ceil(total / limit),
      total,
      limit,
      source: 'kg',
    }
  },
}

// ---------- QQ音乐 tx ----------

const PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19]
const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5]
const SCRAMBLE_VALUES = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179]

const zzcSign = text => {
  const hash = crypto.createHash('sha1').update(text).digest('hex')
  const part1 = PART_1_INDEXES.map(idx => hash[idx]).join('')
  const part2 = PART_2_INDEXES.map(idx => hash[idx]).join('')
  const part3 = SCRAMBLE_VALUES.map((value, i) => value ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16))
  const b64Part = Buffer.from(part3).toString('base64').replace(/[\\/+=]/g, '')
  return `zzc${part1}${b64Part}${part2}`.toLowerCase()
}

const tx = {
  limit: 50,
  successCode: 0,
  async musicSearch(str, page, limit, retryNum = 0) {
    if (retryNum > 5) throw new Error('搜索失败')
    const data = {
      comm: {
        ct: '11',
        cv: '14090508',
        v: '14090508',
        tmeAppID: 'qqmusic',
        phonetype: 'EBG-AN10',
        deviceScore: '553.47',
        devicelevel: '50',
        newdevicelevel: '20',
        rom: 'HuaWei/EMOTION/EmotionUI_14.2.0',
        os_ver: '12',
        OpenUDID: '0',
        OpenUDID2: '0',
        QIMEI36: '0',
        udid: '0',
        chid: '0',
        aid: '0',
        oaid: '0',
        taid: '0',
        tid: '0',
        wid: '0',
        uid: '0',
        sid: '0',
        modeSwitch: '6',
        teenMode: '0',
        ui_mode: '2',
        nettype: '1020',
        v4ip: '',
      },
      req: {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicMobile',
        param: {
          search_type: 0,
          searchid: Math.random().toString().slice(2),
          query: str,
          page_num: page,
          num_per_page: limit,
          highlight: 0,
          nqc_flag: 0,
          multi_zhida: 0,
          cat: 2,
          grp: 1,
          sin: 0,
          sem: 0,
        },
      },
    }
    const sign = zzcSign(JSON.stringify(data))
    const { body } = await httpFetch(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, {
      method: 'post',
      headers: {
        'User-Agent': 'QQMusic 14090508(android 12)',
      },
      body: data,
    }).promise
    if (!body || !body.req || body.code != this.successCode || body.req.code != this.successCode) {
      return tx.musicSearch(str, page, limit, retryNum + 1)
    }
    return body.req.data
  },
  handleResult(rawList) {
    if (!rawList || !Array.isArray(rawList)) return []
    const list = []
    rawList.forEach(item => {
      if (!item.file || !item.file.media_mid) return
      let types = []
      let _types = {}
      const file = item.file
      if (file.size_128mp3 != 0) {
        types.push({ type: '128k', size: sizeFormate(file.size_128mp3) })
        _types['128k'] = { size: sizeFormate(file.size_128mp3) }
      }
      if (file.size_320mp3 !== 0) {
        types.push({ type: '320k', size: sizeFormate(file.size_320mp3) })
        _types['320k'] = { size: sizeFormate(file.size_320mp3) }
      }
      if (file.size_flac !== 0) {
        types.push({ type: 'flac', size: sizeFormate(file.size_flac) })
        _types.flac = { size: sizeFormate(file.size_flac) }
      }
      if (file.size_hires !== 0) {
        types.push({ type: 'flac24bit', size: sizeFormate(file.size_hires) })
        _types.flac24bit = { size: sizeFormate(file.size_hires) }
      }
      let albumId = ''
      let albumName = ''
      if (item.album) {
        albumName = item.album.name
        albumId = item.album.mid
      }
      list.push({
        singer: formatSingerName(item.singer, 'name'),
        name: item.title,
        albumName,
        albumId,
        source: 'tx',
        interval: formatPlayTime(item.interval),
        _interval: item.interval,
        songId: item.id,
        albumMid: item.album ? item.album.mid : '',
        strMediaMid: item.file.media_mid,
        songmid: item.mid,
        img: (albumId === '' || albumId === '空')
          ? item.singer && item.singer.length ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg` : ''
          : `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg`,
        types,
        _types,
        typeUrl: {},
      })
    })
    return list
  },
  async search(str, page = 1, limit = this.limit) {
    const data = await this.musicSearch(str, page, limit)
    const list = this.handleResult(data.body.item_song)
    const total = data.meta.estimate_sum
    return {
      list,
      allPage: Math.ceil(total / limit),
      total,
      limit,
      source: 'tx',
    }
  },
}

// ---------- 网易云 wy ----------

const wyIv = Buffer.from('0102030405060708')
const presetKey = Buffer.from('0CoJUm6Qyw8W8jud')
const linuxapiKey = Buffer.from('rFgB&h#%2?^eDg:Q')
const base62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const wyPublicKey = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----'
const eapiKey = 'e82ckenh8dichen8'

const aesEncrypt = (buffer, mode, key, iv) => {
  const cipher = createCipheriv(mode, key, iv)
  return Buffer.concat([cipher.update(buffer), cipher.final()])
}

const eapi = (url, object) => {
  const text = typeof object === 'object' ? JSON.stringify(object) : object
  const message = `nobody${url}use${text}md5forencrypt`
  const digest = createHash('md5').update(message).digest('hex')
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  return {
    params: aesEncrypt(Buffer.from(data), 'aes-128-ecb', eapiKey, '').toString('hex').toUpperCase(),
  }
}

const eapiRequest = (url, data) => httpFetch('http://interface.music.163.com/eapi/batch', {
  method: 'post',
  headers: {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
    origin: 'https://music.163.com',
  },
  form: eapi(url, data),
})

const wy = {
  limit: 30,
  musicSearch(str, page, limit) {
    return eapiRequest('/api/search/song/list/page', {
      keyword: str,
      needCorrect: '1',
      channel: 'typing',
      offset: limit * (page - 1),
      scene: 'normal',
      total: page == 1,
      limit,
    }).promise.then(({ body }) => body)
  },
  getSinger(singers) {
    let arr = []
    singers.forEach(singer => {
      arr.push(singer.name)
    })
    return arr.join('、')
  },
  handleResult(rawList) {
    if (!rawList) return []
    return rawList.map(item => {
      item = item.baseInfo.simpleSongData
      const types = []
      const _types = {}
      let size
      if (item.privilege.maxBrLevel == 'hires') {
        size = item.hr ? sizeFormate(item.hr.size) : null
        types.push({ type: 'flac24bit', size })
        _types.flac24bit = { size }
      }
      switch (item.privilege.maxbr) {
        case 999000:
          size = item.sq ? sizeFormate(item.sq.size) : null
          types.push({ type: 'flac', size })
          _types.flac = { size }
        case 320000:
          size = item.h ? sizeFormate(item.h.size) : null
          types.push({ type: '320k', size })
          _types['320k'] = { size }
        case 192000:
        case 128000:
          size = item.l ? sizeFormate(item.l.size) : null
          types.push({ type: '128k', size })
          _types['128k'] = { size }
      }
      types.reverse()
      return {
        singer: this.getSinger(item.ar),
        name: item.name,
        albumName: item.al.name,
        albumId: item.al.id,
        source: 'wy',
        interval: formatPlayTime(item.dt / 1000),
        _interval: Math.round(item.dt / 1000),
        songmid: item.id,
        img: item.al.picUrl,
        lrc: null,
        types,
        _types,
        typeUrl: {},
      }
    })
  },
  async search(str, page = 1, limit = this.limit, retryNum = 0) {
    if (++retryNum > 3) throw new Error('try max num')
    const result = await this.musicSearch(str, page, limit)
    if (!result || result.code !== 200) return wy.search(str, page, limit, retryNum)
    const list = this.handleResult(result.data.resources || [])
    if (list == null) return wy.search(str, page, limit, retryNum)
    const total = result.data.totalCount || 0
    return {
      list,
      allPage: Math.ceil(total / limit),
      total,
      limit,
      source: 'wy',
    }
  },
}

// ---------- 咪咕 mg ----------

const createSignature = (time, str) => {
  const deviceId = '963B7AA0D21511ED807EE5846EC87D20'
  const signatureMd5 = '6cdc72a439cef99a3418d2a78aa28c73'
  const sign = toMD5(`${str}${signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`)
  return { sign, deviceId }
}

const mg = {
  limit: 20,
  musicSearch(str, page, limit) {
    const time = Date.now().toString()
    const signData = createSignature(time, str)
    return httpFetch(`https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(str)}&pageNo=${page}&sort=0&sid=USS`, {
      headers: {
        uiVersion: 'A_music_3.6.1',
        deviceId: signData.deviceId,
        timestamp: time,
        sign: signData.sign,
        channel: '0146921',
        'User-Agent': 'Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
      },
    }).promise.then(({ body }) => body)
  },
  filterData(rawData) {
    const list = []
    const ids = new Set()
    rawData.forEach(item => {
      item.forEach(data => {
        if (!data.songId || !data.copyrightId || ids.has(data.copyrightId)) return
        ids.add(data.copyrightId)
        const types = []
        const _types = {}
        data.audioFormats && data.audioFormats.forEach(type => {
          let size
          switch (type.formatType) {
            case 'PQ':
              size = sizeFormate(type.asize ?? type.isize)
              types.push({ type: '128k', size })
              _types['128k'] = { size }
              break
            case 'HQ':
              size = sizeFormate(type.asize ?? type.isize)
              types.push({ type: '320k', size })
              _types['320k'] = { size }
              break
            case 'SQ':
              size = sizeFormate(type.asize ?? type.isize)
              types.push({ type: 'flac', size })
              _types.flac = { size }
              break
            case 'ZQ24':
              size = sizeFormate(type.asize ?? type.isize)
              types.push({ type: 'flac24bit', size })
              _types.flac24bit = { size }
              break
          }
        })
        let img = data.img3 || data.img2 || data.img1 || null
        if (img && !/https?:/.test(img)) img = 'http://d.musicapp.migu.cn' + img
        list.push({
          singer: formatSingerName(data.singerList),
          name: data.name,
          albumName: data.album,
          albumId: data.albumId,
          songmid: data.songId,
          copyrightId: data.copyrightId,
          source: 'mg',
          interval: formatPlayTime(data.duration),
          _interval: data.duration,
          img,
          lrc: null,
          lrcUrl: data.lrcUrl,
          mrcUrl: data.mrcurl,
          trcUrl: data.trcUrl,
          types,
          _types,
          typeUrl: {},
        })
      })
    })
    return list
  },
  async search(str, page = 1, limit = this.limit, retryNum = 0) {
    if (++retryNum > 3) throw new Error('try max num')
    const result = await this.musicSearch(str, page, limit)
    if (!result || result.code !== '000000') throw new Error(result ? result.info : '搜索失败')
    const songResultData = result.songResultData || { resultList: [], totalCount: 0 }
    const list = this.filterData(songResultData.resultList)
    if (list == null) return mg.search(str, page, limit, retryNum)
    const total = parseInt(songResultData.totalCount)
    return {
      list,
      allPage: Math.ceil(total / limit),
      total,
      limit,
      source: 'mg',
    }
  },
}

const PLATFORMS = { kw, kg, tx, wy, mg }

module.exports = { PLATFORMS, httpFetch, decodeName, formatPlayTime, sizeFormate, toMD5 }
