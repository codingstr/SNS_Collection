/* 데스크톱: 카드 줄 위에서 휠을 돌리면 그 줄이 좌우로, 스크롤바 칸 위에서 돌리면 화면이 세로로 움직입니다(글 영역 자체의 세로 휠 스크롤은 막음) */
const wheelAnim = new WeakMap();
// 스크롤바 휠 이동을 부드럽게(목표 위치로 조금씩 따라가기)
const vAnim = { el: null, target: 0, raf: 0 };
function vScroll(el, d) {
  if (vAnim.el !== el || !vAnim.raf) { vAnim.el = el; vAnim.target = el.scrollTop; }
  vAnim.target = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, vAnim.target + d));
  if (vAnim.raf) return;
  const step = () => {
    const diff = vAnim.target - el.scrollTop;
    if (Math.abs(diff) < 0.5) { el.scrollTop = vAnim.target; vAnim.raf = 0; return; }
    el.scrollTop += Math.sign(diff) * Math.max(1, Math.abs(diff) * 0.09);
    vAnim.raf = requestAnimationFrame(step);
  };
  vAnim.raf = requestAnimationFrame(step);
}
// 휠 한 칸이 막대를 같은 거리만큼 움직이도록, 내용이 길수록 한 번에 더 많이 이동(스크롤바 위·글 영역 위 어디서든 같은 속도)
function barWheel(el, dy) {
  const vb = document.getElementById("vbar"), room = vb.clientHeight - 12 - Math.min(120, vb.clientHeight - 12), max = el.scrollHeight - el.clientHeight;
  const SLOW = 0.5; // 전체 스크롤 속도 배율(작을수록 느림)
  const raw = (room > 0 ? dy * max / room : dy) * SLOW, cap = el.clientHeight * 0.6 * SLOW; // 내용이 아주 길어도 휠 한 칸에 한 화면의 60%까지만(한 번에 수백 장이 새로 그려지며 렉 걸리는 것 방지)
  vScroll(el, Math.max(-cap, Math.min(cap, raw)));
}
document.addEventListener("wheel", (ev) => {
  if (ev.ctrlKey || window.innerWidth < 861 || !ev.target.closest) return;
  const dy = ev.deltaMode === 1 ? ev.deltaY * 40 : ev.deltaY;
  // 스크롤바 칸 위에서는 휠이 글 영역(또는 설정·추적 화면)을 세로로 움직입니다
  if (ev.target.closest("#vbar")) {
    const el = ["setPanel", "trackPanel", "adminPanel", "grid", "empty"].map((i) => document.getElementById(i)).find((e) => e && !e.hidden && e.offsetParent !== null);
    if (el) {
      ev.preventDefault();
      // 휠 한 칸이 막대를 같은 거리만큼 움직이도록, 내용이 길수록 한 번에 더 많이 이동
      barWheel(el, dy);
    }
    return;
  }
  // 글 영역에서는 세로 휠 스크롤을 막고, 카드 줄 위에서는 그 줄을 좌우로 움직입니다
  if (!ev.target.closest("#grid")) return;
  if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
    // 트랙패드 가로 스크롤: 카드 줄을 손가락 움직임 그대로(1:1) 따라가게 직접 움직이고, 멈추면 가장 가까운 카드 자리로 살짝 맞춥니다.
    // 줄이 그 방향으로 더 갈 수 없거나 줄이 아닌 곳이면 막아서 브라우저의 '뒤로/앞으로 가기' 스와이프가 발동하지 않게 합니다.
    ev.preventDefault();
    const r = ev.target.closest(".row-cards, .storybar");
    if (!r) return;
    const dx = ev.deltaMode === 1 ? ev.deltaX * 40 : ev.deltaX, mx = r.scrollWidth - r.clientWidth;
    if (mx <= 0 || (dx < 0 && r.scrollLeft <= 0) || (dx > 0 && r.scrollLeft >= mx - 1)) return;
    const st = wheelAnim.get(r) || { target: 0, raf: 0 };
    wheelAnim.set(r, st);
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; } // 세로 휠의 카드 한 장 이동 애니메이션이 돌고 있으면 끊고 손가락을 따라갑니다
    r.classList.add("wheeling"); // 스크롤 스냅이 중간에 끼어들어 튀지 않게
    r.scrollLeft = Math.max(0, Math.min(mx, r.scrollLeft + dx));
    clearTimeout(st.settle);
    st.settle = setTimeout(() => { st.target = snapPos(r, r.scrollLeft); wheelRun(r, st); }, 160);
    return;
  }
  ev.preventDefault();
  let row = ev.target.closest(".row-cards, .storybar");
  // 그룹 줄이 옆으로 넘길 만큼 길지 않으면, 그 위에서 돌린 휠은 글 영역을 세로로 움직입니다.
  if (row && row.classList.contains("storybar") && row.scrollWidth <= row.clientWidth + 1) row = null;
  if (!row) { // 카드 줄이 아닌 곳(세로로 쌓인 카드 목록 등): 스크롤바에 마우스를 올리지 않아도 휠로 글 영역이 세로로 움직입니다
    const g = document.getElementById("grid");
    if (g && g.scrollHeight > g.clientHeight) barWheel(g, dy); // 스크롤바 위에서 돌릴 때와 같은 속도
    return;
  }
  const max = row.scrollWidth - row.clientWidth;
  if (max <= 0) return;
  let st = wheelAnim.get(row);
  const cur = st && st.raf ? st.target : row.scrollLeft;
  if ((cur <= 0 && dy < 0) || (cur >= max - 1 && dy > 0)) return;
  if (!st) { st = { target: row.scrollLeft, raf: 0 }; wheelAnim.set(row, st); }
  if (!st.raf) st.target = row.scrollLeft;
  // 휠 한 번 = 카드 한 장(폭+간격)씩, 부드럽게 이동
  const kids = Array.from(row.children).filter((c) => c.offsetWidth);
  const unit = kids.length > 1 ? kids[1].offsetLeft - kids[0].offsetLeft : kids[0] ? kids[0].offsetWidth + 4 : 240; // 실제 카드 간격(줄마다 gap이 달라도 어긋나지 않게)
  const step = row.classList.contains("storybar") ? 3 : 1; // 그룹 줄은 휠 한 칸에 세 개씩
  const now = Date.now();
  if (st.last && now - st.last < 60) { return; } // 트랙패드 연속 이벤트는 한 번으로 묶기
  st.last = now;
  const base = st.raf ? st.target : snapPos(row, row.scrollLeft);
  st.target = Math.max(0, Math.min(max, snapPos(row, base + (dy > 0 ? unit : -unit) * step)));
  wheelRun(row, st);
}, { passive: false });

// 가장 가까운 카드의 왼쪽 끝 위치(첫 카드가 놓인 자리를 0으로 본 스크롤 값)
function snapPos(row, t) {
  const kids = Array.from(row.children).filter((c) => c.offsetWidth);
  if (!kids.length) return t;
  const base = kids[0].offsetLeft;
  let best = 0, d = Infinity;
  kids.forEach((c) => { const p = c.offsetLeft - base; const dd = Math.abs(p - t); if (dd < d) { d = dd; best = p; } });
  return best;
}
function wheelRun(row, st) {
  row.classList.add("wheeling");
  if (st.raf) return;
  const step = () => {
    const diff = st.target - row.scrollLeft;
    if (Math.abs(diff) < 1) { row.scrollLeft = st.target; st.raf = 0; row.classList.remove("wheeling"); return; }
    row.scrollLeft += Math.sign(diff) * Math.max(1, Math.abs(diff) * 0.08);
    st.raf = requestAnimationFrame(step);
  };
  st.raf = requestAnimationFrame(step);
}

/* 이어보기: 마지막으로 확인한 글 바로 다음의 안 본 글(없으면 첫 안 본 글)로 이동합니다. */
function pickResume(cards, dir) {
  // 글은 최신순(앞 = 더 최근)입니다. 본 글 기록을 기준으로 두 방향 중 하나를 고릅니다.
  const idx = [];
  cards.forEach((c, i) => { if (seen.has(c._item.id)) idx.push(i); });
  if (dir === "new") {
    // 최신글 이어보기: 가장 최근에 본 글 바로 앞의 안 본(더 새로운) 글
    if (!idx.length) return cards[cards.length - 1] || null;
    return idx[0] > 0 ? cards[idx[0] - 1] : null;
  }
  // 이전글 이어보기: 안 본 글 중 가장 최신 글
  return cards.find((c) => !seen.has(c._item.id)) || null;
}
function flash(c) { c.classList.add("flash"); setTimeout(() => c.classList.remove("flash"), 1800); }
const RESUME_LABEL = { new: "‹", old: "›" };
const RESUME_NONE = { new: "더 새로운 글 없음", old: "안 본 글 없음" };
const RESUME_TITLE = { new: "최신글 이어보기: 가장 최근에 확인한 글보다 더 새로운 안 본 글로 이동", old: "이전글 이어보기: 안 본 글 중 가장 최신 글로 이동" };
let noticeTimer = 0;
function showNotice(text) {
  let n = $("notice");
  if (!n) { n = el("div", { id: "notice", role: "status" }); document.body.appendChild(n); }
  n.textContent = text; n.classList.add("show");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => n.classList.remove("show"), 1600);
}
// ‹ 이어보기 › : 왼쪽은 더 새로운 글, 오른쪽은 이전 글로 이어서 봅니다.
function resumeGroup(cls, run) {
  return el("span", { class: "resumegrp" }, [resumeBtn("new", { class: cls, "aria-label": "최신글 이어보기" }, run), el("span", { class: "rl", text: "이어보기" }), resumeBtn("old", { class: cls, "aria-label": "이전글 이어보기" }, run)]);
}
function resumeBtn(dir, extra, run) {
  const b = el("button", Object.assign({ type: "button", text: RESUME_LABEL[dir], title: RESUME_TITLE[dir] }, extra));
  b.addEventListener("click", () => { if (!run(dir)) showNotice(RESUME_NONE[dir]); });
  return b;
}
// 찾은 글로 이동하고, 그 글을 바로 엽니다(이전/다음 이동도 같은 줄 기준으로 됩니다).
function openResume(target) {
  flash(target);
  setViewCtx(target, target._item);
  openItem(target._item);
}
const SHOW_RESUME = false; // 이어보기 버튼은 일단 숨김(true로 바꾸면 다시 나타납니다)
function addResumeButtons() {
  if (!SHOW_RESUME) { const f0 = $("resumeFab"); if (f0) f0.remove(); return; }
  document.querySelectorAll("#grid .sec").forEach((sec) => {
    const head = sec.querySelector(".sec-head"), row = sec.querySelector(".row-cards");
    if (!head || !row || head.querySelector(".resume") || head.querySelector(".namelink")) return; // 사람별 제목 줄에는 이어보기를 두지 않습니다
    const run = (dir) => {
      const target = pickResume(Array.from(row.children).filter((n) => n._item), dir);
      if (!target) return false;
      row.scrollTo({ left: Math.max(0, target.offsetLeft - row.offsetLeft - 8), behavior: "smooth" });
      openResume(target);
      return true;
    };
    head.appendChild(resumeGroup("resume", run));
  });
  // 세로 격자 화면(출처 탭, 한 사람 전체 보기 등)은 오른쪽 아래 떠 있는 버튼으로 이동합니다.
  const grid = document.querySelector("#grid.cards, #grid .cards");
  let fab = $("resumeFab");
  if (grid && Array.from(grid.children).some((n) => n._item)) {
    if (!fab) {
      fab = el("div", { id: "resumeFab" });
      const run = (dir) => {
        const g2 = document.querySelector("#grid.cards, #grid .cards");
        const target = g2 && pickResume(Array.from(g2.children).filter((n) => n._item), dir);
        if (!target) return false;
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        openResume(target);
        return true;
      };
      fab.appendChild(resumeGroup("primary", run));
      document.body.appendChild(fab);
    }
  } else if (fab) fab.remove();
}
// 이어보기 버튼을 쓸 때만 글 영역 변화를 지켜봅니다(숨겨 둔 동안에는 카드가 바뀔 때마다 헛일을 하지 않게).
if (SHOW_RESUME) new MutationObserver(() => addResumeButtons()).observe($("grid"), { childList: true, subtree: true });
else addResumeButtons();

renderAll();

/* ---------- 화이트/다크 모드 전환 (기본은 화이트) ---------- */
(function () {
  const root = document.documentElement, btn = $("themeBtn");
  const apply = (dark) => {
    if (dark) root.setAttribute("data-theme", "dark"); else root.removeAttribute("data-theme");
    btn.textContent = dark ? "☀ 화이트 모드로 전환" : "☾ 다크 모드로 전환";
  };
  apply(root.getAttribute("data-theme") === "dark");
  btn.addEventListener("click", () => {
    const dark = root.getAttribute("data-theme") !== "dark";
    apply(dark);
    try { localStorage.setItem("snsTheme", dark ? "dark" : "light"); } catch (e) {}
  });
})();

/* ---------- 통합 검색창 왼쪽: 검색할 매체 설정 버튼 ---------- */
(function () {
  const ALL = ["youtube", "x", "instagram"], btn = $("sScope"), menu = $("sMenu"), icons = $("sScopeIcons");
  // "전체" 아이콘: 왼쪽 위 로고(겹친 세 원)와 같은 그림
  const allIcon = () => { const w = document.createElement("span"); w.className = "allico"; w.innerHTML = '<svg viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="28" fill="#2a2928"/><circle cx="21" cy="23" r="9" fill="#fff" fill-opacity=".95"/><circle cx="35" cy="23" r="9" fill="#fff" fill-opacity=".6"/><circle cx="28" cy="35" r="9" fill="#fff" fill-opacity=".35"/></svg>'; return w; };
  const save = () => { try { localStorage.setItem("snsSearchPlats", JSON.stringify(searchPlats)); } catch (e) {} };
  const render = () => {
    icons.textContent = "";
    if (searchPlats.length === ALL.length) icons.appendChild(el("span", { class: "si" }, [allIcon()]));
    else ALL.filter((p) => searchPlats.includes(p)).forEach((p) => icons.appendChild(el("span", { class: "si" }, [pIcon(p)])));
    btn.title = "검색할 매체: " + (searchPlats.length === ALL.length ? "전체" : searchPlats.map((p) => PLATFORM[p]).join(", "));
    menu.textContent = "";
    // 전체 / 유튜브 / X / 인스타그램 중 하나만 고릅니다(전체 = 세 매체 모두).
    const isAll = searchPlats.length === ALL.length;
    const opts = [["all", "전체"], ...ALL.map((p) => [p, PLATFORM[p]])];
    opts.forEach(([k, label]) => {
      const on = k === "all" ? isAll : !isAll && searchPlats[0] === k;
      const glyph = k === "all" ? el("span", { class: "si lg" }, [allIcon()]) : el("span", { class: "si lg" }, [pIcon(k)]);
      const b = el("button", { type: "button", class: "sopt" + (on ? " on" : ""), role: "menuitemradio", "aria-checked": String(on), "aria-label": label, title: label }, [glyph]);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        searchPlats = k === "all" ? ALL.slice() : [k];
        save(); render(); renderList(); setOpen(false);
      });
      menu.appendChild(b);
    });
  };
  function setOpen(o) { menu.hidden = !o; btn.setAttribute("aria-expanded", String(o)); }
  btn.addEventListener("click", (e) => { e.stopPropagation(); setOpen(menu.hidden); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".sbox")) setOpen(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
  render();
})();

/* ---------- 통합 검색: 입력 + Enter(또는 돋보기)로 선택한 매체 전부에서 계정 검색 ---------- */
(function () {
  const q = $("q"), go = $("sGo"), box = $("sResults");
  // 지금 진행 중인 검색: { seq: 검색 순번, sid: 서버에 보내는 검색 번호, ctl: 요청을 끊는 AbortController }
  // 검색창을 닫거나 새로 검색하면 이 검색을 취소합니다(브라우저 요청을 끊고 서버에도 cancelSearch를 보냄).
  let cur = null, searchSeq = 0;
  const newSid = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(""); };
  const cancelCur = (leaving) => {
    if (!cur) return;
    const c = cur; cur = null;
    c.ctl.abort();
    call("cancelSearch", { sid: c.sid }, 0, leaving ? { keepalive: true } : undefined).catch(() => {});
  };
  // 좁은 화면(칸이 위아래로 쌓일 때)에서는 결과 상자 안이 아니라 바깥 오른쪽에 둥근 스크롤 막대를 둡니다(보이는 건 CSS가 결정).
  const rail = document.createElement("div"), thumb = document.createElement("i");
  rail.className = "sr-rail"; rail.hidden = true; rail.appendChild(thumb); box.parentNode.appendChild(rail);
  const PAD = 6, THUMB = 120; // 메인 스크롤바와 같은 손잡이 길이(고정)
  const railSync = () => {
    const over = !box.hidden && box.scrollHeight > box.clientHeight + 1;
    rail.hidden = !over;
    if (!over) return;
    rail.style.top = box.offsetTop + "px"; rail.style.height = box.offsetHeight + "px";
    const h = rail.clientHeight, th = Math.min(THUMB, h - PAD * 2);
    const room = Math.max(1, h - PAD * 2 - th), max = Math.max(1, box.scrollHeight - box.clientHeight);
    thumb.style.height = th + "px"; thumb.style.top = Math.round(PAD + room * (box.scrollTop / max)) + "px";
  };
  box.addEventListener("scroll", railSync, { passive: true });
  // 막대 위에서 마우스 휠을 굴려도 결과가 스크롤되게(줄 단위·화면 단위 휠도 픽셀로 환산)
  rail.addEventListener("wheel", (e) => { const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.clientHeight : 1; box.scrollTop += e.deltaY * k; e.preventDefault(); }, { passive: false });
  window.addEventListener("resize", railSync);
  if (window.ResizeObserver) new ResizeObserver(railSync).observe(box);
  new MutationObserver(railSync).observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  thumb.addEventListener("pointerdown", (ev) => {
    ev.preventDefault(); thumb.setPointerCapture(ev.pointerId);
    const y0 = ev.clientY, top0 = box.scrollTop;
    const h = rail.clientHeight, th = thumb.offsetHeight, room = Math.max(1, h - PAD * 2 - th), max = Math.max(1, box.scrollHeight - box.clientHeight);
    const mv = (e) => { box.scrollTop = top0 + (e.clientY - y0) * (max / room); };
    const up = () => { thumb.removeEventListener("pointermove", mv); thumb.removeEventListener("pointerup", up); thumb.removeEventListener("pointercancel", up); };
    thumb.addEventListener("pointermove", mv); thumb.addEventListener("pointerup", up); thumb.addEventListener("pointercancel", up);
  });
  rail.addEventListener("pointerdown", (ev) => { // 막대의 빈 곳을 누르면 그 위치로 이동
    if (ev.target !== rail) return;
    const r = rail.getBoundingClientRect(), frac = (ev.clientY - r.top - PAD) / Math.max(1, r.height - PAD * 2);
    box.scrollTop = frac * (box.scrollHeight - box.clientHeight);
  });
  const close = () => { cancelCur(); box.hidden = true; };
  // 페이지를 떠나면 서버의 검색도 멈춥니다. 뒤로 가기로 이 화면이 그대로 돌아오면(브라우저가 보관해 둔 화면)
  // '찾는 중…'으로 멈춰 있는 매체를 '중단됨'으로 바꿔, 계속 기다리는 것처럼 보이지 않게 합니다.
  let leftMidSearch = false;
  window.addEventListener("pagehide", () => { if (cur) { leftMidSearch = true; cancelCur(true); } });
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted || !leftMidSearch) return;
    leftMidSearch = false;
    box.querySelectorAll(".sr-wait").forEach((n) => {
      n.classList.remove("sr-wait"); n.textContent = "";
      n.appendChild(el("p", { class: "hint", text: "페이지를 떠나 있는 동안 검색이 중단되었습니다. 다시 찾으려면 Enter를 누르세요." }));
    });
  });
  go.hidden = false; // (예전에는 1초마다 다시 켰지만 숨기는 곳이 없어 한 번이면 됩니다)
  const section = (p) => {
    const sec = el("div", { class: "sr-sec" });
    sec.appendChild(el("div", { class: "sr-plat" }, [el("span", { class: "si" }, [pIcon(p)]), el("span", { text: PLATFORM[p] })]));
    const body = el("div", { class: "sr-body" });
    sec.appendChild(body); box.appendChild(sec);
    return body;
  };
  const run = async () => {
    const name = q.value.trim();
    if (!name) return;
    cancelCur(); // 진행 중인 검색이 있으면 취소하고 새로 시작합니다
    const my = { seq: ++searchSeq, sid: newSid(), ctl: new AbortController() };
    const live = () => cur === my; // 이 검색이 아직 화면에 보이는 검색인지(아니면 늦게 온 결과는 버림)
    box.hidden = false; box.textContent = "";
    if (!connected) { box.appendChild(el("p", { class: "hint", text: "로그인해야 계정을 찾을 수 있습니다." })); return; }
    const head = el("div", { class: "sr-head" }, [el("b", { text: "“" + name + "” 계정 찾기" })]);
    const x = el("button", { type: "button", class: "x", text: "×", "aria-label": "닫기" });
    x.addEventListener("click", close); head.appendChild(x);
    box.appendChild(head);
    // 프로필 주소: 검색하지 않고 그 매체에 바로 추가합니다.
    if (/^https?:\/\//i.test(name) || SITE_START.test(name)) {
      const r = parseAccount("youtube", name);
      if (r.error) { box.appendChild(el("p", { class: "hint", text: r.error })); return; }
      fillResults(section(r.account.platform), r.account.platform, [{ acc: r.account, desc: "프로필 주소로 바로 추가" }]);
      return;
    }
    cur = my;
    // 매체(인스타·X·유튜브)마다 요청을 한꺼번에 보냅니다. 서버는 매체별 크롬에서 동시에 찾고, 끝난 매체부터 결과가 옵니다.
    // 칸은 처음에 정해진 순서로 모두 만들어 두므로, 결과가 오는 순서와 관계없이 자리가 바뀌지 않습니다.
    const one = async (p) => {
      const body = section(p);
      // @아이디: 검색 결과와 함께 '바로 추가' 항목을 맨 위에 둡니다(검색이 막힌 매체도 추가할 수 있게).
      const direct = name.startsWith("@") ? parseAccount(p, name) : null;
      if (direct && direct.account) fillResults(body, p, [{ acc: direct.account, desc: "검색 없이 바로 추가" }]);
      const res = el("div", { class: "sr-wait" });
      res.appendChild(el("p", { class: "hint", text: "서버에서 " + PLATFORM[p] + " 계정을 찾는 중… (10~30초)" }));
      body.appendChild(res);
      try {
        let list = await call("searchAccount", { platform: p, q: name, sid: my.sid }, LONG_WAIT, { signal: my.ctl.signal });
        if (!live()) return; // 그사이 닫았거나 새로 검색함: 이 결과는 쓰지 않습니다
        if (direct && direct.account) list = list.filter((r) => p + ":" + (r.handle || r.channelId).toLowerCase() !== direct.account.id);
        res.classList.remove("sr-wait"); res.textContent = "";
        if (direct && direct.account && !list.length) return;
        fillResults(res, p, list);
      } catch (e) {
        if (!live()) return;
        res.classList.remove("sr-wait"); res.textContent = "";
        res.appendChild(el("p", { class: "hint", text: "검색하지 못했습니다: " + ((e && e.message) || "오류") }));
      }
    };
    try {
      await Promise.all(["instagram", "x", "youtube"].filter((p) => searchPlats.includes(p)).map(one));
    } finally { if (cur === my) cur = null; }
  };
  go.addEventListener("click", run);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
  // 바깥 클릭: 검색 중에는 닫지 않습니다(잘못 눌러 30초 넘게 걸린 검색이 취소되지 않게). 닫기(×)·Esc는 검색 중에도 닫고 취소합니다.
  document.addEventListener("click", (e) => { if (!cur && !e.composedPath().some((n) => n.classList && (n.classList.contains("sbox") || n.classList.contains("modal-back")))) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !box.hidden && !document.querySelector(".modal-back:not([hidden])")) close(); });
})();

/* ---------- 상단 홈 / 추적 계정 관리 버튼 ---------- */
$("navHome").addEventListener("click", () => { page = "home"; applyPage(); renderList(); window.scrollTo(0, 0); });
$("themeSwitch").addEventListener("click", () => { $("themeBtn").click(); const d = document.documentElement.getAttribute("data-theme") === "dark"; $("themeSwitch").setAttribute("aria-checked", String(d)); });
{ const d = document.documentElement.getAttribute("data-theme") === "dark"; $("themeSwitch").setAttribute("aria-checked", String(d)); }
$("brand").addEventListener("click", () => $("navHome").click());
$("navFav").addEventListener("click", () => { page = "fav"; activeTab = "people"; personFocus = ""; personPlat = ""; applyPage(); renderList(); window.scrollTo(0, 0); });
$("navManage").addEventListener("click", () => { page = "manage"; applyPage(); window.scrollTo(0, 0); });
$("navAdmin").addEventListener("click", () => { page = "admin"; applyPage(); window.scrollTo(0, 0); });

/* ---------- 벤토 디자인: 계정 메뉴 항목을 '설정' 화면(별도 탭)으로 ---------- */
(function () {
  const root = document.documentElement;
  const ids = ["menuWho", "themeBtn", "menuSettings", "clear", "connOut"];
  const place = () => {
    const bento = root.getAttribute("data-design") === "bento";
    const dest = $(bento ? "setBody" : "acctMenu");
    ids.forEach((i) => dest.appendChild($(i)));
    if (!bento) { $("setPanel").hidden = true; $("setBack").hidden = true; }
    $("acctMenu").hidden = true;
  };
  // 벤토에서는 프로필 버튼이 설정 화면으로 이동시킵니다(클래식은 기존 드롭다운 그대로).
  $("connAcct").addEventListener("click", (e) => {
    if (root.getAttribute("data-design") !== "bento") return;
    e.stopImmediatePropagation(); e.preventDefault();
    setModal(!$("setPanel").hidden ? false : true);
  }, true);
  function setModal(open) {
    $("setPanel").hidden = !open; $("setBack").hidden = !open;
    document.body.classList.toggle("setOpen", open); $("connAcct").classList.toggle("on", open);
  }
  $("setBack").addEventListener("click", () => setModal(false));
  $("setClose").addEventListener("click", () => setModal(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("setPanel").hidden) setModal(false); });
  ["navHome", "navFav", "navManage", "navAdmin"].forEach((i) => $(i).addEventListener("click", () => setModal(false)));
  place();
})();

// 글 영역(또는 설정·추적 화면)과 오른쪽 열 사이 빈틈에 세로 스크롤바를 그립니다.
(() => {
  const bar = document.getElementById("vbar");
  if (!bar) return;
  document.body.appendChild(bar); // 다른 화면(설정·추적)에서 부모가 숨겨져도 보이도록 body 바로 아래로 옮깁니다
  const thumb = bar.firstElementChild;
  let drag = null;
  const THUMB = 120;
  const PAD = 6; // 손잡이가 바탕 박스 끝 밖으로 튀어나오지 않게 안쪽 여백
  const target = () => ["setPanel", "trackPanel", "adminPanel", "grid", "empty"].map((i) => document.getElementById(i)).find((e) => e && !e.hidden && e.offsetParent !== null);
  function update() {
    const el = target();
    if (!el || window.innerWidth < 861) { bar.hidden = true; return; }
    bar.classList.toggle("idle", el.scrollHeight <= el.clientHeight + 1); // 스크롤할 내용이 없어도 바탕은 어느 화면에서나 보입니다
    const r = el.getBoundingClientRect();
    const side = document.getElementById("workCard") || document.getElementById("tabs");
    const sr = side && side.getBoundingClientRect();
    const hasGap = sr && sr.width > 0 && sr.left > r.right; // 오른쪽 열이 없는 화면(설정·추적)은 박스 안쪽 오른쪽 끝에 둡니다
    const gap = hasGap ? sr.left - r.right : 0;
    // 읽기를 먼저 모두 하고 쓰기는 뒤에 몰아서: 스크롤 때마다 강제 레이아웃(수백 장 카드 전체 다시 계산)이 생기지 않게 합니다.
    const bh = Math.max(40, r.height);
    const th = Math.min(THUMB, bh - 2 * PAD); // 내용 길이와 상관없이 고정 길이
    const room = bh - 2 * PAD - th;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const st = el.scrollTop;
    bar.hidden = false;
    bar.classList.toggle("inpanel", !hasGap);
    bar.style.left = hasGap ? r.right + (gap - 36) / 2 + "px" : r.right - 36 - 8 + "px";
    bar.style.top = r.top + "px";
    bar.style.height = bh + "px";
    thumb.style.height = th + "px";
    thumb.style.transform = `translateY(${max > 0 ? PAD + room * st / max : PAD}px)`;
  }
  const scrollTo = (y) => { const el = target(); if (!el) return; const th = thumb.offsetHeight, room = bar.clientHeight - 2 * PAD - th, max = el.scrollHeight - el.clientHeight; el.scrollTop = room > 0 ? Math.max(0, Math.min(1, (y - PAD) / room)) * max : 0; };
  thumb.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); thumb.setPointerCapture(e.pointerId); drag = e.clientY - thumb.getBoundingClientRect().top; bar.classList.add("drag"); });
  thumb.addEventListener("pointermove", (e) => { if (drag !== null) scrollTo(e.clientY - bar.getBoundingClientRect().top - drag); });
  const end = () => { drag = null; bar.classList.remove("drag"); };
  thumb.addEventListener("pointerup", end); thumb.addEventListener("pointercancel", end);
  bar.addEventListener("pointerdown", (e) => { if (e.target === bar) scrollTo(e.clientY - bar.getBoundingClientRect().top - thumb.offsetHeight / 2); });
  let upRaf = 0;
  const updateSoon = () => { if (!upRaf) upRaf = requestAnimationFrame(() => { upRaf = 0; update(); }); }; // 한 프레임에 한 번만
  ["grid", "setPanel", "trackPanel", "adminPanel"].forEach((i) => { const e = document.getElementById(i); if (e) e.addEventListener("scroll", updateSoon, { passive: true }); });
  window.addEventListener("resize", updateSoon);
  new MutationObserver(updateSoon).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "class"] });
  setInterval(update, 800);
  update();
})();

// 카드 줄: 왼쪽으로 넘겨진 상태면 왼쪽 끝에도 약한 흐림(.sl)
(function () {
  const mark = (el) => { if (el && el.classList && el.classList.contains("row-cards")) el.classList.toggle("sl", el.scrollLeft > 2); };
  document.addEventListener("scroll", (e) => mark(e.target), true);
})();

/* 마우스를 올렸을 때 브라우저가 띄우는 흰색 설명 상자(title 툴팁)를 없앱니다. 스크린리더용으로 aria-label이 없으면 title 내용을 거기로 옮깁니다. */
(() => {
  const strip = (n) => {
    if (!n || n.nodeType !== 1) return;
    const fix = (e) => { const t = e.getAttribute("title"); if (t === null) return; if (t && !e.hasAttribute("aria-label") && !e.textContent.trim()) e.setAttribute("aria-label", t); e.removeAttribute("title"); };
    fix(n);
    n.querySelectorAll && n.querySelectorAll("[title]").forEach(fix);
  };
  strip(document.body);
  new MutationObserver((ms) => ms.forEach((m) => {
    if (m.type === "attributes") strip(m.target);
    else m.addedNodes.forEach(strip);
  })).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
})();

// 오른쪽 열 맨 아래의 "현재 작업" 카드 바로 위에, 상단 버튼 줄(.toolbar)이 붙어 보이도록 위치를 맞춥니다(넓은 화면에서만).
(() => {
  const tb = document.querySelector("header .toolbar"), wc = document.getElementById("workCard"), lay = document.querySelector(".layout");
  if (!tb || !wc || !lay) return;
  let raf = 0;
  // 버튼 줄의 위치 기준(위치를 정하는 부모)의 화면 좌표
  const originOf = () => {
    if (getComputedStyle(tb).position === "fixed") return { top: 0, left: 0 };
    const op = tb.offsetParent;
    if (op && op !== document.body && op !== document.documentElement) { const r = op.getBoundingClientRect(); return { top: r.top, left: r.left }; }
    return { top: -window.scrollY, left: -window.scrollX };
  };
  const place = () => {
    raf = 0;
    // 추적 계정 관리 화면(넓은 화면): 오른쪽 열이 없으므로 버튼 줄을 숨깁니다(bento.css의 .toolbar.inpanel).
    const tp = window.innerWidth >= 861 ? document.querySelector("#trackPanel:not([hidden]), #adminPanel:not([hidden])") : null;
    const inPanel = !!(tp && tp.offsetParent !== null);
    tb.classList.toggle("inpanel", inPanel);
    if (inPanel) { tb.style.removeProperty("top"); tb.style.removeProperty("left"); tb.style.removeProperty("right"); return; }
    tb.style.removeProperty("left"); tb.style.removeProperty("right");
    const on = window.innerWidth >= 861 && !wc.hidden && wc.offsetParent !== null;
    if (!on) { tb.style.removeProperty("top"); return; }
    tb.style.setProperty("top", Math.round(wc.getBoundingClientRect().top - originOf().top - tb.offsetHeight) + "px", "important");
  };
  // 다음 화면 그리기 때 한 번만 맞춥니다. 탭이 뒤에 가려져 있으면 그리기가 멈추므로, 잠시 뒤에도 안 했으면 직접 맞춥니다
  // (안 그러면 기다리는 표시가 남아 이후의 화면 변화를 모두 놓칩니다).
  const q = () => {
    if (raf) return;
    raf = requestAnimationFrame(place);
    setTimeout(() => { if (raf) { cancelAnimationFrame(raf); place(); } }, 200);
  };
  window.addEventListener("resize", q);
  if (window.ResizeObserver) { const ro = new ResizeObserver(q); ro.observe(wc); ro.observe(lay); ro.observe(tb); ["trackPanel", "adminPanel"].forEach((i) => { const tp = document.getElementById(i); if (tp) ro.observe(tp); }); }
  new MutationObserver(q).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["hidden"] });
  q();
})();


// 처음 안내: 화면을 어둡게 하고 말풍선으로 하나씩 짚어 줍니다. 로그인 후 첫 화면에서 한 번 자동으로 열리고, 왼쪽 ? 버튼으로 다시 봅니다.
(() => {
  const root = document.getElementById("tour"), btn = document.getElementById("navHelp");
  if (!root || !btn) return;
  const hole = root.querySelector(".tour-hole"), tip = root.querySelector(".tour-tip");
  const $q = (s) => root.querySelector(s);
  const STEPS = [
    { t: "SNS 모아보기에 오신 걸 환영해요", d: "인스타그램·X·유튜브의 새 글을 한곳에 모아 봅니다. 화면을 하나씩 짚어 드릴게요." },
    { sel: [".sbox"], t: "통합 검색창", d: "글 제목·내용·작성자·매체·그룹 이름으로 모아 둔 글을 바로 검색합니다. 왼쪽 동그라미는 '계정 찾기'에서 검색할 매체(인스타·X·유튜브)를 고르는 버튼이에요." },
    { sel: ["#sGo"], t: "계정 찾기", d: "검색창에 이름·@아이디·프로필 주소를 적고 누르면(Enter도 가능) 선택한 매체에서 계정을 찾아 추적 목록에 추가할 수 있어요." },
    { sel: ["#empty:not([hidden])", "#grid:not([hidden])"], t: "글이 모이는 곳", d: "추적 중인 계정의 새 글이 여기에 모입니다. 카드를 누르면 바로 열어 볼 수 있어요." },
    { sel: ["#storyBar"], t: "그룹 고르기", d: "같은 사람의 인스타·X·유튜브 계정을 한 그룹으로 만들어 두면 한 사람으로 모아 봅니다. 동그라미를 눌러 보고 싶은 그룹을 여러 개 고를 수 있고, 아무것도 안 고르면 모두 보여요. 빨간 점은 안 읽은 글이 있다는 뜻이에요. 빠르게 두 번 누르면 안 읽은 글을 오래된 것부터 차례로 열고, 우클릭(휴대폰은 길게 누르기)하면 그 그룹의 글을 모두 읽음으로 표시해요(바로 되돌릴 수 있어요)." },
    { sel: ["#sidePeople:not([hidden])"], t: "계정 목록", d: "매체 탭에서는 그 매체의 계정이 여기에 나와요. 하나를 고르면 그 계정 글만 볼 수 있어요." },
    { sel: ["#tabs"], t: "매체별 보기", d: "인스타·X·유튜브 버튼으로 매체별 글만 모아 볼 수 있습니다. 숫자는 글 개수예요." },
    { sel: ["#workCard", "header .toolbar"], t: "수집 켜기·최신화", d: "매체 아이콘을 누르면 그 매체 수집을 켜고 끕니다(회색이면 서버 테스트 계정 로그인이 필요해 관리자에게 알려 주세요). 동그란 버튼은 '지금 최신화'이고, 수집 중에 두 번 누르면 멈춥니다." },
    { sel: ["#brand"], t: "로고", d: "어느 화면에서든 로고를 누르면 처음 홈 화면(전체 글)으로 돌아옵니다." },
    { sel: ["#navHome"], t: "홈", d: "추적 중인 모든 계정의 글을 한꺼번에 보는 기본 화면이에요." },
    { sel: ["#navFav"], t: "즐겨찾기", d: "☆를 눌러 둔 사람의 글만 모아서 봅니다." },
    { sel: ["#navManage"], t: "추적 계정 관리", d: "그룹별 카드에서 계정을 골라 가져올 기간·그룹을 정하거나, 숨기거나 제거하는 화면이에요. 그룹 이름을 누르면 그 그룹의 계정이 한꺼번에 골라져요. 숨긴 그룹은 홈에 안 나오고 글도 모으지 않아요. 계정 추가는 위쪽 검색창에서 해요." },
    { sel: ["#navHelp"], t: "사용 설명", d: "지금 보는 이 안내예요. 언제든 눌러서 다시 볼 수 있어요." },
    { sel: ["#themeSwitch"], pad: 6, t: "화이트/다크 모드", d: "눌러서 밝은 화면과 어두운 화면을 바꿀 수 있어요." },
    { sel: ["#connAcct"], t: "계정 메뉴", d: "프로필 이미지 설정, 계정 관리, 수집한 글 모두 삭제, 로그아웃이 들어 있어요." },
  ];
  const KEY = "snsHelpSeen";
  let list = [], idx = 0;
  const vis = (e) => { if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(e).visibility !== "hidden" ? r : null; };
  const rectOf = (st) => {
    if (!st.sel) return null;
    const rs = st.sel.map((s) => vis(document.querySelector(s))).filter(Boolean);
    if (!rs.length) return undefined; // 보이는 대상이 없음 → 이 단계는 건너뜀
    const l = Math.min(...rs.map((r) => r.left)), t = Math.min(...rs.map((r) => r.top)), r2 = Math.max(...rs.map((r) => r.right)), b = Math.max(...rs.map((r) => r.bottom));
    return { left: l, top: t, right: r2, bottom: b, width: r2 - l, height: b - t };
  };
  const radiusPx = (st, r) => { const e = st.sel.map((s) => document.querySelector(s)).find((x) => vis(x)); if (!e) return 0; const v = getComputedStyle(e).borderTopLeftRadius; return v.endsWith("%") ? Math.min(r.width, r.height) * parseFloat(v) / 100 : parseFloat(v) || 0; };
  function show() {
    const st = list[idx], r = rectOf(st), PAD = st.pad || 0, M = 12; // 밝은 부분은 대상에 딱 맞게(여백 없음)
    const vw = window.innerWidth, vh = window.innerHeight;
    $q(".tour-step").textContent = idx + 1 + " / " + list.length;
    $q(".tour-title").textContent = st.t; $q(".tour-text").textContent = st.d;
    $q("#tourPrev").disabled = idx === 0;
    $q("#tourNext").textContent = idx === list.length - 1 ? "완료" : "다음";
    $q("#tourSkip").hidden = idx === list.length - 1;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    if (!r) {
      hole.classList.add("none"); hole.style.clipPath = "none"; tip.dataset.side = "";
      tip.style.left = Math.max(M, (vw - tw) / 2) + "px"; tip.style.top = Math.max(M, (vh - th) / 2) + "px"; return;
    }
    hole.classList.remove("none");
    // 어둡게 깔린 화면에서 대상 부분만 뚫어 줍니다(여백 없이 요소 모양 그대로)
    const rad = radiusPx(st, r) + PAD, x0 = r.left - PAD, y0 = r.top - PAD, w0 = r.width + 2 * PAD, h0 = r.height + 2 * PAD;
    const k = Math.min(rad, w0 / 2, h0 / 2), x1 = x0 + w0, y1 = y0 + h0;
    hole.style.clipPath = `path(evenodd, "M0 0H${vw}V${vh}H0Z M${x0 + k} ${y0}H${x1 - k}A${k} ${k} 0 0 1 ${x1} ${y0 + k}V${y1 - k}A${k} ${k} 0 0 1 ${x1 - k} ${y1}H${x0 + k}A${k} ${k} 0 0 1 ${x0} ${y1 - k}V${y0 + k}A${k} ${k} 0 0 1 ${x0 + k} ${y0}Z")`;
    // 말풍선 위치: 오른쪽 → 왼쪽 → 아래 → 위 순서로 들어가는 곳에 놓습니다
    const gap = 16, cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const opts = [
      ["right", r.right + PAD + gap, cy - th / 2, vw - (r.right + PAD + gap) >= tw + M],
      ["left", r.left - PAD - gap - tw, cy - th / 2, r.left - PAD - gap - tw >= M],
      ["bottom", cx - tw / 2, r.bottom + PAD + gap, vh - (r.bottom + PAD + gap) >= th + M],
      ["top", cx - tw / 2, r.top - PAD - gap - th, r.top - PAD - gap - th >= M],
    ];
    let pick = opts.find((o) => o[3]);
    if (!pick) pick = ["bottom", cx - tw / 2, vh - th - M, true]; // 어디에도 안 들어가면 화면 아래쪽에 겹쳐 둡니다
    const x = Math.min(vw - tw - M, Math.max(M, pick[1])), y = Math.min(vh - th - M, Math.max(M, pick[2]));
    tip.dataset.side = pick[0];
    tip.style.left = x + "px"; tip.style.top = y + "px";
    tip.style.setProperty("--ax", Math.min(tw - 20, Math.max(20, cx - x)) + "px");
    tip.style.setProperty("--ay", Math.min(th - 20, Math.max(20, cy - y)) + "px");
  }
  const step = (d) => {
    let n = idx + d;
    while (n >= 0 && n < list.length && rectOf(list[n]) === undefined) n += d;
    if (n < 0) return;
    if (n >= list.length) return close();
    idx = n; show();
  };
  function open() {
    list = STEPS.filter((s) => rectOf(s) !== undefined);
    idx = 0; root.hidden = false; show(); $q("#tourNext").focus();
  }
  function close() { root.hidden = true; try { localStorage.setItem(KEY, "1"); } catch (e) {} }
  btn.addEventListener("click", open);
  $q("#tourNext").addEventListener("click", () => step(1));
  $q("#tourPrev").addEventListener("click", () => step(-1));
  $q("#tourSkip").addEventListener("click", close);
  root.addEventListener("click", (e) => { if (e.target === root || e.target === hole) { /* 바깥 클릭은 무시(실수로 닫히지 않게) */ } });
  document.addEventListener("keydown", (e) => {
    if (root.hidden) return;
    if (e.key === "Escape") close(); else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); step(1); } else if (e.key === "ArrowLeft") step(-1);
  });
  window.addEventListener("resize", () => { if (!root.hidden) show(); });
  let seen = false;
  try { seen = localStorage.getItem(KEY) === "1"; } catch (e) {}
  // 로그인(또는 서버 없이 연결)이 끝난 첫 화면에서 한 번만 자동으로 엽니다. 로그인 화면 위에는 띄우지 않습니다.
  const au = document.getElementById("acctUser");
  const maybe = () => { if (!seen && au && !au.hidden) { seen = true; setTimeout(open, 700); } };
  if (au) { new MutationObserver(maybe).observe(au, { attributes: true, attributeFilter: ["hidden"] }); setTimeout(maybe, 600); }
})();

/* ---------- 단축키 '/': 어느 화면에서든 위쪽 검색창에 커서를 둡니다 ----------
   - 글자를 입력하는 중(입력칸·글 상자·편집 가능한 곳에 커서가 있음)이면 '/'는 그대로 입력됩니다.
   - 글 보기 창이 열려 있으면 닫고 검색창으로 갑니다. 관리 탭·추적 계정 관리 등 다른 화면에서도 위쪽 검색창은 늘 있으므로 그대로 옮깁니다.
   - 대화 상자(설정·그룹 수정·제거 확인 등)나 안내 투어가 떠 있을 때, 로그인 전(검색창을 쓸 수 없음)에는 아무것도 하지 않습니다. */
(() => {
  const typing = (n) => !!n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName || ""));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return;
    if (typing(e.target) || typing(document.activeElement)) return;
    const q = $("q"), au = $("acctUser");
    if (!q || !au || au.hidden) return;   // 로그인 전
    if (document.querySelector(".modal-back:not([hidden])") || !$("setPanel").hidden || !$("tour").hidden) return;
    e.preventDefault();   // 검색창에 '/'가 들어가지 않게
    if (!$("viewer").hidden) closeViewer();
    q.focus();
    q.select();   // 이미 적어 둔 검색어가 있으면 골라 두어 바로 새로 칠 수 있게
  });
})();
