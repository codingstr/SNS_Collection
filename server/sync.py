"""/api/sync : 본 글 기록(흐리게 표시)을 계정에 저장해서 다른 기기와 맞춥니다.

  POST /api/sync  {"action": "getSeen" | "putSeen" | "delSeen", "session": "...", "add": [글 ID, ...], "ids": [글 ID, ...]}
  delSeen: '모두 읽음' 되돌리기 — 본 글 기록에서 뺍니다.
"""
import logging
import time

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from auth import user_by_session
from db import get_db

router = APIRouter()
log = logging.getLogger("sync")
MAX_SEEN = 5000


def fail(code: int, msg: str):
    return JSONResponse({"ok": False, "error": msg}, status_code=code, headers={"Cache-Control": "no-store"})


@router.post("/api/sync")
def sync(body: dict = Body(...)):
    act = body.get("action")
    if act not in ("getSeen", "putSeen", "delSeen"):
        return fail(400, "알 수 없는 요청입니다.")
    add = body.get("add") if act == "putSeen" else body.get("ids") if act == "delSeen" else []
    if add is None:
        add = []
    if not isinstance(add, list):   # 문자열이 오면 글자 하나하나가 글 ID로 저장되던 문제 방지
        return fail(400, "요청 형식이 올바르지 않습니다.")
    try:
        with get_db() as db:
            user = user_by_session(db, body.get("session"))
            if not user:
                return fail(401, "로그인이 필요합니다.")
            uid = user["id"]
            if act == "getSeen":
                rows = db.execute("SELECT item_id FROM seen WHERE user_id = ? ORDER BY at DESC LIMIT ?", (uid, MAX_SEEN)).fetchall()
                return {"ok": True, "ids": [r["item_id"] for r in reversed(rows)]}
            if act == "delSeen":
                ids = [x for x in add[:MAX_SEEN] if isinstance(x, str) and 0 < len(x) <= 200]
                db.executemany("DELETE FROM seen WHERE user_id = ? AND item_id = ?", [(uid, x) for x in ids])
                return {"ok": True, "n": len(ids)}
            add = [x for x in add[:500] if isinstance(x, str) and 0 < len(x) <= 200]
            if add:
                now = int(time.time() * 1000)
                db.executemany("INSERT OR IGNORE INTO seen(user_id, item_id, at) VALUES (?, ?, ?)", [(uid, x, now) for x in add])
                # 오래된 기록은 정리합니다.
                db.execute("""DELETE FROM seen WHERE user_id = ? AND item_id NOT IN
                              (SELECT item_id FROM seen WHERE user_id = ? ORDER BY at DESC LIMIT ?)""", (uid, uid, MAX_SEEN))
            return {"ok": True, "n": len(add)}
    except Exception:
        log.exception("sync 오류: %s", act)
        return fail(500, "서버 오류가 발생했습니다.")
