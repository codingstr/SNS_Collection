"""SQLite 데이터베이스 (server/data/app.db 파일 하나에 모두 저장됩니다)."""
import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "data" / "app.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,            -- 로그인 아이디 (소문자)
  salt        TEXT NOT NULL,
  hash        TEXT NOT NULL,               -- scrypt(비밀번호, salt)
  token       TEXT NOT NULL DEFAULT '',    -- (사용 안 함: 예전 확장 연결 코드)
  sv          INTEGER NOT NULL DEFAULT 0,  -- 세션 버전: 비밀번호를 바꾸면 +1 → 예전 세션 무효
  created_at  INTEGER NOT NULL,
  is_admin    INTEGER NOT NULL DEFAULT 0,  -- 관리자(웹의 '관리' 탭). 가입으로는 만들 수 없고 admin_setup으로만 정합니다
  must_change INTEGER NOT NULL DEFAULT 0   -- 관리자가 비밀번호를 초기화함: 다음 로그인 때 새 비밀번호로 바꾸라고 안내
);
CREATE TABLE IF NOT EXISTS sessions (
  hash        TEXT PRIMARY KEY,            -- sha256(세션 값). 원래 값은 저장하지 않습니다
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sv          INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
-- 사용자별 상태
CREATE TABLE IF NOT EXISTS user_state (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tracked         TEXT NOT NULL DEFAULT '[]',   -- 추적 계정 목록 (JSON, 화면 형식 그대로)
  settings        TEXT NOT NULL DEFAULT '{}',   -- 매체별 수집 켜기/끄기 (JSON)
  window_days     INTEGER NOT NULL DEFAULT 30,  -- 가져올 기간
  status          TEXT NOT NULL DEFAULT '{}',   -- 수집 진행 상태 (JSON)
  cleared_before  INTEGER NOT NULL DEFAULT 0    -- '글 지우기'를 누른 시각: 그 전에 모은 글은 이 사용자에게 안 보임
);
-- 수집한 글. 여러 사용자가 같은 계정을 추적하면 한 번만 저장하고 같이 씁니다.
CREATE TABLE IF NOT EXISTS items (
  id              TEXT PRIMARY KEY,             -- 매체별 글 ID (예: yt:영상ID)
  source          TEXT NOT NULL,                -- youtube-video / youtube-post / x / instagram
  url             TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  author          TEXT NOT NULL DEFAULT '',
  thumb           TEXT NOT NULL DEFAULT '',
  published_at    TEXT NOT NULL DEFAULT '',
  published_text  TEXT NOT NULL DEFAULT '',
  via             TEXT NOT NULL DEFAULT '',     -- 처음 모은 추적 계정 (예: youtube:채널핸들). 실제 연결은 item_via
  collected_at    INTEGER NOT NULL,             -- 처음 모은 시각(밀리초)
  seen_at         INTEGER NOT NULL DEFAULT 0,   -- 마지막으로 다시 본 시각(밀리초). '글 모두 삭제' 뒤에 다시 모으면 다시 보이게 하는 데 씀
  updated_at      INTEGER NOT NULL DEFAULT 0    -- 내용(제목·썸네일·날짜 등)이 실제로 바뀐 시각(밀리초). 화면의 글 목록 버전에 씀
);
-- 글 ↔ 추적 계정 연결. 같은 계정을 사용자마다 다른 이름(@핸들 / 채널 주소)으로 추가해도 각자 글이 보이게 합니다.
CREATE TABLE IF NOT EXISTS item_via (
  item_id         TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  via             TEXT NOT NULL,
  PRIMARY KEY (item_id, via)
);
CREATE INDEX IF NOT EXISTS item_via_via ON item_via(via);
-- 계정 프로필 사진(검색 결과에서 받은 작은 데이터 주소). 모든 사용자·기기가 같이 씁니다.
CREATE TABLE IF NOT EXISTS avatars (
  id              TEXT PRIMARY KEY,             -- 추적 계정 ID (예: x:handle)
  data            TEXT NOT NULL,                -- data:image/...;base64,...
  at              INTEGER NOT NULL
);
-- 본 글 기록 (흐리게 표시)
CREATE TABLE IF NOT EXISTS seen (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL,
  at              INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
-- 서버 전체 값 (예: 테스트 계정 로그인 상태 'loginState')
CREATE TABLE IF NOT EXISTS kv (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key         TEXT PRIMARY KEY,            -- sha256(종류:IP[:아이디])
  count       INTEGER NOT NULL,
  reset_at    INTEGER NOT NULL
);
-- 페이지별 수집 범위 기억(이미 모은 글에서 멈춰도 되는지 판단). collector/runner.py의 cover_plan 참고
CREATE TABLE IF NOT EXISTS coverage (
  url         TEXT PRIMARY KEY,
  data        TEXT NOT NULL,               -- JSON: {"since", "full_at"} / {"gap": true} / 로딩이 막혔을 때 {"stalled_at", "want"}
  at          INTEGER NOT NULL             -- 마지막으로 고친 시각(밀리초). 오래 안 쓴 주소는 정리합니다
);
-- 페이지별 마지막 수집 결과(관리 탭의 'SNS 계정 상태'에 씀). 주소마다 마지막 한 번만 남깁니다.
CREATE TABLE IF NOT EXISTS page_log (
  url         TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,            -- 끝난 시각(밀리초)
  mode        TEXT NOT NULL DEFAULT '',    -- deep(사용자 수집) / shallow(자동 수집)
  why         TEXT NOT NULL DEFAULT '',    -- 멈춘 이유(수집 스크립트가 알려 준 것)
  found       INTEGER NOT NULL DEFAULT 0,  -- 화면에서 본 글 수
  added       INTEGER NOT NULL DEFAULT 0,  -- 새로 저장한 글 수
  error       TEXT NOT NULL DEFAULT '',    -- 실패했으면 그 이유
  ok_at       INTEGER NOT NULL DEFAULT 0   -- 마지막으로 성공한 시각(밀리초)
);
"""
SCHEMA_VERSION = 2   # PRAGMA user_version. 한 번만 하면 되는 변환은 이 번호로 건너뜁니다.


@contextmanager
def get_db():
    """with get_db() as db: ...  — 블록이 끝나면 자동 저장(commit)하고 닫습니다."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA synchronous = NORMAL")  # WAL에서는 이것으로 충분히 안전하고, 잦은 작은 저장이 훨씬 빨라집니다
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    DB_PATH.parent.mkdir(exist_ok=True)
    with get_db() as db:
        db.execute("PRAGMA journal_mode = WAL")  # 읽기·쓰기가 동시에 와도 덜 막힙니다
        ver = db.execute("PRAGMA user_version").fetchone()[0]
        # 예전 DB: items에 새 칸이 없으면 먼저 붙입니다(CREATE TABLE IF NOT EXISTS는 있는 테이블을 고치지 않음).
        has_items = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='items'").fetchone()
        if has_items:
            cols = {r["name"] for r in db.execute("PRAGMA table_info(items)")}
            for col in ("seen_at", "updated_at"):
                if col not in cols:
                    db.execute(f"ALTER TABLE items ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0")
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone():
            cols = {r["name"] for r in db.execute("PRAGMA table_info(users)")}
            for col in ("is_admin", "must_change"):
                if col not in cols:
                    db.execute(f"ALTER TABLE users ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0")
        db.executescript(SCHEMA)
        if ver < SCHEMA_VERSION:
            # 한 번만 하면 되는 변환(예전에는 켤 때마다 전체 표를 훑었음)
            db.execute("UPDATE items SET seen_at = collected_at WHERE seen_at = 0")
            db.execute("UPDATE items SET updated_at = MAX(collected_at, seen_at) WHERE updated_at = 0")
            db.execute("INSERT OR IGNORE INTO item_via(item_id, via) SELECT id, via FROM items WHERE via != ''")
            db.execute("DROP INDEX IF EXISTS items_via")   # item_via 표를 쓰면서 쓰이지 않게 된 색인
            # 예전에는 페이지별 수집 범위를 kv 한 칸에 JSON 하나로 두었습니다 → coverage 표로 옮깁니다.
            row = db.execute("SELECT value FROM kv WHERE key = 'coverage'").fetchone()
            if row:
                try:
                    old = json.loads(row["value"]) or {}
                except ValueError:
                    old = {}
                at = int(time.time() * 1000)
                db.executemany("INSERT OR REPLACE INTO coverage(url, data, at) VALUES (?, ?, ?)",
                               [(u, json.dumps(c), at) for u, c in old.items() if isinstance(c, dict)])
                db.execute("DELETE FROM kv WHERE key = 'coverage'")
            db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        now = int(time.time())
        db.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        db.execute("DELETE FROM rate_limits WHERE reset_at < ?", (now,))
