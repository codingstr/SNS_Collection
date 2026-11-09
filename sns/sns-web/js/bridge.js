/* ---------- 서버 연결 : 글 목록·추적 계정·수집 요청을 서버의 /api/call로 보냅니다 ---------- */
// call(op, payload) → 서버가 돌려준 result. op 종류는 server/api_call.py를 보세요.
// (waitMs는 쓰지 않습니다. 대기 시간은 core.js의 apiPost가 정합니다.)
const CHANGING_OPS = ["set", "checkNow", "clearItems", "removeVia"];
async function call(op, payload, waitMs) {
  const r = await apiPost("/api/call", { session: sess, op, payload: payload || {} });
  let j;
  try { j = await r.json(); } catch (e) { throw new Error("서버 응답을 읽지 못했습니다."); }
  if (!j.ok) throw new Error(j.error || "요청에 실패했습니다.");
  // 내용을 바꾸는 요청 뒤에는 곧바로 서버 상태를 다시 읽습니다(평소 다시 읽는 간격이 30초라서).
  // 수집이 시작됐으면 다시 읽는 간격을 3초로 바꿉니다.
  if (CHANGING_OPS.includes(op) && connected) {
    setTimeout(() => refresh().then(() => { if (checkStatus && checkStatus.running) startPolling(); }).catch(() => {}), 300);
  }
  return j.result;
}

// 화면 전환: 홈(글 모아보기) ↔ 추적 계정 관리(따로 분리된 화면)
let page = "home";
function applyPage() {
  if (!connected && page === "manage") page = "home";
  const manage = connected && page === "manage", sett = false;
  $("trackPanel").hidden = !manage;
  document.querySelector(".layout main").hidden = manage || sett;
  $("navManage").hidden = !connected;
  $("navHome").classList.toggle("on", !manage && !sett && page !== "fav");
  $("navFav").classList.toggle("on", page === "fav");
  $("navManage").classList.toggle("on", manage);
}
function setConn(ok) {
  connected = ok;
  if (!ok) { $("loginBar").hidden = true; }
  $("connectPanel").hidden = ok;
  // 저장된 연결 코드로 자동 연결됐지만 로그인 세션이 없는 경우에도 계정 버튼은 보여서(설정·로그아웃) 다시 로그인할 수 있게 합니다.
  $("connAcct").hidden = !ok;
  if (ok && !$("menuWho").textContent.trim()) $("menuWho").textContent = "로그인 정보 없음 (연결만 된 상태)";
  applyPage();
  $("checkNow").hidden = false; $("checkNow").classList.toggle("off", !ok); // 새로고침 버튼은 항상 보이고, 가운데 점이 연결 상태(초록=연결됨)를 알려 줍니다
  updateConnText();
}
function updateConnText() {
  $("dot").className = "dot" + (connected ? " on" : "");
  const note = saveNote ? " · " + saveNote : "";
  if (connected) $("connText").textContent = "서버와 연결됨 · 글 " + items.length + "건" + note;
  else $("connText").textContent = (sess ? "서버와 연결되지 않았습니다. 잠시 뒤 다시 시도합니다." : "로그인하면 서버와 연결됩니다.") + note;
  $("dot").title = $("connText").textContent;
}

/* ---------- 매체별 로그인 상태 ---------- */
const LOGIN_LINK = { youtube: "https://www.youtube.com/", x: "https://x.com/i/flow/login", instagram: "https://www.instagram.com/accounts/login/" };
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
    "https://" + (p === "youtube" ? "www.youtube.com" : p === "instagram" ? "www.instagram.com" : "x.com") + "/favicon.ico",
  ];
  let i = 0;
  const img = el("img", { alt: "", referrerpolicy: "no-referrer", draggable: "false" });
  img.addEventListener("error", () => { if (++i < srcs.length) img.src = srcs[i]; else { img.remove(); wrap.textContent = PGLYPH[p]; } });
  img.src = srcs[0];
  wrap.appendChild(img);
  return wrap;
}
let loginState = {}, modalShown = false, loginAsked = false;
// 로그인 창 자동 열기는 "내가 확인/가져오기를 누른 직후 30초" 안에, 매체마다 한 번만 합니다.
// (로그인 창 자체나 새로고침이 다시 창을 여는 일이 없게 합니다.)
let promptArmedAt = 0, promptedPlat = {}, loginWatch = 0, loginWatchPlat = {}; // loginWatchPlat: 로그인 창을 연 매체(그 매체만 다시 확인)
function armLoginPrompt() { /* 로그인 창은 이제 모달의 '로그인 하기' 버튼으로만 엽니다 */ }
const needLogin = () => Object.keys(LOGIN_LINK).filter((p) => loginState[p] && loginState[p].loggedIn === false);
function renderLogin() {
  const need = connected ? needLogin() : [];
  const bar = $("loginBar");
  bar.textContent = "";
  bar.hidden = !connected;
  if (connected) {
    // 매체 아이콘 버튼
    //  · 로그인 안 됨: 회색 테두리 + 반투명 회색이 아이콘을 덮음 (누르면 로그인 창)
    //  · 로그인 됨: 수집 켜짐 = 초록 테두리 / 수집 꺼짐 = 빨간 테두리 (누를 때마다 켜고 끔)
    Object.keys(LOGIN_LINK).forEach((p) => {
      const on = !!(loginState[p] && loginState[p].loggedIn === true);
      const collect = settings[p] !== false;
      const cls = "lb pi pi-" + p + (!on ? " nl" : collect ? " go" : " stop");
      const tip = PLATFORM[p] + (!on ? " · 로그인이 필요합니다 (눌러서 로그인)" : collect ? " · 수집 켜짐 (눌러서 끄기)" : " · 수집 꺼짐 (눌러서 켜기)");
      const b = el("button", { type: "button", class: cls, "aria-label": tip, title: tip, "aria-pressed": on ? String(collect) : "false" });
      b.addEventListener("click", async () => {
        if (!on) {
          loginWatch = Date.now(); loginWatchPlat[p] = loginWatch; // 로그인하고 돌아오면 상태가 바로 바뀌도록 잠시 동안 자주 확인합니다
          call("openLogin", { platform: p }).catch(showErr);
          return;
        }
        settings = { ...settings, [p]: !collect };
        renderLogin();
        try { await call("set", { settings }); } catch (e) { settings = { ...settings, [p]: collect }; renderLogin(); showErr(e); }
      });
      bar.appendChild(b);
    });
  }
  if (!$("loginModal").hidden) renderLoginModal();
}
// 로그인이 필요한 매체 목록 모달: 매체마다 '로그인 하기' 버튼, 로그인되면 목록에서 빠집니다.
let modalPlats = [];
function renderLoginModal() {
  const list = $("lmList");
  list.textContent = "";
  const need = modalPlats.filter((p) => !(loginState[p] && loginState[p].loggedIn === true));
  if (!need.length) list.appendChild(el("p", { class: "hint", text: "필요한 매체가 모두 로그인되었습니다. '다시 시도'를 눌러 주세요." }));
  need.forEach((p) => {
    const b = el("button", { type: "button", class: "lb", text: "로그인 하기" });
    b.addEventListener("click", () => {
      loginWatch = Date.now(); loginWatchPlat[p] = loginWatch; // 로그인 후 상태가 바로 바뀌도록 잠시 동안 자주 확인합니다
      call("openLogin", { platform: p }).catch(showErr);
    });
    list.appendChild(el("div", { class: "row", style: "justify-content:space-between;align-items:center" }, [el("span", { text: PLATFORM[p] + " 로그인이 필요합니다" }), b]));
  });
}
function openLoginModal(plats) { modalPlats = plats; renderLoginModal(); $("loginModal").hidden = false; }
// 매체 로그인 버튼: SNS 로그인은 서버 PC 관리자가 server/login_setup.bat으로 하므로, 누르면 안내만 보여 줍니다.
function loginLink(p, text, cls) {
  const a = el("button", { type: "button", class: "lb " + (cls || ""), text });
  a.addEventListener("click", () => { call("openLogin", { platform: p }).catch(showErr); });
  return a;
}
function closeLoginModal() { $("loginModal").hidden = true; }
$("lmX").addEventListener("click", closeLoginModal);
$("lmLater").addEventListener("click", closeLoginModal);
$("lmRetry").addEventListener("click", () => { closeLoginModal(); startRefresh(); });
$("loginModal").addEventListener("click", (e) => { if (e.target === $("loginModal")) closeLoginModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeLoginModal(); closeViewer(); } });


// 로그인 버튼을 누른 매체는, 로그인 창에서 이 웹 화면으로 돌아왔을 때 딱 한 번만 로그인 상태를 확인합니다(주기적으로 반복하지 않고, 누르지 않은 매체의 탭은 열지 않습니다).
// 돌아오기 전(4초 안)이나 이미 로그인된 매체는 확인하지 않습니다. 다시 확인하고 싶으면 그 매체의 버튼을 한 번 더 누르면 됩니다.
const recheckLogin = () => {
  if (!connected) return;
  const todo = Object.keys(loginWatchPlat).filter((p) => Date.now() - loginWatchPlat[p] > 4000 && Date.now() - loginWatchPlat[p] < 30 * 60000 && !(loginState[p] && loginState[p].loggedIn === true));
  Object.keys(loginWatchPlat).forEach((p) => { if (todo.includes(p) || (loginState[p] && loginState[p].loggedIn === true)) delete loginWatchPlat[p]; });
  if (todo.length) call("checkLogin", { platforms: todo }).catch(() => {});
};
window.addEventListener("focus", recheckLogin);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") recheckLogin(); });
