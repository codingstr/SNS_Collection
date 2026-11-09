"""로그인 API (아이디·비밀번호, 세션 30일)

  POST /api/auth  {"action": "signup" | "login" | "me" | "logout" | "changePassword" | "deleteAccount", ...}
  성공: {"ok": true, ...}   실패: {"ok": false, "error": "메시지"}
"""
import hashlib
import hmac
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
RL_MAX, RL_WINDOW = 10, 15 * 60   # 비밀번호 틀림: IP당 15분에 10번까지


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


def user_by_session(db, sess):
    if not isinstance(sess, str) or not 20 <= len(sess) <= 200:
        return None
    return db.execute(
        """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.hash = ? AND s.expires_at > ? AND s.sv = u.sv""",
        (sha(sess), int(time.time())),
    ).fetchone()


def rl_blocked(db, ip: str) -> bool:
    row = db.execute("SELECT count, reset_at FROM rate_limits WHERE key = ?", (sha(ip),)).fetchone()
    return bool(row and row["reset_at"] > time.time() and row["count"] >= RL_MAX)


def rl_bump(db, ip: str):
    now = int(time.time())
    db.execute(
        """INSERT INTO rate_limits(key, count, reset_at) VALUES (?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET
             count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
             reset_at = excluded.reset_at""",
        (sha(ip), now + RL_WINDOW, now),
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
        if rl_blocked(db, ip):
            return fail(429, "시도가 너무 많습니다. 15분 뒤에 다시 하세요.")

        if act == "signup":
            rl_bump(db, ip)  # 가입도 횟수에 넣어 무더기 가입을 막습니다
            salt = secrets.token_hex(16)
            try:
                db.execute(
                    "INSERT INTO users(id, salt, hash, token, sv, created_at) VALUES (?, ?, ?, '', 0, ?)",
                    (uid, salt, hash_pw(pw, salt), int(time.time())),
                )
            except sqlite3.IntegrityError:
                return fail(409, "이미 사용 중인 아이디입니다.")
            return 200, {"ok": True, "session": new_session(db, uid, 0), "id": uid}

        user = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        if not user or not pw_ok(pw, user):
            rl_bump(db, ip)
            return fail(401, "아이디 또는 비밀번호가 맞지 않습니다.")
        return 200, {"ok": True, "session": new_session(db, uid, user["sv"]), "id": uid}

    if act == "me":
        user = user_by_session(db, body.get("session"))
        if not user:
            return fail(401, "로그인이 필요합니다.")
        return 200, {"ok": True, "id": user["id"]}

    if act in ("changePassword", "deleteAccount"):
        user = user_by_session(db, body.get("session"))
        if not user:
            return fail(401, "로그인이 필요합니다.")
        if rl_blocked(db, ip):
            return fail(429, "시도가 너무 많습니다. 15분 뒤에 다시 하세요.")
        if not pw_ok(str(body.get("password") or ""), user):
            rl_bump(db, ip)
            return fail(401, "현재 비밀번호가 맞지 않습니다.")

        if act == "changePassword":
            np = str(body.get("newPassword") or "")
            if not 6 <= len(np) <= 200:
                return fail(400, "새 비밀번호는 6자 이상이어야 합니다.")
            salt, sv = secrets.token_hex(16), user["sv"] + 1
            db.execute("UPDATE users SET salt = ?, hash = ?, sv = ? WHERE id = ?", (salt, hash_pw(np, salt), sv, user["id"]))
            db.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))  # 다른 기기 로그인 해제
            return 200, {"ok": True, "session": new_session(db, user["id"], sv)}

        # 계정 삭제: 세션 등 이 계정에 딸린 데이터는 ON DELETE CASCADE로 같이 지워집니다.
        db.execute("DELETE FROM users WHERE id = ?", (user["id"],))
        return 200, {"ok": True}

    if act == "logout":
        sess = body.get("session")
        if isinstance(sess, str) and len(sess) < 200:
            db.execute("DELETE FROM sessions WHERE hash = ?", (sha(sess),))
        return 200, {"ok": True}

    return fail(400, "알 수 없는 요청입니다.")


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
    return JSONResponse(res, status_code=code, headers={"Cache-Control": "no-store"})
