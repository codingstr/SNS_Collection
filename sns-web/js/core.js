/* API 서버 주소: 화면과 API를 같은 서버(server/main.py)가 제공하므로 같은 주소의 /api를 부릅니다. */
const API_BASE = "";
/* 서버 호출. ms 안에 응답이 없으면 끊고 오류로 알립니다(기본 10초).
   서버가 크롬으로 직접 일하는 요청(계정 검색·게시물 읽기)은 부르는 쪽에서 더 길게 줍니다. */
const API_WAIT = 10000;
const LONG_WAIT = 75000; // 계정 검색·게시물 읽기: 서버가 최대 60초 + 사진 받기까지 기다립니다
// opts.signal: 부르는 쪽이 요청을 끊을 때(검색 취소 등). 끊으면 er.aborted가 붙은 오류를 던집니다.
async function apiPost(path, obj, ms, opts) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || API_WAIT);
  const outer = opts && opts.signal;
  const onOuter = () => ctl.abort();
  if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener("abort", onOuter); }
  try {
    return await fetch(API_BASE + path, { method: "POST", headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" }, body: JSON.stringify(obj), signal: ctl.signal, keepalive: !!(opts && opts.keepalive) });
  } catch (e) {
    if (outer && outer.aborted) { const er = new Error("요청을 취소했습니다."); er.aborted = true; throw er; }
    const late = ctl.signal.aborted;
    const er = new Error(late ? "서버 응답이 너무 늦습니다. 잠시 뒤 다시 시도하세요." : "서버에 연결할 수 없습니다.");
    er.offline = true; er.timeout = late; throw er;
  } finally { clearTimeout(t); if (outer) outer.removeEventListener("abort", onOuter); }
}

/* 화면 아래쪽 알림(오류·안내). 어느 화면에 있든 보입니다.
   action: { label, fn } 을 주면 알림 안에 버튼(예: 되돌리기)이 붙고, 누를 시간을 주려고 조금 더 오래 떠 있습니다. */
function toast(msg, kind, action) {
  if (!msg) return;
  let box = document.getElementById("toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; box.setAttribute("role", "status"); box.setAttribute("aria-live", "polite"); document.body.appendChild(box); }
  // 같은 문구가 이미 떠 있으면 새로 쌓지 않고 시간만 늘립니다(버튼이 있는 알림은 새로 띄움: 되돌릴 대상이 다를 수 있음).
  const same = action ? null : Array.from(box.children).find((n) => n.dataset.msg === msg && !n._action);
  const n = same || document.createElement("div");
  if (!same) {
    n.className = "toast" + (kind === "error" ? " err" : "") + (action ? " act" : "");
    n.dataset.msg = msg;
    n._action = !!action;
    const t = document.createElement("span"); t.textContent = msg;
    const x = document.createElement("button"); x.type = "button"; x.className = "tx"; x.textContent = "×"; x.setAttribute("aria-label", "알림 닫기");
    x.addEventListener("click", () => n.remove());
    n.append(t);
    if (action) {
      const a = document.createElement("button"); a.type = "button"; a.className = "ta"; a.textContent = action.label;
      a.addEventListener("click", () => { n.remove(); try { action.fn(); } catch (e) { /* 무시 */ } });
      n.append(a);
    }
    n.append(x);
    box.appendChild(n);
    while (box.children.length > 4) box.firstChild.remove();
  }
  clearTimeout(n._t);
  n._t = setTimeout(() => n.remove(), action ? 9000 : kind === "error" ? 7000 : 4500);
}

const LABELS = { people: "사람별", youtube: "유튜브", x: "X", instagram: "인스타" };
/* 오른쪽 "현재 작업" 카드 아래 표시되는 정보 — 여기서 바꾸면 됩니다 */
const WEB_VERSION = "v418";
const TEAM_NAME = "WebMonster";
const TEAM_GITHUB = "https://github.com/WM-WebMonsters";
const SRC_LABELS = { "youtube-video": "유튜브 영상", "youtube-post": "유튜브 게시물", x: "X", instagram: "인스타" };

/* 이 브라우저에 저장하는 값 중 사용자마다 따로 둘 것(본 글 기록·프로필 사진·즐겨찾기 등)은 아이디별 이름으로 저장합니다.
   같은 브라우저에서 다른 아이디로 로그인해도 서로 섞이지 않습니다. (화면 설정·테마처럼 기기 설정은 공통) */
const PER_USER_KEYS = ["snsSeen", "snsSeenReset", "snsAvatar", "snsPics", "snsPicPick", "snsPicAt", "snsFavs"];
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
// 본 글 기록을 비운 시각(서버 user_state.seen_reset). 서버가 더 늦은 시각을 알려 주면 이 기기의 기록도 버립니다.
let seenReset = Number(lsGet("snsSeenReset", "0")) || 0;
function applySeenReset(at) {
  if (!(at > seenReset)) return false;
  seenReset = at;
  lsSet("snsSeenReset", String(at));
  seen.clear();
  if (typeof seenQueue !== "undefined") seenQueue.clear();
  clearTimeout(seenSaveTimer);
  lsSet("snsSeen", "[]");
  document.querySelectorAll(".card.seen").forEach((c) => c.classList.remove("seen"));
  if (typeof renderStories === "function") renderStories();
  return true;
}
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
  if (typeof renderStories === "function") renderStories(); // 그룹 줄의 '안 읽은 글' 빨간 점
}
// 여러 글을 한꺼번에 읽음으로(그룹 줄에서 '모두 읽음'). 새로 읽음 처리한 글 ID 목록을 돌려줍니다(되돌리기에 씀).
function markSeenMany(ids) {
  const done = [];
  ids.forEach((id) => {
    if (!id || seen.has(id)) return;
    seen.add(id); done.push(id);
    if (typeof queueSeen === "function") queueSeen(id);
  });
  if (!done.length) return done;
  saveSeen();
  document.querySelectorAll(".card").forEach((c) => { if (c._item && seen.has(c._item.id)) c.classList.add("seen"); });
  if (typeof renderStories === "function") renderStories();
  return done;
}
// '모두 읽음' 되돌리기: 이 기기와 서버의 본 글 기록에서 뺍니다.
function unmarkSeen(ids) {
  const set = new Set(ids);
  if (!set.size) return;
  set.forEach((id) => { seen.delete(id); if (typeof seenQueue !== "undefined") seenQueue.delete(id); });
  saveSeen();
  document.querySelectorAll(".card.seen").forEach((c) => { if (c._item && set.has(c._item.id)) c.classList.remove("seen"); });
  if (typeof renderStories === "function") renderStories();
  // 아직 보내는 중인 '본 글' 기록이 있으면 그게 끝난 뒤에 지웁니다(순서가 바뀌면 지운 기록이 다시 들어감).
  if (sess && typeof sapi === "function") (seenFlushP || Promise.resolve()).catch(() => {}).then(() => sapi("delSeen", { ids: [...set] })).catch(() => {});
}
const $ = (id) => document.getElementById(id);

let refreshing = false; // '지금 최신화'를 요청하는 중
let serverDown = false; // 저장된 로그인으로 들어왔는데 서버에 닿지 않음(홈 화면의 안내 문구를 '불러오는 중' 대신 '연결할 수 없음'으로)
const loadingText = () => (serverDown ? "지금은 서버에 연결할 수 없습니다. 서버가 다시 켜지면 자동으로 이어집니다." : "글을 불러오는 중…");
let trackedHold = 0; // 추적 계정을 서버에 저장하는 중이면, 그 사이 도착한 옛 목록이 화면 목록을 덮어쓰지 않게 막는 시각
let winDays = 30, items = [], settings = {}, tracked = [], checkStatus = {}, nextAuto = 0;
let selIds = []; // 계정 관리에서 고른 계정(누른 순서)
let isAdmin = false; // 관리자로 로그인했으면 왼쪽에 '관리' 탭(js/admin.js)
let personFocus = "", personPlat = "", activeTab = "people", connected = false, polling = null;

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") n.textContent = v; else if (k === "class") n.className = v; else n.setAttribute(k, v);
  }
  children.forEach((c) => n.appendChild(c));
  return n;
}
