/* ---------- 위쪽 그룹 줄 (인스타그램 스토리 모양) ----------
   글 영역 맨 위에 가로로 놓인 동그란 프로필 사진 + 아래 이름. 글을 내려도 위에 붙어 있습니다.
   - 누르면 그 그룹을 고르거나 풉니다(여러 개 가능). 고른 그룹은 사진 테두리가 색으로 바뀌고, 고른 그룹의 글만 보입니다.
   - 아무것도 고르지 않으면(맨 앞 '전체'가 색 테두리) 모든 그룹을 보여 줍니다.
   - 안 읽은 글이 있는 그룹은 이름 오른쪽 위에 빨간 점이 붙고, 줄의 앞쪽으로 옵니다.
   - 사진을 우클릭(휴대폰은 길게 누르기)하면 한 번 확인한 뒤 그 그룹의 글을 모두 읽음으로 표시합니다.
   - 매체 탭(유튜브·X·인스타그램)에서는 그 매체의 글이 있는 그룹만 보여 줍니다(이미 고른 그룹은 풀 수 있게 남겨 둠).
   숨긴 그룹(추적 계정 관리 → '홈에 보일 그룹')은 이 줄에 나오지 않습니다. 사람(그룹) 계산은 list.js의 peopleMap. */
let storySig = "", storyScroll = 0;

// 그룹마다: 안 읽은 글 ID, 가장 최근 글 시각, 이름 옆 사진에 쓸 계정
function storyData() {
  const vp = visiblePeople();
  if (!vp.length) return null;
  const byVia = new Map();
  for (const it of items) {
    if (!it.via || !inPeriod(it)) continue;
    const t = publishedMs(it);
    viasOf(it).forEach((v) => {   // 공동 게시물은 이어진 계정마다
      let e = byVia.get(v);
      if (!e) byVia.set(v, (e = { unread: [], latest: 0, plats: new Set() }));
      e.plats.add(tabOf(it.source));
      if (t > e.latest) e.latest = t;
      if (!seen.has(it.id)) e.unread.push(it.id);
    });
  }
  const sel = effSel();
  // 매체 탭에서는 그 매체 글이 하나도 없는 그룹을 뺍니다. 고른 그룹은 남겨 둡니다(안 보이면 풀 수가 없어 빈 화면의 이유를 알 수 없음).
  const plat = activeTab !== "people" && activeTab !== "all" ? activeTab : "";
  const hasPlat = (p) => [...p.ids].some((id) => { const e = byVia.get(id); return e && e.plats.has(plat); });
  const list = (plat ? vp.filter((p) => sel.has(p.name) || hasPlat(p)) : vp).map((p) => {
    const unread = [];
    let latest = 0;
    p.ids.forEach((id) => { const e = byVia.get(id); if (e) { e.unread.forEach((x) => { if (!unread.includes(x)) unread.push(x); }); if (e.latest > latest) latest = e.latest; } });   // 그룹 안 두 계정의 공동 게시물은 한 번만
    const accs = personAccounts(p);
    const chosen = accs.find((t) => t.platform === picPick[p.name]) || accs.find((t) => picMap[t.id]) || accs[0];
    return { p, unread, latest, chosen, on: sel.has(p.name) };
  });
  // 안 읽은 글이 있는 그룹을 앞으로, 그 안에서는 최근 글 순(인스타그램 스토리처럼)
  list.sort((a, b) => (b.unread.length > 0) - (a.unread.length > 0) || b.latest - a.latest);
  return { list, sel };
}
const storySigOf = (d) => JSON.stringify([d.sel.size, d.list.map((s) => [s.p.name, s.on, s.unread.length > 0, s.chosen ? s.chosen.id : "", s.chosen && picMap[s.chosen.id] ? picMap[s.chosen.id].length : 0])]);

function storyItem({ face, label, on, dot, badge, aria, name }) {
  const ring = el("span", { class: "sring" }, [el("span", { class: "sinner" }, [face])]);
  if (badge) ring.appendChild(el("span", { class: "sbadge", "aria-hidden": "true" }, [pIcon(badge)]));
  const nm = el("span", { class: "sname" }, [el("span", { class: "st", text: label })]);
  if (dot) nm.appendChild(el("i", { class: "sdot", "aria-hidden": "true" }));
  const b = el("button", { type: "button", class: "story" + (on ? " on" : "") + (dot ? " new" : ""), "aria-pressed": String(on), "aria-label": aria }, [ring, nm]);
  if (name) b.dataset.name = name;
  return b;
}
function allFace() {
  const s = el("span", { class: "sface sall", "aria-hidden": "true" });
  s.innerHTML = '<svg viewBox="0 0 56 56"><circle cx="21" cy="23" r="9" fill="currentColor" fill-opacity=".95"/><circle cx="35" cy="23" r="9" fill="currentColor" fill-opacity=".6"/><circle cx="28" cy="35" r="9" fill="currentColor" fill-opacity=".35"/></svg>';
  return s;
}

// 휴대폰: 길게 누르면 우클릭과 같게(아이폰 사파리는 우클릭 이벤트를 보내지 않음)
function onLongPress(b, fn) {
  let timer = 0, x0 = 0, y0 = 0;
  const stop = () => { clearTimeout(timer); timer = 0; };
  b.addEventListener("pointerdown", (e) => {
    b._longPressed = false;
    if (e.pointerType !== "touch") return;
    x0 = e.clientX; y0 = e.clientY; stop();
    timer = setTimeout(() => { timer = 0; b._longPressed = true; fn(); }, 550);
  });
  b.addEventListener("pointermove", (e) => { if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) stop(); });
  ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => b.addEventListener(ev, stop));
}

// 고른 그룹이 바뀐 뒤: 글 목록을 다시 그리고, 키보드로 고르던 중이면 같은 그룹에 포커스를 돌려줍니다.
function afterStorySelect(name) {
  const hadFocus = !!(document.activeElement && document.activeElement.closest && document.activeElement.closest("#storyBar"));
  personFocus = ""; personPlat = ""; backCtx = null;
  renderList();
  const g = $("grid");
  if (g) g.scrollTop = 0;
  if (hadFocus) {
    const bar = $("storyBar");
    const b = bar && Array.from(bar.children).find((x) => (name ? x.dataset.name === name : !x.dataset.name));
    if (b) b.focus({ preventScroll: true });
  }
}
function toggleStory(name) {
  if (storySel.has(name)) storySel.delete(name); else storySel.add(name);
  afterStorySelect(name);
}
// 한 번 누르기 = 고르기/풀기, 빠르게 두 번 누르기 = 안 읽은 글 이어 보기.
// 두 번 누르기와 구별하려고 한 번 누르기는 잠깐(STORY_TAP_MS) 기다렸다가 적용합니다. 휴대폰 두 번 탭도 같은 방식이라 기기마다 다르지 않습니다.
const STORY_TAP_MS = 260;
let storyTap = null; // { name, timer }
function storyClick(p) {
  if (storyTap && storyTap.name === p.name) {
    clearTimeout(storyTap.timer); storyTap = null;
    playUnread(p);
    return;
  }
  if (storyTap) { clearTimeout(storyTap.timer); const prev = storyTap.name; storyTap = null; toggleStory(prev); } // 다른 그룹을 이어서 누름: 앞의 것 먼저 적용
  const name = p.name;
  storyTap = { name, timer: setTimeout(() => { storyTap = null; toggleStory(name); }, STORY_TAP_MS) };
}
// 그룹의 안 읽은 글을 오래된 것부터 차례로 엽니다(인스타그램 스토리처럼). 글 보기 창의 이전/다음으로 넘깁니다.
function playUnread(p) {
  const label = personLabel(p);
  const list = items.filter((it) => viasOf(it).some((v) => p.ids.has(v)) && inPeriod(it) && !seen.has(it.id)).sort((a, b) => publishedMs(a) - publishedMs(b));
  if (!list.length) { toast("‘" + label + "’에는 읽지 않은 글이 없습니다."); return; }
  viewCtx = list; viewIdx = 0;
  toast("‘" + label + "’의 안 읽은 글 " + list.length + "개를 오래된 것부터 엽니다. ‹ › 또는 ← →로 넘기세요.");
  openItem(list[0]);
}

function storyBar(d) {
  d = d || storyData();
  if (!d) { storySig = ""; return null; }
  const bar = el("div", { id: "storyBar", class: "storybar", role: "toolbar", "aria-label": "볼 그룹 고르기(여러 개 가능). 사진을 우클릭하면 모두 읽음" });
  const allOn = !d.sel.size;
  const all = storyItem({ face: allFace(), label: "전체", on: allOn, aria: allOn ? "전체(모든 그룹을 보는 중)" : "전체: 고른 그룹을 모두 풀기" });
  all.addEventListener("click", () => { if (!storySel.size) return; storySel = new Set(); afterStorySelect(""); });
  bar.appendChild(all);
  d.list.forEach((s) => {
    const label = personLabel(s.p);
    const single = s.p.accs.length === 1 && !s.p.accs[0].group;   // 그룹화하지 않은 계정 하나: 어느 매체인지 작은 아이콘으로
    const n = s.unread.length;
    const b = storyItem({
      face: picFace(s.chosen, label.replace(/^@/, ""), "sface"), label, on: s.on, dot: n > 0,
      badge: single ? s.p.accs[0].platform : "", name: s.p.name,
      aria: label + (single ? " (" + PLATFORM[s.p.accs[0].platform] + ")" : "") + (n ? ", 안 읽은 글 " + n + "개" : "") + (s.on ? ", 고름" : ""),
    });
    b.addEventListener("click", () => { if (b._longPressed) { b._longPressed = false; return; } storyClick(s.p); });
    b.addEventListener("contextmenu", (e) => { e.preventDefault(); askReadAll(s.p); });
    onLongPress(b, () => askReadAll(s.p));
    bar.appendChild(b);
  });
  enableDrag(bar);   // 마우스로 잡아 끌기(끈 경우에는 고르기로 치지 않음)
  bar.addEventListener("scroll", () => { storyScroll = bar.scrollLeft; }, { passive: true });
  // 접힌 섬에 보일 글: 고른 그룹 이름(없으면 '전체 그룹'), 보고 있는 그룹에 안 읽은 글이 있으면 빨간 점
  const onL = d.list.filter((s) => s.on);
  const names = onL.map((s) => personLabel(s.p));
  bar._island = { names, dot: (onL.length ? onL : d.list).some((s) => s.unread.length) };
  storySig = storySigOf(d);
  return bar;
}

/* ---------- 섬(다이나믹 아일랜드 모양) ----------
   글을 아래로 내리면 위쪽 그룹 줄을 가운데 위의 작은 알약 모양으로 접고, 마우스를 올리면(휴대폰은 누르면) 원래 줄로 펼칩니다.
   맨 위에서는 늘 펼쳐 둡니다. 그룹 줄은 감싼 상자(.storywrap)가 위에 붙어 있고, 접을 때는 그룹 줄을 알약 모양으로 잘라 보이게(clip-path)만 해서
   레이아웃 높이가 그대로입니다(접고 펼칠 때 글 목록이 움직이지 않음). 잘린 바깥은 마우스가 닿지 않아 아래 글을 그대로 누를 수 있습니다. */
let islandTop = 0;
// 글이 얼마나 내려갔는지(px). 데스크톱은 글 영역이, 휴대폰은 페이지 전체가 스크롤됩니다
function gridScrollPos() {
  const g = $("grid");
  return g ? Math.max(g.scrollTop, -g.getBoundingClientRect().top) : 0;
}
// 접기/펴기는 스크롤 방향을 봅니다(위로 올리는 도중에 접혔다 펴졌다 깜빡이지 않게).
// - 내리는 중: 4px만 내려가도 접음
// - 올리는 중: 그룹 줄 자리(줄 높이)가 보이기 시작하면 바로 펼침. 맨 위로 빠르게 올리면 도착하기 전에 이미 펼쳐져 있음
// - 펼친 뒤 계속 올리는 동안은 다시 접지 않음
function setIsland(w) {
  w = w || document.querySelector("#grid > .storywrap");
  if (!w) return;
  const y = gridScrollPos(), last = w._y;
  w._y = y;
  const was = w.classList.contains("island");
  let on;
  if (y <= 4) on = false;
  else if (last === undefined) on = y >= w.offsetHeight;      // 처음 그릴 때(다시 그려도 보던 위치가 깊으면 접힌 채로)
  else if (y > last) on = was || y > 4;                         // 내리는 중
  else if (y < last) on = was && y >= w.offsetHeight;           // 올리는 중
  else on = was;
  if (on === was) return;
  w.classList.toggle("island", on);
  if (!on) w.classList.remove("open");
}
// 섬 글: 고른 그룹을 " · "로 잇되, 섬이 화면 폭에 비례한 길이(PC는 글 영역의 절반, 휴대폰은 72%)를 넘으면
// 넘는 만큼을 "외 n개"로 줄입니다(예: "뉴진스 · 아이브 외 5개"). 휴대폰은 하나만 고른 게 아니면 "첫 그룹 외 n개"
const wideIsland = window.matchMedia ? window.matchMedia("(min-width: 861px)") : { matches: true };
let islandCtx = null;
function islandText(names, w, it) {
  if (!names.length) return "전체 그룹";
  if (names.length === 1) return names[0];
  if (!wideIsland.matches) return names[0] + " 외 " + (names.length - 1) + "개";
  const avail = Math.max(160, Math.round(w.clientWidth * 0.5)) - 48;   // 알약 좌우 여백·빨간 점 자리
  islandCtx = islandCtx || document.createElement("canvas").getContext("2d");
  const cs = getComputedStyle(it);
  islandCtx.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
  for (let k = names.length; k > 1; k--) {
    const t = names.slice(0, k).join(" · ") + (k < names.length ? " 외 " + (names.length - k) + "개" : "");
    if (islandCtx.measureText(t).width <= avail) return t;
  }
  return names[0] + " 외 " + (names.length - 1) + "개";
}
function paintIsland(bar) {
  const w = bar && bar.parentElement;
  if (!w || !w.classList.contains("storywrap") || !bar._island) return;
  if (!w.isConnected) { requestAnimationFrame(() => { if (bar.parentElement === w && w.isConnected) paintIsland(bar); }); return; }   // 글꼴·폭을 재려면 화면에 붙은 뒤에
  const isl = w.querySelector(".island"), it = isl.querySelector(".it");
  isl.style.maxWidth = wideIsland.matches ? Math.max(200, Math.round(w.clientWidth * 0.5)) + "px" : "";
  it.textContent = islandText(bar._island.names, w, it);
  isl.classList.toggle("new", bar._island.dot);
}
if (wideIsland.addEventListener) wideIsland.addEventListener("change", () => paintIsland($("storyBar")));
// 접혀 있는지(마우스가 올라가 있거나 눌러서 펼친 상태가 아님)
const canHover = window.matchMedia ? window.matchMedia("(hover: hover)") : { matches: true };
function islandFolded(w) { return !!w && w.classList.contains("island") && !w.classList.contains("open") && !(canHover.matches && w.matches(":hover")) && !w.querySelector(":focus-visible"); }
function wrapStory(bar) {
  const isl = el("div", { class: "island", "aria-hidden": "true" }, [el("i", { class: "idot" }), el("span", { class: "it" })]);
  const w = el("div", { class: "storywrap" }, [bar, isl]);
  // 섬 글 길이에 맞춰 알약 폭(--iw)을 맞춥니다(그룹 줄을 같은 폭으로 잘라 보이게)
  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (isl.offsetWidth) w.style.setProperty("--iw", isl.offsetWidth + "px"); }).observe(isl);
    let lastW = 0;   // 글 영역 폭이 바뀌면(창 크기) 섬 글 길이를 다시 맞춤
    new ResizeObserver(() => { if (w.clientWidth && w.clientWidth !== lastW) { lastW = w.clientWidth; paintIsland(bar.parentElement === w ? bar : w.querySelector("#storyBar")); } }).observe(w);
  }
  paintIsland(bar);
  setIsland(w);
  // 휴대폰·펜: 접힌 섬을 처음 누르면 펼치기만 합니다(그 아래 보이지 않던 그룹이 눌리지 않게)
  let swallow = false;
  w.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || !w.classList.contains("island") || w.classList.contains("open")) return;
    w.classList.add("open"); islandTop = window.scrollY + ($("grid") ? $("grid").scrollTop : 0); swallow = true;
    e.preventDefault(); e.stopPropagation();
  }, true);
  w.addEventListener("click", (e) => { if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation(); } }, true);
  return w;
}
// 스크롤할 때 접기/펴기. 눌러서 펼쳐 둔 섬은 조금 더 스크롤하면 다시 접습니다.
document.addEventListener("scroll", (e) => {
  const t = e.target;
  if (t !== document && !(t && t.id === "grid")) return;
  const w = document.querySelector("#grid > .storywrap");
  if (!w) return;
  setIsland(w);
  if (w.classList.contains("open") && Math.abs(window.scrollY + $("grid").scrollTop - islandTop) > 40) w.classList.remove("open");
}, true);
document.addEventListener("pointerdown", (e) => {
  const w = document.querySelector("#grid > .storywrap.open");
  if (w && !w.contains(e.target)) w.classList.remove("open");
}, true);

// 글 목록은 그대로 두고 그룹 줄만 새로 그립니다(본 글·새 글이 바뀌었을 때). 바뀐 게 없으면 아무것도 하지 않습니다.
function renderStories() {
  refreshSideUnread();
  const cur = document.getElementById("storyBar");
  if (!cur || !cur.isConnected) return;
  const d = storyData();
  if (!d) { cur.remove(); storySig = ""; return; }
  if (storySigOf(d) === storySig) return;
  storyScroll = cur.scrollLeft;
  const hadFocus = cur.contains(document.activeElement) ? document.activeElement.dataset.name || "" : null;
  const nb = storyBar(d);
  cur.replaceWith(nb);
  nb.scrollLeft = storyScroll;
  paintIsland(nb);
  if (hadFocus !== null) {
    const b = Array.from(nb.children).find((x) => (hadFocus ? x.dataset.name === hadFocus : !x.dataset.name));
    if (b) b.focus({ preventScroll: true });
  }
}

// 오른쪽 그룹 목록의 '안 읽은 글' 빨간 점만 다시 맞춥니다(글 목록을 새로 그리지 않고).
function refreshSideUnread() {
  document.querySelectorAll("#sidePeople .pbar button").forEach((b) => {
    if (!b._ids) return;
    const unread = b._ids.some((id) => !seen.has(id));
    b.classList.toggle("new", unread);
    b.setAttribute("aria-label", b._label + " " + b._n + "건" + (unread ? ", 안 읽은 글 있음" : "") + (b._jump ? " · 눌러서 그 줄로 이동" : ""));
  });
}

// 확인 창(취소/확인). 확인을 누르면 true.
function confirmBox({ title, text, ok, cls }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const done = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); if (prev && prev.focus && prev.isConnected) prev.focus({ preventScroll: true }); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } };
    const x = el("button", { type: "button", class: "x", text: "×", "aria-label": "닫기" });
    const no = el("button", { type: "button", text: "취소" });
    const yes = el("button", { type: "button", class: "primary", text: ok });
    x.addEventListener("click", () => done(false)); no.addEventListener("click", () => done(false)); yes.addEventListener("click", () => done(true));
    const box = el("div", { class: "modal" }, [x, el("h2", { text: title }), el("p", { class: "hint", text }), el("div", { class: "foot" }, [no, yes])]);
    const back = el("div", { class: "modal-back " + (cls || ""), role: "dialog", "aria-modal": "true", "aria-label": title }, [box]);
    back.addEventListener("click", (e) => { if (e.target === back) done(false); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(back);
    yes.focus();
  });
}

// 그룹의 안 읽은 글을 모두 읽음으로(한 번 확인)
async function askReadAll(p) {
  if (document.querySelector(".modal-back.readall")) return;   // 길게 누르기와 우클릭이 함께 와도 한 번만
  const label = personLabel(p);
  const ids = items.filter((it) => viasOf(it).some((v) => p.ids.has(v)) && inPeriod(it) && !seen.has(it.id)).map((it) => it.id);
  if (!ids.length) { toast("‘" + label + "’에는 읽지 않은 글이 없습니다."); return; }
  const ok = await confirmBox({ title: "모두 읽음으로 표시할까요?", text: "‘" + label + "’의 읽지 않은 글 " + ids.length + "개를 읽은 글로 표시합니다. 바로 뒤에 뜨는 알림에서 잠시 동안 되돌릴 수 있습니다.", ok: "모두 읽음", cls: "readall" });
  if (!ok) return;
  const done = markSeenMany(ids);
  if (!done.length) return;
  toast("‘" + label + "’의 글 " + done.length + "개를 읽음으로 표시했습니다.", "", {
    label: "되돌리기",
    fn: () => { unmarkSeen(done); toast("‘" + label + "’의 읽음 표시를 되돌렸습니다."); },
  });
}
