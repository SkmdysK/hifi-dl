#!/usr/bin/env python3
import configparser
import json
import os
import subprocess
import sys
import webbrowser
from difflib import SequenceMatcher

import shutil

# 解析项目目录，并把纯 Python 依赖库（pylibs）加入导入路径：
# 这样 Windows 上只要装了 Python 3.10+，无需 pip install 即可运行
_PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PYLIBS = os.path.join(_PROJECT_DIR, "vendor", "qobuz-dl", "pylibs")
if os.path.isdir(_PYLIBS) and _PYLIBS not in sys.path:
    sys.path.insert(0, _PYLIBS)

import requests

# 优先使用项目内置的 vendor/qobuz-dl，可用环境变量 QOBUZ_DL_DIR 覆盖
_LOCAL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor", "qobuz-dl")
PROJECT = os.environ.get("QOBUZ_DL_DIR") or _LOCAL
CONFIG = os.path.expanduser("~/.config/qobuz-dl/config.ini")
TOKEN = os.path.expanduser("~/.config/qobuz-dl/.qobuz_dl.oauth.txt")


def _ensure_config():
    """新机器首次运行：把项目内置的 config.ini 安装到 ~/.config/qobuz-dl/（不覆盖已有配置）"""
    try:
        bundled = os.path.join(PROJECT, "config.ini")
        if os.path.isfile(bundled) and not os.path.isfile(CONFIG):
            os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
            shutil.copyfile(bundled, CONFIG)
    except Exception:
        pass


_ensure_config()


def _setup_proxy():
    """requests 只认 http_proxy/https_proxy 环境变量；双击「启动.command」起的服务没有这些变量，
    这里自动读取 macOS 系统代理，保证 GUI 里的登录/搜索/下载都能走代理。"""
    if any(os.environ.get(k) for k in ("http_proxy", "https_proxy", "all_proxy")):
        return
    if sys.platform != "darwin":
        return
    try:
        import re
        out = subprocess.run(["scutil", "--proxy"], capture_output=True, text=True, timeout=5).stdout

        def get(key):
            m = re.search(key + r"\s*:\s*(\S+)", out)
            return m.group(1) if m else None

        if get("HTTPEnable") == "1" and get("HTTPProxy") and get("HTTPPort"):
            proxy = f"http://{get('HTTPProxy')}:{get('HTTPPort')}"
            os.environ.setdefault("http_proxy", proxy)
            os.environ.setdefault("https_proxy", proxy)
    except Exception:
        pass


_setup_proxy()


def cfg():
    c = configparser.ConfigParser()
    c.read(CONFIG)
    return c["DEFAULT"]


def headers():
    c = cfg()
    if not os.path.isfile(TOKEN):
        raise RuntimeError("尚未登录 Qobuz")
    token = open(TOKEN, encoding="utf-8").read().strip()
    return {"User-Agent": "Mozilla/5.0", "X-App-Id": c["app_id"], "X-User-Auth-Token": token}


def search(artist, title):
    query = " ".join(x for x in (artist, title) if x).strip()
    if len(query) < 2:
        return {"results": []}
    r = requests.get("https://www.qobuz.com/api.json/0.2/track/search", params={"query": query, "limit": 10}, headers=headers(), timeout=25)
    r.raise_for_status()
    items = r.json().get("tracks", {}).get("items", [])
    out = []
    wanted_artist = artist.casefold().strip()
    wanted_title = title.casefold().strip()
    for item in items:
        performer = item.get("performer") or {}
        album = item.get("album") or {}
        result = {
            "id": item.get("id"),
            "url": f"https://www.qobuz.com/track/{item.get('id')}",
            "name": item.get("title", ""),
            "singer": performer.get("name", ""),
            "album": album.get("title", ""),
            "duration": item.get("duration"),
            "hires": bool(item.get("hires_streamable")),
            "maximumQuality": item.get("maximum_technical_specifications") or {},
        }
        title_score = SequenceMatcher(None, wanted_title, result["name"].casefold()).ratio() if wanted_title else 0
        artist_score = SequenceMatcher(None, wanted_artist, result["singer"].casefold()).ratio() if wanted_artist else 0
        result["score"] = round((title_score * 0.7 + artist_score * 0.3) * 100) if wanted_artist else round(title_score * 100)
        out.append(result)
    out.sort(key=lambda item: item.get("score", 0), reverse=True)
    return {"query": query, "results": out}


def login():
    # qobuz-dl's existing OAuth implementation opens the browser and owns the callback server.
    # 桌面(Electron)版: 桥接进程只把 OAuth URL 写入临时文件, 由主进程打开系统浏览器;
    # 网页版: 仍由 Python 直接调起系统浏览器。
    import tempfile

    if os.environ.get("HIFIDL_DESKTOP"):
        def _write_login_url(url, new=0, autoraise=True):
            try:
                with open(os.path.join(tempfile.gettempdir(), "hifidl-login.url"), "w", encoding="utf-8") as f:
                    f.write(url)
            except Exception:
                pass
            return True

        webbrowser.open = _write_login_url

    from qobuz_dl import qopy
    c = cfg()
    # 用户主动点登录时强制走 OAuth 浏览器流程:
    # 已存在旧 token 时 Client 会直接复用而跳过浏览器, 先把它移开, 登录失败再还原
    bak = TOKEN + ".hifidl-bak"
    # 自愈: 上次登录被强杀中断时, 新 token 未生成, 先还原备份
    try:
        if not os.path.isfile(TOKEN) and os.path.isfile(bak):
            shutil.move(bak, TOKEN)
    except Exception:
        pass
    had_token = False
    try:
        had_token = os.path.isfile(TOKEN)
        if had_token:
            shutil.move(TOKEN, bak)
    except Exception:
        pass
    try:
        client = qopy.Client(c["app_id"], c["secrets"].split(","), c["private_key"], TOKEN)
        try:
            uat = getattr(client, "uat", None)
            if uat and not os.path.isfile(TOKEN):
                os.makedirs(os.path.dirname(TOKEN), exist_ok=True)
                with open(TOKEN, "w", encoding="utf-8") as f:
                    f.write(uat)
            if os.path.isfile(bak):
                os.remove(bak)
        except Exception:
            pass
    finally:
        if had_token and not os.path.isfile(TOKEN):
            try:
                shutil.move(bak, TOKEN)
            except Exception:
                pass
        elif os.path.isfile(bak):
            try:
                os.remove(bak)
            except Exception:
                pass


def download(url, directory, quality, *extra_args):
    os.makedirs(directory, exist_ok=True)
    env = dict(os.environ)
    pylibs = os.path.join(PROJECT, "pylibs")
    env["PYTHONPATH"] = pylibs + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    cmd = [sys.executable, "-m", "qobuz_dl.cli", "dl", "-d", directory, "-q", quality, *extra_args, url]
    return subprocess.run(cmd, cwd=PROJECT, check=False, env=env).returncode


API_BASE = "https://www.qobuz.com/api.json/0.2"
MAX_EXPAND_TRACKS = 2000


def _api_get(endpoint, **params):
    r = requests.get(f"{API_BASE}/{endpoint}", params=params, headers=headers(), timeout=30)
    r.raise_for_status()
    return r.json()


def _track_item(item, album_title=""):
    performer = item.get("performer") or {}
    album = item.get("album") or {}
    return {
        "id": item.get("id"),
        "url": f"https://www.qobuz.com/track/{item.get('id')}",
        "name": item.get("title", ""),
        "singer": performer.get("name", ""),
        "album": album_title or album.get("title", ""),
        "duration": item.get("duration") or 0,
    }


def _display_name(obj):
    name = obj.get("name") if isinstance(obj, dict) else None
    if isinstance(name, dict):
        name = name.get("display") or name.get("font") or ""
    return name or ""


def expand(url):
    """把 Qobuz 链接展开成单曲列表，供 GUI 逐首下载并显示进度。
    歌手/厂牌/last.fm 链接不适合展开，交给 CLI 整体下载。"""
    if "last.fm" in url:
        return {"kind": "lastfm", "name": url, "tracks": []}
    from qobuz_dl.utils import get_url_info
    try:
        url_type, item_id = get_url_info(url)
    except Exception:
        raise RuntimeError("无法识别的链接，请粘贴 play.qobuz.com 的专辑/歌单/单曲/歌手链接")

    if url_type == "track":
        t = _api_get("track/get", track_id=item_id)
        return {"kind": "track", "name": t.get("title", ""), "tracks": [_track_item(t)]}

    if url_type == "album":
        a = _api_get("album/get", album_id=item_id)
        title = a.get("title", "")
        items = (a.get("tracks") or {}).get("items") or []
        return {"kind": "album", "name": title, "tracks": [_track_item(i, title) for i in items]}

    if url_type == "playlist":
        first = _api_get("playlist/get", extra="tracks", playlist_id=item_id, limit=500, offset=0)
        name = first.get("name", "")
        total = first.get("tracks_count") or (first.get("tracks") or {}).get("total") or 0
        items = list((first.get("tracks") or {}).get("items") or [])
        offset = len(items)
        while total and items and len(items) < min(total, MAX_EXPAND_TRACKS):
            page = _api_get("playlist/get", extra="tracks", playlist_id=item_id, limit=500, offset=offset)
            batch = (page.get("tracks") or {}).get("items") or []
            if not batch:
                break
            items.extend(batch)
            offset += len(batch)
        return {"kind": "playlist", "name": name, "tracks": [_track_item(i) for i in items[:MAX_EXPAND_TRACKS]]}

    if url_type in ("artist", "label"):
        meta = _api_get(f"{url_type}/get", **{f"{url_type}_id": item_id}, extra="albums", limit=0, offset=0)
        kind_name = {"artist": "歌手", "label": "厂牌"}[url_type]
        return {"kind": url_type, "name": _display_name(meta) or f"{kind_name} {item_id}", "tracks": []}

    raise RuntimeError(f"暂不支持这种链接（{url_type}）")


def search_albums(artist, keyword):
    query = " ".join(x for x in (keyword, artist) if x).strip()
    if len(query) < 2:
        return {"results": []}
    r = _api_get("album/search", query=query, limit=10)
    items = r.get("albums", {}).get("items", [])
    out = []
    for item in items:
        art = item.get("artist") or {}
        out.append({
            "id": item.get("id"),
            "url": f"https://play.qobuz.com/album/{item.get('id')}",
            "name": item.get("title", ""),
            "singer": art.get("name", ""),
            "tracksCount": item.get("tracks_count"),
            "duration": item.get("duration"),
            "hires": bool(item.get("hires_streamable")) or bool(item.get("hires")),
            "year": (item.get("release_date_original") or item.get("release_date") or "")[:4],
        })
    return {"query": query, "results": out}


def main():
    command = sys.argv[1]
    try:
        if command == "search":
            print(json.dumps(search(sys.argv[2], sys.argv[3]), ensure_ascii=False))
        elif command == "search_albums":
            print(json.dumps(search_albums(sys.argv[2], sys.argv[3]), ensure_ascii=False))
        elif command == "login":
            login()
        elif command == "download":
            sys.exit(download(sys.argv[2], sys.argv[3], sys.argv[4], *sys.argv[5:]))
        elif command == "expand":
            print(json.dumps(expand(sys.argv[2]), ensure_ascii=False))
        else:
            raise SystemExit(f"unknown command: {command}")
    except RuntimeError as e:
        # 输出干净的错误信息给 GUI 显示，不带异常类型前缀
        print(str(e), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
