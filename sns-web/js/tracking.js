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
// 추적 계정 관리 화면(고르기·묶기·기간·숨기기·제거)은 js/manage.js에 있습니다.
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
/* ---------- 계정 추가 ---------- */
// 추가하면 그 계정의 글을 바로 한 번 모읍니다(다른 수집이 진행 중이면 끝난 뒤 이어서).
function addAccount(acc) {
  if (tracked.some((t) => t.id === acc.id)) { toast("이미 추가된 계정입니다.", "error"); return Promise.resolve(false); }
  if (tracked.length >= MAX_TRACKED) { toast("계정은 최대 " + MAX_TRACKED + "개까지 추가할 수 있습니다.", "error"); return Promise.resolve(false); }
  if (!acc.days) acc.days = 30; // 이 계정만의 가져올 기간
  // 숨긴 묶음에 넣으면 이 계정도 숨김(안 그러면 묶음 전체가 다시 보이게 됨)
  const sameGroup = acc.group ? tracked.filter((t) => t.group === acc.group) : [];
  const intoHidden = sameGroup.length > 0 && sameGroup.every((t) => t.hidden);
  if (intoHidden) acc.hidden = true; else delete acc.hidden;
  const before = tracked;
  removedIds.delete(acc.id); // 방금 지웠던 계정을 다시 추가하는 경우
  tracked = [...tracked, acc];
  renderTracked(); renderTabs(); renderList();
  return saveTracked().then(() => {
    const who = PLATFORM[acc.platform] + " " + (acc.handle ? "@" + acc.handle : acc.channelId || "계정");
    if (intoHidden) {
      // 숨긴 묶음은 수집하지 않으므로 바로 모으지도 않습니다.
      toast(who + " 추가됨 · 숨긴 묶음 ‘" + acc.group + "’에 들어가 홈에 보이지 않고, 다시 보이게 할 때까지 글을 모으지 않습니다.");
    } else {
      toast(who + " 추가됨 · 글을 모으는 중입니다");
      call("checkNow", { only: acc.id }).catch(showErr);
    }
    fetchAvatars().catch(() => {});
    return true;
  }, (e) => { tracked = before; renderTracked(); renderTabs(); renderList(); showErr(e); return false; });
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
    const why = platform === "youtube" ? "" : searchLoggedOut(platform) ? " " + SEARCH_LOGIN_HELP(platform) : " " + PLATFORM[platform] + "이 이름 검색을 막았거나 결과가 없을 수 있습니다. @아이디나 프로필 주소로 검색하면 바로 추가할 수 있습니다.";
    box.appendChild(el("p", { class: "hint", text: "검색 결과가 없습니다." + why }));
  }
  list.forEach((r) => {
    let acc;
    if (r.acc) acc = { ...r.acc }; // 주소·@계정으로 바로 추가하는 항목
    else {
      acc = { id: platform + ":" + (r.handle || r.channelId).toLowerCase(), platform, handle: r.handle || "" };
      if (r.channelId) acc.channelId = r.channelId;
    }
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
      const pk = await pickPeriod(); if (!pk) return;
      const a = { ...acc, days: pk.days }; if (pk.group) a.group = pk.group;
      add.disabled = true;
      if (await addAccount(a)) { paint(); if (r.avatar) storePic(a.id, r.avatar).then((ok) => { if (ok) renderList(); }); } else paint();
    });
    const initial = (r.name || r.handle || acc.handle || "?").trim().charAt(0).toUpperCase();
    const ph = (why) => el("span", { class: "ph", text: initial, title: why || "" });
    let thumb = ph("사진 주소를 읽지 못했습니다");
    const swap = (img, kind, src) => img.addEventListener("error", () => img.replaceWith(ph("사진 불러오기 실패(" + kind + "): " + String(src).slice(0, 80))));
    if (r.avatar) { thumb = el("img", { src: r.avatar, alt: "", referrerpolicy: "no-referrer" }); swap(thumb, "서버가 전달한 데이터", r.avatar); }
    else if (r.avatarUrl) {
      if (window.claude) { thumb = el("img", { alt: "", referrerpolicy: "no-referrer" }); loadImg(r.avatarUrl, thumb); }
      else { thumb = el("img", { src: r.avatarUrl, alt: "", referrerpolicy: "no-referrer" }); swap(thumb, "주소로 직접", r.avatarUrl); }
    }
    box.appendChild(el("div", { class: "res" }, [thumb, el("div", { class: "t" }, [el("b", { text: (() => { const n = (r.name || "").replace(/\s+/g, " ").trim(), h = Math.floor(n.length / 2); return n.length > 1 && n.length % 2 === 1 && n[h] === " " && n.slice(0, h) === n.slice(h + 1) ? n.slice(0, h) : n || (acc.handle ? "@" + acc.handle : acc.channelId || acc.resolveUrl || ""); })() }), el("span", { text: [r.handle ? "@" + r.handle : "", r.desc && r.desc.replace(/^@/, "").toLowerCase() !== String(r.handle || "").toLowerCase() ? r.desc : ""].filter(Boolean).join(" · ") })]), add]));
  });
}
// 지금 최신화: 서버에 수집을 요청합니다. 서버 테스트 계정이 로그인되어 있지 않은 매체(X·인스타)는 서버가 건너뛰고 알려 줍니다.
// 수집 중에 누르면 '멈추기'(한 번 더 눌러야 멈춤).
let stopArmed = 0;
async function startRefresh() {
  if (refreshing || !connected) return;
  if (checkStatus && checkStatus.running) {
    if (!stopArmed) { toast("한 번 더 누르면 수집을 멈춥니다."); stopArmed = setTimeout(() => { stopArmed = 0; }, 4000); return; }
    clearTimeout(stopArmed); stopArmed = 0;
    try { await call("cancelCheck"); toast("수집을 멈추는 중입니다. 지금 보고 있는 페이지까지만 모읍니다."); } catch (e) { showErr(e); }
    return;
  }
  if (!tracked.length) { toast("먼저 위쪽 검색창에서 추적할 계정을 찾아 추가하세요.", "error"); return; }
  refreshing = true; paintCheckNow();
  try {
    const shown = tracked.filter((t) => !t.hidden);   // 숨긴 묶음은 수집하지 않음
    if (!shown.length) { toast("모든 묶음을 숨겨 둬서 모을 계정이 없습니다. 추적 계정 관리에서 다시 보이게 할 수 있습니다.", "error"); return; }
    const plats = Array.from(new Set(shown.filter((t) => settings[t.platform] !== false).map((t) => t.platform)));
    if (!plats.length) { toast("모든 매체의 수집이 꺼져 있습니다. 위쪽 매체 아이콘을 눌러 켜세요.", "error"); return; }
    const out = plats.filter(loggedOut);
    if (out.length) toast(out.map((p) => PLATFORM[p]).join("·") + "는 서버 테스트 계정이 로그인되어 있지 않아 건너뜁니다(관리자 확인 필요).", "error");
    await call("checkNow", { only: "" });
    checkStatus = { ...checkStatus, running: true, message: "수집 대기 중…" }; // 서버 상태를 다시 읽기 전에도 바로 '수집 중'으로 보이게
    renderWork();
  } catch (e) { showErr(e); }
  finally { refreshing = false; paintCheckNow(); }
}
$("checkNow").addEventListener("click", startRefresh);
let clearArmed = null;
$("clear").addEventListener("click", async (e) => {
  e.stopPropagation(); // 메뉴가 닫히지 않게 합니다(한 번 더 눌러야 삭제)
  if (!clearArmed) { $("clear").textContent = "한 번 더 누르면 삭제됩니다"; clearArmed = setTimeout(() => { clearArmed = null; $("clear").textContent = "수집한 글 모두 삭제"; }, 4000); return; }
  clearTimeout(clearArmed); clearArmed = null; $("clear").textContent = "수집한 글 모두 삭제";
  try {
    await call("clearItems");
    items = []; serverItems = [];
    await pullSeen(); // 서버가 본 글 기록도 비웠음: 이 기기의 읽음 표시도 지웁니다(다른 기기는 다음에 맞출 때)
    renderTabs(); renderList(); renderWork();
    toast("모은 글과 읽음 표시를 모두 지웠습니다. 다음 수집부터 다시 모입니다.");
  } catch (err) { showErr(err); }
  $("acctMenu").hidden = true; $("connAcct").setAttribute("aria-expanded", "false");
});



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
})();
