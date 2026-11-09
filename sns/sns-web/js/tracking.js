/* ---------- 계정 입력 해석 ---------- */
const FEED = { youtube: "내 구독 피드", x: "홈 타임라인", instagram: "홈 피드" }; // 예전에 추가한 피드 항목 표시용(새로 추가는 안 됨)
const FEED_MSG = "사이트 메인 주소(내 피드)는 지원하지 않습니다. 서버가 대신 수집하므로 내 계정의 피드를 볼 수 없습니다. @계정이나 프로필 주소를 넣어 주세요.";
const SITE_START = /^(www\.|m\.|mobile\.)?(youtube\.com|youtu\.be|x\.com|twitter\.com|instagram\.com)(\/|$)/i;
const VIDEO_MSG = "영상 주소입니다. 채널 주소(예: https://www.youtube.com/@이름)를 넣어 주세요.";

// 입력을 해석해 { account } 또는 { error }를 돌려줍니다.
function parseAccount(platformHint, raw) {
  let s = raw.trim();
  if (!s) return { error: "계정이나 주소를 입력하세요." };
  // "youtube.com"처럼 프로토콜 없이 사이트 주소만 붙여넣은 경우도 주소로 처리합니다.
  if (!/^https?:\/\//i.test(s) && !s.startsWith("@") && SITE_START.test(s)) s = "https://" + s;

  let platform = platformHint;
  let handle = "";
  let channelId = "";
  let resolveUrl = "";
  let feed = false;

  if (/^https?:\/\//i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch (e) {
      return { error: "주소 형식이 올바르지 않습니다." };
    }
    const host = u.hostname.replace(/^(www|m|mobile)\./, "");
    const parts = u.pathname.split("/").filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch (e) {
        return p;
      }
    });
    if (host === "youtube.com") {
      platform = "youtube";
      if (!parts.length || parts[0] === "feed") feed = true; // 유튜브 메인 → 내 구독 피드
      else if (parts[0].startsWith("@")) handle = parts[0].slice(1);
      else if (parts[0] === "channel" && /^UC[\w-]{22}$/.test(parts[1] || "")) channelId = parts[1];
      else if ((parts[0] === "c" || parts[0] === "user") && parts[1])
        resolveUrl = "https://www.youtube.com/" + parts[0] + "/" + encodeURIComponent(parts[1]);
      else if (parts[0] === "watch" || parts[0] === "shorts") return { error: VIDEO_MSG };
      else return { error: "인식하지 못한 유튜브 주소입니다. 채널 주소(@이름)를 넣어 주세요." };
    } else if (host === "youtu.be") {
      return { error: VIDEO_MSG };
    } else if (host === "x.com" || host === "twitter.com") {
      platform = "x";
      if (!parts.length || parts[0] === "home") feed = true; // X 메인 → 홈 타임라인
      else handle = parts[0];
    } else if (host === "instagram.com") {
      platform = "instagram";
      if (!parts.length) feed = true; // 인스타그램 메인 → 홈 피드
      else handle = parts[0];
    } else {
      return { error: "지원하지 않는 사이트입니다. 유튜브·X·인스타 주소만 넣을 수 있습니다." };
    }
  } else {
    handle = s.replace(/^@/, "");
  }

  if (feed) return { error: FEED_MSG };
  if (!handle && !channelId && !resolveUrl) return { error: "계정을 인식하지 못했습니다. @이름이나 프로필 주소를 입력하세요." };
  if (handle && (!/^[^\s/?#@]{1,60}$/.test(handle) || RESERVED.has(handle.toLowerCase()))) {
    return { error: "계정 이름을 인식하지 못했습니다. @이름 형태로 입력하세요." };
  }
  const key = (handle || channelId || resolveUrl).toLowerCase();
  const account = { id: platform + ":" + key, platform, handle };
  if (channelId) account.channelId = channelId;
  if (resolveUrl) account.resolveUrl = resolveUrl;
  return { account };
}



/* ---------- 이벤트 ---------- */
{ let qt = 0; $("q").addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(renderList, 180); }); } // 글자마다 전체를 다시 그리지 않고 입력이 잠깐 멈추면 한 번만 그립니다
function needPick() { const b = $("selBar"); b.classList.add("need"); setTimeout(() => b.classList.remove("need"), 900); }
$("selClear").addEventListener("click", () => { selIds = []; renderTracked(); });
$("selAll").addEventListener("click", () => { selIds = tracked.map((t) => t.id); renderTracked(); });
// 고른 계정 전부에 적용합니다.
async function applyToSelected(change) {
  if (!selIds.length) { needPick(); return; }
  const ids = new Set(selIds), before = tracked;
  tracked = tracked.map((t) => (ids.has(t.id) ? change({ ...t }) : t));
  renderTracked(); renderList();
  try { await saveTracked(); } catch (e) { tracked = before; renderTracked(); renderList(); showErr(e); }
}
$("groupForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("gName").value.trim().slice(0, 30);
  await applyToSelected((c) => { if (name) c.group = name; else delete c.group; return c; });
  if (selIds.length) $("gName").value = "";
});
$("gClear").addEventListener("click", () => applyToSelected((c) => { delete c.group; return c; }));
// 묶음 수정: 모달에서 묶음을 고르고 새 이름을 적으면, 그 묶음의 모든 계정 이름이 바뀝니다(즐겨찾기·보고 있는 묶음도 따라감).
{
  const modal = $("gmModal"), sel = $("gmSel"), inp = $("gmName"), err = $("gmErr");
  const say = (m) => { err.textContent = m; err.hidden = !m; };
  const close = () => { modal.hidden = true; };
  const groupsNow = () => { const c = new Map(); tracked.forEach((t) => { if (t.group) c.set(t.group, (c.get(t.group) || 0) + 1); }); return c; };
  $("gRename").addEventListener("click", () => {
    const c = groupsNow();
    if (!c.size) { const e = $("addError"); e.textContent = "수정할 묶음이 없습니다. 계정을 골라 '묶기'로 먼저 묶어 주세요."; e.hidden = false; return; }
    $("addError").hidden = true;
    sel.textContent = "";
    c.forEach((n, name) => sel.appendChild(el("option", { value: name, text: name + " (" + n + "개 계정)" })));
    let start = selGroup;
    if (!start) { const gs = Array.from(new Set(tracked.filter((t) => selIds.includes(t.id) && t.group).map((t) => t.group))); if (gs.length === 1) start = gs[0]; }
    if (start && c.has(start)) sel.value = start;
    inp.value = sel.value; say(""); modal.hidden = false; inp.focus(); inp.select();
  });
  sel.addEventListener("change", () => { inp.value = sel.value; say(""); inp.focus(); inp.select(); });
  $("gmX").addEventListener("click", close); $("gmCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("gmOk").click(); } });
  $("gmOk").addEventListener("click", async () => {
    const old = sel.value, neu = inp.value.trim().slice(0, 30);
    if (!neu) { say("새 이름을 적어 주세요."); inp.focus(); return; }
    if (neu === old) { say("현재 이름과 같습니다."); return; }
    const before = tracked;
    tracked = tracked.map((t) => (t.group === old ? { ...t, group: neu } : t));
    if (typeof favs !== "undefined" && favs.has(old)) { favs.delete(old); favs.add(neu); try { localStorage.setItem("snsFavs", JSON.stringify([...favs])); } catch (e) {} }
    if (typeof groupFocus !== "undefined" && groupFocus === old) groupFocus = neu;
    if (typeof personFocus !== "undefined" && personFocus === old) personFocus = neu;
    selGroup = ""; close(); renderTracked(); renderList();
    try { await saveTracked(); } catch (e) { tracked = before; renderTracked(); renderList(); showErr(e); }
  });
}
// 묶음 고르기: 이미 있는 묶음 이름을 칩으로 보여 주고, 하나를 누르면 이름 칸에 그 이름이 들어가 바로 고쳐서 "이름 변경"을 누를 수 있습니다.
let selGroup = "";
function renderGroupChips() {
  const box = $("gChips"); if (!box) return;
  const cnt = new Map(); tracked.forEach((t) => { if (t.group) cnt.set(t.group, (cnt.get(t.group) || 0) + 1); });
  if (selGroup && !cnt.has(selGroup)) selGroup = "";
  box.textContent = ""; box.hidden = !cnt.size;
  box.appendChild(el("span", { class: "gl", text: "묶음" }));
  [...cnt.entries()].sort((a, b) => b[1] - a[1]).forEach(([name, n]) => {
    const b = el("button", { type: "button", class: "gc" + (name === selGroup ? " on" : ""), title: "눌러서 선택 → 아래 칸에서 이름을 고쳐 '이름 변경'" }, [el("span", { text: name }), el("i", { text: String(n) })]);
    b.addEventListener("click", () => {
      selGroup = selGroup === name ? "" : name;
      $("gName").value = selGroup; if (selGroup) { $("gName").focus(); $("gName").select(); const sg = $("gName").parentElement.querySelector(".gsuggest"); if (sg) sg.hidden = true; }
      renderGroupChips();
    });
    box.appendChild(b);
  });
  
}
{ const _rt = renderTracked; renderTracked = function () { const r = _rt.apply(this, arguments); renderGroupChips(); return r; }; }
renderGroupChips();
$("daysForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const d = Number($("dDays").value);
  applyToSelected((c) => { if (d) c.days = d; else delete c.days; return c; });
});
// 제거: 선택한 계정을 추적 목록에서 지웁니다(그 계정으로 모은 글도 함께). 확인 창에서 한 번 더 확인합니다.
const closeRm = () => { $("rmModal").hidden = true; };
$("selRemove").addEventListener("click", () => {
  if (!selIds.length) { needPick(); return; }
  $("rmList").textContent = selIds.map((id) => { const t = tracked.find((x) => x.id === id); return t ? PLATFORM[t.platform] + " " + (t.kind === "feed" ? FEED[t.platform] : t.handle ? "@" + t.handle : t.channelId || "") : ""; }).filter(Boolean).join(" · ");
  $("rmModal").hidden = false;
  $("rmCancel").focus();
});
$("rmX").addEventListener("click", closeRm);
$("rmCancel").addEventListener("click", closeRm);
$("rmModal").addEventListener("click", (e) => { if (e.target === $("rmModal")) closeRm(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("rmModal").hidden) closeRm(); });
$("rmOk").addEventListener("click", async () => { closeRm(); await removeTrackedIds(selIds.slice()); });
async function removeTrackedIds(ids) {
  const set = new Set(ids);
  if (!ids.length) return;
  tracked = tracked.filter((x) => !set.has(x.id));
  items = items.filter((it) => !set.has(it.via)); // 이 계정으로 모은 글도 함께 지웁니다
  selIds = selIds.filter((i) => !set.has(i));
  ids.forEach((i) => removedIds.add(i)); // 서버가 아직 옛 목록을 돌려줘도 다시 나타나지 않게 합니다
  renderTracked(); renderTabs(); renderList();
  await saveTracked().catch(showErr);
}
// 추적 계정 저장: 저장하는 동안(그리고 직후 몇 초)에는 주기적 새로고침이 화면 목록을 옛 목록으로 되돌리지 않게 합니다.
async function saveTracked() {
  trackedHold = Date.now() + 8000;
  try { return await call("set", { tracked }); } finally { trackedHold = Date.now() + 4000; }
}
// 새로 추가하는 계정에서 가져올 기간(마지막 선택을 기억합니다). 추가한 뒤에는 '추적 계정 관리'에서 계정별로 바꿉니다.
// 주소나 @계정이 아니면(예: 그냥 이름) 추가하지 않고 이름으로 검색합니다.
const isDirect = (v) => /^https?:\/\//i.test(v) || v.startsWith("@") || SITE_START.test(v);
$("addForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = $("addError"); err.hidden = true;
  const raw = $("thandle").value.trim();
  if (raw && !isDirect(raw)) { $("searchBtn").click(); return; }
  const r = parseAccount($("tplatform").value, $("thandle").value);
  if (r.error) { err.textContent = r.error; err.hidden = false; return; }
  const acc = r.account;
  const grp = $("tgroup").value.trim().slice(0, 30);
  if (grp && acc.kind !== "feed") acc.group = grp;
  if (!acc.days) acc.days = Number($("addDays").value) || 30; // 이 계정만의 가져올 기간
  if (tracked.some((t) => t.id === acc.id)) { err.textContent = "이미 추가된 계정입니다."; err.hidden = false; return; }
  if (tracked.length >= MAX_TRACKED) { err.textContent = "계정은 최대 " + MAX_TRACKED + "개까지 추가할 수 있습니다."; err.hidden = false; return; }
  const before = tracked;
  tracked = [...tracked, acc];
  $("thandle").value = "";
  renderTracked(); renderList();
  try { await saveTracked(); } catch (e) { tracked = before; renderTracked(); showErr(e); return; }
  call("checkNow", { only: acc.id }).catch(showErr);
});
/* ---------- 이름으로 검색 ---------- */
function addAccount(acc) {
  const err = $("addError"); err.hidden = true;
  if (tracked.some((t) => t.id === acc.id)) { err.textContent = "이미 추가된 계정입니다."; err.hidden = false; return Promise.resolve(false); }
  if (tracked.length >= MAX_TRACKED) { err.textContent = "계정은 최대 " + MAX_TRACKED + "개까지 추가할 수 있습니다."; err.hidden = false; return Promise.resolve(false); }
  if (!acc.days) acc.days = Number($("addDays").value) || 30; // 이 계정만의 가져올 기간
  const before = tracked;
  tracked = [...tracked, acc];
  renderTracked(); renderList();
  return saveTracked().then(() => { call("checkNow", { only: acc.id }).catch(showErr); return true; }, (e) => { tracked = before; renderTracked(); showErr(e); return false; });
}
// 추가 버튼을 누르면 이 계정에서 가져올 기간을 모달에서 고릅니다(1W·2W·1M·2M). 기본은 1M입니다.
function pickPeriod() {
  const OPTS = [["7", "1W", "1주"], ["14", "2W", "2주"], ["30", "1M", "1개월"], ["60", "2M", "2개월"]];
  return new Promise((resolve) => {
    let cur = "30"; // 기본은 1M(30일)
    const done = (v) => { back.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") done(null); };
    const row = el("div", { class: "periodrow" });
    const drawPeriods = () => {
      row.textContent = "";
      OPTS.forEach(([v, label, tip]) => {
        const b = el("button", { type: "button", class: "pbtn" + (v === cur ? " on" : ""), title: tip, text: label });
        b.addEventListener("click", () => { cur = v; drawPeriods(); });
        row.appendChild(b);
      });
    };
    drawPeriods();
    // 묶음: 직접 입력하거나, 이미 있는 묶음 이름을 검색해서 고릅니다.
    const groups = Array.from(new Set(tracked.map((t) => t.group).filter(Boolean)));
    const gin = el("input", { type: "text", maxlength: "30", placeholder: "묶음 이름 (선택) · 기존 묶음 검색", "aria-label": "묶음 이름", autocomplete: "off" });
    const gbox = el("div", { class: "gchips" });
    const drawGroups = () => {
      const q = gin.value.trim().toLowerCase();
      gbox.textContent = "";
      groups.filter((g) => !q || g.toLowerCase().includes(q)).slice(0, 12).forEach((g) => {
        const c = el("button", { type: "button", class: "gchip" + (gin.value.trim() === g ? " on" : ""), text: g });
        c.addEventListener("click", () => { gin.value = g; drawGroups(); });
        gbox.appendChild(c);
      });
      gbox.hidden = !gbox.children.length;
    };
    gin.addEventListener("input", drawGroups);
    drawGroups();
    const ok = el("button", { type: "button", class: "primary", text: "추가" });
    ok.addEventListener("click", () => done({ days: Number(cur), group: gin.value.trim().slice(0, 30) }));
    gin.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } });
    const x = el("button", { type: "button", class: "x", text: "×", "aria-label": "닫기" });
    x.addEventListener("click", () => done(null));
    const box = el("div", { class: "modal" }, [x, el("h2", { text: "가져올 기간" }), row, el("h2", { text: "묶음" }), gin, gbox, el("div", { class: "row" }, [ok])]);
    const back = el("div", { class: "modal-back", role: "dialog", "aria-modal": "true" }, [box]);
    back.addEventListener("click", (e) => { if (e.target === back) done(null); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(back);
    ok.focus();
  });
}
function fillResults(box, platform, list) {
  if (!list.length) {
    const needLog = platform !== "youtube" && loginState[platform] && loginState[platform].loggedIn === false;
    const why = platform === "youtube" ? "" : needLog ? " " + PLATFORM[platform] + "에 로그인되어 있는지 확인하세요." : " " + PLATFORM[platform] + "이 이름 검색을 막았거나 결과가 없을 수 있습니다. @아이디나 주소로 직접 추가해 보세요.";
    box.appendChild(el("p", { class: "hint", text: "검색 결과가 없습니다." + why }));
    if (needLog) box.appendChild(el("div", { class: "row", style: "padding:0 10px 10px" }, [loginLink(platform, PLATFORM[platform] + " 로그인 창 열기", "lb")]));
  }
  list.forEach((r) => {
    const key = (r.handle || r.channelId).toLowerCase();
    const acc = { id: platform + ":" + key, platform, handle: r.handle || "" };
    if (r.channelId) acc.channelId = r.channelId;
    const add = el("button", { type: "button", text: "추가" });
    // 이미 추적 중인 계정이면 "제거", 아니면 "추가"로 보여 줍니다(누를 때마다 바뀜).
    let armed = 0;
    const paint = () => { const on = tracked.some((t) => t.id === acc.id); add.textContent = on ? "제거" : "추가"; add.classList.toggle("rm", on); add.disabled = false; };
    paint();
    add.addEventListener("click", async () => {
      if (tracked.some((t) => t.id === acc.id)) {
        // 제거: 모아 둔 글도 함께 지워지므로 한 번 더 눌러야 제거합니다
        if (!armed) { add.textContent = "정말 제거?"; armed = setTimeout(() => { armed = 0; paint(); }, 4000); return; }
        clearTimeout(armed); armed = 0; add.disabled = true;
        await removeTrackedIds([acc.id]); paint(); return;
      }
      const pk = await pickPeriod(); if (!pk) return; acc.days = pk.days; if (pk.group) acc.group = pk.group; add.disabled = true;
      if (await addAccount(acc)) { paint(); if (r.avatar) storePic(acc.id, r.avatar).then((ok) => { if (ok) renderList(); }); } else paint();
    });
    const initial = (r.name || r.handle || "?").trim().charAt(0).toUpperCase();
    const ph = (why) => el("span", { class: "ph", text: initial, title: why || "" });
    let thumb = ph("사진 주소를 읽지 못했습니다");
    const swap = (img, kind, src) => img.addEventListener("error", () => img.replaceWith(ph("사진 불러오기 실패(" + kind + "): " + String(src).slice(0, 80))));
    if (r.avatar) { thumb = el("img", { src: r.avatar, alt: "", referrerpolicy: "no-referrer" }); swap(thumb, "서버가 전달한 데이터", r.avatar); }
    else if (r.avatarUrl) {
      if (window.claude) { thumb = el("img", { alt: "", referrerpolicy: "no-referrer" }); loadImg(r.avatarUrl, thumb); }
      else { thumb = el("img", { src: r.avatarUrl, alt: "", referrerpolicy: "no-referrer" }); swap(thumb, "주소로 직접", r.avatarUrl); }
    }
    box.appendChild(el("div", { class: "res" }, [thumb, el("div", { class: "t" }, [el("b", { text: (() => { const n = (r.name || "").replace(/\s+/g, " ").trim(), h = Math.floor(n.length / 2); return n.length > 1 && n.length % 2 === 1 && n[h] === " " && n.slice(0, h) === n.slice(h + 1) ? n.slice(0, h) : n || "@" + (r.handle || r.channelId); })() }), el("span", { text: [r.handle ? "@" + r.handle : "", r.desc && r.desc.replace(/^@/, "").toLowerCase() !== String(r.handle || "").toLowerCase() ? r.desc : ""].filter(Boolean).join(" · ") })]), add]));
  });
}
let searchWaiting = false;
$("searchBtn").addEventListener("click", async () => {
  const q = $("thandle").value.trim();
  const box = $("searchResults"), err = $("addError");
  err.hidden = true;
  if (!q) { err.textContent = "검색할 이름을 입력하세요."; err.hidden = false; return; }
  const platform = $("tplatform").value;
  box.hidden = false; box.textContent = "";
  box.appendChild(el("p", { class: "hint", text: "검색 중… 크롬에서 탭이 잠깐 열렸다 닫힙니다." }));
  $("searchBtn").disabled = true; searchActive++; // 검색은 수집보다 우선(수집 중에도 바로 실행)
  try {
    const list = await call("searchAccount", { platform, q }, 40000);
    box.textContent = "";
    fillResults(box, platform, list);
  } catch (e) { box.textContent = ""; showErr(e); box.hidden = true; }
  finally { $("searchBtn").disabled = false; searchActive = Math.max(0, searchActive - 1); }
});

// 지금 최신화: 먼저 로그인 상태를 확인하고, 로그인이 안 된 매체가 있으면 모달(로그인 하기)을 띄웁니다. 모두 로그인되어 있으면 바로 가져옵니다.
let refreshing = false;
async function startRefresh() {
  if (refreshing || !connected) return;
  refreshing = true;
  const btn = $("checkNow");
  btn.disabled = true; btn.classList.add("busy"); btn.title = "로그인 확인 중…";
  try {
    const plats = Array.from(new Set(tracked.filter((t) => settings[t.platform] !== false).map((t) => t.platform)));
    const t0 = Date.now();
    if (plats.length) {
      await call("checkLogin", { platforms: plats }).catch(() => {});
      // 확인 결과가 올 때까지 최대 약 30초 기다립니다(못 알아낸 매체는 막지 않고 진행합니다).
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        await refresh().catch(() => {});
        if (plats.every((p) => loginState[p] && loginState[p].at >= t0 - 1000)) break;
      }
    }
    const need = plats.filter((p) => loginState[p] && loginState[p].loggedIn === false);
    if (need.length) { openLoginModal(need); return; }
    await call("checkNow", { only: "" });
  } catch (e) { showErr(e); }
  finally { refreshing = false; btn.title = "지금 최신화"; btn.classList.toggle("busy", !!(checkStatus && checkStatus.running)); btn.disabled = !!(checkStatus && checkStatus.running) || tracked.length === 0; }
}
$("checkNow").addEventListener("click", startRefresh);
let clearArmed = null;
$("clear").addEventListener("click", async (e) => {
  e.stopPropagation(); // 메뉴가 닫히지 않게 합니다(한 번 더 눌러야 삭제)
  if (!clearArmed) { $("clear").textContent = "한 번 더 누르면 삭제됩니다"; clearArmed = setTimeout(() => { clearArmed = null; $("clear").textContent = "수집한 글 모두 삭제"; }, 4000); return; }
  clearTimeout(clearArmed); clearArmed = null; $("clear").textContent = "수집한 글 모두 삭제";
  items = [];
  await call("clearItems").catch(showErr);
  renderList();
  $("acctMenu").hidden = true; $("connAcct").setAttribute("aria-expanded", "false");
});



// 추적 계정 패널의 두 탭: '추적 계정'(추가·가져오기) / '추적 계정 관리'(계정 목록·묶음·계정별 기간)
(function () {
  const show = (manage) => {
    $("ptAdd").hidden = manage; $("ptManage").hidden = !manage;
  };
  show(true);
})();

// 수집창을 닫아 수집이 종료됐을 때 뜨는 안내 모달
(function () {
  const close = () => { $("closedModal").hidden = true; };
  $("cmX").addEventListener("click", close);
  $("cmClose").addEventListener("click", close);
  $("closedModal").addEventListener("click", (e) => { if (e.target === $("closedModal")) close(); });
  $("cmRetry").addEventListener("click", () => { close(); startRefresh(); });
})();

// 수집이 일시정지됐을 때의 모달: 이어서 수집(수집창을 앞으로) / 닫기(수집 종료)
(function () {
  $("pmResume").addEventListener("click", () => { pauseDismissed = true; $("pausedModal").hidden = true; call("resumeCheck").catch(showErr); });
  $("pmClose").addEventListener("click", () => { pauseDismissed = true; $("pausedModal").hidden = true; call("cancelCheck").catch(showErr); });
})();

/* 묶음 이름 입력: 이미 만들어 둔 묶음을 보여주고, 입력하면 연관 묶음으로 걸러서 고를 수 있게 합니다 */
(function () {
  function groupNames() {
    const m = new Map();
    tracked.forEach((t) => { if (t.group) m.set(t.group, (m.get(t.group) || 0) + 1); });
    return [...m.entries()].map(([name, n]) => ({ name, n }));
  }
  function attach(input) {
    if (!input) return;
    const wrap = input.parentElement;
    wrap.style.position = "relative";
    const box = document.createElement("div");
    box.className = "gsuggest";
    box.hidden = true;
    wrap.appendChild(box);
    let idx = -1;
    const items = () => Array.from(box.querySelectorAll("button"));
    const hide = () => { box.hidden = true; idx = -1; };
    const pick = (name) => { input.value = name; hide(); input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); };
    const show = () => {
      const q = input.value.trim().toLowerCase();
      const list = groupNames().filter((g) => !q || g.name.toLowerCase().includes(q))
        .sort((a, b) => (b.name.toLowerCase().startsWith(q) ? 1 : 0) - (a.name.toLowerCase().startsWith(q) ? 1 : 0) || a.name.localeCompare(b.name, "ko"));
      box.textContent = "";
      if (!list.length) { hide(); return; }
      list.slice(0, 8).forEach((g) => {
        const b = document.createElement("button");
        b.type = "button";
        const nm = document.createElement("span"); nm.textContent = g.name;
        const n = document.createElement("em"); n.textContent = g.n + "개 계정";
        b.append(nm, n);
        b.addEventListener("mousedown", (e) => { e.preventDefault(); pick(g.name); });
        box.appendChild(b);
      });
      idx = -1; box.hidden = false;
    };
    input.addEventListener("focus", show);
    input.addEventListener("input", show);
    input.addEventListener("blur", () => setTimeout(hide, 120));
    input.addEventListener("keydown", (e) => {
      const els = items();
      if (box.hidden || !els.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        idx = (idx + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length;
        els.forEach((b, i) => b.classList.toggle("on", i === idx));
      } else if (e.key === "Enter" && idx >= 0) { e.preventDefault(); pick(els[idx].firstChild.textContent); }
      else if (e.key === "Escape") hide();
    });
  }
  attach($("gName"));
  attach($("tgroup"));
})();
