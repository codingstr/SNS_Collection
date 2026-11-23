"""/api/community : 커뮤니티(모든 사용자가 같이 보는 게시판). 데이터는 app.db의 cm_ 표들에 있습니다(db.py).

  POST /api/community  {"session": "...", "action": "...", ...}
  성공: {"ok": true, "result": ...}   실패: {"ok": false, "error": "메시지"}
  GET  /api/community/img/{열쇠}   글에 붙인 이미지(열쇠는 추측할 수 없는 임의 문자열이라 로그인 없이 엽니다)

action
  summary     {groups: [{key, ids: [계정 ID…]}]}     전체·그룹별 글 수·마지막 글·새 글 수, 스크랩 수(커뮤니티 목록 카드)
  list        {ids?, cat?, q?, offset?, scrap?, mine?, scope?}   글 목록(30개씩). ids가 있으면 그 계정 중 하나라도 태그된 글만,
                                                  scrap이면 내 스크랩만, mine이면 내가 추적하는 계정이 태그된 글만.
                                                  scope(all / g:그룹)를 주면 첫 쪽을 읽을 때 '여기까지 봄'으로 적음
  get         {id}                                 글 하나(글 주소 #c/번호로 바로 열 때)
  comments    {id}                                 그 글의 댓글·답글
  write       {cat, title, body, tags, links, imgs}   글쓰기 → 새 글
  edit        {id, cat, title, body, tags, links, imgs}   글 고치기(쓴 사람만). imgs: 남길 사진 주소(/api/community/img/…)와 새 사진(data:…)
  delete      {id}                                 글 지우기(쓴 사람·관리자)
  like        {id, on}                             좋아요 켜기/끄기(내 글에는 못 누름)
  scrap       {id, on}                             스크랩 켜기/끄기
  comment     {id, body, parent?}                  댓글(parent가 있으면 그 댓글의 답글) → 댓글 목록
  editComment {id, body}                           댓글 고치기(쓴 사람만) → 댓글 목록
  delComment  {id}                                 댓글 지우기(쓴 사람·관리자) → 댓글 목록
  report      {id, cid?, reason, memo?}            글(cid가 있으면 그 댓글) 신고. 관리자가 관리 탭에서 처리할 때까지 그대로 둠
  notifs      {}                                   내 글에 달린 댓글·내 댓글에 달린 답글(최근 30개)
  notifRead   {upto}                               알림을 upto(댓글 번호)까지 읽음으로
  tagStats    {}                                   전체 글에서 태그된 계정과 글 수
  lookup      {urls}                               링크 → 이미 모은 글(카드로 보여 줄 정보)
  findItems   {q}                                  모은 글을 제목·작성자로 찾기(글쓰기의 링크 넣기)

분류: 일반·질문·소식. '공지'는 관리자만 쓰고 목록 맨 위에 붙습니다. 좋아요가 HOT_MIN개 이상인 글은 '인기글'입니다.
글의 태그는 SNS 계정 ID(예: x:handle)라서, 같은 계정을 추적하는 다른 사용자의 그룹 커뮤니티에도 같은 글이 보입니다.
관리자도 남의 글·댓글은 고칠 수 없고 지우기만 합니다.
"""
import base64
import binascii
import json
import logging
import os
import re
import secrets
import time
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse, Response

from api_call import OpError
from auth import rl_blocked, rl_bump, user_by_session
from db import DB_PATH, get_db

router = APIRouter()
log = logging.getLogger("community")

CATS = ("일반", "질문", "소식")
NOTICE = "공지"
HOT = "인기글"
HOT_MIN = 3                    # 좋아요가 이만큼 모이면 인기글
PAGE = 30                      # 한 번에 보내는 글 수
TITLE_MAX, BODY_MAX, CMT_MAX, MEMO_MAX = 80, 2000, 500, 200
TAGS_MAX, LINKS_MAX, IMGS_MAX = 10, 5, 4
IMG_BYTES = 700_000            # 이미지 하나 최대 크기(화면이 보통 1280px JPEG로 줄여서 보냄 → 200KB 안팎)
RL_POST = (20, 3600)           # 한 시간에 글 20개
RL_EDIT = (60, 3600)           # 한 시간에 고치기 60번(글·댓글 합쳐서)
RL_CMT = (90, 3600)            # 한 시간에 댓글 90개
RL_REPORT = (30, 3600)         # 한 시간에 신고 30번
REASONS = ("스팸·광고", "욕설·비방", "부적절한 내용", "기타")
IMG_PATH = "/api/community/img/"
TAG_OK = re.compile(r"^(youtube|x|instagram):[^\s,]{1,200}$")
KEY_OK = re.compile(r"^[A-Za-z0-9_-]{16,40}$")
IMG_OK = re.compile(r"^data:(image/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$")
LINK_OK = re.compile(r"^https?://[^\s/?#]+\.[^\s/?#]+(?:[/?#]\S*)?$", re.I)
SCOPE_OK = re.compile(r"^(all|g:.{1,110})$", re.S)
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


def _limit(db, key: str, rl, msg: str):
    if rl_blocked(db, key, rl):
        raise OpError(msg)
    rl_bump(db, key, rl)


# ---------- 링크 → 이미 모은 글 ----------
# 글 ID는 매체의 글 번호에서 바로 나옵니다(수집 스크립트와 같은 규칙: yt:영상ID, ytpost:게시물ID, x:글번호, ig:코드).
# 그래서 링크를 훑어 글 ID를 만든 뒤 items의 기본 키로 한 번에 찾습니다(표 전체를 뒤지지 않음, 링크 수와 관계없이 쿼리 한 번).
YT_VID = re.compile(r"^[\w-]{11}$")
YT_POST = re.compile(r"^[\w-]{10,60}$")
X_ID = re.compile(r"^\d{5,25}$")
IG_CODE = re.compile(r"^[\w-]{5,40}$")


def link_item_id(url: str) -> str:
    try:
        s = urlsplit(url.strip())
    except ValueError:
        return ""
    host = (s.hostname or "").lower()
    for pre in ("www.", "m.", "mobile.", "music."):
        if host.startswith(pre):
            host = host[len(pre):]
            break
    parts = [x for x in s.path.split("/") if x]
    if host == "youtu.be":
        vid = parts[0] if parts else ""
        return "yt:" + vid if YT_VID.match(vid) else ""
    if host in ("youtube.com", "youtube-nocookie.com"):
        if parts[:1] == ["watch"]:
            vid = (parse_qs(s.query).get("v") or [""])[0]
            return "yt:" + vid if YT_VID.match(vid) else ""
        if len(parts) >= 2 and parts[0] in ("shorts", "embed", "live", "v"):
            return "yt:" + parts[1] if YT_VID.match(parts[1]) else ""
        if len(parts) >= 2 and parts[0] == "post":
            return "ytpost:" + parts[1] if YT_POST.match(parts[1]) else ""
        lb = (parse_qs(s.query).get("lb") or [""])[0]   # 예전 커뮤니티 탭 주소(…/community?lb=게시물ID)
        return "ytpost:" + lb if lb and YT_POST.match(lb) else ""
    if host in ("x.com", "twitter.com"):
        if "status" in parts:
            i = parts.index("status")
            sid = parts[i + 1] if i + 1 < len(parts) else ""
            return "x:" + sid if X_ID.match(sid) else ""
        return ""
    if host == "instagram.com":
        for k, part in enumerate(parts[:-1]):
            if part in ("p", "reel", "reels", "tv"):
                return "ig:" + parts[k + 1] if IG_CODE.match(parts[k + 1]) else ""
    return ""


def item_card(r) -> dict:
    return {"id": r["id"], "source": r["source"], "url": r["url"], "title": r["title"], "author": r["author"], "thumb": r["thumb"],
            "publishedAt": r["published_at"], "publishedText": r["published_text"], "via": r["via"], "collectedAt": r["collected_at"]}


def items_by_links(db, links) -> dict:
    """{링크: 모은 글}. 모으지 않은 글의 링크는 빠집니다."""
    ids = {u: i for u in dict.fromkeys(links) if isinstance(u, str) and (i := link_item_id(u))}
    if not ids:
        return {}
    want = sorted(set(ids.values()))
    rows = {r["id"]: r for r in db.execute(
        f"SELECT id, source, url, title, author, thumb, published_at, published_text, via, collected_at FROM items WHERE id IN ({','.join('?' * len(want))})", want)}
    return {u: item_card(rows[i]) for u, i in ids.items() if i in rows}


def like_esc(s: str) -> str:
    return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def find_items(db, p: dict):
    q = p.get("q").strip()[:80] if isinstance(p.get("q"), str) else ""
    if not q:
        return []
    if re.match(r"^https?://", q, re.I):
        return list(items_by_links(db, [q]).values())
    where, args = [], []
    for w in q.lower().split()[:5]:
        where.append("(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(author) LIKE ? ESCAPE '\\')")
        args += [like_esc(w)] * 2
    rows = db.execute(f"""SELECT id, source, url, title, author, thumb, published_at, published_text, via, collected_at FROM items
                          WHERE {' AND '.join(where)} ORDER BY collected_at DESC LIMIT 8""", args).fetchall()
    return [item_card(r) for r in rows]


# ---------- '어디까지 봤는지' ----------
def seen_get(db, uid: str, scope: str, base_sql: str = "SELECT COALESCE(MAX(id), 0) FROM cm_posts") -> int:
    """처음이면 지금 마지막 번호를 기준으로 적어 둡니다(처음 쓰는 사람에게 예전 글이 모두 '새 글'로 보이지 않게)."""
    r = db.execute("SELECT last_id FROM cm_seen WHERE user_id = ? AND scope = ?", (uid, scope)).fetchone()
    if r:
        return r[0]
    base = db.execute(base_sql).fetchone()[0]
    db.execute("INSERT OR IGNORE INTO cm_seen(user_id, scope, last_id) VALUES (?, ?, ?)", (uid, scope, base))
    return base


def seen_set(db, uid: str, scope: str, last: int):
    db.execute("""INSERT INTO cm_seen(user_id, scope, last_id) VALUES (?, ?, ?)
                  ON CONFLICT(user_id, scope) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)""", (uid, scope, last))


def max_post_id(db) -> int:
    return db.execute("SELECT COALESCE(MAX(id), 0) FROM cm_posts").fetchone()[0]


# 내 글에 다른 사람이 단 댓글, 내 댓글에 다른 사람이 단 답글
NOTIF_SQL = """FROM cm_comments c JOIN cm_posts p ON p.id = c.post_id LEFT JOIN cm_comments pc ON pc.id = c.parent_id
               WHERE c.deleted = 0 AND c.author != ? AND (p.author = ? OR pc.author = ?)"""
MAX_CMT_SQL = "SELECT COALESCE(MAX(id), 0) FROM cm_comments"


def badges(db, uid: str, is_admin: bool) -> dict:
    """화면이 30초마다 상태를 읽을 때 같이 보내는 표시: 안 읽은 알림 수, 커뮤니티 새 글 여부, (관리자) 처리할 신고 수."""
    last = seen_get(db, uid, "notif", MAX_CMT_SQL)
    n = db.execute(f"SELECT COUNT(*) {NOTIF_SQL} AND c.id > ?", (uid, uid, uid, last)).fetchone()[0]
    visit = seen_get(db, uid, "visit")
    new = db.execute("SELECT EXISTS(SELECT 1 FROM cm_posts WHERE id > ? AND author != ?)", (visit, uid)).fetchone()[0]
    out = {"notif": n, "newPosts": bool(new)}
    if is_admin:
        out["reports"] = db.execute("SELECT COUNT(*) FROM (SELECT 1 FROM cm_reports GROUP BY post_id, comment_id)").fetchone()[0]
    return out


def notifs(db, user):
    uid = user["id"]
    last = seen_get(db, uid, "notif", MAX_CMT_SQL)
    rows = db.execute(f"""SELECT c.id, c.post_id, c.author, c.body, c.created_at, p.title, p.author = ? AS on_mine {NOTIF_SQL}
                          ORDER BY c.id DESC LIMIT 30""", (uid, uid, uid, uid)).fetchall()
    items = [{"id": r["id"], "post": r["post_id"], "title": r["title"], "author": r["author"], "body": r["body"][:90], "at": r["created_at"],
              "kind": "post" if r["on_mine"] else "reply", "unread": r["id"] > last} for r in rows]
    unread = db.execute(f"SELECT COUNT(*) {NOTIF_SQL} AND c.id > ?", (uid, uid, uid, last)).fetchone()[0]
    return {"items": items, "unread": unread}


def notif_read(db, user, p: dict):
    upto = p.get("upto")
    if isinstance(upto, bool) or not isinstance(upto, int) or upto < 0:
        raise OpError("알림 번호가 올바르지 않습니다.")
    seen_set(db, user["id"], "notif", min(upto, db.execute(MAX_CMT_SQL).fetchone()[0]))
    return True


# ---------- 읽기 ----------
POST_COLS = """p.*, (SELECT COUNT(*) FROM cm_likes l WHERE l.post_id = p.id) AS likes,
               EXISTS(SELECT 1 FROM cm_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked,
               (SELECT COUNT(*) FROM cm_comments c WHERE c.post_id = p.id AND c.deleted = 0) AS ncmt"""
HOT_SQL = f"(p.cat != '{NOTICE}' AND (SELECT COUNT(*) FROM cm_likes l WHERE l.post_id = p.id) >= {HOT_MIN})"


def post_dict(r, user, scrapped=False, reported=False, cards=None) -> dict:
    mine = r["author"] == user["id"]
    links = json.loads(r["links"])
    cards = cards or {}
    return {
        "id": r["id"], "author": r["author"], "cat": r["cat"], "title": r["title"], "body": r["body"],
        "tags": json.loads(r["tags"]), "links": links,
        "imgs": [IMG_PATH + k for k in json.loads(r["imgs"])],
        "at": r["created_at"], "editedAt": r["edited_at"], "likes": r["likes"], "liked": bool(r["liked"]), "comments": r["ncmt"],
        "hot": r["cat"] != NOTICE and r["likes"] >= HOT_MIN,
        "mine": mine, "canEdit": mine, "canDel": mine or bool(user["is_admin"]),
        "scrapped": scrapped, "reported": reported,
        "cards": {u: cards[u] for u in links if u in cards},   # 링크 중 이미 모은 글(썸네일 카드로 보여 줌)
    }


def posts_out(db, user, rows) -> list:
    """글 목록을 화면 형식으로: 내 스크랩·신고 여부와 링크의 '모은 글' 카드를 한 번에 붙입니다."""
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    marks = ",".join("?" * len(ids))
    scr = {x[0] for x in db.execute(f"SELECT post_id FROM cm_scraps WHERE user_id = ? AND post_id IN ({marks})", (user["id"], *ids))}
    rep = {x[0] for x in db.execute(f"SELECT post_id FROM cm_reports WHERE reporter = ? AND comment_id = 0 AND post_id IN ({marks})", (user["id"], *ids))}
    cards = items_by_links(db, [u for r in rows for u in json.loads(r["links"])])
    return [post_dict(r, user, r["id"] in scr, r["id"] in rep, cards) for r in rows]


def get_post(db, pid: int, user):
    r = db.execute(f"SELECT {POST_COLS} FROM cm_posts p WHERE p.id = ?", (user["id"], pid)).fetchone()
    if not r:
        raise OpError("없는 글입니다(지워졌을 수 있습니다).")
    return r


def one_post(db, user, pid: int) -> dict:
    return posts_out(db, user, [get_post(db, pid, user)])[0]


def my_tracked_ids(db, uid: str) -> list:
    """이 사용자가 추적하는 계정 ID(태그와 같은 형식). 숨긴 계정도 포함합니다."""
    row = db.execute("SELECT tracked FROM user_state WHERE user_id = ?", (uid,)).fetchone()
    try:
        lst = json.loads(row["tracked"]) if row else []
    except ValueError:
        lst = []
    return list(dict.fromkeys(t["id"] for t in lst if isinstance(t, dict) and isinstance(t.get("id"), str) and TAG_OK.match(t["id"])))


def scope(ids: list):
    """계정 ID들 중 하나라도 태그된 글(없으면 모든 글)."""
    if not ids:
        return "1", []
    return f"p.id IN (SELECT post_id FROM cm_tags WHERE tag IN ({','.join('?' * len(ids))}))", list(ids)


def list_posts(db, user, p: dict):
    sw, args = scope(clean_ids(p.get("ids")))
    where, wargs = [sw], list(args)
    if p.get("scrap") is True:
        where.append("p.id IN (SELECT post_id FROM cm_scraps WHERE user_id = ?)")
        wargs.append(user["id"])
    if p.get("mine") is True:   # 내가 추적하는 계정 중 하나라도 태그된 글만(전체 커뮤니티의 '내 추적 계정 글만')
        mids = my_tracked_ids(db, user["id"])
        where.append(f"p.id IN (SELECT post_id FROM cm_tags WHERE tag IN ({','.join('?' * len(mids))}))" if mids else "0")
        wargs += mids
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
    res = {"posts": posts_out(db, user, rows[:PAGE]), "more": len(rows) > PAGE, "counts": counts,
           "hotMin": HOT_MIN, "admin": bool(user["is_admin"]), "me": user["id"]}
    # 전체 분류 첫 쪽에는 최근 인기글 3개를 맨 위에 따로 보여 줍니다(검색 중에는 안 함)
    if not cat and not q and off == 0 and p.get("scrap") is not True:
        hot = db.execute(f"SELECT {POST_COLS} FROM cm_posts p WHERE {base} AND {HOT_SQL} ORDER BY p.id DESC LIMIT 3",
                         [user["id"], *wargs]).fetchall()
        res["hot"] = posts_out(db, user, hot)
    # 커뮤니티를 처음부터 열었으면 '여기까지 봄'으로 적고, 그 전까지 본 번호를 돌려줍니다(화면이 그보다 새 글에 점을 붙임)
    sc = p.get("scope") if isinstance(p.get("scope"), str) and SCOPE_OK.match(p.get("scope")) else ""
    if sc and off == 0 and not cat and not q:
        res["seenBefore"] = seen_get(db, user["id"], sc)
        seen_set(db, user["id"], sc, max_post_id(db))
    return res


def summary(db, user, p: dict):
    uid = user["id"]

    def one(ids, sc):
        sw, args = scope(ids)
        n, mx = db.execute(f"SELECT COUNT(*), MAX(p.id) FROM cm_posts p WHERE {sw}", args).fetchone()
        last = seen_get(db, uid, sc)
        new = db.execute(f"SELECT COUNT(*) FROM cm_posts p WHERE {sw} AND p.id > ? AND p.author != ?", (*args, last, uid)).fetchone()[0]
        return {"n": n, "lastId": mx, "new": new}
    out = {"all": one([], "all"), "groups": {}}
    groups = p.get("groups") if isinstance(p.get("groups"), list) else []
    for g in groups[:60]:
        if isinstance(g, dict) and isinstance(g.get("key"), str) and 0 < len(g["key"]) <= 100:
            ids = clean_ids(g.get("ids"))
            out["groups"][g["key"]] = one(ids, "g:" + g["key"]) if ids else {"n": 0, "lastId": None, "new": 0}
    last_ids = {v["lastId"] for v in [out["all"], *out["groups"].values()] if v["lastId"]}
    lasts = {}
    if last_ids:
        rows = db.execute(f"SELECT id, title, created_at FROM cm_posts WHERE id IN ({','.join('?' * len(last_ids))})", list(last_ids))
        lasts = {r["id"]: {"title": r["title"], "at": r["created_at"]} for r in rows}
    for v in [out["all"], *out["groups"].values()]:
        v["last"] = lasts.get(v.pop("lastId"))
    out["scraps"] = db.execute("SELECT COUNT(*) FROM cm_scraps WHERE user_id = ?", (uid,)).fetchone()[0]
    seen_set(db, uid, "visit", max_post_id(db))   # 커뮤니티 화면을 봤으니 위쪽 버튼의 새 글 점은 끔
    return out


def comments(db, pid: int, user):
    rows = db.execute("SELECT * FROM cm_comments WHERE post_id = ? ORDER BY id", (pid,)).fetchall()
    rep = {x[0] for x in db.execute("SELECT comment_id FROM cm_reports WHERE reporter = ? AND post_id = ? AND comment_id != 0", (user["id"], pid))}
    out = []
    for r in rows:
        mine = r["author"] == user["id"]
        gone = bool(r["deleted"])
        out.append({"id": r["id"], "parent": r["parent_id"], "author": "" if gone else r["author"],
                    "body": "" if gone else r["body"], "at": r["created_at"], "editedAt": 0 if gone else r["edited_at"], "deleted": gone,
                    "mine": mine and not gone, "canEdit": mine and not gone, "canDel": not gone and (mine or bool(user["is_admin"])),
                    "reported": r["id"] in rep})
    return out


def tag_stats(db):
    """전체 글에서 태그된 계정(글이 많은 순). 이름은 그 계정이 태그된 가장 최근 글의 태그 이름을 씁니다."""
    rows = db.execute("SELECT tag, COUNT(*) AS n, MAX(post_id) AS last FROM cm_tags GROUP BY tag ORDER BY n DESC, last DESC LIMIT 80").fetchall()
    if not rows:
        return []
    lasts = sorted({r["last"] for r in rows})
    labels = {}
    for r in db.execute(f"SELECT tags FROM cm_posts WHERE id IN ({','.join('?' * len(lasts))}) ORDER BY id", lasts):
        for t in json.loads(r["tags"]):
            if isinstance(t, dict) and t.get("label"):
                labels[t.get("id")] = t["label"]
    return [{"id": r["tag"], "platform": r["tag"].split(":", 1)[0], "label": labels.get(r["tag"], ""), "n": r["n"]} for r in rows]


# ---------- 쓰기 ----------
def _cat(user, v) -> str:
    if v == NOTICE and not user["is_admin"]:
        raise OpError("공지는 관리자만 쓸 수 있습니다.")
    if v not in (NOTICE, *CATS):
        raise OpError("분류를 골라 주세요.")
    return v


def write(db, user, p: dict):
    uid = user["id"]
    cat = _cat(user, p.get("cat"))
    title, body = _text(p.get("title"), TITLE_MAX, "제목"), _text(p.get("body"), BODY_MAX, "내용")
    tags, links, imgs = clean_tags(p.get("tags")), clean_links(p.get("links")), decode_images(p.get("imgs"))
    _limit(db, "cm-post:" + uid, RL_POST, "글을 너무 자주 썼습니다. 잠시 뒤 다시 시도하세요.")
    keys = [secrets.token_urlsafe(18) for _ in imgs]
    cur = db.execute("INSERT INTO cm_posts(author, cat, title, body, tags, links, imgs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     (uid, cat, title, body, json.dumps(tags, ensure_ascii=False), json.dumps(links, ensure_ascii=False), json.dumps(keys), now_ms()))
    pid = cur.lastrowid
    db.executemany("INSERT INTO cm_tags(post_id, tag) VALUES (?, ?)", [(pid, t["id"]) for t in tags])
    db.executemany("INSERT INTO cm_images(key, post_id, mime, data) VALUES (?, ?, ?, ?)",
                   [(k, pid, mime, data) for k, (mime, data) in zip(keys, imgs)])
    seen_set(db, uid, "visit", pid)   # 내가 쓴 글로 '새 글' 점이 켜지지 않게
    return one_post(db, user, pid)


def edit(db, user, p: dict):
    """글 고치기: 쓴 사람만(관리자도 남의 글은 못 고침). 사진은 남길 것(기존 주소)과 새로 붙일 것(data:)을 순서대로 받습니다."""
    r = get_post(db, _id(p.get("id")), user)
    if r["author"] != user["id"]:
        raise OpError("내가 쓴 글만 고칠 수 있습니다.")
    cat = _cat(user, p.get("cat"))
    title, body = _text(p.get("title"), TITLE_MAX, "제목"), _text(p.get("body"), BODY_MAX, "내용")
    tags, links = clean_tags(p.get("tags")), clean_links(p.get("links"))
    old = json.loads(r["imgs"])
    src = p.get("imgs") if isinstance(p.get("imgs"), list) else []
    if len(src) > IMGS_MAX:
        raise OpError(f"이미지는 {IMGS_MAX}장까지 붙일 수 있습니다.")
    order, new = [], []   # order: 남길 열쇠 또는 새 사진 자리(None)
    for s in src:
        k = s[len(IMG_PATH):] if isinstance(s, str) and s.startswith(IMG_PATH) else None
        if k is not None:
            if k in old and k not in order:
                order.append(k)
        else:
            order.append(None)
            new.append(s)
    decoded = decode_images(new)
    _limit(db, "cm-edit:" + user["id"], RL_EDIT, "너무 자주 고쳤습니다. 잠시 뒤 다시 시도하세요.")
    fresh = iter([(secrets.token_urlsafe(18), m, d) for m, d in decoded])
    keys, adds = [], []
    for k in order:
        if k is None:
            nk, m, d = next(fresh)
            keys.append(nk)
            adds.append((nk, r["id"], m, d))
        else:
            keys.append(k)
    db.execute("UPDATE cm_posts SET cat = ?, title = ?, body = ?, tags = ?, links = ?, imgs = ?, edited_at = ? WHERE id = ?",
               (cat, title, body, json.dumps(tags, ensure_ascii=False), json.dumps(links, ensure_ascii=False), json.dumps(keys), now_ms(), r["id"]))
    gone = [k for k in old if k not in keys]
    if gone:
        db.execute(f"DELETE FROM cm_images WHERE post_id = ? AND key IN ({','.join('?' * len(gone))})", (r["id"], *gone))
    db.executemany("INSERT INTO cm_images(key, post_id, mime, data) VALUES (?, ?, ?, ?)", adds)
    db.execute("DELETE FROM cm_tags WHERE post_id = ?", (r["id"],))
    db.executemany("INSERT INTO cm_tags(post_id, tag) VALUES (?, ?)", [(r["id"], t["id"]) for t in tags])
    return one_post(db, user, r["id"])


def delete_post(db, user, p: dict):
    r = get_post(db, _id(p.get("id")), user)
    if r["author"] != user["id"] and not user["is_admin"]:
        raise OpError("내가 쓴 글만 지울 수 있습니다.")
    db.execute("DELETE FROM cm_posts WHERE id = ?", (r["id"],))   # 태그·댓글·좋아요·이미지·스크랩·신고는 ON DELETE CASCADE
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


def scrap(db, user, p: dict):
    pid = get_post(db, _id(p.get("id")), user)["id"]
    if p.get("on") is True:
        db.execute("INSERT OR IGNORE INTO cm_scraps(user_id, post_id, created_at) VALUES (?, ?, ?)", (user["id"], pid, now_ms()))
    else:
        db.execute("DELETE FROM cm_scraps WHERE user_id = ? AND post_id = ?", (user["id"], pid))
    return {"scrapped": p.get("on") is True}


def _comment(db, cid):
    c = db.execute("SELECT * FROM cm_comments WHERE id = ?", (_id(cid, "댓글"),)).fetchone()
    if not c or c["deleted"]:
        raise OpError("없는 댓글입니다(지워졌을 수 있습니다).")
    return c


def add_comment(db, user, p: dict):
    pid = get_post(db, _id(p.get("id")), user)["id"]
    body = _text(p.get("body"), CMT_MAX, "댓글")
    parent = None
    if p.get("parent") is not None:
        c = db.execute("SELECT * FROM cm_comments WHERE id = ?", (_id(p.get("parent"), "댓글"),)).fetchone()
        if not c or c["post_id"] != pid or c["deleted"]:
            raise OpError("답글을 달 댓글이 없습니다(지워졌을 수 있습니다).")
        parent = c["parent_id"] or c["id"]   # 답글의 답글은 같은 댓글 아래에(한 단계만)
    _limit(db, "cm-cmt:" + user["id"], RL_CMT, "댓글을 너무 자주 달았습니다. 잠시 뒤 다시 시도하세요.")
    db.execute("INSERT INTO cm_comments(post_id, parent_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)",
               (pid, parent, user["id"], body, now_ms()))
    return comments(db, pid, user)


def edit_comment(db, user, p: dict):
    c = _comment(db, p.get("id"))
    if c["author"] != user["id"]:
        raise OpError("내가 단 댓글만 고칠 수 있습니다.")
    body = _text(p.get("body"), CMT_MAX, "댓글")
    if body != c["body"]:
        _limit(db, "cm-edit:" + user["id"], RL_EDIT, "너무 자주 고쳤습니다. 잠시 뒤 다시 시도하세요.")
        db.execute("UPDATE cm_comments SET body = ?, edited_at = ? WHERE id = ?", (body, now_ms(), c["id"]))
    return comments(db, c["post_id"], user)


def remove_comment(db, c):
    """댓글 지우기(사용자·관리자 공통). 답글이 달린 댓글은 내용만 지우고 자리는 남깁니다. 그 댓글의 신고도 지웁니다."""
    db.execute("DELETE FROM cm_reports WHERE comment_id = ?", (c["id"],))
    has_replies = db.execute("SELECT 1 FROM cm_comments WHERE parent_id = ? LIMIT 1", (c["id"],)).fetchone()
    if has_replies:
        db.execute("UPDATE cm_comments SET deleted = 1, body = '' WHERE id = ?", (c["id"],))   # 답글은 남기고 '지운 댓글'로 표시
    else:
        db.execute("DELETE FROM cm_comments WHERE id = ?", (c["id"],))
        if c["parent_id"]:   # 지운 댓글 아래 마지막 답글이었으면 빈 자리도 정리
            db.execute("""DELETE FROM cm_comments WHERE id = ? AND deleted = 1
                          AND NOT EXISTS (SELECT 1 FROM cm_comments WHERE parent_id = ?)""", (c["parent_id"], c["parent_id"]))


def del_comment(db, user, p: dict):
    c = _comment(db, p.get("id"))
    if c["author"] != user["id"] and not user["is_admin"]:
        raise OpError("내가 단 댓글만 지울 수 있습니다.")
    remove_comment(db, c)
    return comments(db, c["post_id"], user)


def report(db, user, p: dict):
    r = get_post(db, _id(p.get("id")), user)
    cid = 0
    if p.get("cid") is not None:
        c = _comment(db, p.get("cid"))
        if c["post_id"] != r["id"]:
            raise OpError("없는 댓글입니다(지워졌을 수 있습니다).")
        if c["author"] == user["id"]:
            raise OpError("내 댓글은 신고할 수 없습니다.")
        cid = c["id"]
    elif r["author"] == user["id"]:
        raise OpError("내 글은 신고할 수 없습니다.")
    reason = p.get("reason")
    if reason not in REASONS:
        raise OpError("신고 이유를 골라 주세요.")
    memo = p.get("memo").strip()[:MEMO_MAX] if isinstance(p.get("memo"), str) else ""
    _limit(db, "cm-report:" + user["id"], RL_REPORT, "신고를 너무 자주 했습니다. 잠시 뒤 다시 시도하세요.")
    cur = db.execute("INSERT OR IGNORE INTO cm_reports(post_id, comment_id, reporter, reason, memo, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                     (r["id"], cid, user["id"], reason, memo, now_ms()))
    if not cur.rowcount:
        raise OpError("이미 신고했습니다. 관리자가 확인할 때까지 기다려 주세요.")
    return True


# ---------- 관리자(관리 탭의 커뮤니티 칸) ----------
def admin_info(db) -> dict:
    n = lambda q, a=(): db.execute(q, a).fetchone()[0]  # noqa: E731
    size = 0
    for suffix in ("", "-wal"):
        try:
            size += os.path.getsize(str(DB_PATH) + suffix)
        except OSError:
            pass
    img_n, img_b = db.execute("SELECT COUNT(*), COALESCE(SUM(LENGTH(data)), 0) FROM cm_images").fetchone()
    # 신고: 대상(글·댓글)마다 묶어서
    reps = {}
    for r in db.execute("SELECT * FROM cm_reports ORDER BY id DESC LIMIT 1000"):
        k = (r["post_id"], r["comment_id"])
        e = reps.setdefault(k, {"post": r["post_id"], "comment": r["comment_id"], "reports": [], "at": r["created_at"]})
        e["reports"].append({"who": r["reporter"], "reason": r["reason"], "memo": r["memo"], "at": r["created_at"]})
    targets = list(reps.values())
    if targets:
        pids = sorted({t["post"] for t in targets})
        posts = {r["id"]: r for r in db.execute(f"SELECT id, title, author, body FROM cm_posts WHERE id IN ({','.join('?' * len(pids))})", pids)}
        cids = sorted({t["comment"] for t in targets if t["comment"]})
        cmts = {r["id"]: r for r in db.execute(f"SELECT id, author, body, deleted FROM cm_comments WHERE id IN ({','.join('?' * len(cids))})", cids)} if cids else {}
        for t in targets:
            pr = posts.get(t["post"])
            t["title"] = pr["title"] if pr else ""
            if t["comment"]:
                c = cmts.get(t["comment"])
                t["author"], t["text"] = (c["author"], c["body"][:200]) if c else ("", "")
            else:
                t["author"], t["text"] = (pr["author"], pr["body"][:200]) if pr else ("", "")
    img_by_post = {r[0]: (r[1], r[2]) for r in db.execute("SELECT post_id, COUNT(*), SUM(LENGTH(data)) FROM cm_images GROUP BY post_id")}
    post_row = lambda r: {"id": r["id"], "title": r["title"], "author": r["author"], "cat": r["cat"], "at": r["created_at"],  # noqa: E731
                          "editedAt": r["edited_at"], "comments": r["ncmt"], "imgs": img_by_post.get(r["id"], (0, 0))[0],
                          "imgBytes": img_by_post.get(r["id"], (0, 0))[1] or 0}
    recent = db.execute("""SELECT p.id, p.title, p.author, p.cat, p.created_at, p.edited_at,
                                  (SELECT COUNT(*) FROM cm_comments c WHERE c.post_id = p.id AND c.deleted = 0) AS ncmt
                           FROM cm_posts p ORDER BY p.id DESC LIMIT 30""").fetchall()
    big_ids = [pid for pid, _ in sorted(img_by_post.items(), key=lambda x: -(x[1][1] or 0))[:10]]
    big = db.execute(f"""SELECT p.id, p.title, p.author, p.cat, p.created_at, p.edited_at,
                                (SELECT COUNT(*) FROM cm_comments c WHERE c.post_id = p.id AND c.deleted = 0) AS ncmt
                         FROM cm_posts p WHERE p.id IN ({','.join('?' * len(big_ids)) or 'NULL'})""", big_ids).fetchall()
    cmts = db.execute("""SELECT c.id, c.post_id, c.author, c.body, c.created_at, c.edited_at, p.title FROM cm_comments c
                         JOIN cm_posts p ON p.id = c.post_id WHERE c.deleted = 0 ORDER BY c.id DESC LIMIT 30""").fetchall()
    users = {}
    for r in db.execute("SELECT author, COUNT(*) FROM cm_posts GROUP BY author"):
        users.setdefault(r[0], {"id": r[0], "posts": 0, "comments": 0, "imgs": 0, "imgBytes": 0})["posts"] = r[1]
    for r in db.execute("SELECT author, COUNT(*) FROM cm_comments WHERE deleted = 0 GROUP BY author"):
        users.setdefault(r[0], {"id": r[0], "posts": 0, "comments": 0, "imgs": 0, "imgBytes": 0})["comments"] = r[1]
    for r in db.execute("SELECT p.author, COUNT(*), SUM(LENGTH(i.data)) FROM cm_images i JOIN cm_posts p ON p.id = i.post_id GROUP BY p.author"):
        u = users.setdefault(r[0], {"id": r[0], "posts": 0, "comments": 0, "imgs": 0, "imgBytes": 0})
        u["imgs"], u["imgBytes"] = r[1], r[2] or 0
    return {
        "counts": {"posts": n("SELECT COUNT(*) FROM cm_posts"), "comments": n("SELECT COUNT(*) FROM cm_comments WHERE deleted = 0"),
                   "imgs": img_n, "imgBytes": img_b, "dbBytes": size, "reports": len(targets),
                   "scraps": n("SELECT COUNT(*) FROM cm_scraps")},
        "reports": sorted(targets, key=lambda t: -t["at"]),
        "posts": [post_row(r) for r in recent],
        "bigPosts": sorted((post_row(r) for r in big), key=lambda x: -x["imgBytes"]),
        "comments": [{"id": r["id"], "post": r["post_id"], "title": r["title"], "author": r["author"], "body": r["body"][:200],
                      "at": r["created_at"], "editedAt": r["edited_at"]} for r in cmts],
        "users": sorted(users.values(), key=lambda u: (-u["imgBytes"], -u["posts"], -u["comments"], u["id"])),
    }


def admin_del_post(db, p: dict):
    pid = _id(p.get("id"))
    if not db.execute("DELETE FROM cm_posts WHERE id = ?", (pid,)).rowcount:
        raise OpError("없는 글입니다(이미 지워졌을 수 있습니다).")
    return True


def admin_del_comment(db, p: dict):
    remove_comment(db, _comment(db, p.get("id")))
    return True


def admin_dismiss(db, p: dict):
    """신고 기각: 그 대상(글 또는 댓글)의 신고를 모두 지웁니다(글·댓글은 그대로)."""
    pid = _id(p.get("post"))
    cid = p.get("comment") if isinstance(p.get("comment"), int) and not isinstance(p.get("comment"), bool) and p.get("comment") >= 0 else 0
    return db.execute("DELETE FROM cm_reports WHERE post_id = ? AND comment_id = ?", (pid, cid)).rowcount


# ---------- 요청 처리 ----------
def handle(db, user, act: str, p: dict):
    if act == "summary":
        return summary(db, user, p)
    if act == "list":
        return list_posts(db, user, p)
    if act == "get":
        return {"post": one_post(db, user, _id(p.get("id"))), "hotMin": HOT_MIN, "admin": bool(user["is_admin"]), "me": user["id"]}
    if act == "comments":
        return comments(db, get_post(db, _id(p.get("id")), user)["id"], user)
    if act == "write":
        return write(db, user, p)
    if act == "edit":
        return edit(db, user, p)
    if act == "delete":
        return delete_post(db, user, p)
    if act == "like":
        return like(db, user, p)
    if act == "scrap":
        return scrap(db, user, p)
    if act == "comment":
        return add_comment(db, user, p)
    if act == "editComment":
        return edit_comment(db, user, p)
    if act == "delComment":
        return del_comment(db, user, p)
    if act == "report":
        return report(db, user, p)
    if act == "notifs":
        return notifs(db, user)
    if act == "notifRead":
        return notif_read(db, user, p)
    if act == "tagStats":
        return tag_stats(db)
    if act == "lookup":
        urls = p.get("urls") if isinstance(p.get("urls"), list) else []
        return items_by_links(db, [u for u in urls[:20] if isinstance(u, str) and len(u) <= 500])
    if act == "findItems":
        return find_items(db, p)
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
