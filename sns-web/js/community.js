/* ---------- 커뮤니티 : 모든 사용자가 같이 보는 게시판 ----------
   서버 /api/community(server/community.py)에 저장합니다(app.db의 cm_ 표). 이 브라우저에는 아무것도 남기지 않습니다.
   - 목록 화면: '전체 커뮤니티' 카드 + 홈에 보이는 그룹마다 카드 하나(그 그룹 계정 중 하나라도 태그된 글 수·마지막 글)
   - 글 화면: 분류 단추 · 글 검색 · 글쓰기 · 글 목록. 글을 누르면 펼쳐져 본문·사진·링크·태그·댓글이 보입니다.
   - 글의 태그는 SNS 계정 ID(예: x:handle)라서, 같은 계정을 추적하는 다른 사용자의 그룹 커뮤니티에도 같은 글이 보입니다.
   - '공지'는 관리자만 쓰고 맨 위에 붙습니다. 좋아요가 일정 수(서버의 HOT_MIN) 이상이면 '인기글'입니다.
   홈의 사람별 그룹 머리줄에 있는 말풍선 버튼(cmBtn)을 누르면 그 그룹의 커뮤니티로 바로 갑니다. */
const CM_CATS = ["질문", "팁", "건의", "잡담"];
const CM_NOTICE = "공지", CM_HOT = "인기글";
const CM_IMG_MAX = 4, CM_IMG_SIDE = 1280, CM_IMG_BYTES = 650000;
const CM_BUBBLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-7.5L7 20.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

// 보기 상태. cmView: {t:"list"} 커뮤니티 목록 / {t:"all"} 전체 / {t:"grp", key, name, ids} 그룹 커뮤니티
let cmView = { t: "list" }, cmCat = "", cmQ = "", cmPosts = [], cmHot = [], cmMore = false, cmCounts = {};
let cmOpenId = 0, cmCmts = {}, cmReply = null, cmDraft = {}, cmMe = "", cmAdmin = false, cmHotMin = 3, cmSum = null, cmGen = 0, cmBusy = false;

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
function cmOpenGroup(g) {
  cmView = g ? { t: "grp", key: g.key, name: g.name, ids: g.ids } : { t: "all" };
  cmCat = ""; cmQ = ""; cmOpenId = 0; cmReply = null;
  $("cmFind").value = "";
  if (page !== "community") { page = "community"; applyPage(); } // applyPage → cmShown(true)가 불러옵니다
  else cmLoad();
  window.scrollTo(0, 0);
}
// 홈의 사람별 그룹 머리줄에 붙는 '커뮤니티' 버튼
function cmBtn(r) {
  const b = el("button", { type: "button", class: "pcomm", title: "이 그룹의 커뮤니티 글 보기", "aria-label": dispName(r) + " 커뮤니티" });
  b.innerHTML = CM_BUBBLE;
  b.addEventListener("click", (e) => { e.stopPropagation(); const g = cmGroups().find((x) => x.key === r.name); cmOpenGroup(g || null); });
  return b;
}

/* ---------- 불러오기 ---------- */
// 커뮤니티 화면이 보이거나 사라질 때(bridge.js의 applyPage)
function cmShown(on) {
  if (!on) { cmCloseWrite(); return; }
  cmLoad();
}
async function cmLoad(more) {
  const gen = ++cmGen;
  if (cmView.t === "list") {
    cmRender();
    try {
      const groups = cmGroups().map((g) => ({ key: g.key, ids: g.ids }));
      const res = await cmCall("summary", { groups });
      if (gen !== cmGen) return;
      cmSum = res; cmRender();
    } catch (e) { if (gen === cmGen) { cmSum = null; cmRender(); showErr(e); } }
    return;
  }
  if (!more) cmRender(true);
  try {
    const res = await cmCall("list", { ids: cmView.t === "grp" ? cmView.ids : [], cat: cmCat, q: cmQ, offset: more ? cmPosts.length : 0 });
    if (gen !== cmGen) return;
    cmMe = res.me; cmAdmin = res.admin; cmHotMin = res.hotMin; cmCounts = res.counts; cmMore = res.more;
    if (more) { const have = new Set(cmPosts.map((p) => p.id)); cmPosts = cmPosts.concat(res.posts.filter((p) => !have.has(p.id))); }
    else { cmPosts = res.posts; cmHot = res.hot || []; }
    cmRender();
    if (cmOpenId && !cmCmts[cmOpenId]) cmLoadCmts(cmOpenId);
  } catch (e) { if (gen === cmGen) { cmRender(); showErr(e); } }
}
async function cmLoadCmts(id) {
  try { cmCmts[id] = await cmCall("comments", { id }); }
  catch (e) { showErr(e); if (/없는 글/.test(e.message)) { cmOpenId = 0; cmLoad(); return; } }
  cmRender();
}
// 다른 탭에 갔다가 돌아오면(글쓰기 중이 아니면) 새 글·댓글을 다시 읽습니다.
document.addEventListener("visibilitychange", () => {
  if (document.hidden || page !== "community" || $("communityPanel").hidden || !$("cmWrite").hidden) return;
  const a = document.activeElement;
  if (a && a.closest && a.closest("#cmList input")) return;   // 댓글을 쓰는 중이면 그대로 둠
  cmLoad();
  if (cmOpenId) cmLoadCmts(cmOpenId);
});

/* ---------- 그리기 ---------- */
function cmRender(loading) {
  const list = cmView.t === "list";
  $("cmBack").hidden = list;
  $("cmCats").hidden = list;
  $("cmNew").hidden = list;
  $("cmFind").placeholder = list ? "커뮤니티 찾기 (그룹 이름·@아이디)" : "글 검색 (제목·내용·쓴 사람·태그)";
  $("cmFind").setAttribute("aria-label", $("cmFind").placeholder);
  const h = $("cmTitle");
  h.textContent = list ? "커뮤니티" : cmView.t === "all" ? "전체 커뮤니티" : cmView.name;
  h.title = h.textContent;
  if (list) { cmRenderList(); return; }
  cmRenderCats();
  const box = $("cmList");
  box.textContent = ""; box.className = "cm-list";
  const n = cmCounts[cmCat] || 0;
  $("cmCount").textContent = loading && !cmPosts.length ? "" : (cmQ ? "검색 결과 " : "글 ") + n + "개";
  if (loading && !cmPosts.length) { box.appendChild(el("p", { class: "cm-empty", text: "불러오는 중…" })); return; }
  const hot = !cmCat && !cmQ ? cmHot : [];
  const hotIds = new Set(hot.map((p) => p.id));
  const rest = cmPosts.filter((p) => !hotIds.has(p.id));
  if (!hot.length && !rest.length) {
    box.appendChild(el("p", { class: "cm-empty", text: cmQ ? "검색 결과가 없습니다." : cmCat ? "이 분류에는 아직 글이 없습니다." : "아직 글이 없습니다. 첫 글을 써 보세요." }));
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
  const sum = cmSum || { all: null, groups: {} };
  const info = (s) => (s ? el("span", { class: "cm-cmeta", text: "글 " + s.n + "개" + (s.last ? " · " + cmAgo(s.last.at) : "") }) : el("span", { class: "cm-cmeta", text: cmSum ? "글 0개" : "…" }));
  const last = (s) => el("span", { class: "cm-clast", text: s && s.last ? s.last.title : "아직 글이 없습니다" });
  const card = (face, name, meta, s, go, extra) => {
    const c = el("button", { type: "button", class: "cm-comm" }, [face, el("span", { class: "cm-cinfo" }, [el("span", { class: "cm-ctop" }, [el("b", { class: "cm-cname", text: name }), ...(extra || [])]), meta, last(s)])]);
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
    box.appendChild(card(face, "전체 커뮤니티", info(sum.all), sum.all, () => cmOpenGroup(null)));
  }
  shown.forEach((g) => {
    const chosen = g.accs.find((t) => t.platform === picPick[g.key]) || g.accs.find((t) => picMap[t.id]) || g.accs[0];
    const face = el("span", { class: "cm-cface" }, [picFace(chosen, g.name.replace(/^@/, ""), "pface")]);
    const plats = el("span", { class: "cm-cplats" }, platOrder([...new Set(g.accs.map((t) => t.platform))]).map((p) => pIcon(p)));
    const s = sum.groups[g.key];
    box.appendChild(card(face, g.name, el("span", { class: "cm-cmeta" }, [plats, info(s)]), s, () => cmOpenGroup(g), g.accs.length > 1 ? [el("i", { class: "cm-gtag", text: "그룹" })] : []));
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
    b.addEventListener("click", () => { if (cmCat === k) return; cmCat = k; cmOpenId = 0; cmPosts = []; cmLoad(); });
    bar.appendChild(b);
  });
}

// 계정 태그 칩. 내가 추적 중인(홈에 보이는) 계정이면 누르면 그 그룹 커뮤니티로 갑니다.
function cmTagEl(t) {
  const g = cmGroupOf(t.id);
  const mine = trackedOf(t.id);
  const label = mine ? cmAcctLabel(mine) : t.label || t.id.split(":").slice(1).join(":");
  const kids = [pIcon(t.platform), el("span", { text: label })];
  if (!g) return el("span", { class: "cm-chip", title: PLATFORM[t.platform] + " " + label }, kids);
  const b = el("button", { type: "button", class: "cm-chip go", title: g.name + " 커뮤니티로" }, kids);
  b.addEventListener("click", (e) => { e.stopPropagation(); cmOpenGroup(g); });
  return b;
}

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

function cmPostEl(p, asHot) {
  const open = cmOpenId === p.id;
  const art = el("article", { class: "cm-post" + (open ? " open" : "") + (p.cat === CM_NOTICE ? " notice" : "") + (asHot || (cmCat === CM_HOT && p.hot) ? " hot" : "") });
  // 그룹 커뮤니티 안에서는 그 그룹 계정 태그를 제목 줄에서 뺍니다(펼치면 모두 보임)
  const inView = new Set(cmView.t === "grp" ? cmView.ids : []);
  const headTags = p.tags.filter((t) => !inView.has(t.id));
  const tagEls = headTags.slice(0, 2).map((t) => { const c = cmTagEl(t); c.classList.add("sm"); return c; });
  if (headTags.length > 2) tagEls.push(el("span", { class: "cm-chip sm more", text: "+" + (headTags.length - 2) }));
  const marks = (p.imgs.length ? "사진 " + p.imgs.length + " · " : "") + (p.links.length ? "링크 · " : "");
  const head = el("div", { class: "cm-head", role: "button", tabindex: "0", "aria-expanded": String(open) }, [
    el("span", { class: "cm-tag", text: asHot || (cmCat === CM_HOT && p.hot) ? CM_HOT : p.cat }),
    el("span", { class: "cm-ttl" }, [el("b", { text: p.title }), ...tagEls]),
    el("span", { class: "cm-meta", title: cmDate(p.at), text: marks + p.author + " · " + cmAgo(p.at) }),
    el("span", { class: "cm-nums" }, [el("span", { class: "cm-lk" + (p.liked ? " on" : ""), text: "♥ " + p.likes }), el("span", { class: "cm-cn", text: "댓글 " + p.comments })]),
  ]);
  const toggle = () => {
    cmOpenId = open ? 0 : p.id; cmReply = null;
    cmRender();
    if (cmOpenId && !cmCmts[cmOpenId]) cmLoadCmts(cmOpenId);
  };
  head.addEventListener("click", (e) => { if (!e.target.closest("button")) toggle(); });
  head.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === head) { e.preventDefault(); toggle(); } });
  art.appendChild(head);
  if (open) art.appendChild(cmOpenEl(p));
  return art;
}

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
  if (p.links.length) body.appendChild(el("div", { class: "cm-links" }, p.links.map(cmLinkEl)));
  if (p.tags.length) body.appendChild(el("div", { class: "cm-tags" }, p.tags.map(cmTagEl)));
  // 좋아요 · 지우기
  const like = el("button", { type: "button", class: "cm-like" + (p.liked ? " on" : ""), "aria-pressed": String(p.liked), text: "♥ 좋아요 " + p.likes });
  if (p.mine) { like.disabled = true; like.title = "내 글에는 좋아요를 누를 수 없습니다"; }
  like.addEventListener("click", async () => {
    like.disabled = true;
    try { Object.assign(p, await cmCall("like", { id: p.id, on: !p.liked })); [...cmPosts, ...cmHot].filter((x) => x.id === p.id).forEach((x) => Object.assign(x, { likes: p.likes, liked: p.liked, hot: p.hot })); cmRender(); }
    catch (e) { like.disabled = false; showErr(e); }
  });
  const acts = el("div", { class: "cm-acts" }, [like]);
  if (p.canDel) {
    const del = el("button", { type: "button", class: "cm-del", text: p.mine ? "글 지우기" : "글 지우기(관리자)" });
    del.addEventListener("click", async () => {
      if (!(await confirmBox({ title: "글을 지울까요?", text: "‘" + p.title + "’ 글과 댓글·사진이 모두 지워집니다. 되돌릴 수 없습니다.", ok: "지우기" }))) return;
      try { await cmCall("delete", { id: p.id }); cmOpenId = 0; toast("글을 지웠습니다."); cmLoad(); } catch (e) { showErr(e); }
    });
    acts.appendChild(del);
  }
  body.appendChild(acts);
  body.appendChild(cmCommentsEl(p));
  return body;
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
      p.comments = cmCmts[p.id].filter((c) => !c.deleted).length;
      cmRender();
    } catch (er) { ok.disabled = false; showErr(er); }
  });
  return f;
}
function cmCommentsEl(p) {
  const wrap = el("div", { class: "cm-cmts" });
  const all = cmCmts[p.id];
  if (!all) { wrap.appendChild(el("p", { class: "cm-empty sm", text: "댓글을 불러오는 중…" })); return wrap; }
  const top = all.filter((c) => !c.parent);
  const line = (c) => {
    const row = el("div", { class: "cm-cmt" + (c.parent ? " reply" : "") + (c.deleted ? " gone" : "") });
    if (c.deleted) { row.appendChild(el("span", { class: "cm-cbody", text: "지운 댓글입니다." })); return row; }
    row.append(el("b", { text: c.author }), el("span", { class: "cm-cbody", text: c.body }), el("em", { title: cmDate(c.at), text: cmAgo(c.at) }));
    const rb = el("button", { type: "button", class: "cm-rbtn", text: "답글" });
    rb.addEventListener("click", () => { cmReply = { post: p.id, parent: c.parent || c.id, to: c.parent ? c.author : "" }; cmRender(); });
    row.appendChild(rb);
    if (c.canDel) {
      const db = el("button", { type: "button", class: "cm-rbtn danger", text: "지우기" });
      db.addEventListener("click", async () => {
        if (!(await confirmBox({ title: "댓글을 지울까요?", text: "되돌릴 수 없습니다. 답글이 달린 댓글은 ‘지운 댓글’로 남습니다.", ok: "지우기" }))) return;
        try { cmCmts[p.id] = await cmCall("delComment", { id: c.id }); p.comments = cmCmts[p.id].filter((x) => !x.deleted).length; cmRender(); } catch (e) { showErr(e); }
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

/* ---------- 글쓰기 ---------- */
let cmW = null; // 쓰는 중인 글: { tags: [{id, platform, label, lock}], imgs: [dataURL] }
function cmCloseWrite() { cmW = null; $("cmWrite").hidden = true; $("cmWrite").textContent = ""; $("cmNew").classList.remove("on"); }
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
function cmOpenWrite() {
  const box = $("cmWrite");
  if (cmW) { $("cmWTitle").focus(); return; }
  const lock = cmView.t === "grp" ? cmView.ids.map((id) => trackedOf(id)).filter(Boolean) : [];
  cmW = { tags: lock.map((t) => ({ id: t.id, platform: t.platform, label: cmAcctLabel(t), lock: true })), imgs: [] };
  $("cmNew").classList.add("on");
  const cat = el("select", { id: "cmWCat", "aria-label": "분류" });
  [...(cmAdmin ? [CM_NOTICE] : []), ...CM_CATS].forEach((c) => cat.appendChild(el("option", { value: c, text: c })));
  cat.value = cmCat && cmCat !== CM_HOT && (cmCat !== CM_NOTICE || cmAdmin) ? cmCat : "질문";
  const title = el("input", { id: "cmWTitle", type: "text", maxlength: "80", placeholder: "제목", "aria-label": "제목", autocomplete: "off" });
  const text = el("textarea", { id: "cmWBody", rows: "5", maxlength: "2000", placeholder: "내용을 적어 주세요", "aria-label": "내용" });
  const links = el("input", { id: "cmWLinks", type: "text", placeholder: "링크 (유튜브·X·인스타 등, 여러 개는 띄어쓰기로 · 최대 5개)", "aria-label": "링크", autocomplete: "off" });
  const file = el("input", { type: "file", accept: "image/*", multiple: "", hidden: "" });
  const pick = el("button", { type: "button", class: "cm-pick", text: "사진 추가" });
  const thumbs = el("div", { class: "cm-thumbs" });
  const tagBox = el("div", { class: "cm-wtags" });
  const addSel = el("select", { "aria-label": "태그할 계정 추가" });
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
  const drawTags = () => {
    tagBox.textContent = "";
    tagBox.appendChild(el("span", { class: "cm-wl", text: "태그" }));
    cmW.tags.forEach((t) => {
      const c = el("span", { class: "cm-chip" + (t.lock ? " lock" : ""), title: t.lock ? "지금 보고 있는 커뮤니티의 계정(뺄 수 없음)" : "" }, [pIcon(t.platform), el("span", { text: t.label })]);
      if (!t.lock) {
        const x = el("button", { type: "button", class: "cm-tx", text: "×", "aria-label": t.label + " 태그 빼기" });
        x.addEventListener("click", () => { cmW.tags = cmW.tags.filter((y) => y !== t); drawTags(); });
        c.appendChild(x);
      }
      tagBox.appendChild(c);
    });
    if (!cmW.tags.length) tagBox.appendChild(el("span", { class: "cm-wnone", text: "태그 없음 · 전체 커뮤니티에만 보입니다" }));
    addSel.textContent = "";
    addSel.appendChild(el("option", { value: "", text: "+ 계정 태그" }));
    const have = new Set(cmW.tags.map((t) => t.id));
    tracked.filter((t) => t.kind !== "feed" && !have.has(t.id)).forEach((t) => addSel.appendChild(el("option", { value: t.id, text: PLATFORM[t.platform] + " " + cmAcctLabel(t) + (t.group ? " · " + t.group : "") })));
    addSel.hidden = addSel.options.length < 2 || cmW.tags.length >= 10;
    tagBox.appendChild(addSel);
  };
  addSel.addEventListener("change", () => { const t = trackedOf(addSel.value); if (t) cmW.tags.push({ id: t.id, platform: t.platform, label: cmAcctLabel(t) }); drawTags(); });
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
  const go = el("button", { type: "submit", class: "primary", text: "등록" });
  cancel.addEventListener("click", cmCloseWrite);
  const form = el("form", { class: "cm-form" }, [
    el("div", { class: "cm-frow" }, [cat, title]), text, links,
    el("div", { class: "cm-frow" }, [pick, file, thumbs]), tagBox, err,
    el("div", { class: "cm-frow end" }, [cancel, go]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!title.value.trim()) { title.focus(); return; }
    if (!text.value.trim()) { text.focus(); return; }
    const linkList = [...new Set(links.value.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean).map((u) => (/^https?:\/\//i.test(u) ? u : "https://" + u)))];
    if (linkList.length > 5) { err.textContent = "링크는 5개까지 넣을 수 있습니다."; err.hidden = false; return; }
    go.disabled = true; err.hidden = true;
    try {
      const p = await cmCall("write", { cat: cat.value, title: title.value, body: text.value, links: linkList, imgs: cmW.imgs, tags: cmW.tags.map((t) => ({ id: t.id, label: t.label })) }, 30000);
      cmCloseWrite();
      cmCat = ""; cmQ = ""; $("cmFind").value = ""; cmOpenId = p.id; cmCmts[p.id] = [];
      toast("글을 올렸습니다.");
      cmLoad();
    } catch (er) { go.disabled = false; err.textContent = er.message; err.hidden = false; }
  });
  box.textContent = ""; box.appendChild(form); box.hidden = false;
  drawThumbs(); drawTags();
  title.focus();
}

/* ---------- 버튼 연결 ---------- */
(function () {
  $("navCommunity").addEventListener("click", () => {
    // 다른 화면에서 오면 보던 커뮤니티 그대로, 커뮤니티 안에서 다시 누르면 커뮤니티 목록으로
    if (page === "community") { cmView = { t: "list" }; cmOpenId = 0; cmCloseWrite(); $("cmFind").value = ""; cmLoad(); }
    else { page = "community"; applyPage(); }
    window.scrollTo(0, 0);
  });
  $("cmBack").addEventListener("click", () => {
    if (cmQ || $("cmFind").value) { cmQ = ""; $("cmFind").value = ""; }
    cmView = { t: "list" }; cmOpenId = 0; cmCat = ""; cmCloseWrite(); cmLoad();
  });
  $("cmNew").addEventListener("click", () => { if (cmW) cmCloseWrite(); else cmOpenWrite(); });
  let t = 0;
  $("cmFind").addEventListener("input", () => {
    if (cmView.t === "list") { cmRenderList(); return; }
    clearTimeout(t);
    t = setTimeout(() => { const v = $("cmFind").value.trim(); if (v === cmQ) return; cmQ = v; cmOpenId = 0; cmPosts = []; cmLoad(); }, 300);
  });
  $("cmFind").addEventListener("keydown", (e) => { if (e.key === "Escape" && $("cmFind").value) { e.stopPropagation(); $("cmFind").value = ""; $("cmFind").dispatchEvent(new Event("input")); } });
})();
