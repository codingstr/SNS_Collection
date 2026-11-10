"""로그인 API (아이디·비밀번호, 세션 30일)

  POST /api/auth  {"action": "signup" | "login" | "me" | "logout" | "changePassword" | "deleteAccount", ...}
  성공: {"ok": true, ...}   실패: {"ok": false, "error": "메시지"}

시도 횟수 제한(한 IP에 여러 사람이 있는 학교·회사 와이파이도 고려):
  - 로그인 실패: 같은 IP에서 같은 아이디로 15분에 10번까지 (맞는 비밀번호로 로그인하는 다른 사람은 막지 않습니다)
  - 로그인 실패 전체: 같은 IP에서 15분에 100번까지 (여러 아이디를 돌려 가며 맞혀 보는 것 방지)
  - 가입: 같은 IP에서 1시간에 60번까지
  - 비밀번호 변경·계정 삭제의 비밀번호 틀림: 계정마다 15분에 10번까지
"""
import hashlib
import hmac
import json
import logging
import re
import secrets
import sqlite3
import time

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from db import get_db

router = APIRouter()
log = logging.getLogger("auth")

SESSION_TTL = 30 * 86400          # 세션 30일
ID_RE = re.compile(r"^[a-z0-9_.-]{3,30}$")
# (최대 횟수, 기간 초)
RL_LOGIN_ID = (10, 15 * 60)       # 로그인 실패: IP+아이디
RL_LOGIN_IP = (100, 15 * 60)      # 로그인 실패: IP 전체
RL_SIGNUP = (60, 60 * 60)         # 가입: IP
RL_ACCOUNT = (10, 15 * 60)        # 비밀번호 확인 실패: 계정
LOGIN_COLLECT_COOLDOWN = 10 * 60  # 저장된 로그인으로 다시 들어왔을 때 자동 수집: 마지막 수집 뒤 10분이 지났을 때만(초)


# ---------- 도구 ----------
def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def hash_pw(pw: str, salt: str) -> str:
    # Node의 crypto.scryptSync(pw, salt, 32) 기본값과 같은 설정
    return hashlib.scrypt(pw.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32).hex()


def pw_ok(pw: str, user) -> bool:
    return hmac.compare_digest(hash_pw(pw, user["salt"]), user["hash"])


def new_session(db, uid: str, sv: int) -> str:
    s = secrets.token_hex(32)
    db.execute(
        "INSERT INTO sessions(hash, user_id, sv, expires_at) VALUES (?, ?, ?, ?)",
        (sha(s), uid, sv, int(time.time()) + SESSION_TTL),
    )
    return s


def who(user) -> dict:
    """로그인·me 응답에 붙이는 사용자 정보. admin: 관리 탭을 보여 줌, mustChange: 관리자가 비밀번호를 초기화함."""
    return {"id": user["id"], "admin": bool(user["is_admin"]), "mustChange": bool(user["must_change"])}


def user_by_session(db, sess):
    if not isinstance(sess, str) or not 20 <= len(sess) <= 200:
        return None
    return db.execute(
        """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.hash = ? AND s.expires_at > ? AND s.sv = u.sv""",
        (sha(sess), int(time.time())),
    ).fetchone()


def rl_blocked(db, key: str, limit) -> bool:
    row = db.execute("SELECT count, reset_at FROM rate_limits WHERE key = ?", (sha(key),)).fetchone()
    return bool(row and row["reset_at"] > time.time() and row["count"] >= limit[0])


def rl_bump(db, key: str, limit):
    """횟수 하나 올리기. 기간이 지났으면 1부터 다시 셉니다(기간은 처음 센 때부터)."""
    now = int(time.time())
    db.execute(
        """INSERT INTO rate_limits(key, count, reset_at) VALUES (?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET
             count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
             reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END""",
        (sha(key), now + limit[1], now, now),
    )


def client_ip(request: Request) -> str:
    # ngrok을 거치면 실제 접속자 IP는 X-Forwarded-For에 들어옵니다.
    # 접속자가 이 헤더를 직접 넣어 속일 수 있으므로, ngrok이 마지막에 붙인 값(맨 뒤)을 씁니다.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[-1].strip()
    return request.client.host if request.client else "?"


# ---------- 요청 처리 ----------
def handle(db, act: str, body: dict, ip: str):
    """(HTTP 상태 코드, 응답 dict)를 돌려줍니다."""
    def fail(code, msg):
        return code, {"ok": False, "error": msg}

    if act in ("signup", "login"):
        uid = str(body.get("id") or "").strip().lower()
        pw = str(body.get("password") or "")
        if not ID_RE.match(uid):
            return fail(400, "아이디는 영문·숫자·_ . - 로 3~30자여야 합니다.")
        if not 6 <= len(pw) <= 200:
            return fail(400, "비밀번호는 6자 이상이어야 합니다.")

        if act == "signup":
            if rl_blocked(db, "signup:" + ip, RL_SIGNUP):
                return fail(429, "이 네트워크에서 가입이 너무 많았습니다. 1시간 뒤에 다시 하세요.")
            rl_bump(db, "signup:" + ip, RL_SIGNUP)  # 무더기 가입을 막습니다
            salt = secrets.token_hex(16)
            try:
                db.execute(
                    "INSERT INTO users(id, salt, hash, token, sv, created_at) VALUES (?, ?, ?, '', 0, ?)",
                    (uid, salt, hash_pw(pw, salt), int(time.time())),
                )
            except sqlite3.IntegrityError:
                return fail(409, "이미 사용 중인 아이디입니다.")
            return 200, {"ok": True, "session": new_session(db, uid, 0), "id": uid}

        if rl_blocked(db, f"login:{ip}:{uid}", RL_LOGIN_ID) or rl_blocked(db, "loginip:" + ip, RL_LOGIN_IP):
            return fail(429, "로그인 실패가 너무 많습니다. 15분 뒤에 다시 하세요.")
        user = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        if not user or not pw_ok(pw, user):
            rl_bump(db, f"login:{ip}:{uid}", RL_LOGIN_ID)
            rl_bump(db, "loginip:" + ip, RL_LOGIN_IP)
            return fail(401, "아이디 또는 비밀번호가 맞지 않습니다.")
        return 200, {"ok": True, "session": new_session(db, uid, user["sv"]), **who(user)}

    if act == "me":
        user = user_by_session(db, body.get("session"))
        if not user:
            return fail(401, "로그인이 필요합니다.")
        return 200, {"ok": True, **who(user)}

    if act in ("changePassword", "deleteAccount"):
        user = user_by_session(db, body.get("session"))
        if not user:
            return fail(401, "로그인이 필요합니다.")
        if rl_blocked(db, "acct:" + user["id"], RL_ACCOUNT):
            return fail(429, "비밀번호를 너무 많이 틀렸습니다. 15분 뒤에 다시 하세요.")
        if not pw_ok(str(body.get("password") or ""), user):
            rl_bump(db, "acct:" + user["id"], RL_ACCOUNT)
            return fail(403, "현재 비밀번호가 맞지 않습니다.")

        if act == "changePassword":
            np = str(body.get("newPassword") or "")
            if not 6 <= len(np) <= 200:
                return fail(400, "새 비밀번호는 6자 이상이어야 합니다.")
            if np == str(body.get("password") or ""):
                return fail(400, "새 비밀번호가 지금 비밀번호와 같습니다.")
            salt, sv = secrets.token_hex(16), user["sv"] + 1
            db.execute("UPDATE users SET salt = ?, hash = ?, sv = ?, must_change = 0 WHERE id = ?", (salt, hash_pw(np, salt), sv, user["id"]))
            db.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))  # 다른 기기 로그인 해제
            return 200, {"ok": True, "session": new_session(db, user["id"], sv)}

        # 계정 삭제: 세션 등 이 계정에 딸린 데이터는 ON DELETE CASCADE로 같이 지워집니다.
        if user["is_admin"] and not db.execute("SELECT 1 FROM users WHERE is_admin = 1 AND id != ?", (user["id"],)).fetchone():
            return fail(400, "마지막 관리자 계정은 지울 수 없습니다. (서버 PC의 admin_setup으로 다른 관리자를 먼저 정하세요)")
        db.execute("DELETE FROM users WHERE id = ?", (user["id"],))
        return 200, {"ok": True}

    if act == "logout":
        sess = body.get("session")
        if isinstance(sess, str) and len(sess) < 200:
            db.execute("DELETE FROM sessions WHERE hash = ?", (sha(sess),))
        return 200, {"ok": True}

    return fail(400, "알 수 없는 요청입니다.")


def collect_on_login(uid: str, fresh_login: bool):
    """로그인하면 그 사용자의 추적 계정을 바로 한 번 모읍니다.
    - 아이디·비밀번호로 로그인: 항상
    - 저장된 로그인으로 화면을 다시 연 경우(me): 마지막 수집 뒤 LOGIN_COLLECT_COOLDOWN이 지났을 때만
      (새로고침·탭 열기마다 수집하지 않게. X·인스타는 수집기의 페이지별 최소 간격도 따로 지켜짐)
    추적 계정이 없거나 이미 수집 중이면 아무것도 하지 않습니다. 실패해도 로그인은 그대로 성공합니다."""
    from collector import collector   # 수집기는 auth보다 무거워서 필요할 때 불러옵니다
    try:
        with get_db() as db:
            row = db.execute("SELECT tracked, settings, status FROM user_state WHERE user_id = ?", (uid,)).fetchone()
        if not row:
            return
        tracked, settings, status = json.loads(row["tracked"]), json.loads(row["settings"]), json.loads(row["status"])
        if status.get("running") or not any(settings.get(t.get("platform")) is not False and t.get("hidden") is not True for t in tracked):
            return
        if not fresh_login and time.time() * 1000 - (status.get("lastRun") or 0) < LOGIN_COLLECT_COOLDOWN * 1000:
            return
        collector.request_collect(uid, "deep")
    except Exception:
        log.exception("로그인 후 자동 수집 요청 오류: %s", uid)


@router.post("/api/auth")
def auth(request: Request, body: dict = Body(...)):
    act = body.get("action")
    if not isinstance(act, str):
        code, res = 400, {"ok": False, "error": "요청 형식이 올바르지 않습니다."}
    else:
        try:
            with get_db() as db:
                code, res = handle(db, act, body, client_ip(request))
        except Exception:
            log.exception("auth 오류")
            code, res = 500, {"ok": False, "error": "서버 오류가 발생했습니다."}
        # 로그인 직후 자동 수집. 로그인 처리(DB 저장)가 끝난 뒤에 요청해야 수집기의 상태 저장과 잠금을 다투지 않습니다.
        if code == 200 and act in ("login", "me"):
            collect_on_login(res["id"], act == "login")
    return JSONResponse(res, status_code=code, headers={"Cache-Control": "no-store"})
