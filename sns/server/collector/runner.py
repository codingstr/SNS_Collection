"""수집기: 서버 PC의 크롬(Playwright)으로 SNS 페이지를 열어 글을 모읍니다.

- 페이지 안에서 하는 일(스크롤·화면 읽기)은 크롬 확장의 수집 스크립트(scripts/*.js)를 그대로 씁니다.
  확장 API(chrome.runtime 등)만 가짜 객체(SHIM)로 바꿔 끼워, 결과가 이 파일의 _on_msg로 오게 합니다.
- Playwright는 작업 스레드 하나에서만 씁니다. 웹 요청은 작업을 큐에 넣고, 필요하면 결과를 기다립니다.
- 페이지 하나를 오래 수집하는 동안 들어온 검색·게시물 읽기·로그인 확인은 기다리지 않고 바로 처리합니다.
  같은 매체의 창이 수집에 쓰이고 있으면 새 창을 잠깐 열어서 처리하고 닫습니다.
- 매체마다 크롬 프로필이 따로 있습니다: server/profiles/<컴퓨터 이름>/<매체>  (테스트 계정 로그인 정보가 저장되는 곳)
  크롬 로그인 정보는 만든 컴퓨터에서만 풀리므로, 외장 SSD를 여러 컴퓨터에서 써도 되게 컴퓨터마다 따로 둡니다.
"""
import asyncio
import itertools
import json
import logging
import queue
import random
import re
import sys
import threading
import time
import warnings
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from db import get_db
from machine import machine_name
from . import winpos

log = logging.getLogger("collector")

BASE = Path(__file__).resolve().parent
PROFILES = BASE.parent / "profiles" / machine_name()
SCRIPTS = BASE / "scripts"

PLATFORMS = ("youtube", "x", "instagram")
PLATFORM_KO = {"youtube": "유튜브", "x": "X", "instagram": "인스타"}
DAY_MS = 86400000
MAX_ITEMS = 20000                 # DB에 남길 글 수(넘으면 오래 전에 모은 것부터 지움)

DEEP_WAIT, SHALLOW_WAIT = 510, 40   # 페이지 하나당 최대 대기(초): 지금 최신화 / 자동 확인
SEARCH_WAIT, POST_WAIT, LOGIN_WAIT = 30, 30, 15
IDLE_CLOSE = 120                  # 할 일이 없으면 2분 뒤 크롬 창을 닫습니다
AUTO_EVERY_MS = 30 * 60000        # 자동 수집 주기(30분): 서버가 켜져 있으면 모든 사용자의 추적 계정을 모읍니다
AUTO_LABEL = "30분마다"           # 화면에 보이는 자동 수집 주기 문구
AUTO_FIRST_DELAY = 60             # 서버를 켠 뒤 첫 자동 수집까지 최소 대기(초)
# 사용자가 누른 수집은 건너뛰지 않되, 같은 페이지를 마지막으로 모은 뒤 이만큼은 지나야 다시 엽니다(밀리초).
# 연타하거나 여러 사람이 잇달아 눌러도 X·인스타 페이지를 짧은 간격으로 반복해서 열지 않게(봇 탐지 방지).
# 유튜브는 로그인 없이 데이터 요청으로 모으므로 기다리지 않습니다.
USER_MIN_GAP_MS = {"youtube": 0, "x": 30000, "instagram": 30000}
# 자동 확인은 최근에 모은 페이지를 건너뜁니다(사용자가 방금 최신화한 페이지 등). 자동 수집 주기보다 짧아야
# 지난 자동 수집이 모은 페이지를 다음 자동 수집이 건너뛰지 않습니다(같으면 실제 주기가 두 배가 됨).
RECENT_ANY_MS = AUTO_EVERY_MS * 2 // 3
LOGIN_OK_MS = 60 * 60000          # 수집 전 로그인 확인: 로그인됨 확인 후 1시간까지는 다시 확인하지 않음
LOGIN_BAD_MS = 10 * 60000         #   로그인 안 됨/알 수 없음은 10분 지나면 다시 확인(관리자가 그사이 로그인했을 수 있음)
STALL_RETRY_MS = 24 * 3600 * 1000 # 로딩이 도중에 막혔던 페이지(X 속도 제한 등)를 끝까지 다시 내려가 보는 것은 하루에 한 번만
COVER_KEEP_MS = 90 * DAY_MS       # 90일 동안 수집하지 않은 페이지의 수집 범위 기억은 지웁니다
ALIVE_EVERY = 3.0                 # 수집 중인 페이지에 스크립트가 남아 있는지 확인하는 간격(초)
IG_DATES_MAX = 6000               # 인스타 게시물 날짜(응답에서 읽은 것) 기억 개수
ALL = "*"                         # 수집 대상: 추적 계정 전체

LOGIN_URLS = {"youtube": "https://www.youtube.com/", "x": "https://x.com/home", "instagram": "https://www.instagram.com/"}

SOURCES = {"youtube-video", "youtube-post", "x", "instagram"}
URL_OK = re.compile(r"^https://(www\.youtube\.com|x\.com|twitter\.com|www\.instagram\.com)/")
HANDLE_OK = re.compile(r"^[^\s/?#@]{1,60}$")
CHANNEL_OK = re.compile(r"^UC[\w-]{22}$")
LEGACY_OK = re.compile(r"^https://www\.youtube\.com/(c|user)/[^/?#]+$")
POST_URL_OK = re.compile(r"^https://www\.youtube\.com/post/[\w-]{10,60}$")
# 페이지가 통째로 이 주소로 이동했다면 테스트 계정 로그인이 풀린 것입니다.
LOGIN_WALL = re.compile(r"^https://(?:(?:x|twitter)\.com/(?:i/flow/login|login)|www\.instagram\.com/(?:accounts/login|challenge))")
IG_CODE = re.compile(r"^[\w-]{5,40}$")
IG_SCRIPT_JSON = re.compile(r'<script type="application/json"[^>]*>(.*?)</script>', re.S)
# 응답에서 읽은 인스타 게시물 날짜를 페이지의 수집 스크립트(instagram.js scanGrid)에 알려 줍니다.
IG_DATES_JS = "(d) => { window.__snsIgDates = Object.assign(window.__snsIgDates || {}, d); return true; }"
ALIVE_JS = "() => window.__snsInjected === true"

WIN_W, WIN_H = 1000, 800          # 수집 창 크기. 서버 PC 화면 오른쪽 아래 구석, 다른 창들 뒤에 엽니다(winpos.py)
CHROME_ARGS = [
    f"--window-size={WIN_W},{WIN_H}",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",   # 자동화 표시(navigator.webdriver) 줄이기
    # 창이 다른 창에 가려지거나 최소화돼도 화면을 계속 그리게 합니다(스크롤 수집에 필요).
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-features=CalculateNativeWinOcclusion",
]
# 페이지가 늘 "보이는 상태"라고 여기게 합니다(수집 스크립트가 가려진 창에서 일시정지하지 않도록).
VISIBLE_JS = """
Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
Object.defineProperty(document, 'hidden', { get: () => false });
"""
# 확장 API 대신 쓰는 가짜 chrome 객체. 수집 스크립트가 보내는 메시지를 window.__snsBridge(파이썬)로 넘깁니다.
SHIM = r"""
(cfg) => {
  if (window.__snsInjected) return "again";
  window.__snsInjected = true;
  let once = ["search", "login", "post"].includes(cfg.mode); // 검색·로그인 확인·게시물 읽기는 한 번만
  // 메시지마다 이 방문의 번호(_v)를 붙입니다. 같은 창을 다음 방문에 다시 쓸 때, 이전 페이지가 늦게 보낸 메시지를 가려내려고.
  const send = (m) => { try { window.__snsBridge(JSON.stringify(Object.assign({}, m, { _v: cfg.visit }))); } catch (e) {} };
  const chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => p,
      sendMessage(msg, cb) {
        if (msg && msg.type === "hello") {
          let res = { auto: false };
          if (once) { res = { auto: true, mode: cfg.mode, since: cfg.since, q: cfg.q || "" }; once = false; cfg.mode = ""; }
          else if (cfg.mode) res = { auto: true, mode: cfg.mode, since: cfg.since, known: cfg.known || [], stopKnown: !!cfg.stopKnown };
          setTimeout(() => cb && cb(res), 0);
          return;
        }
        send(msg);
        if (cb) setTimeout(() => cb(undefined), 0);
      },
    },
    storage: {
      local: { get(k, cb) { setTimeout(() => cb && cb({ settings: {}, tracked: [] }), 0); } },
      onChanged: { addListener() {} },
    },
  };
  (function (chrome) {
__CODE__
  })(chrome);
  return "ok";
}
"""


# ---------- 도구 ----------
def now_ms() -> int:
    return int(time.time() * 1000)


def _s(v, n: int) -> str:
    return v[:n] if isinstance(v, str) else ""


def _parse_iso(s: str):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def earlier(a: str, b: str) -> str:
    """상대 시각("3일 전")으로 추정한 날짜는 늦게 나오기 쉬워서, 두 값 중 이른 쪽을 씁니다."""
    ta, tb = _parse_iso(a or ""), _parse_iso(b or "")
    if ta is None:
        return b
    if tb is None:
        return a
    return a if ta <= tb else b


def sanitize(raw):
    """확장의 sanitize와 같은 검사."""
    if not isinstance(raw, dict):
        return None
    iid, url = _s(raw.get("id"), 120), _s(raw.get("url"), 500)
    if not iid or raw.get("source") not in SOURCES or not URL_OK.match(url):
        return None
    thumb = _s(raw.get("thumb"), 1000)
    return {
        "id": iid, "source": raw["source"], "url": url,
        "title": _s(raw.get("title"), 300), "author": _s(raw.get("author"), 100),
        "thumb": thumb if thumb.startswith("https://") else "",
        "published_at": _s(raw.get("publishedAt"), 40), "published_text": _s(raw.get("publishedText"), 40),
    }


def is_closed_error(e: Exception) -> bool:
    m = str(e).lower()
    return "has been closed" in m or "target closed" in m or "browser has disconnected" in m


def iso_from_s(t: int) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


MERGE_KEYS = ("url", "title", "author", "thumb", "published_text")


def save_items(raw_items, via: str, ig_dates=None) -> int:
    """글 저장. 처음 보는 글은 새로 넣고(돌려주는 개수), 이미 있던 글은 내용을 보충하고 '다시 본 시각'만 갱신합니다.
    via(추적 계정 ID)와의 연결은 item_via에 따로 남겨, 같은 계정을 다른 ID로 추적하는 사용자도 글을 보게 합니다.
    내용(제목·썸네일·날짜 등)이 실제로 바뀐 글만 updated_at을 고쳐, 화면이 바뀐 내용을 다시 받아 가게 합니다.
    ig_dates: 인스타 응답에서 읽은 게시 날짜({게시물 코드: {"t": 초}}). 날짜 없이 온 격자 글을 채웁니다."""
    now = now_ms()
    its, ids = [], set()
    for raw in (raw_items or [])[:200]:
        it = sanitize(raw)
        if not it or it["id"] in ids:
            continue
        ids.add(it["id"])
        if ig_dates and it["source"] == "instagram" and not it["published_at"]:
            d = ig_dates.get(it["id"][3:])
            if d:
                it["published_at"] = iso_from_s(d["t"])
        its.append(it)
    if not its:
        return 0
    with get_db() as db:
        olds = {r["id"]: r for r in db.execute(f"SELECT * FROM items WHERE id IN ({','.join('?' * len(its))})", [it["id"] for it in its])}
        ins, upd = [], []
        for it in its:
            old = olds.get(it["id"])
            if old is None:
                ins.append((it["id"], it["source"], it["url"], it["title"], it["author"], it["thumb"],
                            it["published_at"], it["published_text"], via, now, now, now))
                continue
            m = {k: (it[k] or old[k]) for k in MERGE_KEYS}
            m["published_at"] = earlier(old["published_at"], it["published_at"]) if old["published_at"] and it["published_at"] else (it["published_at"] or old["published_at"])
            changed = any(m[k] != old[k] for k in (*MERGE_KEYS, "published_at"))
            upd.append((m["url"], m["title"], m["author"], m["thumb"], m["published_text"], m["published_at"],
                        old["via"] or via, now, now if changed else old["updated_at"], it["id"]))
        if ins:
            db.executemany(
                """INSERT OR IGNORE INTO items(id, source, url, title, author, thumb, published_at, published_text, via, collected_at, seen_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", ins)
        if upd:
            db.executemany(
                "UPDATE items SET url=?, title=?, author=?, thumb=?, published_text=?, published_at=?, via=?, seen_at=?, updated_at=? WHERE id=?", upd)
        if via:
            db.executemany("INSERT OR IGNORE INTO item_via(item_id, via) VALUES (?, ?)", [(it["id"], via) for it in its])
    return len(ins)


# ---------- 인스타그램 게시 날짜 ----------
# 프로필 격자 화면에는 게시 날짜가 없습니다. 날짜를 따로 요청하면(게시물마다 열기 등) 테스트 계정이 봇으로 보일 수 있어서,
# 인스타 화면이 스스로 받아 온 응답(문서·데이터 요청)을 크롬에서 읽기만 해 게시물 코드별 날짜를 찾습니다. 사이트로 가는 요청은 늘지 않습니다.
def _json_docs(body: str):
    s = body.lstrip()
    if s.startswith("for (;;);"):
        s = s[9:]
    if s[:1] in ("{", "["):
        try:
            yield json.loads(s)
            return
        except ValueError:
            pass
        for line in s.splitlines():   # 여러 JSON이 줄마다 이어 오는 응답
            line = line.strip()
            if line[:1] in ("{", "[") and "taken_at" in line:
                try:
                    yield json.loads(line)
                except ValueError:
                    pass
        return
    for m in IG_SCRIPT_JSON.finditer(s):   # 문서(HTML) 안에 미리 실어 둔 데이터
        txt = m.group(1)
        if "taken_at" in txt:
            try:
                yield json.loads(txt)
            except ValueError:
                pass


def ig_dates_from(body: str) -> list:
    """응답 내용에서 (게시물 코드, 게시 시각(초), 고정 게시물 여부)를 찾습니다."""
    if "taken_at" not in body:
        return []
    out = []
    for doc in _json_docs(body):
        stack, steps = [doc], 0
        while stack and steps < 500000:
            o = stack.pop()
            steps += 1
            if isinstance(o, dict):
                code = o.get("code") or o.get("shortcode")
                t = o.get("taken_at") or o.get("taken_at_timestamp")
                if isinstance(code, str) and IG_CODE.match(code) and isinstance(t, int) and 1_000_000_000 < t < 10_000_000_000:
                    out.append((code, t, bool(o.get("timeline_pinned_user_ids"))))
                stack.extend(v for v in o.values() if isinstance(v, (dict, list)))
            elif isinstance(o, list):
                stack.extend(v for v in o if isinstance(v, (dict, list)))
    return out


def count_new(vias, since_ms: int) -> int:
    """이 추적 계정들에서 since_ms 뒤에 처음 모은 글 수."""
    vias = list(vias) or [""]
    with get_db() as db:
        return db.execute(
            f"""SELECT COUNT(DISTINCT i.id) FROM item_via v JOIN items i ON i.id = v.item_id
                WHERE v.via IN ({','.join('?' * len(vias))}) AND i.collected_at >= ?""", (*vias, since_ms)).fetchone()[0]


def link_vias(src_via: str, extra_vias):
    """src_via로 모은 글을 다른 추적 계정 ID(같은 계정을 다르게 적은 것)에도 연결합니다."""
    with get_db() as db:
        for v in extra_vias:
            db.execute("INSERT OR IGNORE INTO item_via(item_id, via) SELECT item_id, ? FROM item_via WHERE via = ?", (v, src_via))


# ---------- 이미 모은 글에서 멈추기 ----------
# '지금 최신화'와 자동 수집 모두, 맨 위(최신 글)부터 보다가 이미 모은 글이 연달아 나오면 거기서 멈춥니다.
# 처음부터 기간 끝까지 다시 모으는 경우(멈추지 않음):
#   - 이미 모은 글이 하나도 없는 계정(새로 추가한 계정)
#   - 사용자가 '수집한 글 모두 삭제'를 누른 뒤 아직 끝까지 모은 적이 없을 때(= 다시 처음부터 모으고 싶을 때의 방법)
#   - 지난 수집이 새 글을 모으다 중간에 끊겨(시간 한도·멈추기) 사이가 비었을 수 있을 때
#   - 계정의 가져올 기간을 늘려서, 예전에 모은 범위보다 더 오래된 글이 필요할 때
# 페이지마다 기억(coverage): {주소: {"since": 이 시각 이후 글은 빠짐없이 있음, "full_at": 끝까지 모은 시각} 또는 {"gap": True}}
# 끝까지 모았다고 보는 수집 결과(수집 스크립트가 알려 주는 멈춘 이유):
#   기간 밖 글 도달 / 목록 끝(유튜브 데이터 요청) / 더 안 나옴(끝/로딩 정지: 깊게 모을 때 여러 번 확인) / 날짜 없음(횟수 제한: 인스타 격자, 기간에 맞춘 횟수)
COVER_DONE = ("기간 밖 글 도달", "목록 끝", "더 안 나옴(끝", "날짜 없음")


def known_ids(via: str, limit: int = 400) -> list:
    with get_db() as db:
        rows = db.execute("""SELECT i.id FROM item_via v JOIN items i ON i.id = v.item_id WHERE v.via = ?
                             ORDER BY i.collected_at DESC LIMIT ?""", (via, limit)).fetchall()
    return [r["id"] for r in rows]


def cov_get(url: str):
    with get_db() as db:
        row = db.execute("SELECT data FROM coverage WHERE url = ?", (url,)).fetchone()
    try:
        return json.loads(row["data"]) if row else None
    except ValueError:
        return None


def cov_set(url: str, data: dict):
    with get_db() as db:
        db.execute("INSERT OR REPLACE INTO coverage(url, data, at) VALUES (?, ?, ?)", (url, json.dumps(data), now_ms()))


def cover_plan(url: str, via: str, since_ms: int, cleared_ms: int):
    """(이미 모은 글에서 멈춰도 되는지, 이미 모은 글 ID 목록, 지금 기억)"""
    cov = cov_get(url)
    if cov is None:
        ok = not cleared_ms    # 이 기능 전부터 모아 둔 글: 지운 적이 없으면 그대로 이어서
    else:
        whole = not cov.get("gap") and cov.get("full_at", 0) > cleared_ms
        ok = whole and cov.get("since", now_ms()) <= since_ms + 3600000
        # 지난번에 로딩이 도중에 막혀 기간 끝까지 못 간 페이지: 끝까지 다시 내려가 보는 것은 하루에 한 번만 합니다.
        # (매번 처음부터 다시 스크롤하면 같은 제한에 또 걸리고, 사이트에는 봇처럼 보일 수 있습니다.)
        if (not ok and whole and cov.get("stalled_at") and cov.get("want", now_ms()) <= since_ms + 3600000
                and now_ms() - cov["stalled_at"] < STALL_RETRY_MS):
            ok = True
    known = known_ids(via) if ok else []
    return ok and bool(known), known, cov


def cover_update(url: str, res: dict, stop_known: bool, cov, since_ms: int, started_ms: int):
    d = res.get("done") or {}
    why = str(d.get("why") or "")
    if why.startswith(COVER_DONE):
        new = {"since": 0 if why.startswith("목록 끝") else since_ms, "full_at": started_ms}
        if why.startswith("더 안 나옴(끝"):
            # 더 안 불러와져서 멈춤: 실제로 닿은 가장 오래된 글이 기간 끝보다 한참 새것이면, 거기까지만 빠짐없이 모은 것입니다.
            oldest = int(d.get("oldest") or 0)
            if oldest > since_ms + 3600000:
                new = {"since": oldest, "full_at": started_ms, "stalled_at": now_ms(), "want": since_ms}
    elif (stop_known and why.startswith("이미 모은 글 도달")) or (res.get("added", 0) == 0 and d):
        # 예전에 모은 곳까지 이어졌거나 새 글이 없었으면 빈틈도 없습니다: 기억은 그대로 두고 '최근에 씀'만 표시
        if cov is not None:
            with get_db() as db:
                db.execute("UPDATE coverage SET at = ? WHERE url = ?", (now_ms(), url))
        return
    else:
        new = {"gap": True}   # 새 글을 모으다 중간에 끊김: 다음에는 끝까지 다시
    cov_set(url, new)


def prune_items():
    with get_db() as db:
        db.execute("""DELETE FROM items WHERE id IN
                      (SELECT id FROM items ORDER BY MAX(collected_at, seen_at) DESC LIMIT -1 OFFSET ?)""", (MAX_ITEMS,))
        db.execute("DELETE FROM coverage WHERE at < ?", (now_ms() - COVER_KEEP_MS,))


# ---------- 서버 전체 상태(테스트 계정 로그인 상태) ----------
def get_login_state() -> dict:
    with get_db() as db:
        row = db.execute("SELECT value FROM kv WHERE key = 'loginState'").fetchone()
    return json.loads(row["value"]) if row else {}


def set_login(platform: str, logged_in):
    with get_db() as db:
        row = db.execute("SELECT value FROM kv WHERE key = 'loginState'").fetchone()
        st = json.loads(row["value"]) if row else {}
        st[platform] = {"loggedIn": logged_in, "at": now_ms()}
        db.execute("INSERT OR REPLACE INTO kv(key, value) VALUES ('loginState', ?)", (json.dumps(st),))


def kv_get(key: str, default=None):
    with get_db() as db:
        row = db.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def kv_set(key: str, value):
    with get_db() as db:
        db.execute("INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)", (key, json.dumps(value)))


# ---------- 사용자 상태 ----------
def read_user(uid: str) -> dict:
    with get_db() as db:
        row = db.execute("SELECT * FROM user_state WHERE user_id = ?", (uid,)).fetchone()
    if not row:
        return {"tracked": [], "settings": {}, "windowDays": 30, "status": {}, "cleared": 0}
    return {"tracked": json.loads(row["tracked"]), "settings": json.loads(row["settings"]),
            "windowDays": row["window_days"], "status": json.loads(row["status"]), "cleared": row["cleared_before"]}


def set_status(uid: str, **patch):
    with get_db() as db:
        db.execute("INSERT OR IGNORE INTO user_state(user_id) VALUES (?)", (uid,))
        row = db.execute("SELECT status FROM user_state WHERE user_id = ?", (uid,)).fetchone()
        st = json.loads(row["status"])
        st.update(patch)
        db.execute("UPDATE user_state SET status = ? WHERE user_id = ?", (json.dumps(st, ensure_ascii=False), uid))


def reset_running():
    """서버가 다시 켜졌다면 이전 수집은 끝난 것입니다."""
    with get_db() as db:
        for row in db.execute("SELECT user_id, status FROM user_state").fetchall():
            st = json.loads(row["status"])
            if st.get("running"):
                st.update(running=False, message="서버가 다시 시작되어 수집이 중단되었습니다.")
                db.execute("UPDATE user_state SET status = ? WHERE user_id = ?", (json.dumps(st, ensure_ascii=False), row["user_id"]))


# ---------- 방문할 주소 ----------
def page_urls(t: dict) -> list:
    """방문할 주소(확장의 pageUrls와 같음). 유튜브 채널은 영상 탭과 게시물 탭 두 곳입니다."""
    p = t.get("platform")
    if t.get("kind") == "feed":
        return []  # "내 피드"는 지원하지 않습니다(서버 테스트 계정의 피드가 되기 때문)
    handle, cid = t.get("handle") or "", t.get("channelId") or ""
    legacy = t.get("resolveUrl") if LEGACY_OK.match(t.get("resolveUrl") or "") else ""
    if not HANDLE_OK.match(handle) and not CHANNEL_OK.match(cid) and not legacy:
        return []
    h = quote(handle, safe="")
    if p == "youtube":
        base = ("https://www.youtube.com/@" + h) if handle else ("https://www.youtube.com/channel/" + cid) if CHANNEL_OK.match(cid) else legacy
        return [base + "/videos", base + "/posts"] if base else []
    if p == "x":
        return ["https://x.com/" + h]
    if p == "instagram":
        return ["https://www.instagram.com/" + h + "/"]
    return []


def search_url(platform: str, q: str) -> str:
    e = quote(q, safe="")
    return {"youtube": f"https://www.youtube.com/results?search_query={e}&sp=EgIQAg%3D%3D",
            "x": f"https://x.com/search?q={e}&f=user",
            "instagram": "https://www.instagram.com/"}.get(platform, "")


def clean_results(results) -> list:
    out = []
    for r in (results or [])[:8] if isinstance(results, list) else []:
        if not isinstance(r, dict):
            continue
        avatar = _s(r.get("avatar"), 2000)
        c = {
            "handle": r["handle"] if HANDLE_OK.match(r.get("handle") or "") else "",
            "channelId": r["channelId"] if CHANNEL_OK.match(r.get("channelId") or "") else "",
            "name": _s(r.get("name"), 80), "desc": _s(r.get("desc"), 100),
            "avatar": avatar if avatar.startswith("https://") else "",
        }
        if c["handle"] or c["channelId"]:
            out.append(c)
    return out


def clean_post(p):
    if not isinstance(p, dict):
        return None
    https = lambda u: isinstance(u, str) and u.startswith("https://")
    v = p.get("video") if isinstance(p.get("video"), dict) else None
    return {
        "author": _s(p.get("author"), 80), "time": _s(p.get("time"), 40), "text": _s(p.get("text"), 5000),
        "likes": _s(p.get("likes"), 20), "avatar": p["avatar"] if https(p.get("avatar")) else "",
        "images": [u for u in (p.get("images") or []) if https(u)][:6],
        "video": {"id": v["id"], "title": _s(v.get("title"), 120)} if v and re.match(r"^[\w-]{11}$", str(v.get("id") or "")) else None,
    }


# ---------- 작업 스레드 ----------
class Collector:
    def __init__(self):
        self.q = queue.PriorityQueue()   # (우선순위, 순번, 작업)  0 = 검색 등 급한 일, 1 = 수집, 2 = 자동 수집
        self.seq = itertools.count()
        self.pw = None
        self.ctxs, self.pages = {}, {}
        self.last_used = 0.0
        self.curs = {}                   # 페이지 → 그 페이지의 수집 상태(스크립트가 보낸 메시지를 받음)
        self.busy = set()                # 지금 수집에 쓰이고 있는 매체(그 매체의 기본 창)
        self.depth = 0                   # 페이지 방문이 겹친 깊이(바깥 방문 중에만 급한 일을 끼워 처리)
        self.lock = threading.Lock()
        self.queued_users = set()        # 수집 대기/진행 중인 사용자
        self.pending = {}                # 사용자 → 모을 계정(ALL 또는 계정 ID 집합). 수집 중에 들어온 요청은 여기 모았다가 이어서 처리
        self.cancel_users = set()
        self.recent = {}                 # 페이지 주소 → (마지막 수집 시각, mode, 가져온 기간(일))
        self.login_busy = False
        self.bundles = {}
        self.thread = None
        self.next_auto = 0.0             # 다음 자동 수집 시각(초)
        self.visit_seq = itertools.count(1)
        self.ig_dates = OrderedDict()    # 인스타 게시물 코드 → {"t": 게시 시각(초), "pin": 고정 게시물}
        self.ig_pending = []             # 아직 읽지 않은 인스타 응답(이벤트 처리 중에는 읽지 않고 작업 루프에서 읽음)

    # ----- 웹 요청 쪽에서 부르는 함수 -----
    def start(self):
        if self.thread and self.thread.is_alive():
            return   # 이미 돌고 있음(한 프로세스에 수집기는 하나만)
        reset_running()
        last = (kv_get("lastAuto", 0) or 0) / 1000
        self.next_auto = max(last + AUTO_EVERY_MS / 1000, time.time() + AUTO_FIRST_DELAY)
        # 관리자가 login_setup으로 로그인한 뒤 서버를 다시 켰을 수 있으니, 로그인 안 됨/모름으로 남은 매체는 켜자마자 다시 확인합니다.
        st = get_login_state()
        recheck = [p for p in ("x", "instagram") if p in st and st[p].get("loggedIn") is not True]
        if recheck:
            self.request_login_check(recheck)
        self.thread = threading.Thread(target=self._loop, name="collector", daemon=True)
        self.thread.start()

    def request_collect(self, uid: str, mode: str, only: str = "") -> bool:
        """수집 요청. 이미 수집 중(또는 대기 중)이면 버리지 않고 모아 두었다가, 지금 수집이 끝나면 이어서 모읍니다.
        only: 특정 계정 ID만(계정을 새로 추가했을 때). 비우면 추적 계정 전체."""
        with self.lock:
            prev = self.pending.get(uid)
            self.pending[uid] = ALL if (not only or prev == ALL) else (prev or set()) | {only}
            self.cancel_users.discard(uid)
            queued = uid in self.queued_users
            self.queued_users.add(uid)
        if not queued:
            set_status(uid, running=True, closed=False, paused=False, message="수집 대기 중…")
            self.q.put((1, next(self.seq), {"kind": "collect", "uid": uid, "mode": mode}))
        return True

    def cancel(self, uid: str):
        with self.lock:
            if uid in self.queued_users:
                self.cancel_users.add(uid)
                self.pending.pop(uid, None)

    def request_login_check(self, platforms):
        if self.login_busy:
            return
        self.login_busy = True
        self.q.put((0, next(self.seq), {"kind": "login", "platforms": [p for p in platforms if p in PLATFORMS] or list(PLATFORMS)}))

    def run_blocking(self, job: dict, timeout: float):
        """검색·게시물 읽기처럼 결과가 필요한 작업: 큐 맨 앞에 넣고 끝날 때까지 기다립니다."""
        job["event"] = threading.Event()
        self.q.put((0, next(self.seq), job))
        if not job["event"].wait(timeout):
            job["abandoned"] = True  # 아직 시작 전이면 건너뜁니다(기다리던 화면은 이미 오류를 받음)
            raise TimeoutError("서버 수집기가 바빠서 시간 안에 끝내지 못했습니다. 잠시 뒤 다시 시도하세요.")
        if job.get("error"):
            raise RuntimeError(job["error"])
        return job.get("result")

    # ----- 작업 스레드 -----
    @staticmethod
    def _ensure_proactor():
        """Playwright는 크롬을 하위 프로세스로 띄우므로 윈도우에서는 Proactor 이벤트 루프가 필요합니다.
        윈도우의 기본값이 이미 Proactor라서 보통은 아무것도 하지 않고, 다른 것으로 바뀌어 있을 때만 되돌립니다.
        (이벤트 루프 정책 API는 Python 3.14부터 사용 중단 예정이라 경고는 숨기고, 없어진 버전에서는 건너뜁니다.)"""
        if sys.platform != "win32":
            return
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                if not isinstance(asyncio.get_event_loop_policy(), asyncio.WindowsProactorEventLoopPolicy):
                    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        except AttributeError:
            pass

    def _loop(self):
        self._ensure_proactor()
        while True:
            if time.time() >= self.next_auto:
                self.next_auto = time.time() + AUTO_EVERY_MS / 1000
                self.q.put((2, next(self.seq), {"kind": "auto"}))   # 우선순위 2: 사용자 요청보다 뒤
            try:
                _, _, job = self.q.get(timeout=5)
            except queue.Empty:
                if self.pw and time.time() - self.last_used > IDLE_CLOSE:
                    self._close_all()
                continue
            self._exec(job)

    def _exec(self, job):
        if job.get("abandoned"):
            return  # 기다리던 웹 요청이 이미 시간 초과로 끝났습니다
        self.last_used = time.time()
        try:
            kind = job["kind"]
            if kind == "collect":
                self._collect(job)
            elif kind == "auto":
                self._auto()
            elif kind == "search":
                job["result"] = self._search(job["platform"], job["q"])
            elif kind == "post":
                job["result"] = self._post(job["url"])
            elif kind == "login":
                self._check_login(job["platforms"])
        except ValueError as e:
            log.info("%s: %s", job.get("kind"), e)  # 예상된 안내(로그인 필요 등): 오류 내용만 짧게
            job["error"] = str(e)
        except Exception as e:
            log.exception("수집 작업 오류: %s", job.get("kind"))
            job["error"] = self._friendly(e)
        finally:
            self.last_used = time.time()
            if job["kind"] == "login":
                self.login_busy = False
            if job.get("event"):
                job["event"].set()

    def _run_urgent(self, upto: int = 0):
        """수집 중간에 들어온 급한 일을 먼저 처리합니다. upto=0: 검색 등만, upto=1: 사용자 수집 요청까지."""
        held = []
        while True:
            try:
                item = self.q.get_nowait()
            except queue.Empty:
                break
            if item[0] <= upto:
                self._exec(item[2])
            else:
                held.append(item)
        for item in held:
            self.q.put(item)

    def _has_urgent(self) -> bool:
        with self.q.mutex:
            return bool(self.q.queue) and self.q.queue[0][0] == 0

    def _serve_side_jobs(self):
        """페이지를 오래 수집하는 도중에 들어온 급한 일(검색·게시물·로그인 확인)을 바로 처리합니다."""
        if self._has_urgent():
            self._run_urgent(0)

    @staticmethod
    def _friendly(e: Exception) -> str:
        if isinstance(e, ValueError):
            return str(e)  # 직접 만든 안내 문구는 그대로 보여 줍니다
        m = str(e)
        if "ProcessSingleton" in m or "user data directory is already in use" in m.lower():
            return "테스트 계정 크롬 프로필이 다른 창에서 쓰이고 있습니다. login_setup으로 연 크롬 창을 닫아 주세요."
        if "Executable doesn't exist" in m or "chrome" in m.lower() and "not found" in m.lower():
            return "크롬을 찾지 못했습니다. 서버 PC에 크롬을 설치하세요."
        return "수집기 오류: " + m.splitlines()[0][:200]

    # ----- 크롬 -----
    def _bundle(self, platform: str) -> str:
        if platform not in self.bundles:
            code = (SCRIPTS / "common.js").read_text(encoding="utf-8") + "\n" + (SCRIPTS / f"{platform}.js").read_text(encoding="utf-8")
            self.bundles[platform] = SHIM.replace("__CODE__", code)
        return self.bundles[platform]

    def _launch(self, platform: str):
        """매체별 크롬 프로필로 크롬을 띄웁니다. (테스트에서는 이 함수를 바꿔 씁니다)"""
        d = PROFILES / platform
        d.mkdir(parents=True, exist_ok=True)
        kw = dict(user_data_dir=str(d), headless=False, no_viewport=True, args=CHROME_ARGS + winpos.corner_args(WIN_W, WIN_H),
                  ignore_default_args=["--enable-automation"])
        snap = winpos.snapshot()
        try:
            ctx = self.pw.chromium.launch_persistent_context(channel="chrome", **kw)
        except Exception as e:
            if "already in use" in str(e).lower() or "ProcessSingleton" in str(e):
                raise
            log.warning("설치된 크롬으로 띄우지 못해 Playwright 기본 브라우저로 시도합니다: %s", str(e).splitlines()[0])
            ctx = self.pw.chromium.launch_persistent_context(**kw)
        winpos.tuck(snap)   # 서버 PC에서 하던 작업을 가리지 않게 구석·맨 뒤로
        return ctx

    def _context(self, platform: str):
        if not self.pw:
            from playwright.sync_api import sync_playwright
            self.pw = sync_playwright().start()
        ctx = self.ctxs.get(platform)
        if ctx is None:
            ctx = self._launch(platform)
            # 수집 스크립트의 메시지는 어느 페이지에서 왔는지와 함께 받습니다(수집 창과 검색 창이 동시에 열릴 수 있음).
            ctx.expose_binding("__snsBridge", lambda source, raw: self._on_msg(source.get("page"), raw))
            ctx.add_init_script(VISIBLE_JS)
            ctx.on("close", lambda *_: (self.ctxs.pop(platform, None), self.pages.pop(platform, None)))
            if platform == "instagram":
                ctx.on("response", self._ig_on_response)
            self.ctxs[platform] = ctx
        return ctx

    # ----- 인스타 게시 날짜(응답 읽기) -----
    def _ig_on_response(self, r):
        """인스타 화면이 받은 응답 중 게시물 데이터가 있을 만한 것만 기억해 둡니다(내용은 작업 루프에서 읽음)."""
        try:
            if (len(self.ig_pending) < 300 and r.status == 200 and "instagram.com/" in r.url
                    and r.request.resource_type in ("xhr", "fetch", "document")):
                self.ig_pending.append(r)
        except Exception:
            pass

    def _ig_pump(self):
        """기억해 둔 인스타 응답에서 게시 날짜를 읽어, 수집 스크립트에 알려 주고 날짜 없이 저장된 글도 채웁니다."""
        if not self.ig_pending:
            return
        pend, self.ig_pending = self.ig_pending, []
        new = {}
        for r in pend:
            try:
                body = r.text()   # 크롬이 이미 받은 내용을 읽기만 합니다(사이트로 새 요청을 보내지 않음)
            except Exception:
                continue
            if len(body) > 8_000_000:
                continue
            for code, t, pin in ig_dates_from(body):
                v = {"t": t, "pin": pin or bool((self.ig_dates.get(code) or {}).get("pin"))}
                if self.ig_dates.get(code) != v:
                    new[code] = v
                self.ig_dates[code] = v
                self.ig_dates.move_to_end(code)
        while len(self.ig_dates) > IG_DATES_MAX:
            self.ig_dates.popitem(last=False)
        if not new:
            return
        for page, cur in list(self.curs.items()):
            if cur["platform"] == "instagram":
                try:
                    if not page.is_closed():
                        page.evaluate(IG_DATES_JS, new)
                except Exception:
                    pass
        now = now_ms()
        with get_db() as db:
            db.executemany("UPDATE items SET published_at = ?, updated_at = ? WHERE id = ? AND published_at = ''",
                           [(iso_from_s(v["t"]), now, "ig:" + c) for c, v in new.items()])

    # ----- 페이지 상태 -----
    def _gone(self, h) -> str:
        """수집 스크립트가 아직 페이지에 있는지 몇 초마다 확인합니다. 페이지가 통째로 다른 곳(로그인 화면 등)으로
        이동해 스크립트가 사라졌으면, 시간 한도(최대 8분)까지 기다리지 않도록 이유를 돌려줍니다."""
        now = time.time()
        if now - h.get("checked", now) < ALIVE_EVERY:
            h.setdefault("checked", now)
            return ""
        h["checked"] = now
        page = h["page"]
        try:
            alive = page.evaluate(ALIVE_JS)
        except Exception:
            h["miss"] = h.get("miss", 0) + 1   # 페이지가 바뀌는 순간에는 확인이 실패할 수 있어 몇 번 더 봅니다
            if h["miss"] < 3:
                return ""
            alive = False
        else:
            h["miss"] = 0
        if alive:
            return ""
        p, url = h["platform"], page.url
        if p in ("x", "instagram") and LOGIN_WALL.match(url):
            set_login(p, False)
            return f"서버의 {PLATFORM_KO[p]} 테스트 계정 로그인이 풀려 로그인 화면으로 이동했습니다(관리자 확인 필요)"
        return "페이지가 다른 주소로 이동해 수집이 끊겼습니다: " + url[:120]

    @staticmethod
    def _halt(page):
        """끝나지 않은 수집 스크립트를 멈춥니다(멈추기·시간 초과·이동). 빈 페이지로 옮겨 스크롤을 끝냅니다."""
        try:
            if not page.is_closed():
                page.goto("about:blank", timeout=5000)
        except Exception:
            pass

    def _page(self, platform: str, retry: bool = True):
        ctx = self._context(platform)
        try:
            page = self.pages.get(platform)
            if page is None or page.is_closed():
                if ctx.pages:
                    page = ctx.pages[0]
                else:
                    snap = winpos.snapshot()
                    page = ctx.new_page()
                    winpos.tuck(snap)
                self.pages[platform] = page
            return page
        except Exception as e:
            # 서버 PC에서 누가 크롬 창을 직접 닫으면, 수집기는 다음에 쓸 때야 알게 됩니다. 버리고 새로 띄웁니다.
            if retry and is_closed_error(e):
                log.info("%s 크롬 창이 닫혀 있어 다시 엽니다.", platform)
                self._drop(platform)
                return self._page(platform, retry=False)
            raise

    def _side_page(self, platform: str):
        """같은 매체의 기본 창이 수집에 쓰이는 중일 때 잠깐 쓸 새 창. 탭이 아니라 창으로 열어,
        수집 중인 창이 뒤로 숨어 화면 그리기(스크롤 불러오기)가 멈추지 않게 합니다."""
        ctx = self._context(platform)
        main = self.pages.get(platform)
        snap = winpos.snapshot()
        if main is not None and not main.is_closed():
            try:
                cdp = ctx.new_cdp_session(main)
                try:
                    with ctx.expect_page(timeout=10000) as info:
                        cdp.send("Target.createTarget", {"url": "about:blank", "newWindow": True, "background": True})
                    winpos.tuck(snap)
                    return info.value
                finally:
                    try:
                        cdp.detach()
                    except Exception:
                        pass
            except Exception as e:
                log.info("%s 새 창을 열지 못해 새 탭으로 엽니다: %s", platform, str(e).splitlines()[0][:120])
        page = ctx.new_page()
        winpos.tuck(snap)
        return page

    def _drop(self, platform: str):
        ctx = self.ctxs.pop(platform, None)
        self.pages.pop(platform, None)
        if ctx is not None:
            try:
                ctx.close()
            except Exception:
                pass

    def _close_all(self):
        for ctx in list(self.ctxs.values()):
            try:
                ctx.close()
            except Exception:
                pass
        self.ctxs.clear()
        self.pages.clear()
        try:
            self.pw.stop()
        except Exception:
            pass
        self.pw = None
        log.info("할 일이 없어 크롬 창을 닫았습니다.")

    def _on_msg(self, page, raw: str):
        """수집 스크립트가 보낸 메시지(확장 시절 background로 가던 것)."""
        cur = self.curs.get(page)
        if not cur:
            return
        try:
            m = json.loads(raw)
        except Exception:
            return
        if m.get("_v") != cur["visit"]:
            return  # 같은 창의 이전 방문(이전 페이지)이 늦게 보낸 메시지: 이번 방문 것으로 치지 않습니다
        t = m.get("type")
        if t == "items" and cur.get("save") and isinstance(m.get("items"), list):
            cur["added"] += save_items(m["items"], cur["via"], self.ig_dates if cur["platform"] == "instagram" else None)
        elif t == "autoDone":
            cur["done"] = m
        elif t == "login" and isinstance(m.get("loggedIn"), bool):
            set_login(cur["platform"], m["loggedIn"])
            cur["login"] = m["loggedIn"]

    def _visit(self, platform, url, cfg, via="", limit=30, save=False, cancel=None, until_login=False, retry=True):
        """페이지를 열고 수집 스크립트를 넣은 뒤, 스크립트가 '끝'을 알릴 때까지 기다립니다.
        도중에 크롬 창이 닫히면 한 번만 새 창으로 다시 시도합니다.
        같은 매체의 기본 창이 다른 수집에 쓰이는 중이면(수집 도중 끼워 넣은 검색 등) 새 창에서 하고 닫습니다."""
        side = platform in self.busy
        try:
            return self._visit_once(platform, url, cfg, via, limit, save, cancel, until_login, side)
        except Exception as e:
            if side or not (retry and is_closed_error(e)):
                raise
            log.info("%s 크롬 창이 도중에 닫혀 다시 시도합니다.", platform)
            self._drop(platform)
            return self._visit_once(platform, url, cfg, via, limit, save, cancel, until_login, False)

    def _visit_once(self, platform, url, cfg, via, limit, save, cancel, until_login, side=False):
        page = self._side_page(platform) if side else self._page(platform)
        visit = next(self.visit_seq)
        cfg = {**cfg, "visit": visit}
        cur = {"platform": platform, "via": via, "save": save, "done": None, "added": 0, "login": None, "visit": visit}
        self.curs[page] = cur
        if not side:
            self.busy.add(platform)
        self.depth += 1
        h = {"page": page, "platform": platform}
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            try:
                page.wait_for_load_state("load", timeout=10000)
            except Exception:
                pass
            page.evaluate(self._bundle(platform), cfg)
            end = time.time() + limit
            while cur["done"] is None and time.time() < end:
                if cancel and cancel():
                    return {"cancelled": True, **cur}
                if until_login and cur["login"] is not None:
                    break
                if self.depth == 1:
                    self._serve_side_jobs()   # 오래 걸리는 수집 도중에도 검색 등은 바로 처리
                    if cur["done"] is not None:
                        break
                self._ig_pump()
                gone = self._gone(h)
                if gone:
                    raise ValueError(gone)
                page.wait_for_timeout(250)
            return dict(cur)
        finally:
            self.depth -= 1
            self.curs.pop(page, None)
            if not side and cur["done"] is None and not (until_login and cur["login"] is not None):
                self._halt(page)   # 끝나지 않은 스크립트(멈추기·시간 초과)가 뒤에서 계속 스크롤하지 않게
            if side:
                try:
                    page.close()
                except Exception:
                    pass
            else:
                self.busy.discard(platform)

    # ----- 여러 매체 동시 수집 -----
    # 매체마다 크롬이 따로 떠 있으므로(프로필도 따로), 유튜브·X·인스타 페이지를 한 매체에 하나씩 동시에 엽니다.
    # 같은 매체 안에서는 예전처럼 한 페이지씩, 페이지 사이에 쉬는 시간을 둡니다(각 사이트 입장에서는 이전과 같은 속도).
    @staticmethod
    def _gap(platform: str) -> float:
        return random.uniform(1.5, 3.0) if platform == "instagram" else random.uniform(1.0, 2.0) if platform == "x" else random.uniform(0.4, 0.8)

    def _begin(self, platform, url, cfg, via, save):
        """페이지를 열고 수집 스크립트를 넣기만 합니다(끝날 때까지 기다리지 않음). 기다리기는 _run_lanes가 합니다."""
        for attempt in (0, 1):
            page = self._page(platform)
            visit = next(self.visit_seq)
            cur = {"platform": platform, "via": via, "save": save, "done": None, "added": 0, "login": None, "visit": visit}
            self.curs[page] = cur
            self.busy.add(platform)
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                try:
                    page.wait_for_load_state("load", timeout=10000)
                except Exception:
                    pass
                page.evaluate(self._bundle(platform), {**cfg, "visit": visit})
                return {"page": page, "cur": cur, "platform": platform, "checked": time.time()}
            except Exception as e:
                self.curs.pop(page, None)
                self.busy.discard(platform)
                if attempt == 0 and is_closed_error(e):
                    log.info("%s 크롬 창이 닫혀 있어 다시 엽니다.", platform)
                    self._drop(platform)
                    continue
                raise

    def _ready_at(self, t) -> float:
        """이 페이지를 다시 열어도 되는 시각(초): 마지막으로 모은 뒤 매체별 최소 간격(USER_MIN_GAP_MS)."""
        last = self.recent.get(t["url"])
        return (last[0] + USER_MIN_GAP_MS.get(t["p"], 0)) / 1000 if last else 0.0

    def _end(self, h):
        self.curs.pop(h["page"], None)
        self.busy.discard(h["platform"])

    def _has_job(self, upto: int) -> bool:
        with self.q.mutex:
            return bool(self.q.queue) and self.q.queue[0][0] <= upto

    def _run_lanes(self, tasks, limit, on_done, feed=None, on_drop=None, progress=None, yield_to_users=False):
        """매체별 줄(lane)을 동시에 돌립니다. 끝난 페이지마다 on_done(task, 결과 dict 또는 예외, 시작 시각)을 부릅니다.
        feed(): 도는 중에 새로 끼워 넣을 페이지들(다른 사용자가 누른 수집 등)을 돌려줍니다.
        task["owners"]가 있으면(사용자 수집) 멈추기를 누른 사용자는 on_drop(task, owner)으로 빼고, 남은 사용자가 없으면 그 페이지를 멈춥니다.
        yield_to_users: 사용자가 누른 수집이 들어오면 새 페이지를 열지 않고 그것부터 처리(자동 수집용)."""
        lanes, active, next_at = {}, {}, {}

        def add(ts):
            for t in ts or []:
                lanes.setdefault(t["p"], []).append(t)
                next_at.setdefault(t["p"], 0.0)

        def dropped(t) -> bool:
            if "owners" not in t:
                return False
            keep = []
            for o in t["owners"]:
                if o["ctx"]["uid"] in self.cancel_users:
                    if on_drop:
                        on_drop(t, o)
                else:
                    keep.append(o)
            t["owners"] = keep
            return not keep

        add(tasks)
        self.depth += 1   # 이 안에서 끼워 처리하는 검색 등은 다시 끼워 넣지 않게
        try:
            while True:
                if feed:
                    add(feed())
                if not lanes and not active:
                    break
                # 멈추기를 누른 사용자의 페이지 빼기(같은 페이지를 기다리는 다른 사용자가 있으면 계속)
                for p in list(lanes):
                    lanes[p] = [t for t in lanes[p] if not dropped(t)]
                    if not lanes[p]:
                        del lanes[p]
                for p, (t, h, t0, _) in list(active.items()):
                    if dropped(t):
                        self._end(h)
                        self._halt(h["page"])   # 멈추기: 그 페이지의 스크롤도 바로 끝냅니다
                        del active[p]
                        on_done(t, {"cancelled": True, **h["cur"]}, t0)
                        next_at[p] = time.time() + self._gap(p)
                hold = yield_to_users and self._has_job(1)
                if hold and not active:
                    self._run_urgent(upto=1)   # 사용자가 직접 누른 수집·검색이 먼저입니다
                    continue
                now = time.time()
                for p in list(lanes):
                    if hold or p in active or now < next_at[p]:
                        continue
                    # 최소 간격이 아직 안 지난 페이지는 두고, 이 매체 줄에서 지금 열 수 있는 다음 페이지부터 엽니다.
                    k = next((k for k, x in enumerate(lanes[p]) if self._ready_at(x) <= now), None)
                    if k is None:
                        continue
                    t = lanes[p].pop(k)
                    t["started"] = True   # 이제부터는 방문 계획(cfg)을 바꿀 수 없음
                    if not lanes[p]:
                        del lanes[p]
                    try:
                        h = self._begin(p, t["url"], t["cfg"], t["via"], True)
                        active[p] = (t, h, now_ms(), time.time() + limit)
                    except Exception as e:
                        log.exception("페이지 수집 오류: %s", t["url"])
                        on_done(t, e, now_ms())
                        next_at[p] = time.time() + self._gap(p)
                        msg = self._friendly(e)
                        if "프로필" in msg or "크롬을 찾지" in msg:   # 이 매체는 더 해도 소용없음
                            for rest in lanes.pop(p, []):
                                on_done(rest, e, now_ms())
                self._ig_pump()
                for p, (t, h, t0, deadline) in list(active.items()):
                    cur, closed = h["cur"], h["page"].is_closed()
                    gone = "" if closed or cur["done"] is not None else self._gone(h)
                    if cur["done"] is not None or closed or gone or time.time() >= deadline:
                        if closed and cur["done"] is None:
                            res = RuntimeError("크롬 창이 도중에 닫혔습니다(target closed)")
                        elif gone:
                            res = ValueError(gone)
                        else:
                            res = dict(cur)
                        self._end(h)
                        if cur["done"] is None and not closed:
                            self._halt(h["page"])   # 시간 초과·이동: 남은 스크립트를 멈춥니다
                        del active[p]
                        on_done(t, res, t0)
                        next_at[p] = time.time() + self._gap(p)
                        if gone and "로그인이 풀려" in gone:   # 로그인이 풀린 매체는 남은 페이지를 열지 않습니다(로그아웃 상태로 계속 여는 것도 봇처럼 보임)
                            for rest in lanes.pop(p, []):
                                on_done(rest, ValueError(gone), now_ms())
                if progress:
                    now = time.time()
                    progress([a[0] for a in active.values()], [x for ts in lanes.values() for x in ts if self._ready_at(x) > now])
                self._serve_side_jobs()
                pump = next((a[1]["page"] for a in active.values() if not a[1]["page"].is_closed()), None)
                if pump is not None:
                    try:
                        pump.wait_for_timeout(250)   # 이 사이에 모든 창의 수집 스크립트 메시지를 받습니다
                    except Exception:
                        time.sleep(0.05)
                else:
                    time.sleep(0.25)
        finally:
            self.depth -= 1
            for t, h, t0, _ in active.values():
                self._end(h)
                self._halt(h["page"])
                on_done(t, RuntimeError("수집이 중단되었습니다"), t0)

    # ----- 로그인 상태 -----
    def _ensure_login(self, platforms):
        """수집 전에, 오래된(또는 모르는) X·인스타 테스트 계정 로그인 상태를 다시 확인합니다."""
        st, now, todo = get_login_state(), now_ms(), []
        for p in platforms:
            if p == "youtube":
                continue  # 유튜브 채널은 로그인 없이도 보입니다
            s = st.get(p) or {}
            age = now - (s.get("at") or 0)
            if age < (LOGIN_OK_MS if s.get("loggedIn") is True else LOGIN_BAD_MS):
                continue
            todo.append(p)
        if todo:
            self._check_login(todo)

    # ----- 작업 종류별 -----
    def _collect(self, job):
        """사용자 수집. 여러 사용자가 동시에 누르면 한꺼번에 처리합니다: 대기 중인 사용자의 페이지도 비어 있는 매체 줄에 바로 끼워 넣고,
        같은 페이지를 여러 사용자가 원하면 한 번만 방문해서 같이 씁니다. 끝났을 때 그사이 들어온 요청(새로 추가한 계정 등)이 있으면 이어서 모읍니다."""
        batch = {}       # uid → 이 사용자의 진행 상황
        by_url = {}      # 주소 → 이번 묶음에서 아직 안 끝난 페이지(같은 페이지 함께 쓰기)
        extra = []       # 도는 중에 새로 생긴 페이지

        def finish(ctx):
            """사용자의 페이지가 다 끝났을 때: 결과를 적고, 그사이 들어온 요청이 있으면 이어서 준비합니다."""
            if ctx.get("final"):
                return
            msg = self._collect_message(ctx)
            with self.lock:
                stopped = ctx["uid"] in self.cancel_users
                more = ctx["uid"] in self.pending and not stopped
                if not more:
                    self.pending.pop(ctx["uid"], None)
                    self.queued_users.discard(ctx["uid"])
                    self.cancel_users.discard(ctx["uid"])
            if more:
                set_status(ctx["uid"], running=True, paused=False, closed=False, lastRun=now_ms(), message=msg + " · 이어서 추가된 계정을 모읍니다…")
                batch.pop(ctx["uid"], None)
                extra.extend(prepare(ctx["uid"], ctx["mode"]))
            else:
                ctx["final"] = True
                set_status(ctx["uid"], running=False, paused=False, closed=False, lastRun=now_ms(), message=msg)

        def prepare(uid, mode) -> list:
            with self.lock:
                want = self.pending.pop(uid, None)
                stopped = uid in self.cancel_users
            ctx = {"uid": uid, "mode": mode, "deep": mode == "deep", "started": now_ms(), "visited": 0, "detail": {}, "errors": [],
                   "left": 0, "total": 0, "done": 0, "skipped": set(), "tracked": [], "targets": [], "all": [], "urls": set()}
            batch[uid] = ctx
            if stopped or want is None:
                ctx["errors"].append("수집을 멈췄습니다")
                finish(ctx)
                return []
            new = extend(ctx, want)
            if ctx["left"] == 0:
                finish(ctx)
            return new

        def extend(ctx, want) -> list:
            """ctx 사용자의 모을 페이지를 더합니다(처음 준비할 때, 그리고 수집 중에 계정을 새로 추가했을 때)."""
            uid, mode = ctx["uid"], ctx["mode"]
            new = []
            try:
                st = read_user(uid)
                ctx["all"] = [t["id"] for t in st["tracked"]]
                tracked = st["tracked"][:30]
                if want != ALL:
                    tracked = [t for t in tracked if t.get("id") in want]
                ctx["tracked"] += tracked
                settings = st["settings"]
                if not ctx["total"]:
                    set_status(uid, running=True, closed=False, paused=False, message="수집 준비 중…")
                first = len(ctx["targets"])
                # 숨긴 묶음의 계정은 모으지 않습니다(숨기는 동안 사이트 방문을 줄여 테스트 계정이 봇으로 보일 위험을 낮춤).
                hidden = [t for t in tracked if t.get("hidden") is True]
                ctx["hidden"] = ctx.get("hidden", 0) + len(hidden)
                tracked = [t for t in tracked if t.get("hidden") is not True]
                self._ensure_login({t.get("platform") for t in tracked if settings.get(t.get("platform")) is not False})
                logins = get_login_state()
                for t in tracked:
                    p = t.get("platform")
                    if p not in PLATFORMS or settings.get(p) is False:
                        continue
                    # 유튜브 채널은 로그인 없이도 보이므로 건너뛰지 않습니다. X·인스타는 로그인해야 글이 보입니다.
                    if p != "youtube" and (logins.get(p) or {}).get("loggedIn") is False:
                        ctx["skipped"].add(p)
                        continue
                    who = ("@" + t["handle"]) if t.get("handle") else t.get("channelId", "")
                    days = t["days"] if t.get("days") in (7, 14, 30, 60) else st["windowDays"]
                    for url in page_urls(t):
                        if url not in ctx["urls"]:   # 이미 이번에 모으고 있는 페이지는 다시 넣지 않음
                            ctx["urls"].add(url)
                            ctx["targets"].append((who, url, p, t["id"], days))
                for i, (who, url, p, via, days) in list(enumerate(ctx["targets"]))[first:]:
                    kind = " 영상" if url.endswith("/videos") else " 게시물" if url.endswith("/posts") else ""
                    owner = {"ctx": ctx, "i": i, "via": via, "label": who + kind, "days": days}
                    last = self.recent.get(url)
                    # 사용자가 직접 누른 수집(deep)은 건너뛰지 않습니다(새 글을 빨리 확인하려고 누르는 경우).
                    # 대신 같은 페이지를 너무 자주 열지 않게, 마지막으로 모은 뒤 매체별 최소 간격(USER_MIN_GAP_MS)이 지나야 엽니다(_ready_at).
                    # 방금 모은 페이지라도 '이미 모은 글에서 멈추기' 덕분에 대개 첫 화면만 보고 끝나 부담이 적습니다.
                    if last and not ctx["deep"] and now_ms() - last[0] < RECENT_ANY_MS:
                        ctx["detail"][i] = f"{owner['label']}: 방금 모아서 건너뜀"
                        continue
                    ctx["left"] += 1
                    ctx["total"] += 1
                    same = by_url.get(url)
                    since_ms = now_ms() - days * DAY_MS
                    if same and same["days"] >= days and same["cfg"]["mode"] == mode:
                        # 다른 사용자가 이미 요청한 같은 페이지: 한 번만 방문해서 같이 씁니다.
                        # 단, 먼저 요청한 사람 기준으로 '이미 모은 글에서 멈춤'인데 이 사용자는 처음부터 다시 모아야 하면
                        # (예: 이 사용자만 '글 모두 삭제'를 눌렀음), 아직 시작 전이면 계획을 '끝까지'로 바꾸고, 이미 방문 중이면 따로 모읍니다.
                        if not same["stop"] or cover_plan(url, via, since_ms, st["cleared"])[0]:
                            same["owners"].append(owner)
                            continue
                        if not same.get("started"):
                            same["stop"] = False
                            same["cfg"].update(stopKnown=False, known=[])
                            same["owners"].append(owner)
                            continue
                    stop_known, known, cov = cover_plan(url, via, since_ms, st["cleared"])
                    task = {"p": p, "url": url, "via": via, "days": days, "since": since_ms, "stop": stop_known, "cov": cov, "owners": [owner],
                            "cfg": {"mode": mode, "since": since_ms, "known": known, "stopKnown": stop_known}}
                    by_url[url] = task
                    new.append(task)
            except Exception as e:
                log.exception("수집 준비 오류: %s", uid)
                ctx["errors"].append(self._friendly(e))
            return new

        def account(o, res):
            ctx, i, label = o["ctx"], o["i"], o["label"]
            ctx["left"] -= 1
            ctx["done"] += 1
            if isinstance(res, Exception):
                ctx["errors"].append(self._friendly(res))
                ctx["detail"][i] = f"{label}: 오류"
            elif res.get("cancelled"):
                if "수집을 멈췄습니다" not in ctx["errors"]:
                    ctx["errors"].append("수집을 멈췄습니다")
            else:
                ctx["visited"] += 1
                d = res.get("done")
                if d:
                    why = f" [{d.get('why')}]" if d.get("why") else ""
                    ctx["detail"][i] = f"{label}: 화면 {d.get('found', 0)}개 중 {o['days']}일 이내 {d.get('sent', 0)}개{why}"
                else:
                    ctx["detail"][i] = f"{label}: 응답 없음(시간 초과)"
            if ctx["left"] <= 0:
                finish(ctx)

        def on_done(t, res, t0):
            if by_url.get(t["url"]) is t:
                del by_url[t["url"]]
            if not isinstance(res, Exception):
                cover_update(t["url"], res, t["stop"], t["cov"], t["since"], t0)
                if not res.get("cancelled"):
                    self.recent[t["url"]] = (now_ms(), t["cfg"]["mode"], t["days"])
                    others = sorted({o["via"] for o in t["owners"]} - {t["via"]})
                    if others:   # 같은 페이지를 다른 계정 ID로 추적하는 사용자에게도 글을 연결합니다
                        link_vias(t["via"], others)
            for o in t["owners"]:
                account(o, res)

        def on_drop(t, o):
            account(o, {"cancelled": True})

        def feed():
            out, extra[:] = list(extra), []
            # 수집 중에 같은 사용자가 계정을 새로 추가했으면 지금 묶음에 바로 더합니다(끝날 때까지 기다리지 않음).
            for ctx in list(batch.values()):
                if ctx.get("final") or ctx["left"] <= 0:
                    continue
                with self.lock:
                    want = self.pending.pop(ctx["uid"], None) if ctx["uid"] not in self.cancel_users else None
                if want is not None:
                    out.extend(extend(ctx, want))
            # 기다리던 다른 사용자의 수집 요청도 이번 묶음에 넣습니다.
            held = []
            while True:
                try:
                    item = self.q.get_nowait()
                except queue.Empty:
                    break
                if item[0] == 1 and item[2].get("kind") == "collect":
                    out.extend(prepare(item[2]["uid"], item[2]["mode"]))
                else:
                    held.append(item)
            for item in held:
                self.q.put(item)
            return out

        def progress(active, waiting=()):
            now = time.time()
            for ctx in list(batch.values()):
                if ctx.get("final") or ctx["left"] <= 0:
                    continue
                names = ", ".join(o["label"] for t in active for o in t.get("owners", []) if o["ctx"] is ctx)
                mine = [(o["label"], t) for t in waiting for o in t.get("owners", []) if o["ctx"] is ctx]
                wait = ""
                if mine:
                    # 방금 모은 페이지라 최소 간격을 기다리는 중: 남은 시간을 5초 단위로 올려 보여 줍니다(상태 저장이 매초 일어나지 않게).
                    secs = max(5, int(-(-(min(self._ready_at(t) for _, t in mine) - now) // 5) * 5))
                    who = mine[0][0] + (f" 외 {len(mine) - 1}곳" if len(mine) > 1 else "")
                    wait = f"{who}은(는) 방금 모은 페이지라 약 {secs}초 뒤 확인 "
                if names:
                    msg = f"확인 중: {names} " + (f"· {wait}" if wait else "")
                else:
                    msg = wait or "다음 페이지 준비 중 "
                msg += f"({ctx['done']}/{ctx['total']})"
                if ctx.get("last_msg") != msg:
                    ctx["last_msg"] = msg
                    set_status(ctx["uid"], running=True, message=msg)

        try:
            first = prepare(job["uid"], job["mode"])
            limit = DEEP_WAIT if job["mode"] == "deep" else SHALLOW_WAIT
            self._run_lanes(first, limit, on_done, feed=feed, on_drop=on_drop, progress=progress)
        except Exception as e:
            log.exception("수집 오류")
            for ctx in list(batch.values()):
                if not ctx.get("final"):
                    ctx["errors"].append(self._friendly(e))
                    ctx["left"] = 0
                    finish(ctx)
        finally:
            # 혹시 끝맺지 못한 사용자가 있으면 정리합니다(수집 중 표시가 계속 남지 않게).
            for ctx in list(batch.values()):
                if not ctx.get("final"):
                    ctx["left"] = 0
                    with self.lock:
                        self.pending.pop(ctx["uid"], None)
                    finish(ctx)
            prune_items()
            self._prune_recent()

    def _prune_recent(self):
        """건너뛰기 판단에 더는 쓰이지 않는(30분 넘게 지난) 최근 수집 기록을 지웁니다."""
        old = now_ms() - RECENT_ANY_MS
        for url in [u for u, v in self.recent.items() if v[0] < old]:
            del self.recent[url]

    def _collect_message(self, ctx) -> str:
        added = count_new(ctx["all"], ctx["started"])
        detail = [ctx["detail"][k] for k in sorted(ctx["detail"])]
        parts = [f"페이지 {ctx['visited']}곳 확인 · 새 글 {added}건"]
        if detail:
            parts.append(" / ".join(detail))
        if ctx["skipped"]:
            parts.append("서버 테스트 계정이 로그인되어 있지 않아 건너뜀: " + ", ".join(PLATFORM_KO[p] for p in sorted(ctx["skipped"])) + " (관리자 확인 필요)")
        if ctx.get("hidden"):
            parts.append(f"숨긴 묶음의 계정 {ctx['hidden']}개는 수집하지 않음")
        errors = ctx["errors"]
        if errors:
            other = [e for e in errors if e != "수집을 멈췄습니다"]
            if other:
                parts.append(f"오류 {len(other)}건: {other[0]}")
            if "수집을 멈췄습니다" in errors:
                parts.append("수집을 멈췄습니다")
        if errors == ["수집을 멈췄습니다"] and not ctx["targets"]:
            return "수집을 멈췄습니다."
        if not ctx["tracked"] and not errors:
            return "확인할 계정이 없습니다. 추적 계정을 추가하세요."
        if not ctx["targets"] and not ctx["skipped"] and not errors:
            if ctx.get("hidden") and ctx["hidden"] >= len(ctx["tracked"]):
                return "수집할 계정이 없습니다. 숨긴 묶음은 수집하지 않습니다(추적 계정 관리에서 다시 보이게 할 수 있습니다)."
            return "수집할 계정이 없습니다. 매체 아이콘에서 수집이 꺼져 있는지 확인하세요."
        return " · ".join(parts)

    def _auto(self):
        """서버 자동 수집: 모든 사용자의 추적 계정을 모아(겹치는 계정은 한 번만) 첫 화면 위주로 확인합니다."""
        with get_db() as db:
            rows = db.execute("SELECT user_id, tracked, settings, window_days, cleared_before FROM user_state").fetchall()
        wanted = set()
        for row in rows:
            settings = json.loads(row["settings"])
            wanted |= {t.get("platform") for t in json.loads(row["tracked"])[:30] if settings.get(t.get("platform")) is not False and t.get("hidden") is not True}
        self._ensure_login(wanted & set(PLATFORMS))
        logins = get_login_state()
        pages = {}   # 주소 → {"p", "via", "days", "users"}
        for row in rows:
            settings = json.loads(row["settings"])
            for t in json.loads(row["tracked"])[:30]:
                p = t.get("platform")
                if p not in PLATFORMS or settings.get(p) is False or t.get("kind") == "feed":
                    continue
                if t.get("hidden") is True:
                    continue   # 숨긴 묶음은 모으지 않음(같은 계정을 숨기지 않은 다른 사용자가 있으면 그 사용자 몫으로 모음)
                if p != "youtube" and (logins.get(p) or {}).get("loggedIn") is False:
                    continue
                days = t["days"] if t.get("days") in (7, 14, 30, 60) else row["window_days"]
                for url in page_urls(t):
                    e = pages.setdefault(url, {"p": p, "vias": set(), "days": 0, "users": set(), "cleared": 0})
                    e["cleared"] = max(e["cleared"], row["cleared_before"])
                    e["days"] = max(e["days"], days)
                    e["vias"].add(t["id"])
                    e["users"].add(row["user_id"])
        if not pages:
            kv_set("lastAuto", now_ms())
            return
        log.info("자동 수집 시작: 페이지 %d곳", len(pages))
        started, visited = now_ms(), 0
        tasks = []
        for url, e in pages.items():
            last = self.recent.get(url)
            if last and now_ms() - last[0] < RECENT_ANY_MS:
                continue
            vias = sorted(e["vias"])
            since_ms = now_ms() - e["days"] * DAY_MS
            stop_known, known, cov = cover_plan(url, vias[0], since_ms, e["cleared"])
            tasks.append({"p": e["p"], "url": url, "via": vias[0], "vias": vias, "days": e["days"], "since": since_ms, "stop": stop_known, "cov": cov,
                          "cfg": {"mode": "shallow", "since": since_ms, "known": known, "stopKnown": stop_known}})
        done = {"n": 0}

        def on_done(t, res, t0):
            if isinstance(res, Exception):
                return
            cover_update(t["url"], res, t["stop"], t["cov"], t["since"], t0)
            if len(t["vias"]) > 1:   # 같은 계정을 다른 ID로 추적하는 사용자에게도 글을 연결합니다
                link_vias(t["vias"][0], t["vias"][1:])
            self.recent[t["url"]] = (now_ms(), "shallow", t["days"])
            done["n"] += 1

        self._run_lanes(tasks, SHALLOW_WAIT, on_done, yield_to_users=True)
        visited = done["n"]
        prune_items()
        self._prune_recent()
        kv_set("lastAuto", now_ms())
        # 각 사용자에게 결과를 알립니다(그 사용자가 직접 수집 중이면 건드리지 않음).
        users = set().union(*(e["users"] for e in pages.values()))
        for uid in users:
            st = read_user(uid)
            if st["status"].get("running"):
                continue
            added = count_new([t["id"] for t in st["tracked"]], started)
            set_status(uid, lastRun=now_ms(), message=f"서버 자동 수집({AUTO_LABEL}) · 페이지 {visited}곳 확인 · 새 글 {added}건")
        log.info("자동 수집 끝: 페이지 %d곳 확인", visited)

    def _search(self, platform: str, q: str) -> list:
        url = search_url(platform, q)
        if not url:
            raise ValueError("매체가 올바르지 않습니다.")
        if platform != "youtube" and (get_login_state().get(platform) or {}).get("loggedIn") is False:
            raise ValueError(f"서버의 {PLATFORM_KO[platform]} 테스트 계정이 로그인되어 있지 않아 검색할 수 없습니다. "
                             "관리자가 서버 PC에서 login_setup.bat으로 로그인해야 합니다.")
        res = self._visit(platform, url, {"mode": "search", "q": q, "since": 0}, limit=SEARCH_WAIT)
        return clean_results((res.get("done") or {}).get("results"))

    def _post(self, url: str):
        res = self._visit("youtube", url, {"mode": "post", "since": 0}, limit=POST_WAIT)
        post = clean_post((res.get("done") or {}).get("post"))
        if not post:
            raise ValueError("게시물 내용을 읽지 못했습니다.")
        return post

    def _check_login(self, platforms):
        for p in platforms:
            try:
                res = self._visit(p, LOGIN_URLS[p], {"mode": "login", "since": 0}, limit=LOGIN_WAIT, until_login=True)
                if res.get("login") is None:
                    set_login(p, None)  # 알 수 없음(확인한 시각만 남김)
            except Exception:
                log.exception("로그인 확인 오류: %s", p)


collector = Collector()
