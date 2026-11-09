"""이 컴퓨터의 이름. 가상환경(.venv-이름)과 크롬 프로필(profiles/이름/)을 컴퓨터마다 따로 두는 데 씁니다.

외장 SSD처럼 여러 컴퓨터에서 같은 폴더를 쓰면, 크롬 로그인 정보(쿠키)는 만든 컴퓨터에서만 풀리기 때문에
컴퓨터마다 따로 저장해야 합니다. .bat 파일의 %COMPUTERNAME%과 같은 값입니다.
"""
import os
import platform
import re


def machine_name() -> str:
    name = os.environ.get("COMPUTERNAME") or platform.node() or "default"
    return re.sub(r"[^\w.-]", "_", name).upper()
