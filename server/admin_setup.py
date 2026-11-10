"""관리자 계정 정하기 (서버 PC에서만). 웹 가입으로는 관리자를 만들 수 없습니다.

  admin_setup.bat                     아이디·비밀번호를 물어보고 관리자로 만듦(이미 있는 아이디면 관리자로 바꿈)
  admin_setup.bat <아이디>             그 아이디를 관리자로(없으면 비밀번호를 물어보고 새로 만듦)
  admin_setup.bat <아이디> --password <비밀번호>   비밀번호까지 한 번에(이미 있는 아이디면 비밀번호도 바꿈)
  admin_setup.bat <아이디> --revoke    관리자에서 일반 사용자로
  admin_setup.bat --list              관리자 목록

서버가 켜져 있어도 됩니다(같은 DB 파일을 씁니다). 비밀번호를 바꾸면 그 아이디의 다른 기기 로그인은 풀립니다.
"""
import getpass
import secrets
import sys
import time

from auth import ID_RE, hash_pw
from db import get_db, init_db


def ask_pw() -> str:
    while True:
        a = getpass.getpass("비밀번호(6자 이상, 화면에 안 보임): ")
        if len(a) < 6:
            print("6자 이상이어야 합니다.")
            continue
        if getpass.getpass("비밀번호 확인: ") != a:
            print("두 번 입력한 비밀번호가 다릅니다.")
            continue
        return a


def main(argv):
    init_db()
    if "--list" in argv:
        with get_db() as db:
            rows = db.execute("SELECT id FROM users WHERE is_admin = 1 ORDER BY id").fetchall()
        print("관리자:", ", ".join(r["id"] for r in rows) or "(없음)")
        return 0
    args = [a for a in argv if not a.startswith("--")]
    pw = None
    if "--password" in argv:
        i = argv.index("--password")
        pw = argv[i + 1] if i + 1 < len(argv) else ""
        args = [a for a in args if a != pw]
        if len(pw) < 6:
            print("비밀번호는 6자 이상이어야 합니다.")
            return 1
    uid = (args[0] if args else input("관리자 아이디: ")).strip().lower()
    if not ID_RE.match(uid):
        print("아이디는 영문·숫자·_ . - 로 3~30자여야 합니다.")
        return 1
    with get_db() as db:
        user = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        if "--revoke" in argv:
            if not user or not user["is_admin"]:
                print(f"{uid}은(는) 관리자가 아닙니다.")
                return 0
            if not db.execute("SELECT 1 FROM users WHERE is_admin = 1 AND id != ?", (uid,)).fetchone():
                print("마지막 관리자는 해제할 수 없습니다. 다른 관리자를 먼저 정하세요.")
                return 1
            db.execute("UPDATE users SET is_admin = 0 WHERE id = ?", (uid,))
            print(f"{uid}: 관리자 해제")
            return 0
        if user is None:
            pw = pw or ask_pw()
            salt = secrets.token_hex(16)
            db.execute("INSERT INTO users(id, salt, hash, token, sv, created_at, is_admin) VALUES (?, ?, ?, '', 0, ?, 1)",
                       (uid, salt, hash_pw(pw, salt), int(time.time())))
            print(f"{uid}: 관리자 계정을 새로 만들었습니다.")
        else:
            db.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (uid,))
            if pw:
                salt = secrets.token_hex(16)
                db.execute("UPDATE users SET salt = ?, hash = ?, sv = sv + 1, must_change = 0 WHERE id = ?", (salt, hash_pw(pw, salt), uid))
                db.execute("DELETE FROM sessions WHERE user_id = ?", (uid,))
                print(f"{uid}: 관리자로 정하고 비밀번호를 바꿨습니다(다른 기기 로그인은 풀림).")
            else:
                print(f"{uid}: 이미 있는 아이디를 관리자로 정했습니다(비밀번호는 그대로).")
    print("웹에서 이 아이디로 로그인하면 왼쪽에 '관리' 탭이 보입니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
