const test = require('node:test')
const assert = require('node:assert/strict')
const {
  detectPlaylistPlatform,
  parseOnlinePlaylist,
  normalizeNeteaseTrack,
  normalizeQqTrack,
  normalizeKugouSong,
  normalizeAppleTrack,
  kugouGatewayUrl,
  kugouOfficialInfoUrl,
  kugouOfficialSongsUrl,
} = require('../lib/online-playlist')

function response(body, url, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    async text() { return typeof body === 'string' ? body : JSON.stringify(body) },
    async json() { return typeof body === 'string' ? JSON.parse(body) : body },
  }
}

test('识别示例文件中的三种在线歌单平台', () => {
  assert.equal(detectPlaylistPlatform('https://t1.kugou.com/1okgp24G5V2'), 'kugou')
  assert.equal(detectPlaylistPlatform('https://163cn.tv/bfMmRPf8'), 'netease')
  assert.equal(detectPlaylistPlatform('https://y.qq.com/n/ryqq/playlist/123456.html'), 'qq')
  assert.equal(detectPlaylistPlatform('https://i.y.qq.com/n2/m/share/details/taoge.html?id=123456'), 'qq')
  assert.equal(detectPlaylistPlatform('https://music.apple.com/cn/playlist/demo/pl.abc123'), 'apple')
})

test('统一转换三种平台歌曲字段', () => {
  assert.deepEqual(normalizeNeteaseTrack({
    id: 1,
    name: '歌曲',
    ar: [{ name: '歌手一' }, { name: '歌手二' }],
    al: { name: '专辑' },
    dt: 201000,
  }), { name: '歌曲', artist: '歌手一、歌手二', album: '专辑', duration: 201, source: 'netease' })
  assert.equal(normalizeNeteaseTrack({ name: '秒数兼容', artists: [], album: {}, duration: 204000 }).duration, 204)
  assert.deepEqual(normalizeQqTrack({
    title: '歌曲', singer: [{ name: '歌手一' }, { name: '歌手二' }], album: { name: '专辑' }, interval: 204,
  }), { name: '歌曲', artist: '歌手一、歌手二', album: '专辑', duration: 204, source: 'qq' })
  assert.deepEqual(normalizeKugouSong({
    songname: '歌曲', singername: '歌手', album_name: '专辑', timelength: 202000,
  }), { name: '歌曲', artist: '歌手', album: '专辑', duration: 202, source: 'kugou' })
  assert.deepEqual(normalizeAppleTrack({
    attributes: { name: '歌曲', artistName: '歌手', albumName: '专辑', durationInMillis: 203000 },
  }), { name: '歌曲', artist: '歌手', album: '专辑', duration: 203, source: 'apple' })
})

test('解析网易云短链并读取公开歌单', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url === 'https://163cn.tv/bfMmRPf8') return response('', 'https://music.163.com/#/playlist?id=123456')
    assert.match(url, /music\.163\.com\/api\/v6\/playlist\/detail\?id=123456/)
    return response({ code: 200, playlist: {
      name: '测试歌单', tracks: [{ name: '歌曲', ar: [{ name: '歌手' }], al: { name: '专辑' }, dt: 180000 }],
    } }, url)
  }
  const result = await parseOnlinePlaylist('https://163cn.tv/bfMmRPf8', { fetchImpl })
  assert.equal(result.platform, 'netease')
  assert.equal(result.title, '测试歌单')
  assert.deepEqual(result.songs[0], { name: '歌曲', artist: '歌手', album: '专辑', duration: 180, source: 'netease' })
  assert.equal(calls.length, 2)
})

test('按 LX Music 官方流程解析酷狗短码歌单', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    if (url === 'https://t1.kugou.com/1okgp24G5V2') return response('', url)
    if (url === 'https://t.kugou.com/command/') {
      assert.equal(options.method, 'POST')
      assert.equal(options.headers['Content-Type'], 'application/json')
      assert.deepEqual(JSON.parse(options.body).data, '1okgp24G5V2')
      return response({ status: 1, info: { type: 2, global_collection_id: 'gcid_test123' } }, url)
    }
    if (url.startsWith('https://t.kugou.com/v1/songlist/batch_decode?')) {
      assert.equal(options.method, 'POST')
      return response({ status: 1, data: { list: [{ global_collection_id: 'collection_3_123456_1_0' }] } }, url)
    }
    if (url.startsWith('https://mobiles.kugou.com/api/v5/special/info_v2?')) {
      return response('callback(' + JSON.stringify({ status: 1, data: { specialname: '官方歌单', songcount: 1 } }) + ');', url)
    }
    if (url.startsWith('https://mobiles.kugou.com/api/v5/special/song_v2?')) {
      return response('callback(' + JSON.stringify({ status: 1, data: { info: [{ songname: '歌曲', singername: '歌手', album_name: '专辑', timelength: 181000 }] } }) + ');', url)
    }
    throw new Error('unexpected request: ' + url)
  }
  const result = await parseOnlinePlaylist('https://t1.kugou.com/1okgp24G5V2', { fetchImpl })
  assert.equal(result.platform, 'kugou')
  assert.equal(result.title, '官方歌单')
  assert.deepEqual(result.songs[0], { name: '歌曲', artist: '歌手', album: '专辑', duration: 181, source: 'kugou' })
  assert.equal(calls.length, 5)
})

test('酷狗兼容旧版 collection 接口', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://t1.kugou.com/1okgp24G5V2') return response('global_collection_id="collection_3_123456_1_0"', url)
    if (url.startsWith('https://pubsongscdn.kugou.com/v2/get_other_list_file?')) {
      const parsed = new URL(url)
      assert.equal(parsed.searchParams.get('global_collection_id'), 'collection_3_123456_1_0')
      assert.match(parsed.searchParams.get('signature'), /^[a-f0-9]{32}$/)
      return response({ data: { count: 1, info: [{ songname: '歌曲', singername: '歌手', album_name: '专辑', timelength: 181000 }] } }, url)
    }
    throw new Error('unexpected request')
  }
  const result = await parseOnlinePlaylist('https://t1.kugou.com/1okgp24G5V2', { fetchImpl })
  assert.equal(result.platform, 'kugou')
  assert.deepEqual(result.songs[0], { name: '歌曲', artist: '歌手', album: '专辑', duration: 181, source: 'kugou' })
})

test('解析 QQ 音乐公开歌单及分享页 id', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url === 'https://i.y.qq.com/n2/m/share/details/taoge.html?id=123456') return response('', 'https://i.y.qq.com/n2/m/share/details/taoge.html?id=123456')
    assert.match(url, /qzone\/fcg-bin\/fcg_ucc_getcdinfo_byids_cp\.fcg\?/)
    const parsed = new URL(url)
    assert.equal(parsed.searchParams.get('disstid'), '123456')
    return response('MusicJsonCallback(' + JSON.stringify({ code: 0, cdlist: [{ dissname: 'QQ 歌单', songlist: [
      { title: '歌曲', singer: [{ name: '歌手' }], album: { name: '专辑' }, interval: 205 },
    ] }] }) + ')', url)
  }
  const result = await parseOnlinePlaylist('https://i.y.qq.com/n2/m/share/details/taoge.html?id=123456', { fetchImpl })
  assert.equal(result.platform, 'qq')
  assert.equal(result.title, 'QQ 歌单')
  assert.deepEqual(result.songs[0], { name: '歌曲', artist: '歌手', album: '专辑', duration: 205, source: 'qq' })
  assert.equal(calls.length, 2)
})

test('生成酷狗新版歌单接口及稳定签名', () => {
  const endpoint = kugouGatewayUrl('collection_3_123456_1_0', 1)
  assert.match(endpoint, /^https:\/\/pubsongscdn\.kugou\.com\/v2\/get_other_list_file\?/)
  assert.match(endpoint, /signature=[a-f0-9]{32}/)
})

test('生成酷狗官方 info/song 接口', () => {
  assert.match(kugouOfficialInfoUrl('collection_3_123456_1_0'), /signature=[a-f0-9]{32}/)
  assert.match(kugouOfficialSongsUrl('collection_3_123456_1_0', 1, 300), /page=1/)
  assert.match(kugouOfficialSongsUrl('collection_3_123456_1_0', 1, 300), /pagesize=300/)
})

test('解析 Apple Music 页面内嵌公开数据', async () => {
  const html = '<title>测试歌单 - Apple Music</title><script type="application/ld+json">' + JSON.stringify({ itemListElement: [
    { name: '歌曲', artist: '歌手', albumName: '专辑', duration: 182 },
  ] }) + '</script>'
  const fetchImpl = async (url) => response(html, url)
  const result = await parseOnlinePlaylist('https://music.apple.com/cn/playlist/demo/pl.abc123', { fetchImpl })
  assert.equal(result.platform, 'apple')
  assert.equal(result.title, '测试歌单')
  assert.deepEqual(result.songs[0], { name: '歌曲', artist: '歌手', album: '专辑', duration: 182, source: 'apple' })
})
