"""수집용 크롬 창을 서버 PC 화면에 8분할로 놓고(grid), 다른 창들 뒤로 보냅니다(윈도우 전용).

서버 PC로 다른 작업을 하는 중에 수집 창이 앞으로 튀어나와 입력을 가로채지 않게 합니다.
- 창이 뜨기 전 크롬 창 목록과 '지금 쓰던 창'을 기억해 두고(snapshot),
- 새로 뜬 크롬 창만 찾아 구석으로 옮긴 뒤 맨 뒤로 보내고, 쓰던 창에 다시 포커스를 돌려줍니다(tuck).
가려진 창도 계속 그려지도록 크롬은 --disable-backgrounding-occluded-windows 등으로 띄우므로 수집에는 영향이 없습니다.
윈도우가 아니거나 무엇이든 실패하면 아무것도 하지 않습니다(수집은 그대로 진행).
"""
import logging
import sys
import time

log = logging.getLogger("collector")
WIN = sys.platform == "win32"

if WIN:
    import ctypes
    from ctypes import wintypes

    _u = ctypes.WinDLL("user32", use_last_error=True)
    _k = ctypes.WinDLL("kernel32", use_last_error=True)
    _EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    _u.EnumWindows.argtypes = [_EnumProc, wintypes.LPARAM]
    _u.IsWindowVisible.argtypes = [wintypes.HWND]
    _u.IsWindow.argtypes = [wintypes.HWND]
    _u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    _u.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    _u.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    _u.GetWindow.restype = wintypes.HWND
    _u.GetForegroundWindow.restype = wintypes.HWND
    _u.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    _u.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    _u.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT, ctypes.c_void_p, wintypes.UINT]
    _u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    _u.GetWindowThreadProcessId.restype = wintypes.DWORD
    _u.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    _u.SetForegroundWindow.argtypes = [wintypes.HWND]
    _k.GetCurrentThreadId.restype = wintypes.DWORD

    _g = ctypes.WinDLL("gdi32", use_last_error=True)
    _u.GetDC.argtypes = [wintypes.HWND]
    _u.GetDC.restype = wintypes.HDC
    _u.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    _g.GetDeviceCaps.argtypes = [wintypes.HDC, ctypes.c_int]

HWND_BOTTOM = 1
SWP_NOSIZE, SWP_NOMOVE, SWP_NOACTIVATE, SWP_NOOWNERZORDER = 0x0001, 0x0002, 0x0010, 0x0200
# 8분할: 주 모니터 작업 영역(작업 표시줄 뺀 곳)을 가로 4 × 세로 2칸으로 나눕니다(세로 모니터면 2 × 4).
GRID_COLS, GRID_ROWS = 4, 2
# 창이 작아도 페이지는 예전 창(1000×800)만큼 넓게 보도록, 크롬 화면 배율을 낮춰 띄웁니다(--force-device-scale-factor).
# X·인스타는 화면 높이만큼씩 스크롤하며 모으고 폭이 좁으면 모바일처럼 배치가 바뀌므로, 페이지가 보는 크기는 줄이지 않습니다.
PAGE_W, PAGE_H = 1000, 890        # 페이지 폭 1000 · 높이 800 + 크롬 위쪽 막대(탭·주소창) 약 90
SCALE_MIN = 0.5
SPI_GETWORKAREA = 0x0030
GW_OWNER = 4
MARGIN = 8


def _chrome_windows() -> set:
    """화면에 보이는 크롬 브라우저 창(맨 위 창) 목록."""
    out = set()

    def cb(h, _):
        try:
            if h and _u.IsWindowVisible(h) and not _u.GetWindow(h, GW_OWNER) and _u.GetWindowTextLengthW(h) > 0:
                buf = ctypes.create_unicode_buffer(64)
                _u.GetClassNameW(h, buf, 64)
                if buf.value == "Chrome_WidgetWin_1":
                    out.add(int(h))
        except Exception:
            pass
        return True

    _u.EnumWindows(_EnumProc(cb), 0)
    return out


def _work_area():
    r = wintypes.RECT()
    if _u.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(r), 0):
        return r.left, r.top, r.right, r.bottom
    return None


def _phys_ratio() -> float:
    """윈도우 화면 배율(125%면 1.25). 이 프로그램이 받는 좌표(배율 적용 전)를 실제 화면 픽셀로 바꿀 때 씁니다."""
    hdc = _u.GetDC(None)
    try:
        desk, horz = _g.GetDeviceCaps(hdc, 118), _g.GetDeviceCaps(hdc, 8)   # DESKTOPHORZRES(실제), HORZRES(이 프로그램 기준)
    finally:
        _u.ReleaseDC(None, hdc)
    return desk / horz if desk > 0 and horz > 0 else 1.0


def grid():
    """8분할 배치: {"scale": 크롬 화면 배율, "cells": [(x, y, w, h) 크롬 좌표 8칸]} 또는 None(윈도우가 아니거나 실패).
    크롬은 --force-device-scale-factor로 띄우면 화면 좌표도 그 배율 기준(실제 픽셀 ÷ 배율)으로 쓰므로 그렇게 바꿔 돌려줍니다."""
    if not WIN:
        return None
    try:
        wa = _work_area()
        if not wa:
            return None
        ratio = _phys_ratio()
        left, top, right, bottom = (round(v * ratio) for v in wa)
        w, h = right - left, bottom - top
        cols, rows = (GRID_COLS, GRID_ROWS) if w >= h else (GRID_ROWS, GRID_COLS)
        tw, th = w // cols, h // rows
        # 칸이 넉넉하면 평소 배율 그대로(더 키우지 않음), 좁으면 페이지가 1000×800을 보도록 줄임
        s = round(max(SCALE_MIN, min(ratio, tw / PAGE_W, th / PAGE_H)), 3)
        cells = [(round((left + c * tw) / s), round((top + r * th) / s), int(tw / s), int(th / s))
                 for r in range(rows) for c in range(cols)]
        return {"scale": s, "cells": cells}
    except Exception as e:
        log.debug("화면 나누기 계산 실패: %s", e)
        return None


def corner_args(width: int, height: int) -> list:
    """크롬을 처음부터 오른쪽 아래 구석에 띄우는 실행 옵션."""
    if not WIN:
        return []
    try:
        wa = _work_area()
        if not wa:
            return []
        x, y = max(wa[0], wa[2] - width - MARGIN), max(wa[1], wa[3] - height - MARGIN)
        return [f"--window-position={x},{y}"]
    except Exception:
        return []


def snapshot():
    """창을 띄우기 직전에 부릅니다: 이미 있던 크롬 창들과 지금 쓰던 창."""
    if not WIN:
        return None
    try:
        return _chrome_windows(), int(_u.GetForegroundWindow() or 0)
    except Exception:
        return None


def _give_back_focus(hwnd: int, prev: int):
    """수집 창이 포커스를 가져갔으면, 쓰던 창에 돌려줍니다."""
    if not prev or prev == hwnd or not _u.IsWindow(prev):
        return
    if int(_u.GetForegroundWindow() or 0) != hwnd:
        return
    me = _k.GetCurrentThreadId()
    fg = _u.GetWindowThreadProcessId(hwnd, None)
    attached = bool(fg and fg != me and _u.AttachThreadInput(me, fg, True))
    try:
        _u.SetForegroundWindow(prev)
    finally:
        if attached:
            _u.AttachThreadInput(me, fg, False)


def _place(hwnd: int, prev: int, move: bool = True):
    r = wintypes.RECT()
    wa = _work_area() if move else None
    if wa and _u.GetWindowRect(hwnd, ctypes.byref(r)):
        w, h = r.right - r.left, r.bottom - r.top
        x, y = max(wa[0], wa[2] - w - MARGIN), max(wa[1], wa[3] - h - MARGIN)
        _give_back_focus(hwnd, prev)
        _u.SetWindowPos(hwnd, HWND_BOTTOM, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
    else:
        _give_back_focus(hwnd, prev)
        _u.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, 0x0002 | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)  # 0x0002 = 위치 그대로


def tuck(snap, wait: float = 3.0, move: bool = True):
    """snapshot 뒤에 새로 뜬 크롬 창을 구석·맨 뒤로 보내고 포커스를 돌려줍니다.
    move=False: 자리는 옮기지 않고 맨 뒤로만(8분할 칸에 놓는 건 수집기가 크롬에 직접 시킴)."""
    if not WIN or not snap:
        return
    try:
        old, prev = snap
        new, end = set(), time.time() + wait
        while time.time() < end:
            new = _chrome_windows() - old
            if new:
                break
            time.sleep(0.1)
        for hwnd in new:
            _place(hwnd, prev, move)
        if new:
            # 창이 다 뜬 직후 크롬이 한 번 더 앞으로 나오는 경우가 있어 잠시 뒤 한 번 더 확인합니다.
            time.sleep(0.4)
            for hwnd in new:
                if _u.IsWindow(hwnd):
                    _place(hwnd, prev, move)
    except Exception as e:
        log.debug("수집 창을 뒤로 보내지 못했습니다: %s", e)
