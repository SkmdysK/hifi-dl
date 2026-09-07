'use strict'
/** 歌名/歌手/时长 匹配打分，用于从搜索结果中选出最像目标歌曲的候选 */

const PUNCT_RE = /[·・,，、&&\/\\|;；:：'’"“”\-—_…~!！?？.。*★☆【】\[\]()（）《》〈〉<>+\s]/g

/** 归一化：去标点、去空白、小写（用于比较） */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(PUNCT_RE, '')
}

/** 去掉括号及内容（(Live)、feat. 等），用于辅助比较 */
function stripBrackets(s) {
  return String(s || '')
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/(\s*feat\.?\s*.+)$/i, '')
    .trim()
}

/** 字符串包含关系：a 是否包含 b（归一化后） */
function contains(a, b) {
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb) return false
  return na.includes(nb) || nb.includes(na)
}

function tokens(s) {
  const n = normalize(s)
  // 中文按字切，英文按词切
  return n.split(/([a-z0-9]+)/).filter(Boolean).map(seg => (/^[a-z0-9]+$/.test(seg) ? seg : seg.split(''))).flat()
}

/** token 重叠比例（Jaccard） */
function tokenOverlap(a, b) {
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / Math.max(ta.size, tb.size)
}

/** 艺术家匹配得分 0~30 */
function artistScore(targetArtists, candSinger) {
  if (!targetArtists.length || !candSinger) return 0
  let score = 0
  for (const ta of targetArtists) {
    if (contains(ta, candSinger)) return 30 // 互相包含
    if (tokenOverlap(ta, candSinger) > 0.5) score = Math.max(score, 15)
  }
  return score
}

/**
 * 对候选打分（0~160）
 * @param target {name, artist, album, duration}
 * @param cand 搜索结果条目（有 name/singer/albumName/interval/_interval）
 */
function scoreCandidate(target, cand) {
  const tName = normalize(target.name)
  const cName = normalize(cand.name)
  if (!tName || !cName) return 0

  // 歌名 0~100
  let nameScore = 0
  if (tName === cName) {
    nameScore = 100
  } else {
    const tStripped = normalize(stripBrackets(target.name))
    const cStripped = normalize(stripBrackets(cand.name))
    if (tStripped && tStripped === cStripped) {
      nameScore = 95
    } else if (tName.includes(cName) || cName.includes(tName)) {
      nameScore = 70 + Math.round((Math.min(tName.length, cName.length) / Math.max(tName.length, cName.length)) * 20)
    } else {
      const ov = tokenOverlap(tName, cName)
      nameScore = Math.round(ov * 60)
    }
  }

  // 艺人 0~30（多歌手：Apple Music 里分隔符为 &、,、/ 或 feat.）
  const targetArtists = target.artist
    ? String(target.artist).split(/[&,]|\bfeat\.?\b|\//i).map(s => s.trim()).filter(Boolean)
    : []
  const aScore = artistScore(targetArtists, cand.singer)

  // 时长 0~20（搜索结果的 _interval 为秒）
  let dScore = 0
  const cDur = cand._interval ?? cand.interval
  if (target.duration && cDur != null && !Number.isNaN(cDur)) {
    const diff = Math.abs(target.duration - cDur)
    if (diff <= 2) dScore = 20
    else if (diff <= 5) dScore = 10
    else if (diff <= 15) dScore = 0
    else dScore = -20
  }

  // 专辑名 0~10
  let alScore = 0
  if (target.album && cand.albumName && normalize(target.album) === normalize(cand.albumName)) alScore = 10

  return { total: nameScore + aScore + dScore + alScore, nameScore, aScore, dScore, alScore }
}

/** 该分数是否可接受为匹配结果 */
const ACCEPT_THRESHOLD = 75

module.exports = { scoreCandidate, normalize, ACCEPT_THRESHOLD }
