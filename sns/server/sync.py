"""/api/sync : 본 글 기록(흐리게 표시)을 계정에 저장해서 다른 기기와 맞춥니다.

  POST /api/sync  {"action": "getSeen" | "putSeen", "session": "...", "add": [글 ID, ...]}
"""
import time

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from auth import user_by_session
from db import get_db

router = APIRouter()
MAX_SEEN = 5000


@router.post("/api/sync")
def sync(body: dict = Body(...)):
    act = body.get("action")
    if act in ("getSeen", "putSeen"):
        with get_db() as db:
            user = user_by_session(db, body.get("session"))
            if not user:
                return JSONResponse({"ok": False, "error": "로그인이 필요합니다."}, status_code=401)
            uid = user["id"]
            if act == "getSeen":
                rows = db.execute("SELECT item_id FROM seen WHERE user_id = ? ORDER BY at DESC LIMIT ?", (uid, MAX_SEEN)).fetchall()
                return {"ok": True, "ids": [r["item_id"] for r in reversed(rows)]}
            add = [x for x in (body.get("add") or [])[:500] if isinstance(x, str) and 0 < len(x) <= 200]
            now = int(time.time() * 1000)
            db.executemany("INSERT OR IGNORE INTO seen(user_id, item_id, at) VALUES (?, ?, ?)", [(uid, x, now) for x in add])
            # 오래된 기록은 정리합니다.
            db.execute("""DELETE FROM seen WHERE user_id = ? AND item_id NOT IN
                          (SELECT item_id FROM seen WHERE user_id = ? ORDER BY at DESC LIMIT ?)""", (uid, uid, MAX_SEEN))
            return {"ok": True, "n": len(add)}

    return JSONResponse({"ok": False, "error": "알 수 없는 요청입니다."}, status_code=400)
