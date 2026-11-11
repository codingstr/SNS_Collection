"""/api/call : 웹 화면의 글 목록·추적 계정·수집 요청을 처리합니다.

화면(js/bridge.js의 call 함수)이 보내는 형식:
  POST /api/call  {"session": "...", "op": "get" | "set" | "checkNow" | ..., "payload": {...}}
  성공: {"ok": true, "result": ...}   실패: {"ok": false, "error": "메시지"}

op 이름과 result 형식은 예전 크롬 확장 시절과 같게 유지해서 화면 코드를 거의 그대로 씁니다.
실제 수집(checkNow, searchAccount 등)은 수집기(collector)가 서버 PC의 크롬으로 합니다.
"""
import base64
import hashlib
import json
import logging
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from auth import user_by_session
from collector import SearchCancelled, collector, get_login_state
from collector.runner import AUTO_EVERY_MS, LOGIN_ACCTS, save_post, saved_post
from db import get_db, reset_seen

router = APIRouter()
log = logging.getLogger("api_call")

PLATFORMS = ("youtube", "x", "instagram")
MAX_TRACKED = 30
MAX_ITEMS = 5000
DAYS_OK = (7, 14, 30, 60)
HANDLE_OK = re.compile(r"^[^\s/?#@]{1,60}$")
CHANNEL_OK = re.compile(r"^UC[\w-]{22}$")
RESOLVE_OK = re.compile(r"^https://www\.youtube\.com/(c|user)/[^/?#]+$")

COLLECTOR_OPS = ("checkNow", "checkLogin", "cancelCheck", "searchAccount", "cancelSearch", "fetchPost")
SID_OK = re.compile(r"^[A-Za-z0-9_-]{8,40}$")   # 화면이 검색마다 붙이는 검색 번호
AVATAR_MAX = 80000                 # 계정 사진 캐시에 넣는 데이터 주소 최대 길이(글자)


class OpError(Exception):
    """화면에 그대로 보여 줄 오류 메시지."""


# ---------- 사용자 상태 ----------
def load_state(db, uid: str) -> dict:
    row = db.execute("SELECT * FROM user_state WHERE user_id = ?", (uid,)).fetchone()
    if row is None:
        # 처음 한 번만 행을 만듭니다(예전에는 화면이 상태를 읽을 때마다 쓰기가 일어나 수집기의 저장과 잠금을 다퉜음).
        db.execute("INSERT OR IGNORE INTO user_state(user_id) VALUES (?)", (uid,))
        row = db.execute("SELECT * FROM user_state WHERE user_id = ?", (uid,)).fetchone()
    return {
        "tracked": json.loads(row["tracked"]),
        "settings": json.loads(row["settings"]),
        "windowDays": row["window_days"],
        "status": json.loads(row["status"]),
        "clearedBefore": row["cleared_before"],
        "seenReset": row["seen_reset"],
    }


def clean_tracked(lst) -> list:
    """추적 계정 목록 검사: 이상한 값은 버립니다."""
    if not isinstance(lst, list):
        raise OpError("계정 목록 형식이 올바르지 않습니다.")
    out = []
    for t in lst[:MAX_TRACKED]:
        if not isinstance(t, dict) or t.get("platform") not in PLATFORMS:
            continue
        tid = t.get("id")
        if not isinstance(tid, str) or len(tid) > 200:
            continue
        if t.get("kind") == "feed":
            continue  # "내 피드"는 서버 방식에서 지원하지 않습니다(서버 테스트 계정의 피드가 되기 때문)
        c = {"id": tid, "platform": t["platform"], "handle": ""}
        handle = t.get("handle")
        if isinstance(handle, str) and (handle == "" or HANDLE_OK.match(handle)):
            c["handle"] = handle
        else:
            continue
        if isinstance(t.get("channelId"), str) and CHANNEL_OK.match(t["channelId"]):
            c["channelId"] = t["channelId"]
        if isinstance(t.get("resolveUrl"), str) and len(t["resolveUrl"]) < 200 and RESOLVE_OK.match(t["resolveUrl"]):
            c["resolveUrl"] = t["resolveUrl"]
        if isinstance(t.get("group"), str) and t["group"].strip():
            c["group"] = t["group"].strip()[:30]
        if t.get("days") in DAYS_OK:
            c["days"] = t["days"]
        if t.get("hidden") is True:
            c["hidden"] = True   # 홈 화면·그룹 줄에서 숨김(표시만 숨기고 수집은 계속)
        out.append(c)
    return out


# ---------- 글 ----------
def item_dict(r) -> dict:
    return {
        "id": r["id"], "source": r["source"], "url": r["url"], "title": r["title"], "author": r["author"],
        "thumb": r["thumb"], "publishedAt": r["published_at"], "publishedText": r["published_text"],
        "via": r["uvia"], "collectedAt": r["collected_at"],
        # 이 사용자의 추적 계정 중 이 글이 이어진 모든 계정(인스타 공동 게시물처럼 한 글이 두 계정에 올라온 경우 둘 다)
        "vias": sorted(set((r["uvias"] or r["uvia"] or "").split(","))) if (r["uvias"] or r["uvia"]) else [],
    }


def items_for(db, state: dict, known_ver: str):
    """이 사용자가 추적 중인 계정의 글. 화면이 가진 버전(ver)과 같으면 글 목록은 보내지 않습니다(데이터 절약).

    글과 추적 계정은 item_via로 이어져 있어서, 같은 계정을 다른 사용자가 다른 이름으로 추가해도 각자 보입니다.
    via는 이 사용자의 추적 계정 ID로 돌려줍니다(화면이 계정별로 묶는 데 씀). vias는 그 글이 이어진 이 사용자의 모든 계정입니다.
    '글 모두 삭제'를 누른 뒤에는 그 뒤에 새로 모았거나 다시 본 글만 보입니다.
    """
    vias = [t["id"] for t in state["tracked"]]
    if not vias:
        return "empty", {}
    marks = ",".join("?" * len(vias))
    src = f"FROM item_via v JOIN items i ON i.id = v.item_id WHERE v.via IN ({marks}) AND MAX(i.collected_at, i.seen_at) > ?"
    args = (*vias, state["clearedBefore"])
    # 버전: 글 수·가장 최근 수집·가장 최근 내용 변경(썸네일·제목·날짜 보충 등). 내용이 바뀐 글도 화면에 다시 보내집니다.
    cnt, mx, upd = db.execute(f"SELECT COUNT(DISTINCT i.id), MAX(i.collected_at), MAX(i.updated_at) {src}", args).fetchone()
    # 끝의 "v2": 글에 vias가 붙으면서 형식이 바뀜 → 예전 형식 글을 가진 화면도 한 번 새로 받게 합니다
    ver = hashlib.sha1(f"{cnt}:{mx}:{upd}:{','.join(vias)}:{state['clearedBefore']}:v2".encode()).hexdigest()[:16]
    if ver == known_ver:
        return ver, None
    rows = db.execute(f"SELECT i.*, MIN(v.via) AS uvia, GROUP_CONCAT(v.via) AS uvias {src} GROUP BY i.id ORDER BY i.collected_at DESC LIMIT {MAX_ITEMS}", args).fetchall()
    return ver, {r["id"]: item_dict(r) for r in rows}


# ---------- 요청 처리 ----------
def handle(db, uid: str, op: str, p: dict):
    if op == "resumeCheck":
        return True  # 수집 일시정지는 서버 방식에서 생기지 않습니다(화면 호환용)

    if op == "get":
        st = load_state(db, uid)
        ver, items = items_for(db, st, str(p.get("ver") or ""))
        res = {
            "ver": ver,
            "settings": st["settings"],
            "tracked": st["tracked"],
            "autoCheck": {"enabled": True, "minutes": AUTO_EVERY_MS // 60000},
            "status": st["status"],
            "loginState": get_login_state(),  # 서버 테스트 계정의 로그인 상태(모든 사용자 공통)
            "windowDays": st["windowDays"],
            "nextAuto": int(collector.next_auto * 1000),  # 다음 서버 자동 수집 시각(밀리초)
            "seenReset": st["seenReset"],                 # 본 글 기록을 비운 시각: 화면이 더 늦은 값을 보면 자기 읽음 표시도 버림
        }
        if items is None:
            res["same"] = True        # 화면이 가진 글 목록 그대로 쓰면 됨
        else:
            res["items"] = items
        return res

    if op == "set":
        load_state(db, uid)  # 행이 없으면 만듭니다
        if "tracked" in p:
            db.execute("UPDATE user_state SET tracked = ? WHERE user_id = ?",
                       (json.dumps(clean_tracked(p["tracked"]), ensure_ascii=False), uid))
        if isinstance(p.get("settings"), dict):
            s = {k: p["settings"][k] for k in PLATFORMS if isinstance(p["settings"].get(k), bool)}
            db.execute("UPDATE user_state SET settings = ? WHERE user_id = ?", (json.dumps(s), uid))
        if p.get("windowDays") in DAYS_OK:
            db.execute("UPDATE user_state SET window_days = ? WHERE user_id = ?", (p["windowDays"], uid))
        return True

    if op == "removeVia":
        # 글은 다른 사용자도 쓸 수 있어서 지우지 않습니다. 추적 목록에서 빠지면 이 사용자에게는 안 보입니다.
        return 0
    if op == "clearItems":
        load_state(db, uid)
        db.execute("UPDATE user_state SET cleared_before = ? WHERE user_id = ?", (int(time.time() * 1000), uid))
        # 같은 글이 다시 모여도 예전 '읽음' 표시가 남지 않도록 본 글 기록도 비웁니다(모든 기기)
        reset_seen(db, uid)
        return True

    if op == "openWindow":
        raise OpError("새 창은 브라우저에서 직접 엽니다.")  # 화면이 이 오류를 받으면 새 탭으로 엽니다
    if op == "openLogin":
        raise OpError("SNS 로그인은 서버 PC에서 관리자가 합니다. (server 폴더의 login_setup.bat)")
    if op == "image":
        return ""  # 화면은 이미지를 직접 불러옵니다
    if op == "avatars":
        # 계정 프로필 사진(검색할 때 받아 둔 것). {계정 ID: 데이터 주소}
        ids = [x for x in (p.get("ids") or []) if isinstance(x, str) and len(x) <= 200][:60] if isinstance(p.get("ids"), list) else []
        if not ids:
            return {}
        rows = db.execute(f"SELECT id, data FROM avatars WHERE id IN ({','.join('?' * len(ids))})", ids).fetchall()
        return {r["id"]: r["data"] for r in rows}

    raise OpError("알 수 없는 요청입니다.")


# ---------- 수집기 요청 ----------
# DB를 연 채로 기다리면 수집기가 글을 저장하지 못하므로, 이 요청들은 DB 연결 밖에서 처리합니다.
def inline_image(url: str, max_bytes: int = 150000) -> str:
    """검색 결과 프로필 사진을 작은 데이터 주소로 바꿉니다(화면이 사진 주소를 못 불러오는 경우 대비)."""
    if not url.startswith("https://"):
        return ""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=6) as r:
            ctype = r.headers.get("Content-Type", "")
            data = r.read(max_bytes + 1)
        if len(data) > max_bytes or not ctype.startswith("image/"):
            return ""
        return f"data:{ctype};base64," + base64.b64encode(data).decode()
    except Exception:
        return ""


def save_avatars(platform: str, results: list, pics: list):
    """검색 결과의 프로필 사진을 계정 ID별로 저장해 둡니다(다른 기기·사용자도 다시 검색하지 않고 씀)."""
    rows = []
    for r, pic in zip(results, pics):
        if not pic or len(pic) > AVATAR_MAX:
            continue
        for key in {(r.get("handle") or "").lower(), (r.get("channelId") or "").lower()} - {""}:  # 유튜브는 @핸들·채널 ID 둘 다
            rows.append((f"{platform}:{key}", pic, int(time.time() * 1000)))
    if rows:
        with get_db() as db:
            db.executemany("INSERT OR REPLACE INTO avatars(id, data, at) VALUES (?, ?, ?)", rows)


def handle_collector(uid: str, op: str, p: dict):
    if op == "checkNow":
        only = p.get("only") if isinstance(p.get("only"), str) else ""
        collector.request_collect(uid, "deep", only[:200])
        return True
    if op == "checkLogin":
        plats = p.get("platforms") if isinstance(p.get("platforms"), list) else []
        collector.request_login_check([x for x in plats if x in LOGIN_ACCTS])   # 수집용(x)·검색용(x-search) 계정
        return True
    if op == "cancelCheck":
        collector.cancel(uid)
        return True
    if op == "searchAccount":
        q = p.get("q").strip()[:60] if isinstance(p.get("q"), str) else ""
        if not q or p.get("platform") not in PLATFORMS:
            raise OpError("검색어나 매체가 올바르지 않습니다.")
        sid = p.get("sid") if isinstance(p.get("sid"), str) and SID_OK.match(p.get("sid")) else ""
        key = (uid, sid) if sid else None   # 검색 번호가 없으면(예전 화면) 취소할 수 없는 검색
        try:
            results = collector.run_blocking({"kind": "search", "platform": p["platform"], "q": q}, 60, key)
        except SearchCancelled:
            raise OpError("검색을 취소했습니다.")
        except Exception as e:
            raise OpError(str(e))
        if collector.is_search_cancelled(key):
            raise OpError("검색을 취소했습니다.")   # 결과는 나왔지만 그사이 취소함: 사진 받기도 하지 않음
        with ThreadPoolExecutor(8) as ex:
            pics = list(ex.map(inline_image, [r["avatar"] for r in results]))
        save_avatars(p["platform"], results, pics)
        return [{**r, "avatarUrl": r["avatar"], "avatar": pic or r["avatar"]} for r, pic in zip(results, pics)]
    if op == "cancelSearch":
        sid = p.get("sid") if isinstance(p.get("sid"), str) else ""
        if not SID_OK.match(sid):
            raise OpError("검색 번호가 올바르지 않습니다.")
        collector.cancel_search(uid, sid)   # 자기 검색만 취소할 수 있습니다(사용자 ID가 열쇠에 들어감)
        return True
    if op == "fetchPost":
        url = p.get("url") if isinstance(p.get("url"), str) else ""
        if not re.match(r"^https://www\.youtube\.com/post/[\w-]{10,60}$", url):
            raise OpError("게시물 주소가 올바르지 않습니다.")
        # 게시물 탭을 수집할 때 저장해 둔 내용이 있으면 바로 돌려줍니다(크롬을 쓰지 않음).
        pid = url.rsplit("/", 1)[1]
        post = saved_post(pid)
        if post:
            return post
        # 저장해 둔 내용이 없는 예전 게시물만 수집 창에서 읽어 오고, 다음부터 바로 열도록 저장합니다.
        try:
            post = collector.run_blocking({"kind": "post", "url": url}, 60)
        except Exception as e:
            raise OpError(str(e))
        save_post(pid, post)
        return post
    raise OpError("알 수 없는 요청입니다.")


@router.post("/api/call")
def api_call(body: dict = Body(...)):
    op, payload = body.get("op"), body.get("payload") or {}
    if not isinstance(op, str) or not isinstance(payload, dict):
        code, res = 400, {"ok": False, "error": "요청 형식이 올바르지 않습니다."}
    else:
        try:
            with get_db() as db:
                user = user_by_session(db, body.get("session"))
                uid = user["id"] if user else None
            if not uid:
                code, res = 401, {"ok": False, "error": "로그인이 필요합니다."}
            elif op in COLLECTOR_OPS:
                code, res = 200, {"ok": True, "result": handle_collector(uid, op, payload)}
            else:
                with get_db() as db:
                    code, res = 200, {"ok": True, "result": handle(db, uid, op, payload)}
        except OpError as e:
            code, res = 200, {"ok": False, "error": str(e)}
        except Exception:
            log.exception("api_call 오류: %s", op)
            code, res = 500, {"ok": False, "error": "서버 오류가 발생했습니다."}
    return JSONResponse(res, status_code=code, headers={"Cache-Control": "no-store"})
