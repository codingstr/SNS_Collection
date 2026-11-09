"""SNS Collector 서버

실행: start.bat 더블클릭  (또는  .venv\\Scripts\\python.exe main.py)
확인: http://localhost:8080  /  http://localhost:8080/api/health
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

import api_call
import auth
import sync
from collector import collector
from db import init_db

PORT = 8080
BASE_DIR = Path(__file__).resolve().parent      # .../server
WEB_DIR = BASE_DIR.parent / "sns-web"           # .../sns-web (기존 웹 화면)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s", datefmt="%H:%M:%S")


@asynccontextmanager
async def lifespan(_app):
    # 파일을 불러오기만 할 때(테스트·uvicorn --reload 감시 프로세스 등)는 수집기를 띄우지 않고, 서버가 실제로 켜질 때 한 번만 시작합니다.
    init_db()
    collector.start()   # 수집 작업 스레드 (크롬 창은 수집할 때만 뜹니다)
    yield


app = FastAPI(title="SNS Collector", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1000)  # 응답 압축: ngrok 무료 데이터 한도(월 1GB) 절약


# ---------- API ----------
@app.get("/api/health")
def health():
    """서버가 살아 있는지 확인용."""
    return {"ok": True}


app.include_router(auth.router)      # /api/auth  로그인·가입·비밀번호 변경·계정 삭제
app.include_router(api_call.router)  # /api/call  글 목록·추적 계정·수집 요청
app.include_router(sync.router)      # /api/sync  본 글 기록


# ---------- 웹 화면 ----------
# API보다 반드시 아래에 둬야 합니다. ("/" 전체를 잡기 때문)
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


if __name__ == "__main__":
    import uvicorn

    if not WEB_DIR.is_dir():
        raise SystemExit(f"웹 화면 폴더를 찾을 수 없습니다: {WEB_DIR}")
    print(f"서버 시작: http://localhost:{PORT}  (끄려면 Ctrl+C)")
    uvicorn.run(app, host="127.0.0.1", port=PORT)
