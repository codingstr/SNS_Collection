/* API 서버 주소: 화면과 API를 같은 서버(server/main.py)가 제공하므로 같은 주소의 /api를 부릅니다. */
const API_BASE = "";
/* 서버 호출. ms 안에 응답이 없으면 끊고 오류로 알립니다(기본 10초).
   서버가 크롬으로 직접 일하는 요청(계정 검색·게시물 읽기)은 부르는 쪽에서 더 길게 줍니다. */
const API_WAIT = 10000;
const LONG_WAIT = 75000; // 계정 검색·게시물 읽기: 서버가 최대 60초 + 사진 받기까지 기다립니다
async function apiPost(path, obj, ms, opts) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || API_WAIT);
  try {
    return await fetch(API_BASE + path, { method: "POST", headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" }, body: JSON.stringify(obj), signal: ctl.signal, keepalive: !!(opts && opts.keepalive) });
  } catch (e) {
    const late = ctl.signal.aborted;
    const er = new Error(late ? "서버 응답이 너무 늦습니다. 잠시 뒤 다시 시도하세요." : "서버에 연결할 수 없습니다.");
    er.offline = true; er.timeout = late; throw er;
  } finally { clearTimeout(t); }
}

/* 화면 아래쪽 알림(오류·안내). 어느 화면에 있든 보입니다. */
function toast(msg, kind) {
  if (!msg) return;
  let box = document.getElementById("toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; box.setAttribute("role", "status"); box.setAttribute("aria-live", "polite"); document.body.appendChild(box); }
  // 같은 문구가 이미 떠 있으면 새로 쌓지 않고 시간만 늘립니다.
  const same = Array.from(box.children).find((n) => n.dataset.msg === msg);
  const n = same || document.createElement("div");
  if (!same) {
    n.className = "toast" + (kind === "error" ? " err" : "");
    n.dataset.msg = msg;
    const t = document.createElement("span"); t.textContent = msg;
    const x = document.createElement("button"); x.type = "button"; x.className = "tx"; x.textContent = "×"; x.setAttribute("aria-label", "알림 닫기");
    x.addEventListener("click", () => n.remove());
    n.append(t, x);
    box.appendChild(n);
    while (box.children.length > 4) box.firstChild.remove();
  }
  clearTimeout(n._t);
  n._t = setTimeout(() => n.remove(), kind === "error" ? 7000 : 4500);
}

const LABELS = { people: "사람별", youtube: "유튜브", x: "X", instagram: "인스타" };
/* 오른쪽 "현재 작업" 카드 아래 표시되는 정보 — 여기서 바꾸면 됩니다 */
const WEB_VERSION = "v376";
const TEAM_NAME = "WebMonster";
const TEAM_GITHUB = "https://github.com/WM-WebMonsters";
const SRC_LABELS = { "youtube-video": "유튜브 영상", "youtube-post": "유튜브 게시물", x: "X", instagram: "인스타" };

/* 이 브라우저에 저장하는 값 중 사용자마다 따로 둘 것(본 글 기록·프로필 사진·즐겨찾기 등)은 아이디별 이름으로 저장합니다.
   같은 브라우저에서 다른 아이디로 로그인해도 서로 섞이지 않습니다. (화면 설정·테마처럼 기기 설정은 공통) */
const PER_USER_KEYS = ["snsSeen", "snsAvatar", "snsPics", "snsPicPick", "snsPicAt", "snsFavs"];
let UID0 = "";
try { UID0 = localStorage.getItem("snsUid") || ""; } catch (e) {}
const ukey = (k) => (UID0 ? k + "@" + UID0 : k);
try {
  // 예전 버전(아이디 구분 없이 저장)의 값은 마지막으로 로그인했던 아이디의 것으로 옮깁니다.
  if (UID0) PER_USER_KEYS.forEach((k) => { const v = localStorage.getItem(k); if (v !== null) { if (localStorage.getItem(ukey(k)) === null) localStorage.setItem(ukey(k), v); localStorage.removeItem(k); } });
} catch (e) {}
function lsGet(k, def) { try { const v = localStorage.getItem(ukey(k)); return v === null ? def : v; } catch (e) { return def; } }
function lsSet(k, v) { try { localStorage.setItem(ukey(k), v); } catch (e) { /* 저장 불가 */ } }

let searchPlats = ["youtube", "x", "instagram"]; // 통합 검색에서 찾을 매체
try { const v = JSON.parse(localStorage.getItem("snsSearchPlats") || "null"); if (Array.isArray(v)) { const f = v.filter((p) => ["youtube", "x", "instagram"].includes(p)); if (f.length) searchPlats = f; } } catch (e) {}
let ytMode = "both"; // 유튜브 탭: video(영상만) / both(둘 다) / post(게시물만)
try { const m = localStorage.getItem("snsYtMode"); if (m === "video" || m === "post") ytMode = m; } catch (e) {}
const tabOf = (s) => (String(s).startsWith("youtube") ? "youtube" : s);
const PLAT_ORDER = ["instagram", "x", "youtube"]; // 표시 순서
function platOrder(a) { return a.slice().sort((p, q) => PLAT_ORDER.indexOf(p) - PLAT_ORDER.indexOf(q)); }
const PLATFORM = { youtube: "유튜브", x: "X", instagram: "인스타" };
const RESERVED = new Set(["home", "explore", "i", "search", "p", "reel", "reels", "accounts", "settings", "messages"]);
const MAX_TRACKED = 30;
/* ---------- 확인한 글 기록(이어보기) : 연 글을 기록하고, 로그인 중이면 계정에도 저장합니다 ---------- */
const seen = new Set();
try { JSON.parse(lsGet("snsSeen", "[]")).forEach((x) => typeof x === "string" && seen.add(x)); } catch (e) {}
let seenSaveTimer = 0;
function saveSeen() {
  clearTimeout(seenSaveTimer);
  seenSaveTimer = setTimeout(() => lsSet("snsSeen", JSON.stringify([...seen].slice(-8000))), 400);
}
function markSeen(it) {
  if (!it || !it.id || seen.has(it.id)) return;
  seen.add(it.id);
  saveSeen();
  if (typeof queueSeen === "function") queueSeen(it.id); // 로그인 상태면 다른 기기에도 반영
  document.querySelectorAll(".card").forEach((c) => { if (c._item && c._item.id === it.id) c.classList.add("seen"); });
}
const $ = (id) => document.getElementById(id);

let refreshing = false; // '지금 최신화'를 요청하는 중
let trackedHold = 0; // 추적 계정을 서버에 저장하는 중이면, 그 사이 도착한 옛 목록이 화면 목록을 덮어쓰지 않게 막는 시각
let winDays = 30, items = [], settings = {}, tracked = [], checkStatus = {}, nextAuto = 0;
let selIds = []; // 계정 관리에서 고른 계정(누른 순서)
let personFocus = "", personPlat = "", groupFocus = "", activeTab = "people", connected = false, polling = null;

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") n.textContent = v; else if (k === "class") n.className = v; else n.setAttribute(k, v);
  }
  children.forEach((c) => n.appendChild(c));
  return n;
}
