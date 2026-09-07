'use strict'
/**
 * 音频标签写入（零依赖实现）：
 * - mp3  → ID3v2.3（TIT2/TPE1/TALB/APIC 封面/USLT 歌词，UTF-16 编码）
 * - flac → VORBIS_COMMENT（TITLE/ARTIST/ALBUM/LYRICS）+ PICTURE 封面块
 * 写入失败一律抛错，由调用方兜底（不影响已下载的音频文件本身）。
 */

const fs = require('fs')

// ---------- ID3v2.3（mp3） ----------

function syncsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
}

function id3Frame(id, body) {
  const head = Buffer.alloc(10)
  head.write(id, 0, 'latin1')
  head.writeUInt32BE(body.length, 4) // v2.3 用普通整数表示帧长
  return Buffer.concat([head, body])
}

const utf16 = text => Buffer.concat([Buffer.from([1]), Buffer.from('\ufeff' + text + '\0', 'utf16le')])

function id3Tag({ title, artist, album, cover, coverMime, lyric }) {
  const frames = []
  if (title) frames.push(id3Frame('TIT2', utf16(title)))
  if (artist) frames.push(id3Frame('TPE1', utf16(artist)))
  if (album) frames.push(id3Frame('TALB', utf16(album)))
  if (cover) {
    const body = Buffer.concat([
      Buffer.from([0]), // 编码：ISO-8859-1
      Buffer.from(`${coverMime}\0`, 'latin1'),
      Buffer.from([3]), // 图片类型：正面封面
      Buffer.from([0]), // 描述：空
      cover,
    ])
    frames.push(id3Frame('APIC', body))
  }
  if (lyric) {
    const body = Buffer.concat([
      Buffer.from([1]), // 编码：UTF-16
      Buffer.from('chi', 'latin1'), // 语言
      Buffer.from('\ufeff\0', 'utf16le'), // 描述：空（UTF-16 终止符）
      Buffer.from('\ufeff' + lyric, 'utf16le'),
    ])
    frames.push(id3Frame('USLT', body))
  }
  const padding = Buffer.alloc(512)
  const body = Buffer.concat([...frames, padding])
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), syncsafe(body.length), body])
}

function writeMp3Tags(filePath, tags) {
  const buf = fs.readFileSync(filePath)
  let audioStart = 0
  // 跳过已有 ID3v2 标签
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const size = (buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f)
    audioStart = 10 + size
  }
  const tag = id3Tag(tags)
  fs.writeFileSync(filePath, Buffer.concat([tag, buf.slice(audioStart)]))
}

// ---------- FLAC ----------

function vorbisCommentBlock({ title, artist, album, lyric }, withPicture) {
  const entries = []
  if (title) entries.push(`TITLE=${title}`)
  if (artist) entries.push(`ARTIST=${artist}`)
  if (album) entries.push(`ALBUM=${album}`)
  if (lyric) entries.push(`LYRICS=${lyric}`)
  const vendor = Buffer.from('HiFi-DL', 'utf8')
  const vendorLen = Buffer.alloc(4)
  vendorLen.writeUInt32LE(vendor.length)
  const parts = [vendorLen, vendor]
  const count = Buffer.alloc(4)
  count.writeUInt32LE(entries.length)
  parts.push(count)
  for (const e of entries) {
    const b = Buffer.from(e, 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32LE(b.length)
    parts.push(len, b)
  }
  return Buffer.concat(parts)
}

function pictureBlock(cover, coverMime) {
  const mime = Buffer.from(coverMime, 'latin1')
  const head = Buffer.alloc(4 + 4 + mime.length + 4 + 16 + 4)
  let off = 0
  head.writeUInt32BE(3, off); off += 4 // 图片类型：正面封面
  head.writeUInt32BE(mime.length, off); off += 4
  mime.copy(head, off); off += mime.length
  head.writeUInt32BE(0, off); off += 4 // 描述长度
  off += 16 // 宽/高/色深/色彩数：0
  head.writeUInt32BE(cover.length, off)
  return Buffer.concat([head, cover])
}

function flacBlock(type, body, isLast) {
  const header = Buffer.alloc(4)
  header[0] = (isLast ? 0x80 : 0) | type
  header[1] = body.length >> 16 & 0xff
  header[2] = body.length >> 8 & 0xff
  header[3] = body.length & 0xff
  return Buffer.concat([header, body])
}

function writeFlacTags(filePath, tags) {
  const buf = fs.readFileSync(filePath)
  if (buf.toString('ascii', 0, 4) !== 'fLaC') throw new Error('不是有效的 FLAC 文件')
  // 解析元数据块链，只保留 STREAMINFO，其余重建
  let pos = 4
  let streamInfo = null
  while (pos < buf.length) {
    const header = buf[pos]
    const isLast = (header & 0x80) !== 0
    const type = header & 0x7f
    const len = buf.readUIntBE(pos + 1, 3)
    if (type === 0) streamInfo = buf.slice(pos + 4, pos + 4 + len)
    pos += 4 + len
    if (isLast) break
  }
  if (!streamInfo) throw new Error('FLAC 缺少 STREAMINFO 块')
  const comment = flacBlock(4, vorbisCommentBlock(tags, !!tags.cover), !tags.cover)
  const blocks = tags.cover
    ? Buffer.concat([comment, flacBlock(6, pictureBlock(tags.cover, tags.coverMime), true)])
    : comment
  fs.writeFileSync(filePath, Buffer.concat([Buffer.from('fLaC'), flacBlock(0, streamInfo, false), blocks, buf.slice(pos)]))
}

/** 按扩展名写入标签：{ title, artist, album, lyric, cover(Buffer), coverMime } */
async function writeTags(filePath, tags) {
  const ext = filePath.toLowerCase().endsWith('.flac') ? 'flac' : 'mp3'
  if (ext === 'flac') return writeFlacTags(filePath, tags)
  return writeMp3Tags(filePath, tags)
}

module.exports = { writeTags }
