"""테스트 계정 로그인 도구 (서버를 끈 상태에서 실행하세요)

수집기가 쓰는 크롬 프로필을 '보통 크롬 창'으로 열어 줍니다. 열린 창에서 테스트 계정으로 직접 로그인한 뒤 창을 닫으면,
로그인 정보가 프로필에 남아 수집기가 그대로 씁니다. 로그인 정보는 컴퓨터마다 따로 저장되므로(만든 컴퓨터에서만 풀림),
처음 쓰는 컴퓨터에서는 한 번씩 로그인해야 합니다.

크롬 프로필은 둘이고(server/profiles/<컴퓨터 이름>/collect, search), 한 프로필에 X·인스타를 함께 로그인합니다.
  x, instagram                 → collect 프로필: 수집용 계정(추적 계정의 글을 모음)
  x-search, instagram-search   → search 프로필 : 검색용 계정(웹의 '계정 찾기'에만 씀). 수집용과 **다른** 계정으로 로그인하세요
유튜브는 로그인하지 않아도 되므로 창을 열지 않습니다. 그래서 창은 최대 4개입니다.

자동화(Playwright)가 아닌 보통 크롬으로 여는 이유: 구글 등은 자동화된 브라우저에서의 로그인을 막기 때문입니다.

실행: login_setup.bat 더블클릭(4개 모두)  또는  login_setup.bat x-search instagram-search  처럼 일부만
"""
import json
import os
import shutil
import subprocess
import sys
import time

from collector.runner import PROFILE_COLLECT, PROFILE_SEARCH, PROFILES, SETUP_MARK

LOGIN_URL = {"x": "https://x.com/i/flow/login", "instagram": "https://www.instagram.com/accounts/login/"}
# 계정 이름 → (프로필, 매체, 설명)
ACCTS = {
    "x": (PROFILE_COLLECT, "x", "X 수집용 계정"),
    "instagram": (PROFILE_COLLECT, "instagram", "인스타 수집용 계정"),
    "x-search": (PROFILE_SEARCH, "x", "X 검색용 계정(수집용과 다른 계정)"),
    "instagram-search": (PROFILE_SEARCH, "instagram", "인스타 검색용 계정(수집용과 다른 계정)"),
}
OLD_DIRS = ("youtube", "x", "instagram", "x-search", "instagram-search")   # 예전(계정·매체마다 프로필 하나) 폴더


def find_chrome() -> str:
    cands = []
    for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            cands.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
    for c in cands:
        if os.path.isfile(c):
            return c
    for name in ("chrome", "google-chrome", "chrome.exe"):
        p = shutil.which(name)
        if p:
            return p
    return ""


def mark_setup(profile: str, platforms):
    """프로필 안에 '이 매체 로그인 창을 이때 열었음'을 남깁니다. 서버는 이것으로 로그인 준비 여부를 알고,
    마지막 확인보다 새로우면 켤 때 로그인 상태를 다시 확인합니다."""
    f = PROFILES / profile / SETUP_MARK
    try:
        done = json.loads(f.read_text(encoding="utf-8"))
        if not isinstance(done, dict):
            done = {}
    except Exception:
        done = {}
    for p in platforms:
        done[p] = time.time()
    f.write_text(json.dumps(done), encoding="utf-8")


def main():
    bad = [a for a in sys.argv[1:] if a not in ACCTS]
    if bad:
        print("알 수 없는 계정:", ", ".join(bad), "\n쓸 수 있는 이름:", ", ".join(ACCTS))
        return 1
    want = list(dict.fromkeys(sys.argv[1:] or ACCTS))
    chrome = find_chrome()
    if not chrome:
        print("크롬을 찾지 못했습니다. 서버 PC에 구글 크롬을 설치하세요.")
        return 1
    print(f"[{PROFILES.name}] 테스트 계정 로그인 창을 엽니다:", ", ".join(want))
    print("※ 서버(start.bat)가 켜져 있으면 먼저 끄세요. 같은 프로필을 동시에 쓸 수 없습니다.")
    print("※ 검색용(x-search, instagram-search)에는 수집용과 다른 계정으로 로그인하세요.\n")
    by_profile = {}
    for a in want:
        by_profile.setdefault(ACCTS[a][0], []).append(a)
    procs = []
    for profile, accts in by_profile.items():
        d = PROFILES / profile
        d.mkdir(parents=True, exist_ok=True)
        base = [chrome, f"--user-data-dir={d}", "--no-first-run", "--no-default-browser-check", "--new-window"]
        # 프로필마다 크롬은 하나만 뜹니다. 첫 창으로 크롬을 띄우고, 다음 창은 잠깐 뒤 같은 크롬에 '새 창'으로 넘깁니다(그 실행은 바로 끝남).
        first = subprocess.Popen(base + [LOGIN_URL[ACCTS[accts[0]][1]]])
        print(f"- {accts[0]}: 창이 열렸습니다. [{ACCTS[accts[0]][2]}]  (프로필: {profile})")
        for a in accts[1:]:
            time.sleep(2.5)
            subprocess.Popen(base + [LOGIN_URL[ACCTS[a][1]]])
            print(f"- {a}: 창이 열렸습니다. [{ACCTS[a][2]}]  (프로필: {profile})")
        procs.append((profile, accts, first))
    print("\n로그인을 마치면 크롬 창을 모두 닫으세요. 프로필의 창이 모두 닫히면 그 프로필이 끝납니다.")
    for profile, accts, proc in procs:
        proc.wait()
        mark_setup(profile, [ACCTS[a][1] for a in accts])
        print(f"- {profile} 프로필({', '.join(accts)}): 창이 모두 닫혔습니다.")
    old = [n for n in OLD_DIRS if (PROFILES / n).is_dir()]
    if old:
        print("\n예전 방식의 프로필 폴더는 더 쓰지 않습니다(지워도 됩니다):", ", ".join(str(PROFILES / n) for n in old))
    print("\n완료. 이제 start.bat으로 서버를 켜세요. 켜질 때 로그인 상태를 다시 확인합니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
