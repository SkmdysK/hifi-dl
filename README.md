<div align="center">

# HiFi-DL · 音乐下载器

**简体中文** | [English](README_EN.md)

本地运行的手账风格音乐批量下载器：LX 多音源聚合搜索与下载 · Qobuz 无损 / Hi-Res 下载 · 在线歌单解析 · 歌词与封面内嵌 · 下载历史

</div>

> [!WARNING]
> ### 免责声明
> - 本项目基于 [qobuz-dlp](https://github.com/infojunkie/qobuz-dlp.py) 与 [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) 的开源代码开发，**不内置、不提供、不分发任何音源脚本或音乐下载链接**，全部内容均来源于网络，由使用者自行配置。
> - 本项目仅供学习与研究使用，严禁用于商业用途。下载内容的版权归原平台及版权方所有，请在 24 小时内自行删除，使用本项目产生的一切法律责任由使用者自行承担。
> - 使用本项目即表示你已阅读并同意上述条款。如有侵权，请联系删除。

---

## 📦 版本下载

前往 [Releases](https://github.com/SkmdysK/hifi-dl/releases) 下载对应平台的最新版本：

| 版本 | 文件 | 说明 |
|---|---|---|
| **macOS** | `HiFi-DL-mac-arm64-1.0.0.dmg` | 适用于 Apple Silicon（M1 – M4）；打开 dmg，将 App 拖入「Applications」即可 |
| **Windows** | `HiFi-DL-win-x64-1.0.0.zip` | 适用于 Windows 10/11 x64；解压后双击 `HiFi-DL.exe`，免安装绿色版 |
| **网页版（源码）** | `HiFi-DL-web-1.0.0.zip` | 适合想以网页方式运行或二次开发的用户；解压后执行 `node server.js` 启动 |

> [!TIP]
> - 三个版本界面与功能完全一致，各自数据相互独立、互不影响。
> - macOS / Windows 版内置 Node 运行时，**无需安装 Node.js**；仅 Qobuz 功能需要系统安装 Python 3.10+。
> - 应用未做代码签名：**macOS** 首次打开请右键 → 打开；**Windows** 遇到 SmartScreen 提示请选择「更多信息 → 仍要运行」。
> - 也可以直接克隆本仓库源码运行：`node server.js`（需 Node.js ≥ 20）。

---

## ✨ 功能特性

### 我的歌单
- 解析公开歌单链接：酷狗 / 网易云 / QQ 音乐 / Apple Music
- 支持拖入或选择 Apple Music 导出的 .txt 歌单
- **多歌单管理**：按名字保存任意多个歌单，重启不丢失，点击即可打开

### 歌单综合下载
- LX 与 Qobuz 双引擎，可设置优先级，互为备选自动回退
- 逐首实时进度、失败列表、一键重试

### LX 搜索
- 酷我 / 酷狗 / QQ 音乐 / 网易云 / 咪咕 五通道并行聚合，或单通道精确搜索
- 多线程分段下载（大文件自动 4 段并发）
- 可选：.lrc 歌词文件、封面与歌词内嵌到音频、按歌单分组保存、文件命名模板、下载代理

### Qobuz 搜索与下载
- 单曲 / 专辑搜索；支持粘贴 Qobuz 专辑、歌单、单曲、歌手、厂牌链接以及 last.fm 歌单链接批量入队
- 音质四档：MP3 320k / 无损 16bit / Hi-Res 24bit ≤96kHz / Hi-Res 最高
- 专辑封面内嵌到每一首歌；本地去重；保存结构（专辑文件夹 / 平铺）与文件命名可配置

### 其他
- 三条独立下载队列（歌单综合 / LX / Qobuz），支持暂停、继续、取消
- **下载记录**：按来源筛选查看历史，可一键清空（设置中可关闭）
- **中英双语界面**，首次打开自动跟随系统语言
- 手账风格界面，内置手写字体，无需联网加载

## 🖥 环境要求

| 平台 | LX 搜索/下载 | Qobuz 下载 |
|---|---|---|
| macOS | ✅ | ✅ |
| Windows | ✅ | ✅ |

- **Node.js ≥ 20**（必需）：[nodejs.org](https://nodejs.org/) 下载安装即可，无需 `npm install`
- **Python 3.10+**（仅 Qobuz 功能需要）：[python.org](https://www.python.org/downloads/) 安装时勾选 *Add to PATH*；其余 Python 依赖已内置，无需 pip install
- Qobuz 下载需要你自己的 **Qobuz Studio 订阅账号**

## 🚀 快速开始

```bash
# macOS：双击「start.command」，或命令行：
node server.js          # 浏览器自动打开 http://127.0.0.1:8978

# Windows：双击「start.bat」；停止运行「stop.bat」
```

停止服务：双击「stop.command」（或页面右上角「退出服务」）。

## 📖 使用说明

### 首次使用：添加音源（重要）

出于版权考虑，本项目**不内置任何音源**。使用 LX 下载前，请自行获取 LX Music 音源脚本，并在 **设置 → LX Music → 音乐源** 中导入（每行一个音源脚本 URL）。

- 未添加音源时：搜索功能可用，下载会提示缺少音源
- 音源脚本可通过搜索引擎以「LX Music 音源」等关键词自行查找

### Qobuz 首次使用

1. 确认网络可访问 Qobuz（软件会自动读取 macOS 系统代理；Windows 可在设置中配置代理）
2. 设置 → Qobuz → 「打开 Qobuz 登录」，在浏览器中完成登录（凭据仅保存在你本机）
3. 之后即可搜索、粘贴链接批量下载

Qobuz 的应用配置（config.ini，仅含应用注册信息，不含任何账号凭据）已内置，首次使用会自动安装到用户目录。

### 各页签说明

| 页签 | 说明 |
|---|---|
| 我的歌单 | 导入 / 保存 / 打开歌单，勾选后批量下载 |
| 下载中 | 三条队列的实时进度，暂停 / 继续 / 取消选中 |
| LX 搜索 | 可选通道，搜索结果直接下载 |
| Qobuz 搜索 | 单曲 / 专辑切换，贴链接批量入队 |
| 需要重试 | 失败歌曲汇总，一键重试 |
| 下载记录 | 全部下载历史，按来源筛选 |
| 下载设置 | 语言、保存位置、优先级、音质、并发、分页、LX / Qobuz 详细设置 |

## ⚙️ 设置概览

- **通用**：保存位置、歌单下载优先级、音乐品质、同时下载数、列表每页条数（20/50/100）、下载记录开关、界面语言
- **LX Music**：音源管理、文件命名模板（`{歌手}` `{歌名}` `{专辑}` `{序号}`）、按歌单分组、.lrc 歌词、封面 / 歌词内嵌、下载代理
- **Qobuz**：登录、音质、保存结构（专辑文件夹 / 平铺）、文件命名、封面内嵌、去重

## 📁 目录结构

```
HiFi-DL/
├─ server.js / main.js           服务端 / 命令行入口（零 npm 依赖）
├─ web/                          前端页面（内置字体 + 中英字典）
├─ lib/                          下载器、匹配、搜索 SDK、Qobuz 桥接、标签写入
├─ vendor/qobuz-dl/
│   ├─ pylibs/                   Qobuz 纯 Python 依赖库（跨平台，无需 pip）
│   └─ config.ini                Qobuz 应用配置（自动安装到用户目录）
├─ cache/                        运行缓存（音源脚本、保存的歌单、下载历史）
├─ start.command / start.bat     一键启动
└─ stop.command / stop.bat       一键停止
```

所有设置与数据仅保存在本机，不会上传到任何服务器。

## 🙏 致谢

- [qobuz-dlp](https://github.com/infojunkie/qobuz-dlp.py)（基于 [vitiko98/qobuz-dl](https://github.com/vitiko98/qobuz-dl)）— Qobuz 下载核心
- [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) — 多平台搜索逻辑移植来源
- 字体：[悠哉字体 Yozai](https://github.com/lxgw/yozai-font) · [Kalam](https://fonts.google.com/specimen/Kalam) · [Patrick Hand](https://fonts.google.com/specimen/Patrick+Hand)（均为开源授权）

## 📄 许可证

本项目基于上游开源项目开发，仅供学习交流。使用时请遵守你所在地区的法律法规及各上游项目的开源协议。

<div align="center">

**简体中文** | [English](README_EN.md)

</div>
