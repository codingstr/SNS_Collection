"""수집용 크롬 창을 서버 PC 화면의 오른쪽 아래 구석, 다른 창들 뒤로 보냅니다(윈도우 전용).

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

HWND_BOTTOM = 1
SWP_NOSIZE, SWP_NOACTIVATE, SWP_NOOWNERZORDER = 0x0001, 0x0010, 0x0200
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


def _place(hwnd: int, prev: int):
    r = wintypes.RECT()
    wa = _work_area()
    if wa and _u.GetWindowRect(hwnd, ctypes.byref(r)):
        w, h = r.right - r.left, r.bottom - r.top
        x, y = max(wa[0], wa[2] - w - MARGIN), max(wa[1], wa[3] - h - MARGIN)
        _give_back_focus(hwnd, prev)
        _u.SetWindowPos(hwnd, HWND_BOTTOM, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
    else:
        _give_back_focus(hwnd, prev)
        _u.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, 0x0002 | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)  # 0x0002 = 위치 그대로


def tuck(snap, wait: float = 3.0):
    """snapshot 뒤에 새로 뜬 크롬 창을 구석·맨 뒤로 보내고 포커스를 돌려줍니다."""
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
            _place(hwnd, prev)
        if new:
            # 창이 다 뜬 직후 크롬이 한 번 더 앞으로 나오는 경우가 있어 잠시 뒤 한 번 더 확인합니다.
            time.sleep(0.4)
            for hwnd in new:
                if _u.IsWindow(hwnd):
                    _place(hwnd, prev)
    except Exception as e:
        log.debug("수집 창을 뒤로 보내지 못했습니다: %s", e)
