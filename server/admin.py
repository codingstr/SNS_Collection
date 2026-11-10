"""/api/admin : 관리자 전용(웹의 '관리' 탭). 관리자 계정은 server\\admin_setup.bat으로만 정합니다(가입으로는 못 만듦).

  POST /api/admin  {"session": "...", "action": "...", ...}
  성공: {"ok": true, "result": ...}   실패: {"ok": false, "error": "메시지"}

action
  users                          모든 사용자 요약
  user          {uid}            한 사용자: 추적 계정(묶음·숨김·기간), 매체별 수집 켜기, 기본 기간, 수집 상태, 통계
  editTracked   {uid, ids, change}   고른 추적 계정 고치기. change: {hidden: bool} / {group: "이름" 또는 ""(묶음 풀기)} /
                                     {days: 7|14|30|60|0(기본)} / {remove: true}
  setUser       {uid, settings?, windowDays?}   매체별 수집 켜기/끄기, 기본 기간
  collect       {uid}            그 사용자의 추적 계정을 지금 수집
  cancel        {uid}            그 사용자의 수집 멈추기
  clearItems    {uid}            그 사용자에게 보이는 수집 글 비우기(사용자의 '수집한 글 모두 삭제'와 같음)
  clearSeen     {uid}            본 글 기록 지우기
  resetPassword {uid}            비밀번호를 RESET_PW로 초기화(모든 기기 로그아웃, 다음 로그인 때 바꾸라고 안내)
  deleteUser    {uid}            사용자와 그 데이터 삭제
  accounts                       모든 사용자가 추적 중인 SNS 계정의 수집 상태
  server                         서버 상태(테스트 계정 로그인, 자동 수집, 큐, 통계)
  checkLogin                     테스트 계정 로그인 상태 다시 확인
관리자 계정끼리는 비밀번호 초기화·삭제를 하지 않습니다(관리자가 모두 잠기는 일 방지). 관리자 자신의 비밀번호는 계정 메뉴에서 바꿉니다.
"""
import json
import logging
import secrets
import time

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from api_call import DAYS_OK, PLATFORMS, OpError, clean_tracked
from auth import hash_pw, sha, user_by_session
from collector import collector, get_login_state
from collector.runner import AUTO_EVERY_MS, LOGIN_ACCTS, kv_get, page_urls
from db import get_db

router = APIRouter()
log = logging.getLogger("admin")

RESET_PW = "000000"       # 관리자가 비밀번호를 초기화할 때의 값(사용자는 다음 로그인 때 바꾸라는 안내를 받음)
STALE_MS = 2 * AUTO_EVERY_MS + 10 * 60000   # 이보다 오래 성공한 수집이 없으면 '오래됨'


def now_ms() -> int:
    return int(time.time() * 1000)


def _uid(p) -> str:
    u = p.get("uid")
    if not isinstance(u, str) or not 1 <= len(u) <= 40:
        raise OpError("사용자 아이디가 올바르지 않습니다.")
    return u


def _user(db, uid: str):
    u = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    if not u:
        raise OpError("없는 사용자입니다(이미 삭제되었을 수 있습니다).")
    return u


def _state(db, uid: str) -> dict:
    db.execute("INSERT OR IGNORE INTO user_state(user_id) VALUES (?)", (uid,))
    r = db.execute("SELECT * FROM user_state WHERE user_id = ?", (uid,)).fetchone()
    return {"tracked": json.loads(r["tracked"]), "settings": json.loads(r["settings"]), "windowDays": r["window_days"],
            "status": json.loads(r["status"]), "clearedBefore": r["cleared_before"]}


def _not_admin(u, what: str):
    if u["is_admin"]:
        raise OpError(f"관리자 계정은 여기서 {what}할 수 없습니다.")


# ---------- 사용자 ----------
def users(db):
    rows = db.execute("""SELECT u.id, u.is_admin, u.must_change, u.created_at, s.tracked, s.status,
                                (SELECT COUNT(*) FROM sessions x WHERE x.user_id = u.id AND x.expires_at > ? AND x.sv = u.sv) AS logins
                         FROM users u LEFT JOIN user_state s ON s.user_id = u.id ORDER BY u.is_admin DESC, u.id""",
                      (int(time.time()),)).fetchall()
    out = []
    for r in rows:
        tracked = json.loads(r["tracked"] or "[]")
        st = json.loads(r["status"] or "{}")
        out.append({"id": r["id"], "admin": bool(r["is_admin"]), "mustChange": bool(r["must_change"]), "createdAt": r["created_at"] * 1000,
                    "accounts": len(tracked), "hidden": sum(1 for t in tracked if t.get("hidden") is True),
                    "groups": len({t["group"] for t in tracked if t.get("group")}), "logins": r["logins"],
                    "running": bool(st.get("running")), "lastRun": st.get("lastRun") or 0, "message": st.get("message") or ""})
    return out


def user_detail(db, uid: str):
    u = _user(db, uid)
    st = _state(db, uid)
    vias = [t["id"] for t in st["tracked"]]
    counts = {}
    if vias:
        marks = ",".join("?" * len(vias))
        for r in db.execute(f"""SELECT v.via, COUNT(*) AS n, MAX(i.published_at) AS last FROM item_via v JOIN items i ON i.id = v.item_id
                                WHERE v.via IN ({marks}) AND MAX(i.collected_at, i.seen_at) > ? GROUP BY v.via""", (*vias, st["clearedBefore"])):
            counts[r["via"]] = {"n": r["n"], "last": r["last"] or ""}
    seen = db.execute("SELECT COUNT(*) FROM seen WHERE user_id = ?", (uid,)).fetchone()[0]
    logins = db.execute("SELECT COUNT(*) FROM sessions WHERE user_id = ? AND expires_at > ? AND sv = ?", (uid, int(time.time()), u["sv"])).fetchone()[0]
    return {"id": u["id"], "admin": bool(u["is_admin"]), "mustChange": bool(u["must_change"]), "createdAt": u["created_at"] * 1000,
            "logins": logins, "seen": seen, **st, "counts": counts}


def edit_tracked(db, uid: str, p: dict):
    ids = p.get("ids")
    ch = p.get("change")
    if not isinstance(ids, list) or not ids or not isinstance(ch, dict):
        raise OpError("고칠 계정을 고르세요.")
    want = {x for x in ids if isinstance(x, str)}
    st = _state(db, uid)
    out, hit, shown = [], 0, []
    for t in st["tracked"]:
        if t.get("id") not in want:
            out.append(t)
            continue
        hit += 1
        if ch.get("remove") is True:
            continue
        c = dict(t)
        if isinstance(ch.get("hidden"), bool):
            if ch["hidden"]:
                c["hidden"] = True
            elif c.pop("hidden", None):
                shown.append(c["id"])
        if isinstance(ch.get("group"), str):
            g = ch["group"].strip()[:30]
            if g:
                c["group"] = g
            else:
                c.pop("group", None)
        if "days" in ch:
            if ch["days"] in DAYS_OK:
                c["days"] = ch["days"]
            else:
                c.pop("days", None)
        out.append(c)
    if not hit:
        raise OpError("고칠 계정을 찾지 못했습니다(사용자가 그새 바꿨을 수 있습니다).")
    db.execute("UPDATE user_state SET tracked = ? WHERE user_id = ?", (json.dumps(clean_tracked(out), ensure_ascii=False), uid))
    return shown


def set_user(db, uid: str, p: dict):
    _state(db, uid)
    if isinstance(p.get("settings"), dict):
        s = {k: p["settings"][k] for k in PLATFORMS if isinstance(p["settings"].get(k), bool)}
        db.execute("UPDATE user_state SET settings = ? WHERE user_id = ?", (json.dumps(s), uid))
    if p.get("windowDays") in DAYS_OK:
        db.execute("UPDATE user_state SET window_days = ? WHERE user_id = ?", (p["windowDays"], uid))


# ---------- SNS 계정 상태 ----------
TAB_LABEL = {"/videos": "영상", "/shorts": "쇼츠", "/posts": "게시물"}


def accounts(db):
    login = get_login_state()
    active = collector.active_urls()
    acc = {}
    for r in db.execute("SELECT user_id, tracked, settings FROM user_state").fetchall():
        settings = json.loads(r["settings"] or "{}")
        for t in json.loads(r["tracked"] or "[]"):
            a = acc.setdefault(t.get("id"), {"id": t.get("id"), "platform": t.get("platform"), "handle": t.get("handle") or "",
                                             "channelId": t.get("channelId") or "", "owners": [], "urls": page_urls(t)})
            a["owners"].append({"uid": r["user_id"], "group": t.get("group") or "", "hidden": t.get("hidden") is True,
                                "off": settings.get(t.get("platform")) is False, "days": t.get("days") or 0})
    if not acc:
        return []
    urls = sorted({u for a in acc.values() for u in a["urls"]})
    logs = {}
    for i in range(0, len(urls), 400):
        chunk = urls[i:i + 400]
        marks = ",".join("?" * len(chunk))
        # 결과 기록(page_log)이 생기기 전에 모은 페이지: 수집 범위 기억(coverage)의 마지막 방문 시각으로 대신 보여 줍니다.
        for r in db.execute(f"SELECT url, at, data FROM coverage WHERE url IN ({marks})", chunk):
            gap = '"gap"' in (r["data"] or "")
            logs[r["url"]] = {"at": r["at"], "ok_at": r["at"], "mode": "", "why": "이전 수집(자세한 결과는 다음 수집부터)" + (" · 지난번 중간에 끊김" if gap else ""),
                              "found": 0, "added": 0, "error": "", "old": True}
        for r in db.execute(f"SELECT * FROM page_log WHERE url IN ({marks})", chunk):
            logs[r["url"]] = dict(r)
    ids = list(acc)
    counts = {}
    for i in range(0, len(ids), 400):
        chunk = ids[i:i + 400]
        for r in db.execute(f"""SELECT v.via, COUNT(*) AS n, MAX(i.published_at) AS last, MAX(i.collected_at) AS got
                                FROM item_via v JOIN items i ON i.id = v.item_id WHERE v.via IN ({','.join('?' * len(chunk))}) GROUP BY v.via""", chunk):
            counts[r["via"]] = r
    now = now_ms()
    out = []
    for a in acc.values():
        pages = []
        for u in a["urls"]:
            lg = logs.get(u) or {}
            tab = next((v for k, v in TAB_LABEL.items() if u.endswith(k)), "")
            pages.append({"url": u, "tab": tab, "active": u in active, "at": lg.get("at", 0), "okAt": lg.get("ok_at", 0), "mode": lg.get("mode", ""),
                          "why": lg.get("why", ""), "found": lg.get("found", 0), "added": lg.get("added", 0), "error": lg.get("error", ""),
                          "old": bool(lg.get("old"))})
        p = a["platform"]
        everyone_off = all(o["hidden"] or o["off"] for o in a["owners"])
        logged_out = p in ("x", "instagram") and (login.get(p) or {}).get("loggedIn") is False
        last_ok = max((x["okAt"] for x in pages), default=0)
        if any(x["active"] for x in pages):
            state = "running"
        elif everyone_off:
            state = "off"
        elif logged_out:
            state = "login"
        elif not any(x["at"] for x in pages):
            state = "never"
        elif any(x["error"] for x in pages if x["at"]):
            state = "error"
        elif now - last_ok > STALE_MS:
            state = "stale"
        else:
            state = "ok"
        c = counts.get(a["id"])
        out.append({**{k: a[k] for k in ("id", "platform", "handle", "channelId", "owners")}, "pages": pages, "state": state,
                    "lastAt": max((x["at"] for x in pages), default=0), "lastOk": last_ok,
                    "items": c["n"] if c else 0, "lastPost": (c["last"] or "") if c else "", "lastGot": (c["got"] or 0) if c else 0})
    return out


def server_info(db):
    n = lambda q: db.execute(q).fetchone()[0]  # noqa: E731
    return {"login": get_login_state(), "loginAccts": list(LOGIN_ACCTS), "lastAuto": kv_get("lastAuto", 0) or 0,
            "autoMinutes": AUTO_EVERY_MS // 60000, **collector.queue_info(),
            "counts": {"users": n("SELECT COUNT(*) FROM users"), "items": n("SELECT COUNT(*) FROM items"),
                       "pages": n("SELECT COUNT(*) FROM page_log"), "errors": n("SELECT COUNT(*) FROM page_log WHERE error != ''")}}


# ---------- 요청 처리 ----------
def handle(db, me: str, act: str, p: dict):
    if act == "users":
        return users(db)
    if act == "accounts":
        return accounts(db)
    if act == "server":
        return server_info(db)
    uid = _uid(p)
    if act == "user":
        return user_detail(db, uid)
    u = _user(db, uid)
    log.info("관리자 %s: %s %s", me, act, uid)
    if act == "editTracked":
        return {"shown": edit_tracked(db, uid, p)}
    if act == "setUser":
        set_user(db, uid, p)
        return True
    if act == "clearItems":
        _state(db, uid)
        db.execute("UPDATE user_state SET cleared_before = ? WHERE user_id = ?", (now_ms(), uid))
        return True
    if act == "clearSeen":
        return db.execute("DELETE FROM seen WHERE user_id = ?", (uid,)).rowcount
    if act == "resetPassword":
        _not_admin(u, "비밀번호를 초기화")
        salt = secrets.token_hex(16)
        db.execute("UPDATE users SET salt = ?, hash = ?, sv = sv + 1, must_change = 1 WHERE id = ?", (salt, hash_pw(RESET_PW, salt), uid))
        db.execute("DELETE FROM sessions WHERE user_id = ?", (uid,))   # 모든 기기 로그아웃
        db.execute("DELETE FROM rate_limits WHERE key = ?", (sha("acct:" + uid),))
        return True
    if act == "deleteUser":
        _not_admin(u, "삭제")
        db.execute("DELETE FROM users WHERE id = ?", (uid,))   # 세션·상태·본 글 기록은 ON DELETE CASCADE로 같이 지워짐
        return True
    raise OpError("알 수 없는 요청입니다.")


# 수집기에 일을 넣는 요청은 DB 연결 밖에서(수집기가 상태를 저장하며 DB를 씀)
COLLECTOR_ACTS = ("collect", "cancel", "checkLogin")


@router.post("/api/admin")
def admin(body: dict = Body(...)):
    act = body.get("action")
    p = body if isinstance(body, dict) else {}
    try:
        with get_db() as db:
            me = user_by_session(db, body.get("session"))
        if not me:
            code, res = 401, {"ok": False, "error": "로그인이 필요합니다."}
        elif not me["is_admin"]:
            code, res = 403, {"ok": False, "error": "관리자만 쓸 수 있습니다."}
        elif not isinstance(act, str):
            code, res = 400, {"ok": False, "error": "요청 형식이 올바르지 않습니다."}
        elif act in COLLECTOR_ACTS:
            if act == "checkLogin":
                collector.request_login_check(list(LOGIN_ACCTS))
            else:
                uid = _uid(p)
                with get_db() as db:
                    _user(db, uid)
                log.info("관리자 %s: %s %s", me["id"], act, uid)
                if act == "collect":
                    collector.request_collect(uid, "deep")
                else:
                    collector.cancel(uid)
            code, res = 200, {"ok": True, "result": True}
        else:
            with get_db() as db:
                result = handle(db, me["id"], act, p)
            if act == "editTracked":
                for tid in result["shown"]:   # 다시 보이게 한 계정은 숨긴 동안 못 모은 글을 바로 모읍니다(사용자 화면과 같음)
                    collector.request_collect(p["uid"], "deep", tid)
            if act == "deleteUser":
                collector.cancel(p["uid"])
            code, res = 200, {"ok": True, "result": result}
    except OpError as e:
        code, res = 200, {"ok": False, "error": str(e)}
    except Exception:
        log.exception("admin 오류: %s", act)
        code, res = 500, {"ok": False, "error": "서버 오류가 발생했습니다."}
    return JSONResponse(res, status_code=code, headers={"Cache-Control": "no-store"})
