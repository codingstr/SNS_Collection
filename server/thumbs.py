"""인스타그램 썸네일 보관.

인스타그램(메타 CDN) 그림 주소에는 만료 시각(oe=)과 서명(oh=)이 붙어 있어 며칠 뒤면 403으로 막힙니다.
수집기가 다시 보지 않는 오래된 글은 주소가 새로 갱신되지 않으므로, 주소가 살아 있을 때 그림을 받아
작게 줄여(JPEG, 폭 520px) DB(thumbs 표)에 넣어 두고 /api/thumb/{글 ID}로 보여 줍니다.

  - 수집기가 인스타 글을 저장하면 want()로 받을 글을 알려 줍니다. 받기는 이 파일의 작업 스레드가 한 장씩 합니다.
  - 서버를 켤 때 아직 안 받은(주소가 살아 있는) 인스타 글도 한 번 훑어 받습니다.
  - 받은 글은 items.updated_at을 올려, 화면이 글 목록을 다시 받아 새 주소(/api/thumb/…)로 바꾸게 합니다.
  - 그림을 줄이는 데 Pillow가 필요합니다. 없으면(setup.bat을 다시 안 돌린 컴퓨터) 받기만 건너뛰고 나머지는 그대로 돌아갑니다.
"""
import io
import logging
import queue
import re
import threading
import time
import urllib.request
from urllib.parse import urlsplit

from fastapi import APIRouter
from fastapi.responses import Response

from db import get_db

log = logging.getLogger("thumbs")
router = APIRouter()

THUMB_PATH = "/api/thumb/"
ID_OK = re.compile(r"^ig:[\w-]{5,60}$")
HOST_OK = re.compile(r"(^|\.)(cdninstagram\.com|fbcdn\.net)$")
OE = re.compile(r"[?&]oe=([0-9A-Fa-f]{6,10})(?:&|$)")
WIDTH = 520           # 카드 폭 240px 안팎의 2배(화면이 줄이던 크기와 같음)
MAX_HEIGHT = 1040     # 아주 긴 세로 그림은 높이도 제한
QUALITY = 75          # 한 장 40~50KB 안팎(원본은 평균 600KB). 화면은 ngrok을 거쳐 받으므로 작을수록 좋음
MAX_BYTES = 12 << 20  # 원본이 이보다 크면 받지 않음(인스타 원본은 보통 0.1~2MB)
GAP_S = 0.4           # 한 장 받은 뒤 쉬는 시간(CDN에 몰아서 요청하지 않게)
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

_q: "queue.Queue[str]" = queue.Queue()
_pending: set = set()   # 줄에 들어 있는 글 ID(같은 글을 두 번 넣지 않게)
_failed: dict = {}      # 글 ID -> 받기에 실패한 주소. 수집기가 새 주소를 가져오면 다시 시도합니다
_lock = threading.Lock()
_started = False


def expiry(url: str):
    """서명된 주소의 만료 시각(초). 만료 표시가 없는 주소는 None."""
    m = OE.search(url or "")
    return int(m.group(1), 16) if m else None


def expired(url: str, margin: int = 0) -> bool:
    e = expiry(url)
    return e is not None and e <= time.time() + margin


def shown(item_id: str, thumb: str, stored) -> str:
    """화면에 보낼 썸네일 주소: 보관한 그림이 있으면 그것, 만료된 주소는 빈칸(화면이 403을 받지 않게), 아니면 원래 주소."""
    if stored:
        return THUMB_PATH + item_id
    return "" if expired(thumb) else thumb


# 글 목록 SQL에 붙여 쓰는 '보관한 그림이 있는지' 칸(items 별칭이 i일 때)
STORED_COL = "EXISTS(SELECT 1 FROM thumbs t WHERE t.id = i.id) AS stored"


def _wanted(item_id: str, url: str) -> bool:
    if not ID_OK.match(item_id or "") or not url.startswith("https://") or expired(url, 60):
        return False
    if not HOST_OK.search(urlsplit(url).hostname or ""):
        return False
    return _failed.get(item_id) != url


def want(items) -> None:
    """수집기가 저장한 글 [{id, source, thumb}, ...] 중 인스타 글의 썸네일을 받을 줄에 넣습니다."""
    if not _started:
        return
    with _lock:
        for it in items:
            if it.get("source") == "instagram" and it["id"] not in _pending and _wanted(it["id"], it.get("thumb") or ""):
                _pending.add(it["id"])
                _q.put(it["id"])


def _shrink(data: bytes) -> bytes:
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(data)) as im:
        im.draft("RGB", (WIDTH * 2, MAX_HEIGHT * 2))   # JPEG는 읽을 때부터 1/2·1/4 크기로 풀어 빠르게
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((WIDTH, MAX_HEIGHT), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, "JPEG", quality=QUALITY, optimize=True, progressive=True)
        return out.getvalue()


def _fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"})
    with urllib.request.urlopen(req, timeout=20) as r:
        if not (r.headers.get("Content-Type") or "").startswith("image/"):
            raise ValueError("그림이 아님: " + (r.headers.get("Content-Type") or "?"))
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("너무 큼")
    return data


def _one(item_id: str) -> None:
    with get_db() as db:
        r = db.execute("SELECT thumb, EXISTS(SELECT 1 FROM thumbs WHERE id = ?) AS stored FROM items WHERE id = ?", (item_id, item_id)).fetchone()
    if not r or r["stored"] or not _wanted(item_id, r["thumb"]):
        return
    url = r["thumb"]
    try:
        small = _shrink(_fetch(url))
    except Exception as e:
        _failed[item_id] = url
        log.info("썸네일 받기 실패 %s: %s", item_id, e)
        return
    now = int(time.time() * 1000)
    with get_db() as db:
        if not db.execute("SELECT 1 FROM items WHERE id = ?", (item_id,)).fetchone():
            return   # 받는 사이 지워진 글
        db.execute("INSERT OR REPLACE INTO thumbs(id, data, at) VALUES (?, ?, ?)", (item_id, small, now))
        db.execute("UPDATE items SET updated_at = ? WHERE id = ?", (now, item_id))   # 화면이 글 목록을 다시 받아 새 주소로 바꿈
    _failed.pop(item_id, None)


def _work() -> None:
    while True:
        item_id = _q.get()
        try:
            _one(item_id)
        except Exception:
            log.exception("썸네일 처리 오류: %s", item_id)
        finally:
            with _lock:
                _pending.discard(item_id)
        time.sleep(GAP_S)


def start() -> None:
    """작업 스레드를 띄우고, 아직 안 받은 인스타 썸네일(주소가 살아 있는 것)을 줄에 넣습니다."""
    global _started
    if _started:
        return
    try:
        import PIL  # noqa: F401
    except ImportError:
        log.warning("Pillow가 없어 인스타그램 썸네일을 보관하지 않습니다. setup.bat을 다시 실행하세요.")
        return
    _started = True
    threading.Thread(target=_work, name="thumbs", daemon=True).start()
    with get_db() as db:
        rows = db.execute("""SELECT id, source, thumb FROM items WHERE source = 'instagram' AND thumb != ''
                             AND id NOT IN (SELECT id FROM thumbs) ORDER BY collected_at DESC""").fetchall()
    want([dict(r) for r in rows])
    if not _q.empty():
        log.info("인스타그램 썸네일 %d장을 받습니다.", _q.qsize())


@router.get("/api/thumb/{item_id}")
def thumb(item_id: str):
    """보관한 썸네일. 글 ID(인스타 게시물 코드)는 공개 정보라 로그인 없이 엽니다(커뮤니티 이미지와 같음)."""
    if not ID_OK.match(item_id):
        return Response(status_code=404)
    with get_db() as db:
        r = db.execute("SELECT data FROM thumbs WHERE id = ?", (item_id,)).fetchone()
    if not r:
        return Response(status_code=404)
    return Response(content=bytes(r["data"]), media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})
