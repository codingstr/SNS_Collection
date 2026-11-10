/* ---------- 서버 연결 : 글 목록·추적 계정·수집 요청을 서버의 /api/call로 보냅니다 ---------- */
// call(op, payload, waitMs) → 서버가 돌려준 result. op 종류는 server/api_call.py를 보세요.
// waitMs: 응답을 기다릴 최대 시간(기본 10초). 계정 검색·게시물 읽기는 LONG_WAIT로 길게 줍니다.
// opts: { signal } 요청을 도중에 끊을 때, { keepalive } 페이지를 떠나는 중에도 보낼 때
const CHANGING_OPS = ["set", "checkNow", "clearItems", "cancelCheck"];
async function call(op, payload, waitMs, opts) {
  const used = sess;
  const r = await apiPost("/api/call", { session: used, op, payload: payload || {} }, waitMs, opts);
  if (r.status === 401) throw sessionLost(used);
  let j;
  try { j = await r.json(); } catch (e) { const er = new Error("서버에 연결할 수 없습니다(서버 PC가 꺼져 있을 수 있습니다)."); er.offline = true; throw er; }
  if (!j.ok) throw new Error(j.error || "요청에 실패했습니다.");
  // 내용을 바꾸는 요청 뒤에는 곧바로 서버 상태를 다시 읽습니다(평소 다시 읽는 간격이 30초라서).
  // 수집이 시작됐으면 다시 읽는 간격을 3초로 바꿉니다.
  if (CHANGING_OPS.includes(op) && connected) {
    setTimeout(() => refresh().then(() => { if (checkStatus && checkStatus.running) startPolling(); }).catch(() => {}), 300);
  }
  return j.result;
}
// 로그인 세션이 끝났을 때(다른 기기에서 비밀번호 변경, 30일 지남 등): 다시 로그인하도록 로그인 화면으로 돌아갑니다.
// 그 사이 이 기기에서 세션을 새로 받았다면(비밀번호 변경 직후 등) 옛 요청의 실패는 무시합니다.
function sessionLost(used) {
  const er = new Error("로그인이 필요합니다.");
  er.authLost = true;
  if (used && used === sess) {
    clearTimeout(polling); pollGen++;
    try { sessionStorage.setItem("snsAuthMsg", "로그인이 만료되었습니다. 다시 로그인해 주세요."); } catch (e) {}
    setSess("");
    location.reload();
  }
  return er;
}

// 화면 전환: 홈(글 모아보기) ↔ 추적 계정 관리 ↔ 관리(관리자만) — 관리 화면들은 따로 분리된 화면
let page = "home";
function applyPage() {
  if (!connected && page === "manage") page = "home";
  if ((!connected || !isAdmin) && page === "admin") page = "home";
  const manage = connected && page === "manage", adminOn = page === "admin";
  const wasAdmin = !$("adminPanel").hidden;
  $("trackPanel").hidden = !manage;
  $("adminPanel").hidden = !adminOn;
  document.querySelector(".layout main").hidden = manage || adminOn;
  $("navManage").hidden = !connected;
  $("navAdmin").hidden = !(connected && isAdmin);
  $("navHome").classList.toggle("on", !manage && !adminOn && page !== "fav");
  $("navFav").classList.toggle("on", page === "fav");
  $("navManage").classList.toggle("on", manage);
  $("navAdmin").classList.toggle("on", adminOn);
  if (adminOn !== wasAdmin && typeof adminShown === "function") adminShown(adminOn);
}
function setConn(ok) {
  connected = ok;
  if (!ok) { $("loginBar").hidden = true; }
  $("connectPanel").hidden = ok;
  $("connAcct").hidden = !ok && !sess;
  applyPage();
  $("checkNow").hidden = false; $("checkNow").classList.toggle("off", !ok); // 새로고침 버튼은 항상 보이고, 가운데 점이 연결 상태(초록=연결됨)를 알려 줍니다
  updateConnText();
}
function updateConnText() {
  $("dot").className = "dot" + (connected ? " on" : "");
  if (connected) $("connText").textContent = "서버와 연결됨 · 글 " + items.length + "건";
  else $("connText").textContent = sess ? "서버와 연결되지 않았습니다. 잠시 뒤 다시 시도합니다." : "로그인하면 서버와 연결됩니다.";
  $("dot").title = $("connText").textContent;
}

/* ---------- 매체 아이콘 · 서버 테스트 계정 로그인 상태 ---------- */
const LOGIN_PLATS = ["youtube", "x", "instagram"];
const PGLYPH = { youtube: "▶", x: "X", instagram: "◎" };
// 각 매체의 실제 아이콘(파비콘)을 불러옵니다. 못 불러오면 기호로 대신합니다.
const PLOCAL = { youtube: "img/youtube.png", x: "img/x.png", instagram: "img/instagram.png" };
const PDOMAIN = { youtube: "youtube.com", x: "x.com", instagram: "instagram.com" };
function pIcon(p) {
  const wrap = el("span", { class: "pg" });
  const d = PDOMAIN[p];
  // 여러 곳에서 차례로 시도합니다. 모두 실패하면 기호로 대신합니다.
  const srcs = [
    PLOCAL[p],
    "https://www.google.com/s2/favicons?domain=" + d + "&sz=128",
    "https://icons.duckduckgo.com/ip3/" + d + ".ico",
  ];
  let i = 0;
  const img = el("img", { alt: "", referrerpolicy: "no-referrer", draggable: "false" });
  img.addEventListener("error", () => { if (++i < srcs.length) img.src = srcs[i]; else { img.remove(); wrap.textContent = PGLYPH[p]; } });
  img.src = srcs[0];
  wrap.appendChild(img);
  return wrap;
}
let loginState = {}, loginAsked = false;
// 서버 테스트 계정이 로그인되어 있지 않아 수집할 수 없는 매체. 유튜브 채널은 로그인 없이도 수집됩니다.
const loggedOut = (p) => p !== "youtube" && !!(loginState[p] && loginState[p].loggedIn === false);
const LOGIN_HELP = (p) => "서버의 " + PLATFORM[p] + " 수집용 테스트 계정이 로그인되어 있지 않아 " + PLATFORM[p] + " 글을 모을 수 없습니다. 관리자가 서버 PC에서 login_setup.bat " + p + " 로 로그인해야 합니다.";
// X·인스타의 '계정 찾기'는 수집용과 다른 검색용 계정(x-search, instagram-search)으로 합니다.
const SEARCH_ACCT = { x: "x-search", instagram: "instagram-search" };
const searchLoggedOut = (p) => !!SEARCH_ACCT[p] && !!(loginState[SEARCH_ACCT[p]] && loginState[SEARCH_ACCT[p]].loggedIn === false);
const SEARCH_LOGIN_HELP = (p) => "서버의 " + PLATFORM[p] + " 검색용 테스트 계정이 로그인되어 있지 않아 이름으로 찾을 수 없습니다(@아이디·프로필 주소로는 바로 추가할 수 있습니다). 관리자가 서버 PC에서 login_setup.bat " + SEARCH_ACCT[p] + " 로 로그인해야 합니다.";
let loginRecheckAt = {};
function renderLogin() {
  const bar = $("loginBar");
  bar.textContent = "";
  bar.hidden = !connected;
  if (!connected) return;
  // 매체 아이콘 버튼
  //  · 서버 테스트 계정이 로그인 안 됨(X·인스타): 회색 (누르면 안내 + 다시 확인)
  //  · 그 밖: 수집 켜짐 = 초록 테두리 / 수집 꺼짐 = 빨간 테두리 (누를 때마다 켜고 끔)
  LOGIN_PLATS.forEach((p) => {
    const out = loggedOut(p);
    const collect = settings[p] !== false;
    const cls = "lb pi pi-" + p + (out ? " nl" : collect ? " go" : " stop");
    const tip = PLATFORM[p] + (out ? " · 서버 테스트 계정 로그인 필요 (눌러서 다시 확인)" : collect ? " · 수집 켜짐 (눌러서 끄기)" : " · 수집 꺼짐 (눌러서 켜기)");
    const b = el("button", { type: "button", class: cls, "aria-label": tip, title: tip, "aria-pressed": out ? "false" : String(collect) });
    b.addEventListener("click", async () => {
      if (out) {
        toast(LOGIN_HELP(p), "error");
        if (Date.now() - (loginRecheckAt[p] || 0) > 20000) { loginRecheckAt[p] = Date.now(); call("checkLogin", { platforms: [p] }).catch(() => {}); }
        return;
      }
      settings = { ...settings, [p]: !collect };
      renderLogin();
      try { await call("set", { settings }); toast(PLATFORM[p] + " 수집을 " + (!collect ? "켰습니다." : "껐습니다.")); }
      catch (e) { settings = { ...settings, [p]: collect }; renderLogin(); showErr(e); }
    });
    bar.appendChild(b);
  });
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeViewer(); });
