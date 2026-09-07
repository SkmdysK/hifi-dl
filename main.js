#!/usr/bin/env node
'use strict'
const path = require('path')
const os = require('os')
const { Downloader } = require('./lib/downloader')
const { parseOnlinePlaylist } = require('./lib/online-playlist')

function parseArgs(argv) {
  const opts = {
    // 默认输出目录：文稿(Documents)/music
    outDir: path.join(os.homedir(), 'Documents', 'music'),
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    const val = () => { i++; return next }
    switch (arg) {
      case '--playlist': opts.playlist = val(); break
      case '--playlist-url': opts.playlistUrl = val(); break
      case '--sources': opts.sources = val(); break
      case '--out': opts.outDir = val(); break
      case '--limit': opts.limit = parseInt(val(), 10); break
      case '--quality': opts.quality = val(); break
      case '--concurrency': opts.concurrency = parseInt(val(), 10); break
      case '--source-order': opts.sourceOrder = val(); break
      case '--threshold': opts.threshold = parseInt(val(), 10); break
      case '--force': opts.force = true; break
      case '--skip-update': opts.skipUpdate = true; break
      case '--quiet': opts.quiet = true; break
      case '-h':
      case '--help':
        console.log(`用法: node main.js [选项]

  基于 LX Music 自定义音源批量下载歌单中的歌曲（默认最高音质）

选项:
  --playlist <file>      歌单文件（默认 ./Ll.txt）
  --playlist-url <url>   在线歌单链接（支持酷狗、网易云、QQ 音乐、Apple Music）
  --sources <file>       音源列表文件（默认 ./lxmusic.txt）
  --out <dir>            下载输出目录（默认 ~/Documents/music）
  --limit <n>            只处理前 n 首（用于测试）
  --quality <q>          指定音质: flac24bit|flac|320k|128k|best（默认 best=从高到低尝试）
  --source-order <list>  搜索平台优先级（默认 kw,kg,tx,wy,mg）
  --concurrency <n>      并发数（默认 3）
  --threshold <n>        匹配分数阈值 0-160（默认 75）
  --force                覆盖已存在的文件
  --skip-update          不重新下载音源脚本（使用本地缓存）
  --quiet                只输出结果摘要
`)
        process.exit(0)
      default:
        if (arg.startsWith('-')) {
          console.error(`未知参数: ${arg}`)
          process.exit(1)
        }
    }
  }
  return opts
}

// 第三方音源脚本行为不可控，兜底防止单脚本异常终止整个任务
process.on('uncaughtException', err => console.error('[uncaughtException]', err.message))
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err && err.message))

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const downloader = new Downloader({ ...opts, workDir: __dirname })
  let runOpts
  if (opts.playlistUrl) {
    const playlist = await parseOnlinePlaylist(opts.playlistUrl)
    const songs = playlist.songs.map((song, idx) => ({ ...song, idx }))
    console.log(`\n== ${playlist.platformName}${playlist.title ? `：${playlist.title}` : ''} ==`)
    console.log(`歌单解析完成: 共 ${songs.length} 首歌`)
    runOpts = { songs }
  }
  const report = await downloader.run(runOpts)
  const summary = report.summary
  const failed = (summary.failed || 0) + (summary.no_match || 0) + (summary.no_url || 0)
  if (failed > 0 && summary.downloaded > 0) process.exitCode = 0 // 部分失败不算异常退出
  else if (summary.downloaded == null) process.exitCode = 1
}

main().catch(err => {
  console.error('运行失败:', err)
  process.exit(1)
})
