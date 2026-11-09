"""SQLite 데이터베이스 (server/data/app.db 파일 하나에 모두 저장됩니다)."""
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
  created_at  INTEGER NOT NULL
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
  via             TEXT NOT NULL DEFAULT '',     -- 어느 추적 계정에서 모았는지 (예: youtube:채널핸들)
  collected_at    INTEGER NOT NULL              -- 밀리초
);
CREATE INDEX IF NOT EXISTS items_via ON items(via, collected_at);
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
  key         TEXT PRIMARY KEY,            -- sha256(IP)
  count       INTEGER NOT NULL,
  reset_at    INTEGER NOT NULL
);
"""


@contextmanager
def get_db():
    """with get_db() as db: ...  — 블록이 끝나면 자동 저장(commit)하고 닫습니다."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
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
        db.executescript(SCHEMA)
        db.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
