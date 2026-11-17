"""/api/community : 커뮤니티(모든 사용자가 같이 보는 게시판). 데이터는 app.db의 cm_ 표들에 있습니다(db.py).

  POST /api/community  {"session": "...", "action": "...", ...}
  성공: {"ok": true, "result": ...}   실패: {"ok": false, "error": "메시지"}
  GET  /api/community/img/{열쇠}   글에 붙인 이미지(열쇠는 추측할 수 없는 임의 문자열이라 로그인 없이 엽니다)

action
  summary    {groups: [{key, ids: [계정 ID…]}]}      전체·그룹별 글 수와 마지막 글(커뮤니티 목록 카드)
  list       {ids?, cat?, q?, offset?}              글 목록(30개씩). ids(계정 ID들)가 있으면 그 계정 중 하나라도 태그된 글만
  comments   {id}                                   그 글의 댓글·답글
  write      {cat, title, body, tags, links, imgs}  글쓰기 → 새 글
  delete     {id}                                   글 지우기(쓴 사람·관리자)
  like       {id, on}                               좋아요 켜기/끄기(내 글에는 못 누름)
  comment    {id, body, parent?}                    댓글(parent가 있으면 그 댓글의 답글) → 댓글 목록
  delComment {id}                                   댓글 지우기(쓴 사람·관리자) → 댓글 목록

분류: 질문·팁·건의·잡담. '공지'는 관리자만 쓰고 목록 맨 위에 붙습니다. 좋아요가 HOT_MIN개 이상인 글은 '인기글'입니다.
글의 태그는 SNS 계정 ID(예: x:handle)라서, 같은 계정을 추적하는 다른 사용자의 그룹 커뮤니티에도 같은 글이 보입니다.
"""
import base64
import binascii
import json
import logging
import re
import secrets
import time

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse, Response

from api_call import OpError
from auth import rl_blocked, rl_bump, user_by_session
from db import get_db

router = APIRouter()
log = logging.getLogger("community")

CATS = ("질문", "팁", "건의", "잡담")
NOTICE = "공지"
HOT = "인기글"
HOT_MIN = 3                    # 좋아요가 이만큼 모이면 인기글
PAGE = 30                      # 한 번에 보내는 글 수
TITLE_MAX, BODY_MAX, CMT_MAX = 80, 2000, 500
TAGS_MAX, LINKS_MAX, IMGS_MAX = 10, 5, 4
IMG_BYTES = 700_000            # 이미지 하나 최대 크기(화면이 보통 1280px JPEG로 줄여서 보냄 → 200KB 안팎)
RL_POST = (20, 3600)           # 한 시간에 글 20개
RL_CMT = (90, 3600)            # 한 시간에 댓글 90개
TAG_OK = re.compile(r"^(youtube|x|instagram):[^\s,]{1,200}$")
KEY_OK = re.compile(r"^[A-Za-z0-9_-]{16,40}$")
IMG_OK = re.compile(r"^data:(image/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$")
LINK_OK = re.compile(r"^https?://[^\s/?#]+\.[^\s/?#]+(?:[/?#]\S*)?$", re.I)
MAGIC = {"image/jpeg": (b"\xff\xd8\xff",), "image/png": (b"\x89PNG",), "image/gif": (b"GIF87a", b"GIF89a"), "image/webp": (b"RIFF",)}


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------- 입력 검사 ----------
def _id(v, what="글") -> int:
    if isinstance(v, bool) or not isinstance(v, int) or v <= 0:
        raise OpError(f"{what} 번호가 올바르지 않습니다.")
    return v


def _text(v, mx: int, what: str) -> str:
    s = v.strip() if isinstance(v, str) else ""
    if not s:
        raise OpError(f"{what}을 적어 주세요.")
    if len(s) > mx:
        raise OpError(f"{what}은 {mx}자까지 쓸 수 있습니다.")
    return s


def clean_ids(v) -> list:
    if not isinstance(v, list):
        return []
    return list(dict.fromkeys(x for x in v[:60] if isinstance(x, str) and TAG_OK.match(x)))


def clean_tags(v) -> list:
    out, seen = [], set()
    for t in v if isinstance(v, list) else []:
        if not isinstance(t, dict) or not isinstance(t.get("id"), str) or not TAG_OK.match(t["id"]) or t["id"] in seen:
            continue
        seen.add(t["id"])
        label = t.get("label").strip()[:60] if isinstance(t.get("label"), str) else ""
        out.append({"id": t["id"], "platform": t["id"].split(":", 1)[0], "label": label})
        if len(out) >= TAGS_MAX:
            break
    return out


def clean_links(v) -> list:
    out = []
    for u in v if isinstance(v, list) else []:
        u = u.strip() if isinstance(u, str) else ""
        if u and len(u) <= 500 and LINK_OK.match(u) and u not in out:
            out.append(u)
        if len(out) >= LINKS_MAX:
            break
    return out


def decode_images(v) -> list:
    """data:image/...;base64,... 목록 → [(mime, bytes)]. 이미지가 아니거나 너무 크면 거절합니다."""
    if not isinstance(v, list):
        return []
    if len(v) > IMGS_MAX:
        raise OpError(f"이미지는 {IMGS_MAX}장까지 붙일 수 있습니다.")
    out = []
    for s in v:
        m = IMG_OK.match(s) if isinstance(s, str) and len(s) < IMG_BYTES * 4 // 3 + 100 else None
        if not m:
            raise OpError("이미지 형식이 올바르지 않거나 너무 큽니다.")
        try:
            data = base64.b64decode(m.group(2), validate=True)
        except (binascii.Error, ValueError):
            raise OpError("이미지를 읽을 수 없습니다.")
        mime = m.group(1)
        ok = any(data.startswith(x) for x in MAGIC[mime]) and (mime != "image/webp" or data[8:12] == b"WEBP")
        if not ok or len(data) > IMG_BYTES:
            raise OpError("이미지 형식이 올바르지 않거나 너무 큽니다.")
        out.append((mime, data))
    return out


# ---------- 읽기 ----------
POST_COLS = """p.*, (SELECT COUNT(*) FROM cm_likes l WHERE l.post_id = p.id) AS likes,
               EXISTS(SELECT 1 FROM cm_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked,
               (SELECT COUNT(*) FROM cm_comments c WHERE c.post_id = p.id AND c.deleted = 0) AS ncmt"""
HOT_SQL = f"(p.cat != '{NOTICE}' AND (SELECT COUNT(*) FROM cm_likes l WHERE l.post_id = p.id) >= {HOT_MIN})"


def post_dict(r, user) -> dict:
    mine = r["author"] == user["id"]
    return {
        "id": r["id"], "author": r["author"], "cat": r["cat"], "title": r["title"], "body": r["body"],
        "tags": json.loads(r["tags"]), "links": json.loads(r["links"]),
        "imgs": ["/api/community/img/" + k for k in json.loads(r["imgs"])],
        "at": r["created_at"], "likes": r["likes"], "liked": bool(r["liked"]), "comments": r["ncmt"],
        "hot": r["cat"] != NOTICE and r["likes"] >= HOT_MIN,
        "mine": mine, "canDel": mine or bool(user["is_admin"]),
    }


def get_post(db, pid: int, user):
    r = db.execute(f"SELECT {POST_COLS} FROM cm_posts p WHERE p.id = ?", (user["id"], pid)).fetchone()
    if not r:
        raise OpError("없는 글입니다(지워졌을 수 있습니다).")
    return r


def scope(ids: list):
    """계정 ID들 중 하나라도 태그된 글(없으면 모든 글)."""
    if not ids:
        return "1", []
    return f"p.id IN (SELECT post_id FROM cm_tags WHERE tag IN ({','.join('?' * len(ids))}))", list(ids)


def like_esc(s: str) -> str:
    return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def list_posts(db, user, p: dict):
    sw, args = scope(clean_ids(p.get("ids")))
    where, wargs = [sw], list(args)
    q = p.get("q").strip()[:60] if isinstance(p.get("q"), str) else ""
    for w in q.lower().split()[:5]:   # 띄어 쓴 낱말이 모두 들어 있는 글(제목·본문·쓴 사람·태그 이름)
        where.append("(LOWER(p.title) LIKE ? ESCAPE '\\' OR LOWER(p.body) LIKE ? ESCAPE '\\' OR p.author LIKE ? ESCAPE '\\' OR LOWER(p.tags) LIKE ? ESCAPE '\\')")
        wargs += [like_esc(w)] * 4
    base = " AND ".join(where)
    # 분류별 글 수(분류 단추에 표시)
    counts = {r[0]: r[1] for r in db.execute(f"SELECT p.cat, COUNT(*) FROM cm_posts p WHERE {base} GROUP BY p.cat", wargs)}
    counts = {"": sum(counts.values()), NOTICE: counts.get(NOTICE, 0), **{c: counts.get(c, 0) for c in CATS},
              HOT: db.execute(f"SELECT COUNT(*) FROM cm_posts p WHERE {base} AND {HOT_SQL}", wargs).fetchone()[0]}
    cat = p.get("cat") if p.get("cat") in (NOTICE, HOT, *CATS) else ""
    cw = " AND p.cat = ?" if cat in (NOTICE, *CATS) else f" AND {HOT_SQL}" if cat == HOT else ""
    cargs = [cat] if cat in (NOTICE, *CATS) else []
    off = p.get("offset") if isinstance(p.get("offset"), int) and 0 <= p.get("offset") <= 100000 else 0
    rows = db.execute(f"""SELECT {POST_COLS} FROM cm_posts p WHERE {base}{cw}
                          ORDER BY CASE WHEN p.cat = '{NOTICE}' THEN 0 ELSE 1 END, p.id DESC LIMIT ? OFFSET ?""",
                      [user["id"], *wargs, *cargs, PAGE + 1, off]).fetchall()
    res = {"posts": [post_dict(r, user) for r in rows[:PAGE]], "more": len(rows) > PAGE, "counts": counts,
           "hotMin": HOT_MIN, "admin": bool(user["is_admin"]), "me": user["id"]}
    # 전체 분류 첫 쪽에는 최근 인기글 3개를 맨 위에 따로 보여 줍니다(검색 중에는 안 함)
    if not cat and not q and off == 0:
        hot = db.execute(f"SELECT {POST_COLS} FROM cm_posts p WHERE {sw} AND {HOT_SQL} ORDER BY p.id DESC LIMIT 3",
                         [user["id"], *args]).fetchall()
        res["hot"] = [post_dict(r, user) for r in hot]
    return res


def summary(db, p: dict):
    def one(ids):
        sw, args = scope(ids)
        n, mx = db.execute(f"SELECT COUNT(*), MAX(p.id) FROM cm_posts p WHERE {sw}", args).fetchone()
        return {"n": n, "lastId": mx}
    out = {"all": one([]), "groups": {}}
    groups = p.get("groups") if isinstance(p.get("groups"), list) else []
    for g in groups[:60]:
        if isinstance(g, dict) and isinstance(g.get("key"), str) and len(g["key"]) <= 100:
            ids = clean_ids(g.get("ids"))
            out["groups"][g["key"]] = one(ids) if ids else {"n": 0, "lastId": None}
    last_ids = {v["lastId"] for v in [out["all"], *out["groups"].values()] if v["lastId"]}
    lasts = {}
    if last_ids:
        rows = db.execute(f"SELECT id, title, created_at FROM cm_posts WHERE id IN ({','.join('?' * len(last_ids))})", list(last_ids))
        lasts = {r["id"]: {"title": r["title"], "at": r["created_at"]} for r in rows}
    for v in [out["all"], *out["groups"].values()]:
        v["last"] = lasts.get(v.pop("lastId"))
    return out


def comments(db, pid: int, user):
    rows = db.execute("SELECT * FROM cm_comments WHERE post_id = ? ORDER BY id", (pid,)).fetchall()
    out = []
    for r in rows:
        mine = r["author"] == user["id"]
        gone = bool(r["deleted"])
        out.append({"id": r["id"], "parent": r["parent_id"], "author": "" if gone else r["author"],
                    "body": "" if gone else r["body"], "at": r["created_at"], "deleted": gone,
                    "mine": mine and not gone, "canDel": not gone and (mine or bool(user["is_admin"]))})
    return out


# ---------- 쓰기 ----------
def write(db, user, p: dict):
    uid = user["id"]
    cat = p.get("cat")
    if cat == NOTICE and not user["is_admin"]:
        raise OpError("공지는 관리자만 쓸 수 있습니다.")
    if cat not in (NOTICE, *CATS):
        raise OpError("분류를 골라 주세요.")
    title, body = _text(p.get("title"), TITLE_MAX, "제목"), _text(p.get("body"), BODY_MAX, "내용")
    tags, links, imgs = clean_tags(p.get("tags")), clean_links(p.get("links")), decode_images(p.get("imgs"))
    if rl_blocked(db, "cm-post:" + uid, RL_POST):
        raise OpError("글을 너무 자주 썼습니다. 잠시 뒤 다시 시도하세요.")
    rl_bump(db, "cm-post:" + uid, RL_POST)
    keys = [secrets.token_urlsafe(18) for _ in imgs]
    cur = db.execute("INSERT INTO cm_posts(author, cat, title, body, tags, links, imgs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     (uid, cat, title, body, json.dumps(tags, ensure_ascii=False), json.dumps(links, ensure_ascii=False), json.dumps(keys), now_ms()))
    pid = cur.lastrowid
    db.executemany("INSERT INTO cm_tags(post_id, tag) VALUES (?, ?)", [(pid, t["id"]) for t in tags])
    db.executemany("INSERT INTO cm_images(key, post_id, mime, data) VALUES (?, ?, ?, ?)",
                   [(k, pid, mime, data) for k, (mime, data) in zip(keys, imgs)])
    return post_dict(get_post(db, pid, user), user)


def delete_post(db, user, p: dict):
    r = get_post(db, _id(p.get("id")), user)
    if r["author"] != user["id"] and not user["is_admin"]:
        raise OpError("내가 쓴 글만 지울 수 있습니다.")
    db.execute("DELETE FROM cm_posts WHERE id = ?", (r["id"],))   # 태그·댓글·좋아요·이미지는 ON DELETE CASCADE
    return True


def like(db, user, p: dict):
    r = get_post(db, _id(p.get("id")), user)
    if r["author"] == user["id"]:
        raise OpError("내 글에는 좋아요를 누를 수 없습니다.")
    if p.get("on") is True:
        db.execute("INSERT OR IGNORE INTO cm_likes(post_id, user_id) VALUES (?, ?)", (r["id"], user["id"]))
    else:
        db.execute("DELETE FROM cm_likes WHERE post_id = ? AND user_id = ?", (r["id"], user["id"]))
    r = get_post(db, r["id"], user)
    return {"likes": r["likes"], "liked": bool(r["liked"]), "hot": r["cat"] != NOTICE and r["likes"] >= HOT_MIN}


def add_comment(db, user, p: dict):
    pid = get_post(db, _id(p.get("id")), user)["id"]
    body = _text(p.get("body"), CMT_MAX, "댓글")
    parent = None
    if p.get("parent") is not None:
        c = db.execute("SELECT * FROM cm_comments WHERE id = ?", (_id(p.get("parent"), "댓글"),)).fetchone()
        if not c or c["post_id"] != pid or c["deleted"]:
            raise OpError("답글을 달 댓글이 없습니다(지워졌을 수 있습니다).")
        parent = c["parent_id"] or c["id"]   # 답글의 답글은 같은 댓글 아래에(한 단계만)
    if rl_blocked(db, "cm-cmt:" + user["id"], RL_CMT):
        raise OpError("댓글을 너무 자주 달았습니다. 잠시 뒤 다시 시도하세요.")
    rl_bump(db, "cm-cmt:" + user["id"], RL_CMT)
    db.execute("INSERT INTO cm_comments(post_id, parent_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)",
               (pid, parent, user["id"], body, now_ms()))
    return comments(db, pid, user)


def del_comment(db, user, p: dict):
    c = db.execute("SELECT * FROM cm_comments WHERE id = ?", (_id(p.get("id"), "댓글"),)).fetchone()
    if not c or c["deleted"]:
        raise OpError("없는 댓글입니다(지워졌을 수 있습니다).")
    if c["author"] != user["id"] and not user["is_admin"]:
        raise OpError("내가 단 댓글만 지울 수 있습니다.")
    has_replies = db.execute("SELECT 1 FROM cm_comments WHERE parent_id = ? LIMIT 1", (c["id"],)).fetchone()
    if has_replies:
        db.execute("UPDATE cm_comments SET deleted = 1, body = '' WHERE id = ?", (c["id"],))   # 답글은 남기고 '지운 댓글'로 표시
    else:
        db.execute("DELETE FROM cm_comments WHERE id = ?", (c["id"],))
        if c["parent_id"]:   # 지운 댓글 아래 마지막 답글이었으면 빈 자리도 정리
            db.execute("""DELETE FROM cm_comments WHERE id = ? AND deleted = 1
                          AND NOT EXISTS (SELECT 1 FROM cm_comments WHERE parent_id = ?)""", (c["parent_id"], c["parent_id"]))
    return comments(db, c["post_id"], user)


def handle(db, user, act: str, p: dict):
    if act == "summary":
        return summary(db, p)
    if act == "list":
        return list_posts(db, user, p)
    if act == "comments":
        return comments(db, get_post(db, _id(p.get("id")), user)["id"], user)
    if act == "write":
        return write(db, user, p)
    if act == "delete":
        return delete_post(db, user, p)
    if act == "like":
        return like(db, user, p)
    if act == "comment":
        return add_comment(db, user, p)
    if act == "delComment":
        return del_comment(db, user, p)
    raise OpError("알 수 없는 요청입니다.")


def reply(code: int, res: dict):
    return JSONResponse(res, status_code=code, headers={"Cache-Control": "no-store"})


@router.post("/api/community")
def community(body: dict = Body(...)):
    act = body.get("action")
    if not isinstance(act, str):
        return reply(400, {"ok": False, "error": "요청 형식이 올바르지 않습니다."})
    try:
        with get_db() as db:
            user = user_by_session(db, body.get("session"))
            if not user:
                return reply(401, {"ok": False, "error": "로그인이 필요합니다."})
            res = handle(db, user, act, body)
        return reply(200, {"ok": True, "result": res})
    except OpError as e:
        return reply(200, {"ok": False, "error": str(e)})
    except Exception:
        log.exception("community 오류: %s", act)
        return reply(500, {"ok": False, "error": "서버 오류가 발생했습니다."})


@router.get("/api/community/img/{key}")
def image(key: str):
    if not KEY_OK.match(key):
        return Response(status_code=404)
    with get_db() as db:
        r = db.execute("SELECT mime, data FROM cm_images WHERE key = ?", (key,)).fetchone()
    if not r:
        return Response(status_code=404)
    return Response(content=bytes(r["data"]), media_type=r["mime"],
                    headers={"Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})
