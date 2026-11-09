/* ---------- 서버에서 글·추적 계정 읽기 ---------- */
// 글과 추적 계정은 서버 DB에 있어서, 어느 기기에서든 로그인하면 같은 내용이 보입니다.
// 서버 상태는 call("get")으로 읽고(refresh), 본 글 기록만 /api/sync로 따로 맞춥니다(아래 "본 글 기록").
let saveNote = ""; // 연결 표시줄 뒤에 덧붙이는 짧은 안내
async function sapi(action, extra) {
  const r = await apiPost("/api/sync", Object.assign({ action, session: sess }, extra || {}));
  let j;
  try { j = await r.json(); } catch (e) { throw new Error("서버 응답을 읽지 못했습니다."); }
  if (!j.ok) throw new Error(j.error || "요청에 실패했습니다.");
  return j;
}

let prevRunning = false;
const removedIds = new Set(); // 방금 지운 추적 계정: 서버가 옛 목록을 돌려줘도 다시 나타나지 않게 합니다
let lastClosedShown = 0, pauseDismissed = false, lastAutoResume = 0;
let lastDataSig = "", lastStatusSig = "", lastLoginSig = "";
let lastGetVer = "", serverItems = []; // 서버 글 목록의 버전: 바뀌지 않았으면 서버가 글 목록을 다시 보내지 않습니다(데이터 절약)
async function refresh() {
  const d = await call("get", { ver: lastGetVer });
  if (!d.same) { serverItems = Object.values(d.items || {}); lastGetVer = d.ver || ""; }
  settings = d.settings || {};
  if (Date.now() >= trackedHold) tracked = Array.isArray(d.tracked) ? d.tracked : [];
  if (Date.now() >= trackedHold && removedIds.size && tracked.some((t) => removedIds.has(t.id))) {
    tracked = tracked.filter((t) => !removedIds.has(t.id));
    call("set", { tracked }).catch(() => {}); // 지운 계정이 서버에 남아 있으면 다시 지웁니다
  }
  items = serverItems;
  autoCheck = { enabled: true, hours: 1 };
  winDays = [7, 14, 30, 60].includes(d.windowDays) ? d.windowDays : 30;
  periodDays = winDays;
  checkStatus = d.status || {};
  loginState = d.loginState || {};
  // 사용자가 수집창을 닫아 수집이 끝났다면: 한 번만 안내 모달을 띄웁니다.
  if (checkStatus.closed && checkStatus.lastRun && checkStatus.lastRun !== lastClosedShown && !checkStatus.running) {
    lastClosedShown = checkStatus.lastRun;
    $("closedModal").hidden = false;
    $("cmRetry").focus();
  }
  // 수집창이 가려져 수집이 일시정지됐다면 안내 모달을 띄웁니다(이어서 수집 / 닫기).
  // 이 웹 화면을 보고 있는 중이면 모달 없이 바로 수집창을 앞으로 내 이어서 수집합니다(몇 초 간격으로 한 번씩).
  // 웹 화면을 벗어나 있을 때만 모달(이어서 수집/닫기)을 준비해 둡니다.
  if (checkStatus.paused && checkStatus.running && !searchActive) {
    if (document.visibilityState === "visible") {
      $("pausedModal").hidden = true;
      if (!pauseDismissed && Date.now() - lastAutoResume > 6000) { lastAutoResume = Date.now(); call("resumeCheck").catch(() => {}); }
    } else if (!pauseDismissed) $("pausedModal").hidden = false;
  } else { pauseDismissed = false; $("pausedModal").hidden = true; }
  if (!connected) { setConn(true); lastDataSig = ""; lastStatusSig = ""; lastLoginSig = ""; }
  // 수집이 끝나는 순간, 프로필 사진도 함께 최신화합니다.
  { const nowRun = !!(checkStatus && checkStatus.running); if (prevRunning && !nowRun) setTimeout(() => refreshPics().catch(() => {}), 1500); prevRunning = nowRun; }
  // 웹을 처음 열 때, 서버 테스트 계정의 로그인 상태가 오래됐으면 서버에 다시 확인을 부탁합니다.
  // (서버 PC에서 매체 메인 화면을 잠깐 열어 확인합니다. 30분 안에 확인한 적이 있으면 건너뜁니다.)
  if (!loginAsked) {
    loginAsked = true;
    // 확인이 필요한(처음이거나 오래된) 매체만 확인합니다.
    // 로그인이 안 된 것으로 확인된 매체는 2시간에 한 번만 다시 봅니다(열 때마다 탭이 뜨지 않게).
    const stale = Object.keys(LOGIN_LINK).filter((p) => !loginState[p] || Date.now() - (loginState[p].at || 0) > (loginState[p].loggedIn === false ? 120 : 30) * 60000);
    if (stale.length) call("checkLogin", { platforms: stale }).catch(() => {});
  }
  // 바뀐 부분만 다시 그려서 화면이 깜빡이지 않게 합니다.
  let mx = 0;
  for (const it of items) if (it.collectedAt > mx) mx = it.collectedAt;
  const dataSig = items.length + ":" + mx + ":" + JSON.stringify([tracked, settings, autoCheck, winDays]);
  const statusSig = JSON.stringify(checkStatus);
  const loginSig = JSON.stringify([loginState, settings]);
  // 확인(업데이트)이 진행되는 동안에는 글 목록을 다시 그리지 않고(상태 문구만 갱신), 끝난 뒤에 한 번만 새로 그립니다.
  const updating = !!(checkStatus && checkStatus.running) && firstDrawn;
  if (dataSig !== lastDataSig && !updating) { lastDataSig = dataSig; lastStatusSig = statusSig; firstDrawn = true; keepView(renderAll); }
  else if (statusSig !== lastStatusSig) { lastStatusSig = statusSig; renderTracked(); }
  if (loginSig !== lastLoginSig) { lastLoginSig = loginSig; renderLogin(); }
  renderWork();
}
let firstDrawn = false;
// 자동 수집은 서버가 1시간마다 알아서 합니다(server/collector). 화면은 결과만 읽습니다.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  // 웹 화면으로 돌아오면 다음 주기를 기다리지 않고 곧바로 서버 상태를 다시 읽습니다.
  $("pausedModal").hidden = true;
  if (connected) refresh().catch(() => {});
});

// 서버 상태 다시 읽기: 수집 중에는 3초, 평소에는 30초마다. 화면을 보지 않는 동안은 쉽니다.
// (ngrok 무료는 한 달 요청 수에 한도가 있어서 예전처럼 늘 3초마다 묻지 않습니다. 화면으로 돌아오면 바로 한 번 읽습니다.)
let pollGen = 0;
function startPolling() {
  const gen = ++pollGen;
  clearTimeout(polling); clearInterval(polling);
  const tick = () => {
    if (gen !== pollGen) return; // 새로 시작된 반복이 있으면 이 반복은 끝냅니다
    const busy = !!(checkStatus && checkStatus.running);
    polling = setTimeout(async () => {
      if (gen !== pollGen) return;
      if (document.visibilityState === "visible") {
        try { await refresh(); } catch (e) { if (connected) setConn(false); }
      }
      tick();
    }, busy ? 3000 : 30000);
  };
  tick();
}
async function connect(fromForm) {
  const err = $("acctMsg");
  err.hidden = true;
  try {
    await refresh();
    setConn(true);
    startPolling();
  } catch (e) {
    setConn(false);
    if (fromForm) { err.textContent = e.message; err.hidden = false; }
    if (sess) startPolling(); // 서버가 꺼져 있었다면, 다시 켜졌을 때 자동으로 연결되게 계속 확인합니다
  }
}


/* 새로 그린 뒤에도 보던 자리를 유지합니다: 페이지 세로 위치, 각 줄의 가로 위치(보던 첫 카드 기준), 세로 격자의 보던 카드. */
function viewKey(sec, seen) {
  const h = sec.querySelector(".sec-head h3, .sec-head h4");
  const base = h ? h.textContent.trim() : "";
  seen[base] = (seen[base] || 0) + 1;
  return base + "#" + seen[base];
}
function firstVisibleCard(box, horizontal) {
  const rb = box.getBoundingClientRect();
  for (const c of box.children) {
    if (!c._item) continue;
    const r = c.getBoundingClientRect();
    if (horizontal ? r.right > rb.left + 1 : r.bottom > 0) return { id: c._item.id, off: horizontal ? r.left - rb.left : r.top };
  }
  return null;
}
function keepView(draw) {
  const grid = document.getElementById("grid");
  const y = window.scrollY, rows = {}, cnt = {};
  let vert = null, secAnchor = null;
  try {
    grid.querySelectorAll(".sec").forEach((sec) => {
      const key = viewKey(sec, cnt);
      // 세로 기준: 지금 화면에 걸쳐 보이는 첫 줄(계정·묶음). 위에 새 줄이 끼어들어도 이 줄이 같은 자리에 오게 합니다.
      if (!secAnchor) { const r = sec.getBoundingClientRect(); if (r.bottom > 0) secAnchor = { key, top: r.top }; }
      const row = sec.querySelector(".row-cards");
      if (row) rows[key] = { left: row.scrollLeft, a: firstVisibleCard(row, true) };
    });
    const cards = grid.matches(".cards") ? grid : grid.querySelector(".cards");
    if (cards) vert = firstVisibleCard(cards, false);
  } catch (e) { /* 위치를 못 읽으면 그냥 다시 그립니다 */ }
  draw();
  try {
    const cnt2 = {};
    grid.querySelectorAll(".sec").forEach((sec) => {
      const row = sec.querySelector(".row-cards"), st = row && rows[viewKey(sec, cnt2)];
      if (!row || !st) return;
      const c = st.a && Array.from(row.children).find((n) => n._item && n._item.id === st.a.id);
      row.scrollLeft = c ? Math.max(0, c.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft - st.a.off) : st.left;
    });
    window.scrollTo(0, y);
    if (secAnchor) {
      const cnt3 = {};
      for (const sec of grid.querySelectorAll(".sec")) {
        if (viewKey(sec, cnt3) === secAnchor.key) { window.scrollBy(0, sec.getBoundingClientRect().top - secAnchor.top); break; }
      }
    }
    if (vert) {
      const cards = grid.matches(".cards") ? grid : grid.querySelector(".cards");
      const c = cards && Array.from(cards.children).find((n) => n._item && n._item.id === vert.id);
      if (c) window.scrollBy(0, c.getBoundingClientRect().top - vert.off);
    }
  } catch (e) { /* 무시 */ }
}

/* ---------- 본 글 기록(흐리게 보이는 표시)을 계정에 동기화: 합집합으로만 합칩니다 ---------- */
const seenQueue = new Set();
let seenTimer = 0, lastSeenPull = 0;
function queueSeen(id) {
  if (!sess) return;
  seenQueue.add(id);
  clearTimeout(seenTimer);
  seenTimer = setTimeout(flushSeen, 8000);
}
async function flushSeen() {
  if (!sess || !seenQueue.size) return;
  const add = Array.from(seenQueue).slice(0, 500);
  try {
    await sapi("putSeen", { add });
    add.forEach((id) => seenQueue.delete(id));
  } catch (e) { /* 다음 기회에 다시 보냅니다 */ }
  if (seenQueue.size) { clearTimeout(seenTimer); seenTimer = setTimeout(flushSeen, 8000); }
}
async function pullSeen() {
  if (!sess) return;
  lastSeenPull = Date.now();
  try {
    const ids = (await sapi("getSeen")).ids || [];
    const server = new Set(ids);
    let added = false;
    for (const id of ids) if (!seen.has(id)) { seen.add(id); added = true; }
    if (added) {
      saveSeen();
      document.querySelectorAll("#grid .card").forEach((c) => { if (c._item && seen.has(c._item.id)) c.classList.add("seen"); });
    }
    // 이 기기에만 있던 기록은 서버로 올립니다.
    Array.from(seen).slice(-2000).forEach((id) => { if (!server.has(id)) seenQueue.add(id); });
    if (seenQueue.size) { clearTimeout(seenTimer); seenTimer = setTimeout(flushSeen, 3000); }
  } catch (e) { /* 무시 */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && sess && Date.now() - lastSeenPull > 60000) pullSeen();
});
