"""수집기: 서버 PC의 크롬(Playwright)으로 SNS 페이지를 열어 글을 모읍니다.

- 페이지 안에서 하는 일(스크롤·화면 읽기)은 크롬 확장의 수집 스크립트(scripts/*.js)를 그대로 씁니다.
  확장 API(chrome.runtime 등)만 가짜 객체(SHIM)로 바꿔 끼워, 결과가 이 파일의 _on_msg로 오게 합니다.
- Playwright는 작업 스레드 하나에서만 씁니다. 웹 요청은 작업을 큐에 넣고, 필요하면 결과를 기다립니다.
- 매체마다 크롬 프로필이 따로 있습니다: server/profiles/<매체>  (테스트 계정 로그인 정보가 저장되는 곳)
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
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from db import get_db

log = logging.getLogger("collector")

BASE = Path(__file__).resolve().parent
PROFILES = BASE.parent / "profiles"
SCRIPTS = BASE / "scripts"

PLATFORMS = ("youtube", "x", "instagram")
PLATFORM_KO = {"youtube": "유튜브", "x": "X", "instagram": "인스타"}
DAY_MS = 86400000
MAX_ITEMS = 20000                 # DB에 남길 글 수(넘으면 오래 전에 모은 것부터 지움)

DEEP_WAIT, SHALLOW_WAIT = 510, 40   # 페이지 하나당 최대 대기(초): 지금 최신화 / 자동 확인
SEARCH_WAIT, POST_WAIT, LOGIN_WAIT = 30, 30, 15
IDLE_CLOSE = 120                  # 할 일이 없으면 2분 뒤 크롬 창을 닫습니다
AUTO_EVERY_MS = 3600 * 1000       # 자동 수집 주기(1시간): 서버가 켜져 있으면 모든 사용자의 추적 계정을 모읍니다
AUTO_FIRST_DELAY = 60             # 서버를 켠 뒤 첫 자동 수집까지 최소 대기(초)
RECENT_DEEP_MS = 3 * 60000        # 같은 페이지를 방금(3분 안) 깊게 모았으면 다른 사용자 요청은 건너뜀
RECENT_ANY_MS = 30 * 60000        # 자동 확인은 30분 안에 모은 페이지를 건너뜀

LOGIN_URLS = {"youtube": "https://www.youtube.com/", "x": "https://x.com/home", "instagram": "https://www.instagram.com/"}

SOURCES = {"youtube-video", "youtube-post", "x", "instagram"}
URL_OK = re.compile(r"^https://(www\.youtube\.com|x\.com|twitter\.com|www\.instagram\.com)/")
HANDLE_OK = re.compile(r"^[^\s/?#@]{1,60}$")
CHANNEL_OK = re.compile(r"^UC[\w-]{22}$")
LEGACY_OK = re.compile(r"^https://www\.youtube\.com/(c|user)/[^/?#]+$")
POST_URL_OK = re.compile(r"^https://www\.youtube\.com/post/[\w-]{10,60}$")

CHROME_ARGS = [
    "--window-size=1000,800",
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
  const send = (m) => { try { window.__snsBridge(JSON.stringify(m)); } catch (e) {} };
  const chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => p,
      sendMessage(msg, cb) {
        if (msg && msg.type === "hello") {
          let res = { auto: false };
          if (once) { res = { auto: true, mode: cfg.mode, since: cfg.since, q: cfg.q || "" }; once = false; cfg.mode = ""; }
          else if (cfg.mode) res = { auto: true, mode: cfg.mode, since: cfg.since };
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


def save_items(raw_items, via: str) -> int:
    n = 0
    with get_db() as db:
        for raw in (raw_items or [])[:200]:
            it = sanitize(raw)
            if not it:
                continue
            old = db.execute("SELECT * FROM items WHERE id = ?", (it["id"],)).fetchone()
            if old:
                merged = {k: (it[k] or old[k]) for k in ("url", "title", "author", "thumb", "published_text")}
                merged["published_at"] = earlier(old["published_at"], it["published_at"]) if old["published_at"] and it["published_at"] else (it["published_at"] or old["published_at"])
                merged["via"] = old["via"] or via
                db.execute(
                    "UPDATE items SET url=?, title=?, author=?, thumb=?, published_text=?, published_at=?, via=? WHERE id=?",
                    (merged["url"], merged["title"], merged["author"], merged["thumb"], merged["published_text"],
                     merged["published_at"], merged["via"], it["id"]),
                )
            else:
                db.execute(
                    """INSERT INTO items(id, source, url, title, author, thumb, published_at, published_text, via, collected_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (it["id"], it["source"], it["url"], it["title"], it["author"], it["thumb"],
                     it["published_at"], it["published_text"], via, now_ms()),
                )
                n += 1
    return n


def prune_items():
    with get_db() as db:
        db.execute("""DELETE FROM items WHERE id IN
                      (SELECT id FROM items ORDER BY collected_at DESC LIMIT -1 OFFSET ?)""", (MAX_ITEMS,))


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
        return {"tracked": [], "settings": {}, "windowDays": 30, "status": {}}
    return {"tracked": json.loads(row["tracked"]), "settings": json.loads(row["settings"]),
            "windowDays": row["window_days"], "status": json.loads(row["status"])}


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
        self.q = queue.PriorityQueue()   # (우선순위, 순번, 작업)  0 = 검색 등 급한 일, 1 = 수집
        self.seq = itertools.count()
        self.pw = None
        self.ctxs, self.pages = {}, {}
        self.last_used = 0.0
        self.cur = None                  # 지금 열린 페이지의 수집 상태
        self.lock = threading.Lock()
        self.queued_users = set()        # 수집 대기/진행 중인 사용자
        self.cancel_users = set()
        self.recent = {}                 # 페이지 주소 → (마지막 수집 시각, mode)
        self.login_busy = False
        self.bundles = {}
        self.thread = None
        self.next_auto = 0.0             # 다음 자동 수집 시각(초)

    # ----- 웹 요청 쪽에서 부르는 함수 -----
    def start(self):
        reset_running()
        last = (kv_get("lastAuto", 0) or 0) / 1000
        self.next_auto = max(last + AUTO_EVERY_MS / 1000, time.time() + AUTO_FIRST_DELAY)
        self.thread = threading.Thread(target=self._loop, name="collector", daemon=True)
        self.thread.start()

    def request_collect(self, uid: str, mode: str, only: str = "") -> bool:
        with self.lock:
            if uid in self.queued_users:
                return False
            self.queued_users.add(uid)
            self.cancel_users.discard(uid)
        set_status(uid, running=True, closed=False, paused=False, message="수집 대기 중…")
        self.q.put((1, next(self.seq), {"kind": "collect", "uid": uid, "mode": mode, "only": only}))
        return True

    def cancel(self, uid: str):
        with self.lock:
            self.cancel_users.add(uid)

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
            raise TimeoutError("서버 수집기가 바빠서 시간 안에 끝내지 못했습니다. 잠시 뒤 다시 시도하세요.")
        if job.get("error"):
            raise RuntimeError(job["error"])
        return job.get("result")

    # ----- 작업 스레드 -----
    def _loop(self):
        if sys.platform == "win32":
            # Playwright는 크롬을 하위 프로세스로 띄우므로 윈도우에서는 Proactor 이벤트 루프가 필요합니다.
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
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
        except Exception as e:
            log.exception("수집 작업 오류: %s", job.get("kind"))
            job["error"] = self._friendly(e)
        finally:
            self.last_used = time.time()
            if job["kind"] == "collect":
                with self.lock:
                    self.queued_users.discard(job["uid"])
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
        kw = dict(user_data_dir=str(d), headless=False, no_viewport=True, args=CHROME_ARGS,
                  ignore_default_args=["--enable-automation"])
        try:
            return self.pw.chromium.launch_persistent_context(channel="chrome", **kw)
        except Exception as e:
            if "already in use" in str(e).lower() or "ProcessSingleton" in str(e):
                raise
            log.warning("설치된 크롬으로 띄우지 못해 Playwright 기본 브라우저로 시도합니다: %s", str(e).splitlines()[0])
            return self.pw.chromium.launch_persistent_context(**kw)

    def _page(self, platform: str, retry: bool = True):
        if not self.pw:
            from playwright.sync_api import sync_playwright
            self.pw = sync_playwright().start()
        ctx = self.ctxs.get(platform)
        if ctx is None:
            ctx = self._launch(platform)
            ctx.expose_function("__snsBridge", self._on_msg)
            ctx.add_init_script(VISIBLE_JS)
            ctx.on("close", lambda *_: (self.ctxs.pop(platform, None), self.pages.pop(platform, None)))
            self.ctxs[platform] = ctx
        try:
            page = self.pages.get(platform)
            if page is None or page.is_closed():
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                self.pages[platform] = page
            return page
        except Exception as e:
            # 서버 PC에서 누가 크롬 창을 직접 닫으면, 수집기는 다음에 쓸 때야 알게 됩니다. 버리고 새로 띄웁니다.
            if retry and is_closed_error(e):
                log.info("%s 크롬 창이 닫혀 있어 다시 엽니다.", platform)
                self._drop(platform)
                return self._page(platform, retry=False)
            raise

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

    def _on_msg(self, raw: str):
        """수집 스크립트가 보낸 메시지(확장 시절 background로 가던 것)."""
        cur = self.cur
        if not cur:
            return
        try:
            m = json.loads(raw)
        except Exception:
            return
        t = m.get("type")
        if t == "items" and cur.get("save") and isinstance(m.get("items"), list):
            cur["added"] += save_items(m["items"], cur["via"])
        elif t == "autoDone":
            cur["done"] = m
        elif t == "login" and isinstance(m.get("loggedIn"), bool):
            set_login(cur["platform"], m["loggedIn"])
            cur["login"] = m["loggedIn"]

    def _visit(self, platform, url, cfg, via="", limit=30, save=False, cancel=None, until_login=False, retry=True):
        """페이지를 열고 수집 스크립트를 넣은 뒤, 스크립트가 '끝'을 알릴 때까지 기다립니다.
        도중에 크롬 창이 닫히면 한 번만 새 창으로 다시 시도합니다."""
        try:
            return self._visit_once(platform, url, cfg, via, limit, save, cancel, until_login)
        except Exception as e:
            if not (retry and is_closed_error(e)):
                raise
            log.info("%s 크롬 창이 도중에 닫혀 다시 시도합니다.", platform)
            self._drop(platform)
            return self._visit_once(platform, url, cfg, via, limit, save, cancel, until_login)

    def _visit_once(self, platform, url, cfg, via, limit, save, cancel, until_login):
        page = self._page(platform)
        self.cur = {"platform": platform, "via": via, "save": save, "done": None, "added": 0, "login": None}
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            try:
                page.wait_for_load_state("load", timeout=10000)
            except Exception:
                pass
            page.evaluate(self._bundle(platform), cfg)
            end = time.time() + limit
            while self.cur["done"] is None and time.time() < end:
                if cancel and cancel():
                    return {"cancelled": True, **self.cur}
                if until_login and self.cur["login"] is not None:
                    break
                page.wait_for_timeout(250)
            return dict(self.cur)
        finally:
            self.cur = None

    # ----- 작업 종류별 -----
    def _collect(self, job):
        uid, mode, only = job["uid"], job["mode"], job.get("only") or ""
        deep = mode == "deep"
        st = read_user(uid)
        tracked = st["tracked"][:30]
        if only:
            tracked = [t for t in tracked if t.get("id") == only]
        settings, logins = st["settings"], get_login_state()
        targets, skipped_login = [], set()
        for t in tracked:
            p = t.get("platform")
            if p not in PLATFORMS or settings.get(p) is False:
                continue
            # 유튜브 채널은 로그인 없이도 보이므로 건너뛰지 않습니다. X·인스타는 로그인해야 글이 보입니다.
            if p != "youtube" and (logins.get(p) or {}).get("loggedIn") is False:
                skipped_login.add(p)
                continue
            who = ("@" + t["handle"]) if t.get("handle") else t.get("channelId", "")
            days = t["days"] if t.get("days") in (7, 14, 30, 60) else st["windowDays"]
            for url in page_urls(t):
                targets.append((who, url, p, t["id"], days))

        started = now_ms()
        visited, detail, errors = 0, [], []
        set_status(uid, running=True, closed=False, paused=False, message="")
        cancelled = lambda: uid in self.cancel_users
        for i, (who, url, p, via, days) in enumerate(targets):
            if cancelled():
                errors.append("사용자가 수집을 종료했습니다")
                break
            self._run_urgent()
            kind = " 영상" if url.endswith("/videos") else " 게시물" if url.endswith("/posts") else ""
            last = self.recent.get(url)
            if last and ((deep and last[1] == "deep" and now_ms() - last[0] < RECENT_DEEP_MS) or (not deep and now_ms() - last[0] < RECENT_ANY_MS)):
                detail.append(f"{who}{kind}: 방금 모아서 건너뜀")
                continue
            set_status(uid, running=True, message=f"확인 중: {who} ({i + 1}/{len(targets)})")
            try:
                res = self._visit(p, url, {"mode": mode, "since": now_ms() - days * DAY_MS}, via=via,
                                  limit=DEEP_WAIT if deep else SHALLOW_WAIT, save=True, cancel=cancelled)
                if res.get("cancelled"):
                    errors.append("사용자가 수집을 종료했습니다")
                    break
                visited += 1
                self.recent[url] = (now_ms(), mode)
                d = res.get("done")
                if d:
                    why = f" [{d.get('why')}]" if d.get("why") else ""
                    detail.append(f"{who}{kind}: 화면 {d.get('found', 0)}개 중 {days}일 이내 {d.get('sent', 0)}개{why}")
                else:
                    detail.append(f"{who}{kind}: 응답 없음(시간 초과)")
            except Exception as e:
                log.exception("페이지 수집 오류: %s", url)
                errors.append(self._friendly(e))
                if "프로필" in errors[-1] or "크롬을 찾지" in errors[-1]:
                    break
            if i < len(targets) - 1:
                time.sleep(random.uniform(1.5, 3.0) if p == "instagram" else random.uniform(1.0, 2.0) if p == "x" else random.uniform(0.4, 0.8))

        with get_db() as db:
            vias = [t["id"] for t in tracked] or [""]
            added = db.execute(f"SELECT COUNT(*) FROM items WHERE via IN ({','.join('?' * len(vias))}) AND collected_at >= ?",
                               (*vias, started)).fetchone()[0]
        prune_items()
        parts = [f"최근 {st['windowDays']}일 · 페이지 {visited}곳 확인 · 새 글 {added}건"]
        if detail:
            parts.append(" / ".join(detail))
        if skipped_login:
            parts.append("서버 테스트 계정 로그인 필요로 건너뜀: " + ", ".join(PLATFORM_KO[p] for p in skipped_login))
        if errors:
            parts.append(f"오류 {len(errors)}건: {errors[0]}")
        if not targets and not skipped_login:
            parts = ["확인할 계정이 없습니다. 추적 계정을 추가하세요."]
        set_status(uid, running=False, paused=False, closed=False, lastRun=now_ms(), message=" · ".join(parts))
        with self.lock:
            self.cancel_users.discard(uid)

    def _auto(self):
        """서버 자동 수집: 모든 사용자의 추적 계정을 모아(겹치는 계정은 한 번만) 첫 화면 위주로 확인합니다."""
        with get_db() as db:
            rows = db.execute("SELECT user_id, tracked, settings, window_days FROM user_state").fetchall()
        logins = get_login_state()
        pages = {}   # 주소 → {"p", "via", "days", "users"}
        for row in rows:
            settings = json.loads(row["settings"])
            for t in json.loads(row["tracked"])[:30]:
                p = t.get("platform")
                if p not in PLATFORMS or settings.get(p) is False or t.get("kind") == "feed":
                    continue
                if p != "youtube" and (logins.get(p) or {}).get("loggedIn") is False:
                    continue
                days = t["days"] if t.get("days") in (7, 14, 30, 60) else row["window_days"]
                for url in page_urls(t):
                    e = pages.setdefault(url, {"p": p, "via": t["id"], "days": 0, "users": set()})
                    e["days"] = max(e["days"], days)
                    e["users"].add(row["user_id"])
        if not pages:
            kv_set("lastAuto", now_ms())
            return
        log.info("자동 수집 시작: 페이지 %d곳", len(pages))
        started, visited = now_ms(), 0
        for i, (url, e) in enumerate(pages.items()):
            self._run_urgent(upto=1)   # 사용자가 직접 누른 수집·검색이 먼저입니다
            last = self.recent.get(url)
            if last and now_ms() - last[0] < RECENT_ANY_MS:
                continue
            try:
                self._visit(e["p"], url, {"mode": "shallow", "since": now_ms() - e["days"] * DAY_MS},
                            via=e["via"], limit=SHALLOW_WAIT, save=True)
                self.recent[url] = (now_ms(), "shallow")
                visited += 1
            except Exception:
                log.exception("자동 수집 오류: %s", url)
            if i < len(pages) - 1:
                time.sleep(random.uniform(1.5, 3.0) if e["p"] == "instagram" else random.uniform(1.0, 2.0) if e["p"] == "x" else random.uniform(0.4, 0.8))
        prune_items()
        kv_set("lastAuto", now_ms())
        # 각 사용자에게 결과를 알립니다(그 사용자가 직접 수집 중이면 건드리지 않음).
        users = set().union(*(e["users"] for e in pages.values()))
        for uid in users:
            st = read_user(uid)
            if st["status"].get("running"):
                continue
            vias = [t["id"] for t in st["tracked"]] or [""]
            with get_db() as db:
                added = db.execute(f"SELECT COUNT(*) FROM items WHERE via IN ({','.join('?' * len(vias))}) AND collected_at >= ?",
                                   (*vias, started)).fetchone()[0]
            set_status(uid, lastRun=now_ms(), message=f"서버 자동 수집(1시간마다) · 페이지 {visited}곳 확인 · 새 글 {added}건")
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
