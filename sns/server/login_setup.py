"""테스트 계정 로그인 도구 (서버를 끈 상태에서 실행하세요)

수집기가 쓰는 크롬 프로필(server/profiles/<매체>)을 '보통 크롬 창'으로 열어 줍니다.
열린 창에서 테스트 계정으로 직접 로그인한 뒤 창을 닫으면, 로그인 정보가 프로필에 남아 수집기가 그대로 씁니다.

자동화(Playwright)가 아닌 보통 크롬으로 여는 이유: 구글 등은 자동화된 브라우저에서의 로그인을 막기 때문입니다.

실행: login_setup.bat 더블클릭  또는  python login_setup.py [youtube] [x] [instagram]
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

PROFILES = Path(__file__).resolve().parent / "profiles"
LOGIN = {
    "youtube": "https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/",
    "x": "https://x.com/i/flow/login",
    "instagram": "https://www.instagram.com/accounts/login/",
}


def find_chrome() -> str:
    cands = []
    for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            cands.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
    for c in cands:
        if c.is_file():
            return str(c)
    for name in ("chrome", "google-chrome", "chrome.exe"):
        p = shutil.which(name)
        if p:
            return p
    return ""


def main():
    plats = [a for a in sys.argv[1:] if a in LOGIN] or list(LOGIN)
    chrome = find_chrome()
    if not chrome:
        print("크롬을 찾지 못했습니다. 서버 PC에 구글 크롬을 설치하세요.")
        return 1
    print("테스트 계정 로그인 창을 엽니다:", ", ".join(plats))
    print("※ 서버(start.bat)가 켜져 있으면 먼저 끄세요. 같은 프로필을 동시에 쓸 수 없습니다.\n")
    procs = []
    for p in plats:
        d = PROFILES / p
        d.mkdir(parents=True, exist_ok=True)
        procs.append((p, subprocess.Popen([chrome, f"--user-data-dir={d}", "--no-first-run", "--no-default-browser-check", "--new-window", LOGIN[p]])))
        print(f"- {p}: 창이 열렸습니다. 테스트 계정으로 로그인하세요.")
    print("\n로그인을 마치면 각 크롬 창을 닫으세요. 모든 창이 닫히면 이 창도 끝납니다.")
    for p, proc in procs:
        proc.wait()
        print(f"- {p}: 창이 닫혔습니다.")
    print("\n완료. 이제 start.bat으로 서버를 켜세요.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
