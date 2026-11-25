/* ---------- 커뮤니티 : 모든 사용자가 같이 보는 게시판 ----------
   서버 /api/community(server/community.py)에 저장합니다(app.db의 cm_ 표). 이 브라우저에는 아무것도 남기지 않습니다.
   - 목록 화면: '전체 커뮤니티'·'스크랩' 카드 + 홈에 보이는 그룹마다 카드 하나(글 수·마지막 글·마지막으로 본 뒤 새 글 수)
   - 글 화면: 분류 단추 · 글 검색 · 글쓰기 · 글 목록. 글을 누르면 펼쳐져 본문·사진·링크·태그·댓글이 보입니다.
     전체 커뮤니티 위쪽에는 '태그된 계정' 칸(내 그룹별 / 추적하지 않는 계정은 바로 추가)이 있습니다.
   - 글의 태그는 SNS 계정 ID(예: x:handle)라서, 같은 계정을 추적하는 다른 사용자의 그룹 커뮤니티에도 같은 글이 보입니다.
   - 링크가 이미 모은 글이면 썸네일 카드로 보여 주고, 누르면 홈과 같은 자세히보기로 엽니다.
   - 주소(#c/…)에 보던 화면과 펼친 글이 남아 새로고침·뒤로 가기에도 그대로입니다. 글 주소는 #c/글번호.
   - 위쪽 '커뮤니티' 버튼: 안 읽은 댓글 알림 수(숫자) 또는 새 글(점). 알림은 커뮤니티 머리줄의 '알림' 버튼에서 봅니다.
   - '공지'는 관리자만 쓰고 맨 위에 붙습니다. 좋아요가 일정 수(서버의 HOT_MIN) 이상이면 '인기글'입니다.
   홈의 사람별 그룹 머리줄에 있는 말풍선 버튼(cmBtn)을 누르면 그 그룹의 커뮤니티로 바로 갑니다. */
const CM_CATS = ["일반", "질문", "소식"];
const CM_NOTICE = "공지", CM_HOT = "인기글";
const CM_REASONS = ["스팸·광고", "욕설·비방", "부적절한 내용", "기타"];
const CM_IMG_MAX = 4, CM_IMG_SIDE = 1280, CM_IMG_BYTES = 650000, CM_LINK_MAX = 5, CM_TAG_MAX = 20;
const CM_BUBBLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-7.5L7 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const CM_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="currentColor"/></svg>';

// 보기 상태. cmView: {t:"list"} 커뮤니티 목록 / {t:"all"} 전체 / {t:"grp", key, name, ids} 그룹 / {t:"post", id} 글 하나
// 전체·그룹 보기에 sc: true가 붙으면 그 커뮤니티 글 중 내가 스크랩한 글만 봅니다(머리줄의 스크랩 버튼).
let cmView = { t: "list" }, cmCat = "", cmQ = "", cmPosts = [], cmHot = [], cmMore = false, cmCounts = {};
let cmOpenId = 0, cmCmts = {}, cmReply = null, cmDraft = {}, cmMe = "", cmAdmin = false, cmHotMin = 3, cmSum = null, cmGen = 0;
let cmTagF = null, cmTags = null, cmTagOpen = false, cmSeenBefore = Infinity, cmEditCmt = 0, cmFocusCmt = 0, cmMissing = "";
let cmBadge = { notif: 0, newPosts: false, reports: 0 };
// 전체 커뮤니티의 '내 추적 계정 글만'(이 브라우저에 기억)
let cmMine = false;
try { cmMine = localStorage.getItem("snsCmMine") === "1"; } catch (e) {}

async function cmCall(action, body, ms) {
  const used = sess;
  const r = await apiPost("/api/community", Object.assign({ session: used, action }, body || {}), ms);
  if (r.status === 401) throw sessionLost(used);
  let j;
  try { j = await r.json(); } catch (e) { const er = new Error("서버에 연결할 수 없습니다."); er.offline = true; throw er; }
  if (!j.ok) throw new Error(j.error || "요청에 실패했습니다.");
  return j.result;
}
function cmAgo(ms) {
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (m < 1) return "방금";
  if (m < 60) return m + "분 전";
  if (m < 1440) return Math.floor(m / 60) + "시간 전";
  if (m < 1440 * 30) return Math.floor(m / 1440) + "일 전";
  return new Date(ms).toLocaleDateString("ko-KR");
}
const cmDate = (ms) => new Date(ms).toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const cmPostUrl = (id) => location.origin + location.pathname + location.search + "#c/" + id;
const cmSrcPlat = (src) => (/^youtube/.test(src || "") ? "youtube" : src === "x" ? "x" : src === "instagram" ? "instagram" : "");

/* ---------- 그룹 ↔ 커뮤니티 ---------- */
// 커뮤니티 목록에 보일 그룹: 홈에 보이는 그룹(숨긴 그룹 제외). 그룹의 모든 계정(따로 숨긴 계정 포함)에 태그된 글을 모읍니다.
function cmGroups() {
  return visiblePeople().map((p) => {
    const accs = personAccounts(p, true);
    return { key: p.name, name: dispName(p), p, accs, ids: accs.map((t) => t.id) };
  }).filter((g) => g.ids.length);
}
const cmAcctLabel = (t) => (t.handle ? "@" + t.handle : t.channelId || t.id.split(":").slice(1).join(":"));
// 계정 ID가 들어 있는(홈에 보이는) 그룹
const cmGroupOf = (id) => cmGroups().find((g) => g.ids.includes(id)) || null;
const cmGrpView = (g) => (g ? { t: "grp", key: g.key, name: g.name, ids: g.ids } : { t: "all" });

/* ---------- 화면 이동 · 주소(#c/…) ---------- */
// 주소: #c 목록 · #c/all 전체 · #c/g/<그룹> 그룹 · #c/s 스크랩 · #c/<번호> 글 하나. 펼친 글은 뒤에 /<번호>(예: #c/all/12)
// 커뮤니티 안의 스크랩만 보기는 /s를 붙입니다(예: #c/all/s, #c/g/<그룹>/s/12).
function cmHash() {
  const v = cmView;
  let h = v.t === "list" ? "#c" : v.t === "all" ? "#c/all" : v.t === "grp" ? "#c/g/" + encodeURIComponent(v.key) : "#c/" + v.id;
  if (v.sc) h += "/s";
  if (cmOpenId && v.t !== "post" && v.t !== "list") h += "/" + cmOpenId;
  return h;
}
// 커뮤니티 안에서 보기를 바꿨을 때 주소를 맞춥니다(주소 기록은 bridge.js의 syncRoute가 한 곳에서 다룸)
function cmSyncHash(push) {
  if (page !== "community") return;
  syncRoute(push);
}
function cmParseHash(h) {
  const m = /^#c(?:\/(.*))?$/.exec(h || "");
  if (!m) return null;
  const parts = (m[1] || "").split("/").filter(Boolean);
  const num = (x) => (/^\d{1,9}$/.test(x || "") ? Number(x) : 0);
  if (!parts.length) return { v: { t: "list" }, open: 0 };
  if (num(parts[0])) return { v: { t: "post", id: num(parts[0]) }, open: num(parts[0]) };
  if (parts[0] === "all") return parts[1] === "s" ? { v: { t: "all", sc: true }, open: num(parts[2]) } : { v: { t: "all" }, open: num(parts[1]) };
  if (parts[0] === "s") return { v: { t: "all", sc: true }, open: num(parts[1]) };   // 예전 스크랩 주소 → 전체 커뮤니티의 스크랩
  if (parts[0] === "g") {
    let key = "";
    try { key = decodeURIComponent(parts[1] || ""); } catch (e) {}
    const g = cmGroups().find((x) => x.key === key);
    if (!g) return { v: { t: "list" }, open: 0 };   // 그룹 이름이 바뀌었으면 목록으로
    return parts[2] === "s" ? { v: { ...cmGrpView(g), sc: true }, open: num(parts[3]) } : { v: cmGrpView(g), open: num(parts[2]) };
  }
  return { v: { t: "list" }, open: 0 };
}
// 다른 화면으로 이동: 보기 상태를 새로 정하고 불러옵니다. push: 뒤로 가기로 돌아올 수 있게 주소 기록을 남김
function cmGo(v, open, push = true) {
  cmCloseWrite(); cmCloseNotif();
  cmView = v; cmCat = ""; cmQ = ""; cmOpenId = open || 0; cmReply = null; cmTagF = null; cmEditCmt = 0;
  cmSeenBefore = Infinity; cmPosts = []; cmHot = []; cmMore = false; cmCounts = {}; cmMissing = "";
  if (v.t === "all") cmTags = null;
  $("cmFind").value = "";
  if (page !== "community") { page = "community"; applyPage(); }   // applyPage → cmShown(true)가 불러옵니다
  else cmLoad();
  cmSyncHash(push);
  $("communityPanel").scrollTop = 0; window.scrollTo(0, 0);
}
function cmOpenGroup(g) { cmGo(cmGrpView(g)); }
// 글 하나로 바로(알림·관리 탭·공유 주소). cid가 있으면 그 댓글을 찾아 보여 줍니다.
function cmGoPost(pid, cid) { cmFocusCmt = cid || 0; delete cmCmts[pid]; cmGo({ t: "post", id: pid }, pid); }
// 주소(#c/…)대로 커뮤니티 화면을 엽니다(bridge.js의 applyRoute가 부름: 연결됐을 때·뒤로/앞으로 가기·주소 직접 입력)
function cmApplyHash() {
  const r = cmParseHash(location.hash);
  if (!r || !connected) return false;
  cmGo(r.v, r.open, false);
  return true;
}

// 홈의 사람별 그룹 머리줄에 붙는 '커뮤니티' 버튼
function cmBtn(r) {
  const b = el("button", { type: "button", class: "pcomm", title: "이 그룹의 커뮤니티 글 보기", "aria-label": dispName(r) + " 커뮤니티" });
  b.innerHTML = CM_BUBBLE;
  b.addEventListener("click", (e) => { e.stopPropagation(); const g = cmGroups().find((x) => x.key === r.name); cmOpenGroup(g || null); });
  return b;
}

/* ---------- 표시(위쪽 버튼의 알림 수·새 글 점, 관리 버튼의 신고 수) ---------- */
// store.js가 30초마다 상태를 읽을 때 서버가 같이 보내 줍니다(d.cm).
function cmBadges(b) {
  if (!b) return;
  cmBadge = { notif: Number(b.notif) || 0, newPosts: !!b.newPosts, reports: Number(b.reports) || 0 };
  cmPaintBadges();
}
function cmPaintBadges() {
  const nc = $("navCommunity"), na = $("navAdmin"), n = cmBadge.notif;
  if (n) nc.dataset.badge = n > 99 ? "99+" : String(n);
  else if (cmBadge.newPosts && page !== "community") nc.dataset.badge = "";
  else delete nc.dataset.badge;
  nc.title = "모든 사용자가 같이 보는 게시판" + (n ? " · 안 읽은 알림 " + n + "개" : cmBadge.newPosts ? " · 새 글 있음" : "");
  const bell = $("cmBell");
  bell.classList.toggle("has", n > 0);
  bell.querySelector(".n").textContent = n ? (n > 99 ? "99+" : String(n)) : "";
  bell.setAttribute("aria-label", "알림" + (n ? " " + n + "개 안 읽음" : ""));
  if (cmBadge.reports) na.dataset.badge = String(cmBadge.reports); else delete na.dataset.badge;
  na.title = "관리(관리자 전용)" + (cmBadge.reports ? " · 처리할 신고 " + cmBadge.reports + "건" : "");
  if (typeof adPaintCommTab === "function") adPaintCommTab();
}

/* ---------- 불러오기 ---------- */
// 커뮤니티 화면이 보이거나 사라질 때(bridge.js의 applyPage)
function cmShown(on) {
  if (!on) { cmCloseWrite(); cmCloseNotif(); cmPaintBadges(); return; }   // 주소는 옮겨 간 화면이 적음(bridge.js의 goPage)
  cmLoad();
  cmSyncHash(true);
  cmPaintBadges();
}
async function cmLoad(more) {
  const gen = ++cmGen, v = cmView;
  if (v.t === "list") {
    cmRender();
    try {
      const groups = cmGroups().map((g) => ({ key: g.key, ids: g.ids }));
      const res = await cmCall("summary", { groups });
      if (gen !== cmGen) return;
      cmSum = res; cmRender();
      cmBadge.newPosts = false; cmPaintBadges();   // 커뮤니티 목록을 봤으니 새 글 점은 끔(서버도 같이 적음)
    } catch (e) { if (gen === cmGen) { cmSum = null; cmRender(); showErr(e); } }
    return;
  }
  if (v.t === "post") {
    cmRender(true);
    try {
      const res = await cmCall("get", { id: v.id });
      if (gen !== cmGen) return;
      cmMe = res.me; cmAdmin = res.admin; cmHotMin = res.hotMin;
      cmPosts = [res.post]; cmHot = []; cmMore = false; cmCounts = {}; cmOpenId = v.id; cmMissing = "";
      cmRender();
      if (!cmCmts[v.id]) cmLoadCmts(v.id);
    } catch (e) { if (gen === cmGen) { cmPosts = []; cmMissing = e.message || "글을 불러오지 못했습니다."; cmRender(); } }
    return;
  }
  if (!more) cmRender(true);
  if (v.t === "all" && !more && !cmTags) cmLoadTags();
  const ids = v.t === "grp" ? v.ids : cmTagF ? [cmTagF.id] : [];
  const mine = v.t === "all" && cmMine;
  const scope = cmTagF || mine || v.sc ? "" : v.t === "all" ? "all" : v.t === "grp" ? "g:" + v.key : "";   // 거른 목록을 봤다고 '여기까지 봄'으로 적지 않음
  try {
    const res = await cmCall("list", { ids, cat: cmCat, q: cmQ, offset: more ? cmPosts.length : 0, scrap: !!v.sc, mine, scope });
    if (gen !== cmGen) return;
    cmMe = res.me; cmAdmin = res.admin; cmHotMin = res.hotMin; cmCounts = res.counts; cmMore = res.more;
    if (typeof res.seenBefore === "number") cmSeenBefore = res.seenBefore;
    if (more) { const have = new Set(cmPosts.map((p) => p.id)); cmPosts = cmPosts.concat(res.posts.filter((p) => !have.has(p.id))); }
    else { cmPosts = res.posts; cmHot = res.hot || []; }
    cmRender();
    if (cmOpenId && !cmCmts[cmOpenId]) cmLoadCmts(cmOpenId);
  } catch (e) { if (gen === cmGen) { cmRender(); showErr(e); } }
}
async function cmLoadCmts(id) {
  try { cmCmts[id] = await cmCall("comments", { id }); }
  catch (e) { showErr(e); if (/없는 글/.test(e.message)) { cmOpenId = 0; cmSyncHash(false); cmLoad(); return; } }
  cmRender();
  if (cmFocusCmt) {
    const c = document.querySelector('#cmList [data-cid="' + cmFocusCmt + '"]');
    cmFocusCmt = 0;
    if (c) { c.scrollIntoView({ block: "center", behavior: "smooth" }); c.classList.add("flash"); setTimeout(() => c.classList.remove("flash"), 2200); }
  }
}
async function cmLoadTags() {
  try { cmTags = await cmCall("tagStats", {}); } catch (e) { cmTags = []; }
  if (cmView.t === "all") cmRender();
}
// 다른 탭에 갔다가 돌아오면(글쓰기·수정 중이 아니면) 새 글·댓글을 다시 읽습니다.
document.addEventListener("visibilitychange", () => {
  if (document.hidden || page !== "community" || $("communityPanel").hidden || !$("cmWrite").hidden || cmEditCmt) return;
  const a = document.activeElement;
  if (a && a.closest && a.closest("#cmList input, #cmList textarea")) return;   // 댓글을 쓰는 중이면 그대로 둠
  cmLoad();
  if (cmOpenId && cmView.t !== "post") cmLoadCmts(cmOpenId);
});

/* ---------- 그리기 ---------- */
function cmRender(loading) {
  const v = cmView, list = v.t === "list";
  $("cmBack").hidden = list;
  $("cmCats").hidden = list || v.t === "post";
  $("cmNew").hidden = v.t === "post";   // 커뮤니티 목록에서 쓰면 전체 커뮤니티에, 스크랩만 보는 중이면 그 커뮤니티에 올라갑니다
  // 스크랩 버튼: 목록에서는 스크랩 화면으로, 전체·그룹 커뮤니티에서는 그 커뮤니티의 스크랩 글만 보기(켜고 끄기)
  const sb = $("cmScrap"), inComm = v.t === "all" || v.t === "grp";
  sb.hidden = !list && !inComm;
  sb.classList.toggle("on", !!v.sc);
  if (inComm) {
    sb.setAttribute("aria-pressed", String(!!v.sc));
    sb.querySelector(".n").textContent = "";
    sb.setAttribute("aria-label", v.sc ? "스크랩만 보기 끄기" : "이 커뮤니티의 스크랩한 글만 보기");
    sb.title = v.sc ? "모든 글 보기로 돌아갑니다" : "이 커뮤니티 글 중 내가 스크랩한 글만 봅니다";
  } else { sb.removeAttribute("aria-pressed"); sb.title = "스크랩한 글 (나중에 볼 글)"; }
  $("cmFind").hidden = v.t === "post";
  $("cmFind").placeholder = list ? "커뮤니티 찾기 (그룹 이름·@아이디)" : "글 검색 (제목·내용·쓴 사람·태그)";
  $("cmFind").setAttribute("aria-label", $("cmFind").placeholder);
  const h = $("cmTitle");
  h.textContent = (list ? "커뮤니티" : v.t === "all" ? "전체 커뮤니티" : v.t === "grp" ? v.name : "글") + (v.sc ? " · 스크랩" : "");
  h.title = h.textContent;
  if (list) { cmRenderList(); return; }
  if (v.t !== "post") cmRenderCats();
  const box = $("cmList");
  box.textContent = ""; box.className = "cm-list";
  if (v.t === "post") {
    $("cmCount").textContent = "";
    if (cmMissing) {
      const back = el("button", { type: "button", class: "cm-more", text: "커뮤니티 목록으로" });
      back.addEventListener("click", () => cmGo({ t: "list" }));
      box.append(el("p", { class: "cm-empty", text: cmMissing }), back);
      return;
    }
    if (loading && !cmPosts.length) { box.appendChild(el("p", { class: "cm-empty", text: "불러오는 중…" })); return; }
    cmPosts.forEach((p) => box.appendChild(cmPostEl(p, false)));
    return;
  }
  if (v.t === "all" && !cmQ) box.appendChild(cmTagPanel());
  if (cmTagF) box.appendChild(cmFilterEl());
  const n = cmCounts[cmCat] || 0;
  $("cmCount").textContent = loading && !cmPosts.length ? "" : (cmQ ? "검색 결과 " : "글 ") + n + "개";
  if (loading && !cmPosts.length) { box.appendChild(el("p", { class: "cm-empty", text: "불러오는 중…" })); return; }
  const hot = !cmCat && !cmQ && !v.sc ? cmHot : [];
  const hotIds = new Set(hot.map((p) => p.id));
  const rest = cmPosts.filter((p) => !hotIds.has(p.id));
  if (!hot.length && !rest.length) {
    box.appendChild(el("p", { class: "cm-empty", text: cmQ ? "검색 결과가 없습니다." : v.t === "all" && cmMine && !cmTagF ? "내가 추적하는 계정이 태그된 글이 없습니다. 위쪽 ‘내 추적 계정 글만’을 끄면 모든 글이 보입니다." : v.sc ? "이 커뮤니티에서 스크랩한 글이 없습니다. 위쪽 ‘스크랩’을 다시 누르면 모든 글이 보입니다." : cmCat ? "이 분류에는 아직 글이 없습니다." : "아직 글이 없습니다. 첫 글을 써 보세요." }));
    return;
  }
  hot.forEach((p) => box.appendChild(cmPostEl(p, true)));
  if (hot.length && rest.length) box.appendChild(el("div", { class: "cm-sep", role: "separator" }));
  rest.forEach((p) => box.appendChild(cmPostEl(p, false)));
  if (cmMore) {
    const b = el("button", { type: "button", class: "cm-more", text: "더 보기" });
    b.addEventListener("click", () => { b.disabled = true; b.textContent = "불러오는 중…"; cmLoad(true); });
    box.appendChild(b);
  }
}

function cmRenderList() {
  const box = $("cmList");
  box.textContent = ""; box.className = "cm-list cm-grid";
  const q = $("cmFind").value.trim().toLowerCase();
  const sum = cmSum || { all: null, groups: {}, scraps: 0 };
  const info = (s) => (s ? el("span", { class: "cm-cmeta", text: "글 " + s.n + "개" + (s.last ? " · " + cmAgo(s.last.at) : "") }) : el("span", { class: "cm-cmeta", text: cmSum ? "글 0개" : "…" }));
  const last = (s) => el("span", { class: "cm-clast", text: s && s.last ? s.last.title : "아직 글이 없습니다" });
  const newPill = (s) => (s && s.new ? [el("i", { class: "cm-newn", title: "마지막으로 본 뒤 올라온 글", text: "새 글 " + (s.new > 99 ? "99+" : s.new) })] : []);
  const card = (face, name, meta, s, go, extra, lastEl) => {
    const c = el("button", { type: "button", class: "cm-comm" }, [face, el("span", { class: "cm-cinfo" }, [el("span", { class: "cm-ctop" }, [el("b", { class: "cm-cname", text: name }), ...(extra || [])]), meta, lastEl || last(s)])]);
    c.addEventListener("click", go);
    return c;
  };
  const groups = cmGroups();
  // 글이 있는 그룹을 먼저(최근 글 순), 나머지는 홈 그룹 순서대로
  const at = (g) => { const s = sum.groups[g.key]; return s && s.last ? s.last.at : 0; };
  const shown = groups.filter((g) => !q || [g.name, g.key, ...g.accs.flatMap((t) => [t.handle || "", t.channelId || "", t.group || "", PLATFORM[t.platform]])].join(" ").toLowerCase().includes(q))
    .map((g, i) => ({ g, i })).sort((a, b) => at(b.g) - at(a.g) || a.i - b.i).map((x) => x.g);
  const showAll = !q || "전체 커뮤니티".includes(q);
  $("cmCount").textContent = (q ? "검색 결과 " : "") + (shown.length + (showAll ? 1 : 0)) + "개";
  if (showAll) {
    const face = el("span", { class: "cm-cface all" }); face.innerHTML = LOGO_SVG;
    box.appendChild(card(face, "전체 커뮤니티", info(sum.all), sum.all, () => cmOpenGroup(null), newPill(sum.all)));
  }
  // 스크랩은 카드 대신 머리줄(검색칸 옆)의 작은 버튼으로
  $("cmScrap").querySelector(".n").textContent = cmSum && sum.scraps ? String(sum.scraps > 99 ? "99+" : sum.scraps) : "";
  $("cmScrap").setAttribute("aria-label", "스크랩" + (cmSum ? " " + (sum.scraps || 0) + "개" : ""));
  shown.forEach((g) => {
    const chosen = g.accs.find((t) => t.platform === picPick[g.key]) || g.accs.find((t) => picMap[t.id]) || g.accs[0];
    const face = el("span", { class: "cm-cface" }, [picFace(chosen, g.name.replace(/^@/, ""), "pface")]);
    const plats = el("span", { class: "cm-cplats" }, platOrder([...new Set(g.accs.map((t) => t.platform))]).map((p) => pIcon(p)));
    const s = sum.groups[g.key];
    box.appendChild(card(face, g.name, el("span", { class: "cm-cmeta" }, [plats, info(s)]), s, () => cmOpenGroup(g), [...(g.accs.length > 1 ? [el("i", { class: "cm-gtag", text: "그룹" })] : []), ...newPill(s)]));
  });
  if (!box.children.length) box.appendChild(el("p", { class: "cm-empty", text: "찾는 커뮤니티가 없습니다." }));
}

function cmRenderCats() {
  const bar = $("cmCats");
  bar.textContent = "";
  const cats = [["", "전체"], ...(cmCounts[CM_NOTICE] ? [[CM_NOTICE, CM_NOTICE]] : []), [CM_HOT, CM_HOT], ...CM_CATS.map((c) => [c, c])];
  cats.forEach(([k, label]) => {
    const b = el("button", { type: "button", class: "cm-cat" + (cmCat === k ? " on" : ""), role: "tab", "aria-selected": String(cmCat === k) }, [document.createTextNode(label), el("span", { class: "n", text: String(cmCounts[k] || 0) })]);
    if (k === CM_HOT) b.title = "좋아요 " + cmHotMin + "개 이상 받은 글";
    b.addEventListener("click", () => { if (cmCat === k) return; cmCat = k; cmOpenId = 0; cmPosts = []; cmSyncHash(false); cmLoad(); });
    bar.appendChild(b);
  });
  // 전체 커뮤니티: 내가 추적하는 계정(숨긴 계정 포함)이 태그된 글만 보기. 분류·검색·태그 거르기와 같이 쓸 수 있습니다.
  if (cmView.t === "all") {
    const n = tracked.filter((t) => t.kind !== "feed").length;
    const b = el("button", { type: "button", class: "cm-mine" + (cmMine ? " on" : ""), role: "switch", "aria-checked": String(cmMine),
      title: n ? "내가 추적하는 계정 " + n + "개 중 하나라도 태그된 글만 봅니다" : "추적하는 계정이 없습니다" }, [el("span", { class: "sw", "aria-hidden": "true" }), document.createTextNode("내 추적 계정 글만")]);
    if (!n && !cmMine) b.disabled = true;
    b.addEventListener("click", () => {
      cmMine = !cmMine;
      try { localStorage.setItem("snsCmMine", cmMine ? "1" : "0"); } catch (e) {}
      cmOpenId = 0; cmPosts = []; cmSyncHash(false); cmLoad();
    });
    bar.appendChild(b);
  }
}

// 계정 태그 칩. 내가 추적 중인(홈에 보이는) 계정이면 누르면 그 그룹 커뮤니티로 갑니다.
// addable: 내가 추적하지 않는 계정이면 옆에 '＋'(내 추적 계정에 추가)를 붙입니다(펼친 글의 태그 줄).
function cmTagEl(t, addable) {
  const g = cmGroupOf(t.id);
  const mine = trackedOf(t.id);
  const label = mine ? cmAcctLabel(mine) : t.label || t.id.split(":").slice(1).join(":");
  const kids = [pIcon(t.platform), el("span", { text: label })];
  if (!mine && addable) {
    const chip = el("span", { class: "cm-chip", title: PLATFORM[t.platform] + " " + label + " · 추적하지 않는 계정" }, kids);
    const add = el("button", { type: "button", class: "cm-tadd", text: "＋", title: label + " 을(를) 내 추적 계정에 추가", "aria-label": label + " 추가" });
    add.addEventListener("click", (e) => { e.stopPropagation(); cmAddTagAcct(t, label); });
    return el("span", { class: "cm-tpair" }, [chip, add]);
  }
  if (!g) return el("span", { class: "cm-chip", title: PLATFORM[t.platform] + " " + label }, kids);
  const b = el("button", { type: "button", class: "cm-chip go", title: g.name + " 커뮤니티로" }, kids);
  b.addEventListener("click", (e) => { e.stopPropagation(); cmOpenGroup(g); });
  return b;
}

/* ---------- 전체 커뮤니티: 태그된 계정 ---------- */
// 전체 글에서 태그된 계정을 내 그룹별로 묶고, 내가 추적하지 않는 계정은 매체별로 모아 바로 추가할 수 있게 합니다.
// 계정을 누르면 그 계정이 태그된 글만 봅니다.
function cmTagPanel() {
  const stats = cmTags || [];
  const det = el("details", { class: "cm-tagbox" });
  det.open = cmTagOpen;
  det.addEventListener("toggle", () => { cmTagOpen = det.open; });
  det.appendChild(el("summary", {}, [el("b", { text: "태그된 계정" }), el("span", { class: "n", text: cmTags ? stats.length + "개" : "…" }),
    el("span", { class: "hint", text: "누르면 그 계정 글만 · ＋로 내 추적 계정에 추가" })]));
  if (!cmTags) { det.appendChild(el("p", { class: "cm-empty sm", text: "불러오는 중…" })); return det; }
  if (!stats.length) { det.appendChild(el("p", { class: "cm-empty sm", text: "아직 계정이 태그된 글이 없습니다." })); return det; }
  const groups = cmGroups(), byGroup = new Map(), hiddenMine = [], others = {};
  stats.forEach((t) => {
    if (trackedOf(t.id)) {
      const g = groups.find((x) => x.ids.includes(t.id));
      if (g) { if (!byGroup.has(g.key)) byGroup.set(g.key, { g, list: [] }); byGroup.get(g.key).list.push(t); }
      else hiddenMine.push(t);
    } else (others[t.platform] = others[t.platform] || []).push(t);
  });
  const sec = (head, chips, cls) => el("div", { class: "cm-tsec" + (cls ? " " + cls : "") }, [head, el("div", { class: "cm-tchips" }, chips)]);
  groups.filter((g) => byGroup.has(g.key)).forEach((g) => {
    const hb = el("button", { type: "button", class: "cm-thead go", title: g.name + " 커뮤니티로", text: g.name });
    hb.addEventListener("click", () => cmOpenGroup(g));
    det.appendChild(sec(hb, byGroup.get(g.key).list.map((t) => cmTagChip(t, false))));
  });
  if (hiddenMine.length) det.appendChild(sec(el("span", { class: "cm-thead", text: "숨긴 그룹의 내 계정" }), hiddenMine.map((t) => cmTagChip(t, false))));
  const plats = platOrder(Object.keys(others));
  if (plats.length) {
    det.appendChild(el("p", { class: "cm-tnote", text: "내가 추적하지 않는 계정" }));
    plats.forEach((p) => det.appendChild(sec(el("span", { class: "cm-thead" }, [pIcon(p), document.createTextNode(PLATFORM[p])]), others[p].map((t) => cmTagChip(t, true)), "other")));
  }
  return det;
}
function cmTagLabel(t) { const mine = trackedOf(t.id); return mine ? cmAcctLabel(mine) : t.label || t.id.split(":").slice(1).join(":"); }
function cmTagChip(t, addable) {
  const label = cmTagLabel(t);
  const on = cmTagF && cmTagF.id === t.id;
  const b = el("button", { type: "button", class: "cm-chip go" + (on ? " on" : ""), title: PLATFORM[t.platform] + " " + label + " · 태그된 글 " + t.n + "개 (눌러서 이 계정 글만 보기)" },
    [pIcon(t.platform), el("span", { text: label }), el("small", { text: String(t.n) })]);
  b.addEventListener("click", () => { cmTagF = on ? null : { id: t.id, platform: t.platform, label }; cmOpenId = 0; cmPosts = []; cmCat = ""; cmLoad(); });
  if (!addable) return b;
  const add = el("button", { type: "button", class: "cm-tadd", text: "＋", title: label + " 을(를) 내 추적 계정에 추가", "aria-label": label + " 추가" });
  add.addEventListener("click", () => cmAddTagAcct(t, label));
  return el("span", { class: "cm-tpair" }, [b, add]);
}
// 태그된 계정을 내 추적 계정으로 추가: 계정 ID는 태그 그대로(그 계정 태그 글이 바로 그룹 커뮤니티에 이어지게)
async function cmAddTagAcct(t, label) {
  const p = t.platform, key = t.id.slice(p.length + 1), lab = String(t.label || "").trim().replace(/^@/, "");
  const acc = { id: t.id, platform: p, handle: "" };
  if (p === "youtube") {
    if (/^UC[\w-]{22}$/.test(lab)) acc.channelId = lab;
    else if (lab && lab.toLowerCase() === key) acc.handle = lab;
    else if (/^uc[\w-]{22}$/.test(key)) { toast("이 채널은 채널 주소로 직접 추가해 주세요(위쪽 계정 찾기).", "error"); return; }
    else if (!/^https?:/.test(key)) acc.handle = lab && /^[^\s/?#@]{1,60}$/.test(lab) && !/\s/.test(lab) && lab.toLowerCase() === key ? lab : key;
  } else acc.handle = lab && lab.toLowerCase() === key.toLowerCase() ? lab : key;
  if (!acc.handle && !acc.channelId) { toast("이 계정은 여기서 추가할 수 없습니다. 위쪽 계정 찾기에서 추가해 주세요.", "error"); return; }
  const pk = await pickPeriod();
  if (!pk) return;
  acc.days = pk.days;
  if (pk.group) acc.group = pk.group;
  if (await addAccount(acc)) { toast(label + " 을(를) 추가했습니다."); cmRender(); }
}
function cmFilterEl() {
  const x = el("button", { type: "button", class: "cm-tx", text: "×", "aria-label": "거르기 풀기", title: "모든 글 보기" });
  x.addEventListener("click", () => { cmTagF = null; cmOpenId = 0; cmPosts = []; cmLoad(); });
  return el("div", { class: "cm-filter" }, [el("span", { text: "태그된 글만:" }), el("span", { class: "cm-chip" }, [pIcon(cmTagF.platform), el("span", { text: cmTagF.label })]), x]);
}

/* ---------- 링크 · 모은 글 카드 ---------- */
const cmYt = (u) => { const m = String(u).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/); return m ? m[1] : ""; };
const CM_LINK_PLAT = [[/(^|\.)(x|twitter)\.com$/, "x"], [/(^|\.)instagram\.com$/, "instagram"], [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"]];
function cmLinkEl(u) {
  let host = u;
  try { host = new URL(u).hostname.replace(/^www\./, ""); } catch (e) {}
  const yt = cmYt(u);
  if (yt) {
    const a = el("a", { class: "cm-yt", href: u, target: "_blank", rel: "noopener noreferrer", title: "유튜브에서 보기" });
    const img = el("img", { src: "https://i.ytimg.com/vi/" + yt + "/hqdefault.jpg", alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => img.remove());
    a.append(img, el("span", { class: "cm-play", "aria-hidden": "true" }), el("span", { class: "cm-ytl", text: "YouTube에서 보기 ↗" }));
    return a;
  }
  const plat = (CM_LINK_PLAT.find((x) => x[0].test(host)) || [])[1];
  const a = el("a", { class: "cm-link", href: u, target: "_blank", rel: "noopener noreferrer" });
  if (plat) a.appendChild(pIcon(plat));
  a.append(el("b", { text: (plat ? PLATFORM[plat] : host) + " 열기 ↗" }), el("span", { text: u.replace(/^https?:\/\/(www\.)?/, "") }));
  return a;
}
// 이미 모은 글: 썸네일 카드. 누르면 홈과 같은 자세히보기(영상 재생·게시물 내용)로 엽니다.
function cmItemCard(it) {
  const plat = cmSrcPlat(it.source);
  const when = it.publishedAt && !Number.isNaN(Date.parse(it.publishedAt)) ? cmAgo(Date.parse(it.publishedAt)) : it.publishedText || "";
  const kind = it.source === "youtube-post" ? "유튜브 게시물" : /\/shorts\//.test(it.url) ? "쇼츠" : it.source === "youtube-video" ? "유튜브 영상" : PLATFORM[plat] || "";
  const b = el("button", { type: "button", class: "cm-icard" + (/\/shorts\//.test(it.url) ? " short" : ""), title: "자세히 보기" });
  if (it.thumb && thumbOk(it.thumb)) {
    const img = el("img", { src: it.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => { imgBad.add(it.thumb); img.remove(); });
    b.appendChild(el("span", { class: "cm-ithumb" }, [img, ...(it.source === "youtube-video" ? [el("span", { class: "cm-play", "aria-hidden": "true" })] : [])]));
  }
  b.appendChild(el("span", { class: "cm-iinfo" }, [
    el("b", { text: it.title || it.author || it.url }),
    el("span", { class: "cm-imeta" }, [...(plat ? [pIcon(plat)] : []), el("span", { text: [kind, it.author, when].filter(Boolean).join(" · ") })]),
  ]));
  b.addEventListener("click", (e) => { e.stopPropagation(); viewCtx = [it]; viewIdx = 0; openItem(it); });
  return b;
}

/* ---------- 글 ---------- */
const cmIsNew = (p) => !p.mine && p.id > cmSeenBefore;
function cmPostEl(p, asHot) {
  const open = cmOpenId === p.id;
  const art = el("article", { class: "cm-post" + (open ? " open" : "") + (p.cat === CM_NOTICE ? " notice" : "") + (asHot || (cmCat === CM_HOT && p.hot) ? " hot" : ""), "data-pid": String(p.id) });
  // 그룹 커뮤니티 안에서는 그 그룹 계정 태그를 제목 줄에서 뺍니다(펼치면 모두 보임)
  const inView = new Set(cmView.t === "grp" ? cmView.ids : []);
  const headTags = p.tags.filter((t) => !inView.has(t.id));
  const tagEls = headTags.slice(0, 2).map((t) => { const c = cmTagEl(t); c.classList.add("sm"); return c; });
  if (headTags.length > 2) tagEls.push(el("span", { class: "cm-chip sm more", text: "+" + (headTags.length - 2) }));
  const marks = (p.imgs.length ? "사진 " + p.imgs.length + " · " : "") + (p.links.length ? "링크 · " : "");
  const meta = el("span", { class: "cm-meta", title: cmDate(p.at) + (p.editedAt ? " · 수정 " + cmDate(p.editedAt) : ""), text: marks + p.author + " · " + cmAgo(p.at) + (p.editedAt ? " · 수정됨" : "") });
  const head = el("div", { class: "cm-head", role: "button", tabindex: "0", "aria-expanded": String(open) }, [
    el("span", { class: "cm-tag", text: asHot || (cmCat === CM_HOT && p.hot) ? CM_HOT : p.cat }),
    el("span", { class: "cm-ttl" }, [...(cmIsNew(p) ? [el("i", { class: "cm-newdot", title: "새 글", "aria-label": "새 글" })] : []), el("b", { text: p.title }), ...(p.scrapped ? [el("span", { class: "cm-scr", title: "스크랩한 글" })] : []), ...tagEls]),
    meta,
    el("span", { class: "cm-nums" }, [el("span", { class: "cm-lk" + (p.liked ? " on" : ""), text: "♥ " + p.likes }), el("span", { class: "cm-cn", text: "댓글 " + p.comments })]),
  ]);
  const toggle = () => {
    if (cmView.t === "post") return;   // 글 하나 화면에서는 늘 펼친 채로
    cmOpenId = open ? 0 : p.id; cmReply = null; cmEditCmt = 0;
    cmSyncHash(false);
    cmRender();
    if (cmOpenId && !cmCmts[cmOpenId]) cmLoadCmts(cmOpenId);
  };
  head.addEventListener("click", (e) => { if (!e.target.closest("button")) toggle(); });
  head.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === head) { e.preventDefault(); toggle(); } });
  art.appendChild(head);
  if (open) art.appendChild(cmOpenEl(p));
  return art;
}
// 글 정보를 바꾼 뒤(좋아요·스크랩·수정): 목록·인기글에 있는 같은 글을 모두 맞춥니다.
function cmPatch(id, ch) { [...cmPosts, ...cmHot].filter((x) => x.id === id).forEach((x) => Object.assign(x, ch)); }

function cmOpenEl(p) {
  const body = el("div", { class: "cm-open" }, [el("p", { class: "cm-text", text: p.body })]);
  if (p.imgs.length) {
    const g = el("div", { class: "cm-imgs" });
    p.imgs.forEach((src, i) => {
      const b = el("button", { type: "button", class: "cm-im", title: "크게 보기", "aria-label": "첨부 사진 " + (i + 1) + " 크게 보기" }, [el("img", { src, alt: "", loading: "lazy" })]);
      b.addEventListener("click", () => cmLightbox(p.imgs, i, p.title));
      g.appendChild(b);
    });
    body.appendChild(g);
  }
  if (p.links.length) body.appendChild(el("div", { class: "cm-links" }, p.links.map((u) => (p.cards && p.cards[u] ? cmItemCard(p.cards[u]) : cmLinkEl(u)))));
  if (p.tags.length) body.appendChild(el("div", { class: "cm-tags" }, p.tags.map((t) => cmTagEl(t, true))));
  if (p.editedAt) body.appendChild(el("p", { class: "cm-editnote", text: "수정됨 · " + cmDate(p.editedAt) }));
  // 좋아요 · 스크랩 · 링크 복사 · 수정 · 신고 · 지우기 (하고 나면 아래쪽에 짧은 알림)
  const like = el("button", { type: "button", class: "cm-like" + (p.liked ? " on" : ""), "aria-pressed": String(p.liked), text: "♥ 좋아요 " + p.likes });
  if (p.mine) { like.disabled = true; like.title = "내 글에는 좋아요를 누를 수 없습니다"; }
  like.addEventListener("click", async () => {
    like.disabled = true;
    try { const r = await cmCall("like", { id: p.id, on: !p.liked }); Object.assign(p, r); cmPatch(p.id, r); toast(r.liked ? "좋아요를 눌렀습니다." : "좋아요를 취소했습니다."); cmRender(); }
    catch (e) { like.disabled = false; showErr(e); }
  });
  const scr = el("button", { type: "button", class: "cm-act" + (p.scrapped ? " on" : ""), "aria-pressed": String(p.scrapped), text: p.scrapped ? "★ 스크랩함" : "☆ 스크랩", title: p.scrapped ? "스크랩에서 빼기" : "나중에 볼 글로 모아 두기(커뮤니티 목록 위쪽의 ‘스크랩’)" });
  scr.addEventListener("click", async () => {
    scr.disabled = true;
    try {
      const r = await cmCall("scrap", { id: p.id, on: !p.scrapped });
      cmPatch(p.id, r); Object.assign(p, r);
      toast(r.scrapped ? "스크랩했습니다. 커뮤니티 목록 위쪽의 ‘스크랩’에서 볼 수 있습니다." : "스크랩에서 뺐습니다.");
      if (cmView.sc && !r.scrapped) { cmPosts = cmPosts.filter((x) => x.id !== p.id); cmOpenId = 0; cmCounts[cmCat] = Math.max(0, (cmCounts[cmCat] || 1) - 1); cmSyncHash(false); }
      cmRender();
    } catch (e) { scr.disabled = false; showErr(e); }
  });
  const copy = el("button", { type: "button", class: "cm-act", text: "링크 복사", title: "이 글의 주소를 복사합니다(받은 사람이 누르면 이 글이 바로 열림)" });
  copy.addEventListener("click", async () => {
    const u = cmPostUrl(p.id);
    if (await copyText(u)) toast("글 주소를 복사했습니다.");
    else toast("복사하지 못했습니다. 주소: " + u, "error");
  });
  const acts = el("div", { class: "cm-acts" }, [like, scr, copy]);
  if (p.canEdit) {
    const ed = el("button", { type: "button", class: "cm-act", text: "수정" });
    ed.addEventListener("click", () => cmOpenWrite({ edit: p }));
    acts.appendChild(ed);
  }
  if (!p.mine) {
    const rp = el("button", { type: "button", class: "cm-act warn", text: p.reported ? "신고함" : "신고", title: p.reported ? "신고했습니다. 관리자가 확인합니다." : "이 글을 관리자에게 신고합니다" });
    if (p.reported) rp.disabled = true;
    rp.addEventListener("click", async () => {
      const r = await cmReportBox("글 신고", "‘" + p.title + "’");
      if (!r) return;
      try { await cmCall("report", { id: p.id, reason: r.reason, memo: r.memo }); cmPatch(p.id, { reported: true }); p.reported = true; toast("신고했습니다. 관리자가 확인합니다."); cmRender(); }
      catch (e) { showErr(e); if (/이미 신고/.test(e.message)) { cmPatch(p.id, { reported: true }); cmRender(); } }
    });
    acts.appendChild(rp);
  }
  if (p.canDel) {
    const del = el("button", { type: "button", class: "cm-del", text: p.mine ? "글 지우기" : "글 지우기(관리자)" });
    del.addEventListener("click", async () => {
      if (!(await confirmBox({ title: "글을 지울까요?", text: "‘" + p.title + "’ 글과 댓글·사진이 모두 지워집니다. 되돌릴 수 없습니다.", ok: "지우기" }))) return;
      try {
        await cmCall("delete", { id: p.id }); toast("글을 지웠습니다.");
        if (cmView.t === "post") { cmGo({ t: "list" }, 0, false); return; }
        cmOpenId = 0; cmSyncHash(false); cmLoad();
      } catch (e) { showErr(e); }
    });
    acts.appendChild(del);
  }
  body.appendChild(acts);
  body.appendChild(cmCommentsEl(p));
  return body;
}

// 신고 창: 이유(필수)와 메모(선택). 확인하면 {reason, memo}, 취소하면 null.
function cmReportBox(title, what) {
  return new Promise((done) => {
    let reason = "";
    const opts = el("div", { class: "cm-reasons", role: "radiogroup", "aria-label": "신고 이유" });
    const ok = el("button", { type: "button", class: "danger", text: "신고", disabled: "" });
    CM_REASONS.forEach((r) => {
      const b = el("button", { type: "button", class: "cm-reason", role: "radio", "aria-checked": "false", text: r });
      b.addEventListener("click", () => { reason = r; opts.querySelectorAll(".cm-reason").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); }); ok.disabled = false; });
      opts.appendChild(b);
    });
    const memo = el("textarea", { rows: "3", maxlength: "200", placeholder: "자세한 내용 (선택, 200자까지)", "aria-label": "신고 메모" });
    const no = el("button", { type: "button", text: "취소" });
    const back = el("div", { class: "modal-back cm-rmodal", role: "dialog", "aria-modal": "true", "aria-label": title });
    const finish = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); done(v); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); finish(null); } };
    ok.addEventListener("click", () => { if (reason) finish({ reason, memo: memo.value.trim() }); });
    no.addEventListener("click", () => finish(null));
    back.addEventListener("click", (e) => { if (e.target === back) finish(null); });
    document.addEventListener("keydown", onKey, true);
    back.appendChild(el("div", { class: "modal" }, [el("h2", { text: title }), el("p", { class: "hint", text: what + " · 관리자가 확인하고 지우거나 그대로 둡니다. 신고한 사실은 다른 사용자에게 보이지 않습니다." }), opts, memo, el("div", { class: "foot" }, [no, ok])]));
    document.body.appendChild(back);
    opts.firstChild.focus();
  });
}

// 사진 크게 보기: 글 보기 창(#viewer)과 같은 틀. ‹ ›·← →로 넘기고, Esc·×·바깥 영역을 누르면 닫습니다.
function cmLightbox(srcs, start, title) {
  let i = start;
  const prevFocus = document.activeElement;
  const img = el("img", { class: "cm-lbimg", alt: "" });
  const cap = el("b");
  const tab = el("button", { type: "button", text: "새 탭으로 열기", title: "이 사진을 원래 크기로 새 탭에서 엽니다" });
  const x = el("button", { type: "button", text: "×", "aria-label": "닫기" });
  const pv = el("button", { type: "button", class: "vnav cm-lbprev", text: "‹", "aria-label": "이전 사진" });
  const nx = el("button", { type: "button", class: "vnav cm-lbnext", text: "›", "aria-label": "다음 사진" });
  const box = el("div", { class: "viewer cm-lbv" }, [el("div", { class: "vh" }, [cap, tab, x]), el("div", { class: "vb" }, [img])]);
  const back = el("div", { class: "viewer-back cm-lb", role: "dialog", "aria-modal": "true", "aria-label": "사진 크게 보기" }, [pv, nx, box]);
  const show = () => {
    img.src = srcs[i];
    cap.textContent = title + (srcs.length > 1 ? " · " + (i + 1) + " / " + srcs.length : "");
    pv.hidden = nx.hidden = srcs.length < 2;
    pv.disabled = i === 0; nx.disabled = i === srcs.length - 1;
  };
  const go = (d) => { const j = i + d; if (j >= 0 && j < srcs.length) { i = j; show(); } };
  const close = () => {
    back.remove(); document.removeEventListener("keydown", onKey, true);
    if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus({ preventScroll: true });
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
  };
  pv.addEventListener("click", () => go(-1));
  nx.addEventListener("click", () => go(1));
  x.addEventListener("click", close);
  tab.addEventListener("click", () => window.open(srcs[i], "_blank", "noopener"));
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(back);
  show();
  x.focus();
}

/* ---------- 댓글 ---------- */
// 댓글 입력 칸(글 아래 새 댓글, 또는 댓글 아래 답글). 쓰던 내용은 다시 그려도 남깁니다(cmDraft).
function cmCmtForm(p, parent, to) {
  const key = p.id + ":" + (parent || 0);
  const inp = el("input", { type: "text", maxlength: "500", placeholder: parent ? (to ? "@" + to + " 에게 답글" : "답글 달기") : "댓글 달기", "aria-label": parent ? "답글" : "댓글", autocomplete: "off" });
  inp.value = cmDraft[key] || "";
  inp.addEventListener("input", () => { cmDraft[key] = inp.value; });
  const ok = el("button", { type: "submit", text: "등록" });
  const f = el("form", { class: "cm-cform" + (parent ? " reply" : "") }, [inp, ok]);
  if (parent) {
    const no = el("button", { type: "button", class: "cm-x", text: "취소" });
    no.addEventListener("click", () => { cmReply = null; delete cmDraft[key]; cmRender(); });
    f.appendChild(no);
    setTimeout(() => inp.focus(), 0);
  }
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = inp.value.trim();
    if (!t || ok.disabled) return;
    ok.disabled = true;
    try {
      cmCmts[p.id] = await cmCall("comment", { id: p.id, body: (to ? "@" + to + " " : "") + t, parent: parent || null });
      delete cmDraft[key]; cmReply = null;
      toast(parent ? "답글을 달았습니다." : "댓글을 달았습니다.");
      p.comments = cmCmts[p.id].filter((c) => !c.deleted).length; cmPatch(p.id, { comments: p.comments });
      cmRender();
    } catch (er) { ok.disabled = false; showErr(er); }
  });
  return f;
}
// 댓글 수정 칸(그 댓글 자리에)
function cmCmtEditForm(p, c) {
  const inp = el("input", { type: "text", maxlength: "500", "aria-label": "댓글 수정", autocomplete: "off" });
  inp.value = c.body;
  const ok = el("button", { type: "submit", text: "저장" });
  const no = el("button", { type: "button", class: "cm-x", text: "취소" });
  no.addEventListener("click", () => { cmEditCmt = 0; cmRender(); });
  inp.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); no.click(); } });
  const f = el("form", { class: "cm-cform edit", "data-cid": String(c.id) }, [inp, ok, no]);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = inp.value.trim();
    if (!t || ok.disabled) return;
    if (t === c.body) { cmEditCmt = 0; cmRender(); return; }
    ok.disabled = true;
    try { cmCmts[p.id] = await cmCall("editComment", { id: c.id, body: t }); cmEditCmt = 0; toast("댓글을 수정했습니다."); cmRender(); }
    catch (er) { ok.disabled = false; showErr(er); }
  });
  setTimeout(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }, 0);
  return f;
}
function cmCommentsEl(p) {
  const wrap = el("div", { class: "cm-cmts" });
  const all = cmCmts[p.id];
  if (!all) { wrap.appendChild(el("p", { class: "cm-empty sm", text: "댓글을 불러오는 중…" })); return wrap; }
  const top = all.filter((c) => !c.parent);
  const line = (c) => {
    if (cmEditCmt === c.id && c.canEdit) return cmCmtEditForm(p, c);
    const row = el("div", { class: "cm-cmt" + (c.parent ? " reply" : "") + (c.deleted ? " gone" : ""), "data-cid": String(c.id) });
    if (c.deleted) { row.appendChild(el("span", { class: "cm-cbody", text: "지운 댓글입니다." })); return row; }
    row.append(el("b", { text: c.author }), el("span", { class: "cm-cbody", text: c.body }), el("em", { title: cmDate(c.at) + (c.editedAt ? " · 수정 " + cmDate(c.editedAt) : ""), text: cmAgo(c.at) + (c.editedAt ? " · 수정됨" : "") }));
    const rb = el("button", { type: "button", class: "cm-rbtn", text: "답글" });
    rb.addEventListener("click", () => { cmReply = { post: p.id, parent: c.parent || c.id, to: c.parent ? c.author : "" }; cmEditCmt = 0; cmRender(); });
    row.appendChild(rb);
    if (c.canEdit) {
      const eb = el("button", { type: "button", class: "cm-rbtn", text: "수정" });
      eb.addEventListener("click", () => { cmEditCmt = c.id; cmReply = null; cmRender(); });
      row.appendChild(eb);
    }
    if (!c.mine) {
      const rp = el("button", { type: "button", class: "cm-rbtn", text: c.reported ? "신고함" : "신고", title: c.reported ? "신고했습니다. 관리자가 확인합니다." : "이 댓글을 관리자에게 신고합니다" });
      if (c.reported) rp.disabled = true;
      rp.addEventListener("click", async () => {
        const r = await cmReportBox("댓글 신고", c.author + ": " + c.body.slice(0, 60));
        if (!r) return;
        try { await cmCall("report", { id: p.id, cid: c.id, reason: r.reason, memo: r.memo }); c.reported = true; toast("신고했습니다. 관리자가 확인합니다."); cmRender(); }
        catch (e) { showErr(e); if (/이미 신고/.test(e.message)) { c.reported = true; cmRender(); } }
      });
      row.appendChild(rp);
    }
    if (c.canDel) {
      const db = el("button", { type: "button", class: "cm-rbtn danger", text: "지우기" });
      db.addEventListener("click", async () => {
        if (!(await confirmBox({ title: "댓글을 지울까요?", text: "되돌릴 수 없습니다. 답글이 달린 댓글은 ‘지운 댓글’로 남습니다.", ok: "지우기" }))) return;
        try { cmCmts[p.id] = await cmCall("delComment", { id: c.id }); p.comments = cmCmts[p.id].filter((x) => !x.deleted).length; cmPatch(p.id, { comments: p.comments }); toast("댓글을 지웠습니다."); cmRender(); } catch (e) { showErr(e); }
      });
      row.appendChild(db);
    }
    return row;
  };
  top.forEach((c) => {
    const box = el("div", { class: "cm-cwrap" }, [line(c)]);
    const reps = all.filter((x) => x.parent === c.id);
    const replying = cmReply && cmReply.post === p.id && cmReply.parent === c.id;
    if (reps.length || replying) {
      const rl = el("div", { class: "cm-replies" }, reps.map(line));
      if (replying) rl.appendChild(cmCmtForm(p, c.id, cmReply.to));
      box.appendChild(rl);
    }
    wrap.appendChild(box);
  });
  if (!top.length) wrap.appendChild(el("p", { class: "cm-empty sm", text: "아직 댓글이 없습니다." }));
  wrap.appendChild(cmCmtForm(p, 0, ""));
  return wrap;
}

/* ---------- 알림 ---------- */
// 내 글에 달린 댓글·내 댓글에 달린 답글. 펼치면 읽음으로 적고(모든 기기), 누르면 그 글로 가서 그 댓글을 보여 줍니다.
function cmCloseNotif() { $("cmNotif").hidden = true; $("cmBell").classList.remove("on"); $("cmBell").setAttribute("aria-expanded", "false"); }
async function cmToggleNotif() {
  const box = $("cmNotif");
  if (!box.hidden) { cmCloseNotif(); return; }
  box.hidden = false; $("cmBell").classList.add("on"); $("cmBell").setAttribute("aria-expanded", "true");
  box.textContent = ""; box.appendChild(el("p", { class: "cm-empty sm", text: "불러오는 중…" }));
  let res;
  try { res = await cmCall("notifs", {}); } catch (e) { box.textContent = ""; box.appendChild(el("p", { class: "cm-empty sm", text: e.message })); return; }
  if (box.hidden) return;
  box.textContent = "";
  box.appendChild(el("div", { class: "cm-nhead" }, [el("b", { text: "알림" }), el("span", { class: "hint", text: "내 글의 댓글 · 내 댓글의 답글" })]));
  if (!res.items.length) box.appendChild(el("p", { class: "cm-empty sm", text: "아직 알림이 없습니다." }));
  res.items.forEach((n) => {
    const b = el("button", { type: "button", class: "cm-nitem" + (n.unread ? " unread" : "") }, [
      el("span", { class: "cm-ntop" }, [el("b", { text: n.author }), el("span", { text: n.kind === "post" ? "님이 내 글에 댓글을 달았습니다" : "님이 내 댓글에 답글을 달았습니다" }), el("em", { title: cmDate(n.at), text: cmAgo(n.at) })]),
      el("span", { class: "cm-nbody", text: n.body }),
      el("span", { class: "cm-npost", text: "‘" + n.title + "’" }),
    ]);
    b.addEventListener("click", () => { cmCloseNotif(); cmGoPost(n.post, n.id); });
    box.appendChild(b);
  });
  const top = res.items.length ? res.items[0].id : 0;
  if (res.unread && top) {
    cmCall("notifRead", { upto: top }).then(() => { cmBadge.notif = 0; cmPaintBadges(); }).catch(() => {});
  }
}
document.addEventListener("click", (e) => {
  if ($("cmNotif").hidden || e.target.closest("#cmNotif, #cmBell")) return;
  cmCloseNotif();
});

/* ---------- 글쓰기 · 수정 ---------- */
let cmW = null; // 쓰는 중인 글: { edit: 수정하는 글 번호(새 글이면 0), tags: [{id, platform, label, lock}], imgs: [사진 주소 또는 dataURL] }
function cmCloseWrite() { cmW = null; $("cmWrite").hidden = true; $("cmWrite").textContent = ""; $("cmWrite").classList.remove("picking"); $("cmNew").classList.remove("on"); }
// 투명한 부분이 있는 사진인지(작게 그려서 알파 값을 봄)
function cmHasAlpha(im) {
  try {
    const k = Math.min(1, 256 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(im.naturalWidth * k)); c.height = Math.max(1, Math.round(im.naturalHeight * k));
    const g = c.getContext("2d"); g.drawImage(im, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    for (let j = 3; j < d.length; j += 4) if (d[j] < 255) return true;
  } catch (e) {}
  return false;
}
// 사진을 긴 변 CM_IMG_SIDE px로 줄입니다. 보통 사진은 JPEG, 투명 배경이 있는 사진(PNG 등)은 투명함을 살려 WebP(안 되는 브라우저는 PNG)로.
// 서버 한도(CM_IMG_BYTES)를 넘으면 화질을 낮추고, 그래도 크면 크기를 줄여 다시 해 봅니다.
function cmShrink(file) {
  return new Promise((res) => {
    const rd = new FileReader();
    rd.onload = () => {
      const im = new Image();
      im.onload = () => {
        const alpha = !/jpe?g/i.test(file.type) && cmHasAlpha(im);
        const fits = (d) => d && d.length * 0.75 < CM_IMG_BYTES;
        let side = CM_IMG_SIDE;
        for (let t = 0; t < 5; t++, side = Math.round(side * 0.75)) {
          const k = Math.min(1, side / Math.max(im.naturalWidth, im.naturalHeight));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(im.naturalWidth * k)); c.height = Math.max(1, Math.round(im.naturalHeight * k));
          const g = c.getContext("2d");
          if (!alpha) { g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); }
          g.drawImage(im, 0, 0, c.width, c.height);
          const tries = alpha ? [() => c.toDataURL("image/webp", 0.9), () => c.toDataURL("image/webp", 0.75), () => c.toDataURL("image/png")]
            : [0.85, 0.75, 0.65].map((q) => () => c.toDataURL("image/jpeg", q));
          for (const f of tries) {
            const d = f();
            if (alpha && !/^data:image\/(webp|png)/.test(d)) continue;   // WebP를 못 만드는 브라우저는 PNG로 나옴
            if (fits(d)) { res(d); return; }
          }
        }
        res("");
      };
      im.onerror = () => res("");
      im.src = String(rd.result);
    };
    rd.onerror = () => res("");
    rd.readAsDataURL(file);
  });
}
const cmParseLinks = (s) => [...new Set(String(s || "").split(/[\s,]+/).map((u) => u.trim()).filter(Boolean).map((u) => (/^https?:\/\//i.test(u) ? u : "https://" + u)))];
// 모은 글의 계정 → 태그(내가 추적 중이면 내 이름표, 아니면 글쓴이 이름)
function cmItemTag(it) {
  if (!it || !/^(youtube|x|instagram):/.test(it.via || "")) return null;
  const mine = trackedOf(it.via);
  return { id: it.via, platform: it.via.split(":")[0], label: mine ? cmAcctLabel(mine) : (it.author || it.via.split(":").slice(1).join(":")).slice(0, 60) };
}
// opts.edit: 수정할 글 / opts.share: {url, item} 홈에서 '커뮤니티에 공유'로 온 글
function cmOpenWrite(opts = {}) {
  const box = $("cmWrite");
  const ed = opts.edit || null;
  if (cmW && !ed && !opts.share && !cmW.edit) { $("cmWTitle").focus(); return; }
  if (cmW) cmCloseWrite();
  const lock = !ed && cmView.t === "grp" ? cmView.ids.map((id) => trackedOf(id)).filter(Boolean) : [];
  cmW = {
    edit: ed ? ed.id : 0,
    tags: ed ? ed.tags.map((t) => ({ id: t.id, platform: t.platform, label: t.label || cmTagLabel(t) })) : lock.map((t) => ({ id: t.id, platform: t.platform, label: cmAcctLabel(t), lock: true })),
    imgs: ed ? ed.imgs.slice() : [], found: {},
  };
  if (opts.share) { const t = cmItemTag(opts.share.item); if (t && !cmW.tags.some((x) => x.id === t.id)) cmW.tags.push(t); }
  if (!ed) $("cmNew").classList.add("on");
  const cat = el("select", { id: "cmWCat", "aria-label": "분류" });
  [...(cmAdmin || (ed && ed.cat === CM_NOTICE) ? [CM_NOTICE] : []), ...CM_CATS].forEach((c) => cat.appendChild(el("option", { value: c, text: c })));
  cat.value = ed ? ed.cat : cmCat && cmCat !== CM_HOT && (cmCat !== CM_NOTICE || cmAdmin) ? cmCat : "일반";
  const title = el("input", { id: "cmWTitle", type: "text", maxlength: "80", placeholder: "제목", "aria-label": "제목", autocomplete: "off" });
  const text = el("textarea", { id: "cmWBody", rows: "5", maxlength: "2000", placeholder: "내용을 적어 주세요", "aria-label": "내용" });
  const links = el("input", { id: "cmWLinks", type: "text", placeholder: "링크 (유튜브·X·인스타 등, 여러 개는 띄어쓰기로 · 최대 5개)", "aria-label": "링크", autocomplete: "off" });
  if (ed) { title.value = ed.title; text.value = ed.body; links.value = ed.links.join(" "); }
  if (opts.share) links.value = opts.share.url;
  // 모은 글 찾아 넣기: 제목·작성자로 찾거나 주소를 붙여 넣으면 목록에서 골라 링크로 넣습니다(그 계정도 태그)
  const find = el("input", { type: "search", class: "cm-wfind", placeholder: "모은 글 찾아 넣기 (제목·작성자)", "aria-label": "모은 글 찾기", autocomplete: "off" });
  const found = el("div", { class: "cm-wfound", hidden: "" });
  const sug = el("div", { class: "cm-wsug", hidden: "" });
  const file = el("input", { type: "file", accept: "image/*", multiple: "", hidden: "" });
  const pick = el("button", { type: "button", class: "cm-pick", text: "사진 추가" });
  const thumbs = el("div", { class: "cm-thumbs" });
  const tagBox = el("div", { class: "cm-wtags" });
  const tagAdd = el("button", { type: "button", class: "cm-tadd", "aria-expanded": "false" });
  const tagQ = el("input", { type: "search", class: "cm-tpq", placeholder: "그룹·계정 찾기", "aria-label": "태그할 그룹·계정 찾기", autocomplete: "off" });
  const tagDone = el("button", { type: "button", class: "cm-tpdone", text: "완료" });
  const tagList = el("div", { class: "cm-tplist" });
  const tagPick = el("div", { class: "cm-tpick", hidden: "" }, [el("div", { class: "cm-tptop" }, [tagQ, tagDone]), tagList]);
  const err = el("p", { class: "error", hidden: "" });
  const drawThumbs = () => {
    thumbs.textContent = "";
    cmW.imgs.forEach((src, i) => {
      const x = el("button", { type: "button", class: "cm-tx", text: "×", "aria-label": "사진 빼기" });
      x.addEventListener("click", () => { cmW.imgs.splice(i, 1); drawThumbs(); });
      thumbs.appendChild(el("span", { class: "cm-th" }, [el("img", { src, alt: "" }), x]));
    });
    pick.disabled = cmW.imgs.length >= CM_IMG_MAX;
    pick.textContent = "사진 추가 (" + cmW.imgs.length + "/" + CM_IMG_MAX + ")";
  };
  // 태그: 계정 하나씩, 또는 그룹을 눌러 그 그룹 계정을 한 번에. 그룹 계정이 모두 태그되면 그룹 칩 하나로 묶어 보입니다.
  const myAccs = () => tracked.filter((t) => t.kind !== "feed");
  const myGroups = () => {
    const m = new Map();
    myAccs().forEach((t) => { if (t.group) { if (!m.has(t.group)) m.set(t.group, []); m.get(t.group).push(t); } });
    return [...m].map(([name, accs]) => ({ name, accs }));
  };
  const hasTag = (id) => cmW.tags.some((x) => x.id === id);
  const accTag = (t) => ({ id: t.id, platform: t.platform, label: cmAcctLabel(t) });
  const redraw = () => { drawTags(); drawSug(); drawPick(); };
  const addTags = (list) => {
    const add = list.filter((t, i) => t && !hasTag(t.id) && list.findIndex((y) => y && y.id === t.id) === i);
    if (!add.length) return;
    if (cmW.tags.length + add.length > CM_TAG_MAX) {
      toast("태그는 " + CM_TAG_MAX + "개까지 넣을 수 있습니다" + (add.length > 1 ? "(지금 " + cmW.tags.length + "개 + 이 그룹 " + add.length + "개)" : "") + ".", "error");
      return;
    }
    add.forEach((t) => cmW.tags.push({ id: t.id, platform: t.platform, label: t.label }));
    redraw();
  };
  const addTag = (t) => addTags([t]);
  const dropTags = (ids) => { const s = new Set(ids); cmW.tags = cmW.tags.filter((x) => x.lock || !s.has(x.id)); redraw(); };
  const xBtn = (label, fn) => { const x = el("button", { type: "button", class: "cm-tx", text: "×", "aria-label": label + " 태그 빼기" }); x.addEventListener("click", fn); return x; };
  const drawTags = () => {
    tagBox.textContent = "";
    tagBox.appendChild(el("span", { class: "cm-wl", text: "태그 " + cmW.tags.length + "/" + CM_TAG_MAX }));
    const used = new Set();
    myGroups().forEach((g) => {
      if (g.accs.length < 2 || !g.accs.every((t) => hasTag(t.id))) return;
      const tags = cmW.tags.filter((x) => g.accs.some((t) => t.id === x.id));
      tags.forEach((x) => used.add(x.id));
      const lock = tags.every((x) => x.lock);
      const c = el("span", { class: "cm-chip grp" + (lock ? " lock" : ""), title: tags.map((x) => x.label).join(", ") + (lock ? " (지금 보고 있는 커뮤니티라 뺄 수 없음)" : "") }, [
        el("i", { class: "cm-gtag", text: "그룹" }), el("span", { text: g.name + " · " + tags.length + "개" }),
      ]);
      if (!lock) c.appendChild(xBtn(g.name + " 그룹", () => dropTags(g.accs.map((t) => t.id))));
      tagBox.appendChild(c);
    });
    cmW.tags.filter((t) => !used.has(t.id)).forEach((t) => {
      const c = el("span", { class: "cm-chip" + (t.lock ? " lock" : ""), title: t.lock ? "지금 보고 있는 커뮤니티의 계정(뺄 수 없음)" : "" }, [pIcon(t.platform), el("span", { text: t.label })]);
      if (!t.lock) c.appendChild(xBtn(t.label, () => dropTags([t.id])));
      tagBox.appendChild(c);
    });
    if (!cmW.tags.length) tagBox.appendChild(el("span", { class: "cm-wnone", text: "태그 없음 · 전체 커뮤니티에만 보입니다" }));
    tagAdd.textContent = tagPick.hidden ? "＋ 그룹·계정 태그" : "고르기 닫기";
    tagAdd.setAttribute("aria-expanded", String(!tagPick.hidden));
    tagAdd.hidden = !myAccs().length;
    tagBox.appendChild(tagAdd);
  };
  // 태그 고르기 칸: 그룹(눌러서 한 번에 넣기·빼기)과 그 계정들, 그룹에 없는 계정. 위쪽 칸으로 찾기.
  const drawPick = () => {
    if (tagPick.hidden) return;
    tagList.textContent = "";
    const q = tagQ.value.trim().toLowerCase();
    const hit = (t) => !q || [cmAcctLabel(t), t.id, PLATFORM[t.platform]].join(" ").toLowerCase().includes(q);
    const accBtn = (t) => {
      const on = hasTag(t.id), lock = on && cmW.tags.find((x) => x.id === t.id).lock;
      const b = el("button", { type: "button", class: "cm-tpa" + (on ? " on" : ""), "aria-pressed": String(on), title: lock ? "지금 보고 있는 커뮤니티의 계정(뺄 수 없음)" : on ? "태그 빼기" : "태그하기" }, [pIcon(t.platform), el("span", { text: cmAcctLabel(t) })]);
      if (lock) b.disabled = true;
      b.addEventListener("click", () => (hasTag(t.id) ? dropTags([t.id]) : addTag(accTag(t))));
      return b;
    };
    const groups = myGroups().filter((g) => !q || g.name.toLowerCase().includes(q) || g.accs.some(hit));
    if (groups.length) tagList.appendChild(el("p", { class: "cm-tph", text: "그룹 · 이름을 누르면 그룹의 계정을 한 번에 넣거나 뺍니다" }));
    groups.forEach((g) => {
      const n = g.accs.filter((t) => hasTag(t.id)).length, all = n === g.accs.length;
      const locked = g.accs.every((t) => { const x = cmW.tags.find((y) => y.id === t.id); return x && x.lock; });
      const head = el("button", { type: "button", class: "cm-tpg" + (all ? " on" : n ? " part" : ""), "aria-pressed": all ? "true" : n ? "mixed" : "false",
        title: locked ? "지금 보고 있는 커뮤니티의 그룹(뺄 수 없음)" : all ? "이 그룹의 태그를 모두 뺍니다" : "이 그룹의 계정 " + g.accs.length + "개를 모두 태그합니다" }, [
        el("span", { class: "ck", "aria-hidden": "true", text: all ? "✓" : n ? "−" : "" }), el("b", { text: g.name }), el("span", { class: "cnt", text: n + "/" + g.accs.length }),
      ]);
      if (locked) head.disabled = true;
      head.addEventListener("click", () => (all ? dropTags(g.accs.map((t) => t.id)) : addTags(g.accs.map(accTag))));
      const accs = q && !g.name.toLowerCase().includes(q) ? g.accs.filter(hit) : g.accs;
      tagList.appendChild(el("div", { class: "cm-tprow" }, [head, el("div", { class: "cm-tpaccs" }, accs.map(accBtn))]));
    });
    const singles = myAccs().filter((t) => !t.group && hit(t));
    if (singles.length) {
      tagList.appendChild(el("p", { class: "cm-tph", text: "그룹에 없는 계정" }));
      tagList.appendChild(el("div", { class: "cm-tprow" }, [el("div", { class: "cm-tpaccs" }, singles.map(accBtn))]));
    }
    if (!groups.length && !singles.length) tagList.appendChild(el("p", { class: "cm-wnone", text: "찾는 그룹·계정이 없습니다." }));
  };
  // 고르기 칸을 열면 글쓰기 칸을 키우고(picking), 태그 줄부터 고르기 칸 끝까지 한눈에 보이게 맞춥니다.
  const showPick = () => {
    const w = $("cmWrite"), wr = w.getBoundingClientRect(), tb = tagBox.getBoundingClientRect(), pb = tagPick.getBoundingClientRect();
    if (w.scrollHeight > w.clientHeight + 1) {   // 넓은 화면: 글쓰기 칸 안에서 스크롤
      const d = Math.min(pb.bottom - wr.bottom + 8, tb.top - wr.top - 8);
      if (d > 0) w.scrollTop += d;
    } else {                                     // 좁은 화면: 페이지를 스크롤
      const d = Math.min(pb.bottom - window.innerHeight + 16, tb.top - 80);
      if (d > 0) window.scrollBy(0, d);
    }
  };
  const openPick = (on) => {
    tagPick.hidden = !on;
    $("cmWrite").classList.toggle("picking", on);
    if (on) { tagQ.value = ""; drawPick(); setTimeout(() => tagQ.focus({ preventScroll: true }), 0); }
    drawTags();
    if (on) setTimeout(showPick, 0);
  };
  tagAdd.addEventListener("click", () => openPick(tagPick.hidden));
  tagDone.addEventListener("click", () => { openPick(false); tagAdd.focus(); });
  tagQ.addEventListener("input", drawPick);
  tagQ.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault();
    if (e.key === "Escape") { e.stopPropagation(); if (tagQ.value) { tagQ.value = ""; drawPick(); } else { openPick(false); tagAdd.focus(); } }
  });
  // 링크 중 이미 모은 글: '모은 글 n개 · 카드로 보입니다' + 그 글 계정을 태그로 제안
  const drawSug = () => {
    sug.textContent = "";
    const items = cmParseLinks(links.value).map((u) => cmW.found[u]).filter(Boolean);
    if (!items.length) { sug.hidden = true; return; }
    sug.appendChild(el("span", { class: "hint", text: "모은 글 " + items.length + "개 · 글에서 썸네일 카드로 보입니다" }));
    const seen = new Set();
    items.map(cmItemTag).filter((t) => t && !seen.has(t.id) && seen.add(t.id) && !cmW.tags.some((x) => x.id === t.id)).forEach((t) => {
      const b = el("button", { type: "button", class: "cm-chip go sug", title: "이 계정을 태그합니다" }, [document.createTextNode("＋"), pIcon(t.platform), el("span", { text: t.label + " 태그" })]);
      b.addEventListener("click", () => addTag(t));
      sug.appendChild(b);
    });
    sug.hidden = false;
  };
  let lookT = 0, lookGen = 0;
  const lookup = () => {
    clearTimeout(lookT);
    lookT = setTimeout(async () => {
      const urls = cmParseLinks(links.value).filter((u) => !(u in cmW.found)).slice(0, CM_LINK_MAX);
      if (urls.length) {
        const g = ++lookGen;
        let res = {};
        try { res = await cmCall("lookup", { urls }); } catch (e) { return; }
        if (g !== lookGen || !cmW) return;
        urls.forEach((u) => { cmW.found[u] = res[u] || null; });
      }
      if (cmW) drawSug();
    }, 350);
  };
  links.addEventListener("input", lookup);
  let findT = 0, findGen = 0;
  find.addEventListener("input", () => {
    clearTimeout(findT);
    const q = find.value.trim();
    if (!q) { found.hidden = true; found.textContent = ""; return; }
    findT = setTimeout(async () => {
      const g = ++findGen;
      let list = [];
      try { list = await cmCall("findItems", { q }); } catch (e) { return; }
      if (g !== findGen || !cmW) return;
      found.textContent = "";
      if (!list.length) found.appendChild(el("p", { class: "cm-empty sm", text: "찾는 글이 없습니다(이미 모은 글에서만 찾습니다)." }));
      list.forEach((it) => {
        const b = el("button", { type: "button", class: "cm-fitem" }, [
          ...(it.thumb && thumbOk(it.thumb) ? [el("img", { src: it.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })] : [el("span", { class: "cm-fnoimg" })]),
          el("span", { class: "cm-iinfo" }, [el("b", { text: it.title || it.url }), el("span", { class: "cm-imeta" }, [pIcon(cmSrcPlat(it.source) || "youtube"), el("span", { text: it.author || "" })])]),
        ]);
        b.addEventListener("click", () => {
          const cur = cmParseLinks(links.value);
          if (!cur.includes(it.url)) {
            if (cur.length >= CM_LINK_MAX) { toast("링크는 " + CM_LINK_MAX + "개까지 넣을 수 있습니다.", "error"); return; }
            links.value = [...cur, it.url].join(" ");
          }
          cmW.found[it.url] = it;
          addTag(cmItemTag(it));
          find.value = ""; found.hidden = true; found.textContent = "";
          drawSug();
        });
        found.appendChild(b);
      });
      found.hidden = false;
    }, 300);
  });
  find.addEventListener("keydown", (e) => { if (e.key === "Escape" && find.value) { e.stopPropagation(); find.value = ""; found.hidden = true; } if (e.key === "Enter") e.preventDefault(); });
  pick.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    for (const f of [...file.files]) {
      if (cmW.imgs.length >= CM_IMG_MAX) { toast("사진은 " + CM_IMG_MAX + "장까지 붙일 수 있습니다."); break; }
      const d = await cmShrink(f);
      if (d && cmW) cmW.imgs.push(d); else if (!d) toast("‘" + f.name + "’은(는) 사진으로 읽을 수 없습니다.", "error");
    }
    file.value = "";
    if (cmW) drawThumbs();
  });
  const cancel = el("button", { type: "button", text: "취소" });
  const go = el("button", { type: "submit", class: "primary", text: ed ? "저장" : "등록" });
  cancel.addEventListener("click", cmCloseWrite);
  const form = el("form", { class: "cm-form" + (ed ? " editing" : "") }, [
    ...(ed ? [el("p", { class: "cm-wmode", text: "글 수정 · ‘" + ed.title + "’" })] : opts.share ? [el("p", { class: "cm-wmode", text: "커뮤니티에 공유 · 링크와 계정 태그를 채워 두었습니다" })] : []),
    el("div", { class: "cm-frow" }, [cat, title]), text, links,
    el("div", { class: "cm-wfindbox" }, [find, found]), sug,
    el("div", { class: "cm-frow" }, [pick, file, thumbs]), tagBox, tagPick, err,
    el("div", { class: "cm-frow end" }, [cancel, go]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!title.value.trim()) { title.focus(); return; }
    if (!text.value.trim()) { text.focus(); return; }
    const linkList = cmParseLinks(links.value);
    if (linkList.length > CM_LINK_MAX) { err.textContent = "링크는 " + CM_LINK_MAX + "개까지 넣을 수 있습니다."; err.hidden = false; return; }
    go.disabled = true; err.hidden = true;
    const body = { cat: cat.value, title: title.value, body: text.value, links: linkList, imgs: cmW.imgs, tags: cmW.tags.map((t) => ({ id: t.id, label: t.label })) };
    try {
      if (cmW.edit) {
        const p = await cmCall("edit", Object.assign({ id: cmW.edit }, body), 30000);
        cmCloseWrite();
        cmPatch(p.id, p);
        toast("글을 수정했습니다.");
        cmRender();
        return;
      }
      const p = await cmCall("write", body, 30000);
      cmCloseWrite();
      if (cmView.t === "list") { toast("글을 올렸습니다. 전체 커뮤니티에서 볼 수 있습니다."); cmGo({ t: "all" }, p.id); return; }
      // 스크랩만 보는 중에 쓴 글: 새 글은 스크랩 전이라 안 보이므로, 그 커뮤니티의 모든 글 보기로 가서 펼칩니다
      if (cmView.sc) { const n = { ...cmView }; delete n.sc; toast("글을 올렸습니다."); cmGo(n, p.id); return; }
      cmCat = ""; cmQ = ""; cmTagF = null; $("cmFind").value = ""; cmOpenId = p.id; cmCmts[p.id] = [];
      toast("글을 올렸습니다.");
      cmSyncHash(false);
      cmLoad();
    } catch (er) { go.disabled = false; err.textContent = er.message; err.hidden = false; }
  });
  box.textContent = ""; box.appendChild(form); box.hidden = false;
  drawThumbs(); drawTags();
  if (links.value) lookup();
  if (ed) box.scrollIntoView({ block: "start", behavior: "smooth" });
  title.focus({ preventScroll: !!ed });
}

/* ---------- 홈 자세히보기 → 커뮤니티에 공유 ---------- */
// 그 글의 계정이 내 그룹에 있으면 그 그룹 커뮤니티에서, 아니면 전체 커뮤니티에서 글쓰기를 엽니다(링크·계정 태그를 채워서).
function cmShareItem(it) {
  if (!connected || !it) return;
  const acc = trackedOf(it.via);
  const g = acc ? cmGroupOf(acc.id) : null;
  cmGo(cmGrpView(g));
  cmOpenWrite({ share: { url: it.url, item: it } });
}

/* ---------- 버튼 연결 ---------- */
(function () {
  $("navCommunity").addEventListener("click", () => {
    // 다른 화면에서 오면 보던 커뮤니티 그대로, 커뮤니티 안에서 다시 누르면 커뮤니티 목록으로
    if (page === "community") cmGo({ t: "list" });
    else goPage("community");
    window.scrollTo(0, 0);
  });
  $("cmBack").addEventListener("click", () => { if (cmQ || $("cmFind").value) { cmQ = ""; $("cmFind").value = ""; } cmGo({ t: "list" }); });
  $("cmNew").addEventListener("click", () => { if (cmW && !cmW.edit) cmCloseWrite(); else cmOpenWrite(); });
  $("cmBell").addEventListener("click", (e) => { e.stopPropagation(); cmToggleNotif(); });
  $("cmScrap").querySelector(".ic").innerHTML = CM_STAR;
  $("cmScrap").addEventListener("click", () => {
    const v = cmView;
    if (v.t === "all" || v.t === "grp") { const n = { ...v }; if (v.sc) delete n.sc; else n.sc = true; cmGo(n); }
    else cmGo({ t: "all", sc: true });   // 커뮤니티 목록에서는 전체 커뮤니티의 스크랩(#c/all/s)으로
  });
  $("vShare").addEventListener("click", () => { const it = viewCtx[viewIdx]; if (!it) return; closeViewer(); cmShareItem(it); });
  let t = 0;
  $("cmFind").addEventListener("input", () => {
    if (cmView.t === "list") { cmRenderList(); return; }
    clearTimeout(t);
    t = setTimeout(() => { const v = $("cmFind").value.trim(); if (v === cmQ) return; cmQ = v; cmOpenId = 0; cmPosts = []; cmSyncHash(false); cmLoad(); }, 300);
  });
  $("cmFind").addEventListener("keydown", (e) => { if (e.key === "Escape" && $("cmFind").value) { e.stopPropagation(); $("cmFind").value = ""; $("cmFind").dispatchEvent(new Event("input")); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("cmNotif").hidden) { e.stopPropagation(); cmCloseNotif(); } }, true);
})();
