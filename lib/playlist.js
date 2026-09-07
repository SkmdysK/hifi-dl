'use strict'
const fs = require('fs')

/**
 * 解析 Apple Music 导出的歌单文件（Ll.txt）
 *
 * 格式特点（实测）：
 * - UTF-16LE 编码（BOM: FF FE），整文件只有行尾一个 \n
 * - 每条记录以 \r 分隔；表头 31 列，歌曲记录 30 列（无"位置"列）
 * - 列分隔符为 \t
 * 歌曲字段顺序：名称 艺人 作曲者 专辑 归类 作品 乐章编号 乐章数 乐章名称
 *   类型 大小 时长 光盘编号 光盘统计 音轨编号 音轨统计 年份 修改日期 添加日期
 *   位速率 采样速率 音量调整 种类 均衡器 注释 播放次数 上次播放时间 跳过次数
 *   上次跳过时间 我的评分
 */
function parsePlaylist(filePath) {
  const raw = fs.readFileSync(filePath)
  let text
  if (raw[0] === 0xff && raw[1] === 0xfe) {
    text = raw.subarray(2).toString('utf16le') // UTF-16LE
  } else if (raw[0] === 0xfe && raw[1] === 0xff) {
    const swapped = Buffer.alloc(raw.length - 2)
    for (let i = 2; i + 1 < raw.length; i += 2) {
      swapped[i - 2] = raw[i + 1]
      swapped[i - 1] = raw[i]
    }
    text = swapped.toString('utf16le') // UTF-16BE
  } else {
    text = raw.toString('utf8')
  }
  text = text.replace(/[\r\n]+$/, '')

  const records = text.split('\r')
  const songs = []
  for (const rec of records) {
    if (!rec.trim()) continue
    const f = rec.split('\t')
    if (f.length < 12) continue
    if (f[0] === '名称') continue // 表头
    const duration = parseInt(f[11], 10)
    songs.push({
      name: f[0].trim(),
      artist: (f[1] || '').trim(),
      composer: (f[2] || '').trim(),
      album: (f[3] || '').trim(),
      genre: (f[9] || '').trim(),
      duration: Number.isFinite(duration) ? duration : null,
      trackNo: f[14],
      trackCount: f[15],
      year: f[16],
      bitrate: f[19],
      sampleRate: f[20],
      kind: f[22],
    })
  }
  return songs
}

module.exports = { parsePlaylist }
