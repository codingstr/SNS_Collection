/* ---------- 목록 ---------- */
const rtf = new Intl.RelativeTimeFormat("ko", { numeric: "auto" });
function relative(ms) {
  const diff = (ms - Date.now()) / 1000;
  for (const [u, s] of [["day", 86400], ["hour", 3600], ["minute", 60]]) if (Math.abs(diff) >= s) return rtf.format(Math.round(diff / s), u);
  return "방금";
}
// 기간은 계정마다 따로 정합니다(계정에 days가 있으면 그 기간으로 가져오고 보여줍니다). 없는 계정은 기본 기간(periodDays)을 따릅니다.
let periodDays = 30;
const publishedMs = (it) => { const t = Date.parse(it.publishedAt || ""); return Number.isNaN(t) ? it.collectedAt : t; };
// 계정별 기간이 있으면 그 계정의 글은 그 기간으로, 없으면 맨 위 기간으로 거릅니다.
const inPeriod = (it) => {
  const t = it.via ? tracked.find((x) => x.id === it.via) : null;
  const d = (t && t.days) || periodDays;
  return !d || publishedMs(it) >= Date.now() - d * 86400000;
};

// 이미지: 외부 이미지를 막는 환경에서는 서버에 요청해 데이터로 받아 보여줍니다(보이는 카드만, 동시에 4장).
const imgCache = new Map(), imgQueue = [];
let imgActive = 0;
function pumpImg() {
  while (imgActive < 4 && imgQueue.length) {
    const { url, img } = imgQueue.shift();
    imgActive++;
    call("image", { url }, 20000)
      .then((v) => { imgCache.set(url, v || ""); v ? (img.src = v) : img.remove(); })
      .catch(() => { img.remove(); })
      .finally(() => { imgActive--; pumpImg(); });
  }
}

// 카드는 폭 240px 안팎인데 원본 썸네일(특히 인스타그램)은 1000px 이상이라, 큰 채로 올려 두면 메모리·디코딩 부담으로 스크롤이 끊깁니다.
// 한 번 받아서 폭 520px(2배 화면 대응)로 줄인 JPEG로 바꿔 쓰고, 같은 주소는 다시 받지 않습니다. 줄이기가 막히면(CORS 등) 원본을 그대로 씁니다.
const smallCache = new Map(); // 원본 주소 -> 줄인 그림 주소
const smallQueue = [];
let smallActive = 0;
function pumpSmall() {
  while (smallActive < 3 && smallQueue.length) {
    const { url, img } = smallQueue.shift();
    if (smallCache.has(url)) { if (img.isConnected) img.src = smallCache.get(url); continue; }
    smallActive++;
    const done = () => { smallActive--; pumpSmall(); };
    const direct = () => { if (img.isConnected) { img.addEventListener("error", () => img.remove(), { once: true }); img.src = url; } done(); };
    // 빠른 길: 받아서 줄이는 것(디코딩·인코딩)을 메인 화면 작업과 따로(비동기) 처리합니다. 안 되면 아래 기존 방식으로.
    if (typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function") {
      fetch(url, { mode: "cors", referrerPolicy: "no-referrer", credentials: "omit" })
        .then((r) => { if (!r.ok) throw new Error("http"); return r.blob(); })
        .then((blob) => createImageBitmap(blob, { resizeWidth: 520, resizeQuality: "medium" }))
        .then((bm) => {
          const oc = new OffscreenCanvas(bm.width, bm.height);
          oc.getContext("2d").drawImage(bm, 0, 0);
          if (bm.close) bm.close();
          return oc.convertToBlob({ type: "image/jpeg", quality: 0.82 });
        })
        .then((b2) => { const u = URL.createObjectURL(b2); smallCache.set(url, u); if (img.isConnected) img.src = u; done(); })
        .catch(() => slow());
      continue;
    }
    slow();
    continue;
    function slow() {
    const t = new Image();
    t.crossOrigin = "anonymous"; t.referrerPolicy = "no-referrer"; t.decoding = "async";
    t.onerror = direct;
    t.onload = () => {
      try {
        const w = Math.min(520, t.naturalWidth || 520);
        if (!t.naturalWidth || t.naturalWidth <= 560) { smallCache.set(url, url); if (img.isConnected) img.src = url; done(); return; } // 이미 작으면 그대로
        const c = document.createElement("canvas");
        c.width = w; c.height = Math.max(1, Math.round((t.naturalHeight * w) / t.naturalWidth));
        c.getContext("2d").drawImage(t, 0, 0, c.width, c.height);
        c.toBlob((b) => {
          if (!b) { direct(); return; }
          const u = URL.createObjectURL(b);
          smallCache.set(url, u);
          if (img.isConnected) img.src = u;
          done();
        }, "image/jpeg", 0.82);
      } catch (e) { direct(); }
    };
    t.src = url;
    }
  }
}
function loadSmall(url, img) {
  if (smallCache.has(url)) { img.src = smallCache.get(url); return; }
  smallQueue.push({ url, img });
  pumpSmall();
}
function loadImg(url, img) {
  // 일반 웹 주소에서는 이미지를 바로 불러옵니다. 외부 이미지가 막힌 곳(claude.ai 안)에서만 서버를 거칩니다.
  if (!window.claude) { if (/^https:\/\//.test(url || "")) loadSmall(url, img); else img.remove(); return; }
  if (!connected || !/^https:\/\//.test(url || "")) { img.remove(); return; }
  if (imgCache.has(url)) { const v = imgCache.get(url); v ? (img.src = v) : img.remove(); return; }
  imgQueue.push({ url, img });
  pumpImg();
}
// 화면 근처(위아래 약 1200px)의 그림만 메모리에 올리고, 멀어지면 내려놓습니다(인스타그램 252장처럼 큰 그림이 수백 장 쌓여 렉 걸리는 것 방지). 칸 크기는 16:9로 고정이라 다시 올려도 위치가 안 밀립니다.
const imgObserver = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    const img = e.target;
    if (e.isIntersecting) { if (!img.getAttribute("src") && img.isConnected) loadImg(img.dataset.src, img); }
    else if (img.getAttribute("src")) img.removeAttribute("src");
  });
}, { rootMargin: "1200px 0px" });

// 글 열기: 유튜브 영상·X·인스타그램 글은 이 페이지 안에서 바로 보고, 그 밖(유튜브 게시물 등)은 새 크롬 창으로 엽니다.
function embedFor(it) {
  if (window.claude) return null; // claude.ai 안에서는 다른 사이트를 끼워 넣을 수 없습니다
  const u = it.url || "";
  let m;
  if (it.source === "youtube-video" && (m = /[?&]v=([\w-]{11})/.exec(u))) return { src: "https://www.youtube-nocookie.com/embed/" + m[1] + "?autoplay=1&rel=0", ratio: "16 / 9" };
  if (it.source === "x" && (m = /\/status\/(\d+)/.exec(u))) return { src: "https://platform.twitter.com/embed/Tweet.html?id=" + m[1], h: 640 };
  if (it.source === "instagram" && (m = /instagram\.com\/(p|reel|tv)\/([\w-]+)/.exec(u))) return { src: "https://www.instagram.com/" + m[1] + "/" + m[2] + "/embed", h: 700 };
  return null;
}
function openWindow(url) { call("openWindow", { url }).catch(() => window.open(url, "_blank", "noopener")); }
let viewerUrl = "";
let viewCtx = [], viewIdx = -1;
// 누른 카드가 속한 줄(또는 격자)의 카드들을 이전/다음 이동 순서로 씁니다.
function setViewCtx(a, it) {
  const p = a.parentElement;
  viewCtx = p ? Array.from(p.children).filter((n) => n._item).map((n) => n._item) : [it];
  viewIdx = viewCtx.indexOf(it);
  if (viewIdx < 0) { viewCtx = [it]; viewIdx = 0; }
}
function updateNav() {
  const many = viewCtx.length > 1;
  $("vPrev").hidden = $("vNext").hidden = !many;
  $("vPrev").disabled = viewIdx <= 0;
  $("vNext").disabled = viewIdx >= viewCtx.length - 1;
}
function navView(d) {
  const n = viewIdx + d;
  if (n < 0 || n >= viewCtx.length) return;
  viewIdx = n;
  openItem(viewCtx[n]);
}
function closeViewer() { $("viewer").hidden = true; $("vBody").textContent = ""; }
const postCache = new Map();
function renderPost(p, it) {
  const wrap = el("div", { class: "post" });
  const head = el("div", { class: "ph2" });
  if (p.avatar) head.appendChild(el("img", { class: "av", src: p.avatar, alt: "", referrerpolicy: "no-referrer" }));
  head.appendChild(el("div", { class: "who" }, [el("b", { text: p.author || it.author || "" }), el("span", { text: [p.time || "", p.likes ? "좋아요 " + p.likes : ""].filter(Boolean).join(" · ") })]));
  wrap.appendChild(head);
  if (p.text) wrap.appendChild(el("div", { class: "txt", text: p.text }));
  if (p.video && /^[\w-]{11}$/.test(p.video.id || "")) {
    const box = el("div", { class: "vid" });
    if (window.claude) {
      box.appendChild(el("button", { type: "button", text: "▶ 첨부 영상 보기" + (p.video.title ? ": " + p.video.title : "") }));
      box.firstChild.addEventListener("click", () => openWindow("https://www.youtube.com/watch?v=" + p.video.id));
    } else {
      box.appendChild(el("iframe", { src: "https://www.youtube-nocookie.com/embed/" + p.video.id + "?rel=0", title: p.video.title || "첨부 영상", allow: "encrypted-media; picture-in-picture; fullscreen", allowfullscreen: "", referrerpolicy: "strict-origin-when-cross-origin" }));
    }
    wrap.appendChild(box);
  }
  if (p.images && p.images.length) {
    const g = el("div", { class: "imgs" });
    p.images.forEach((u) => g.appendChild(el("img", { src: u, alt: "", referrerpolicy: "no-referrer" })));
    wrap.appendChild(g);
  }
  return wrap;
}
async function openPost(it) {
  viewerUrl = it.url;
  updateNav();
  $("vTitle").textContent = it.author || "유튜브 게시물";
  const body = $("vBody");
  body.textContent = "";
  body.appendChild(el("p", { class: "hint", style: "padding:24px", text: "게시물을 불러오는 중… 크롬에서 탭이 잠깐 열렸다 닫힙니다." }));
  $("viewer").hidden = false;
  try {
    let p = postCache.get(it.url);
    if (!p) { p = await call("fetchPost", { url: it.url }, 45000); postCache.set(it.url, p); }
    if ($("viewer").hidden || viewerUrl !== it.url) return;
    body.textContent = "";
    body.appendChild(renderPost(p, it));
  } catch (e) {
    if (viewerUrl !== it.url) return;
    body.textContent = "";
    body.appendChild(el("p", { class: "error", style: "padding:24px", text: "게시물을 불러오지 못했습니다. " + (e && e.message ? e.message : "") + " 아래 버튼으로 원본을 열어 주세요." }));
  }
}
function openItem(it) {
  markSeen(it);
  if (it.source === "youtube-post" && /^https:\/\/www\.youtube\.com\/post\//.test(it.url || "")) { openPost(it); return; }
  const e = embedFor(it);
  if (!e) { openWindow(it.url); return; }
  viewerUrl = it.url;
  updateNav();
  $("vTitle").textContent = it.title || it.author || "";
  const f = el("iframe", { src: e.src, title: "글 보기", allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: "", referrerpolicy: "strict-origin-when-cross-origin" });
  if (e.ratio) f.style.aspectRatio = e.ratio; else f.style.height = e.h + "px";
  const body = $("vBody");
  body.textContent = "";
  body.appendChild(f);
  $("viewer").hidden = false;
}
$("vClose").addEventListener("click", closeViewer);
$("vPrev").addEventListener("click", () => navView(-1));
$("vNext").addEventListener("click", () => navView(1));
// 글 보기 창 바깥의 회색 영역에서 휠을 돌리면 이전/다음 글로 이동합니다(아래로 = 다음).
let wheelNavAt = 0;
$("viewer").addEventListener("wheel", (ev) => {
  if (ev.target.closest && ev.target.closest(".viewer")) return;
  ev.preventDefault();
  const now = Date.now();
  if (now - wheelNavAt < 450 || Math.abs(ev.deltaY) < 4) return;
  wheelNavAt = now;
  navView(ev.deltaY > 0 ? 1 : -1);
}, { passive: false });
document.addEventListener("keydown", (e) => {
  if ($("viewer").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || "";
  if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
  if (e.key === "ArrowLeft") navView(-1); else if (e.key === "ArrowRight") navView(1);
});
$("vWin").addEventListener("click", () => { openWindow(viewerUrl); });
$("viewer").addEventListener("click", (e) => { if (e.target === $("viewer")) closeViewer(); });


// 카드가 많을 때(검색 결과 등) 한꺼번에 수백 장을 그리면 이미지·레이어가 과해 화면이 깨지며 멈출 수 있어, 48장씩 스크롤에 맞춰 이어서 그립니다.

let backCtx = null; // 매체 이름을 눌러 들어오기 전 화면(돌아가기용)
// "352건 · 인스타그램·X·유튜브": 매체 이름을 누르면 이 사람의 그 매체 글만 모아 봅니다.
function platMeta(r) {
  const span = el("span", { class: "n" });
  span.append(document.createTextNode(r.list.length + "건 · "));
  platOrder([...r.plats]).forEach((p, i) => {
    if (i) span.append(document.createTextNode("·"));
    const a = el("span", { class: "platlink", role: "button", tabindex: "0", text: PLATFORM[p] });
    const go = (e) => { e.stopPropagation(); e.preventDefault(); backCtx = { tab: activeTab, pf: personFocus, pp: personPlat, af: acctFocus, gf: groupFocus, pg: page, st: ($("grid") || {}).scrollTop || 0 }; activeTab = "people"; acctFocus = ""; personFocus = r.name; personPlat = p; renderList(); }; // 이 사람의 이 매체 글만
    a.addEventListener("click", go);
    a.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") go(e); });
    span.append(a);
  });
  return span;
}
function appendProgressive(g, arr, step) {
  step = step || 48;
  let n = 0;
  const sentinel = el("div", { style: "grid-column:1/-1;height:1px" });
  const more = () => {
    const end = Math.min(arr.length, n + step);
    for (; n < end; n++) g.insertBefore(card(arr[n]), sentinel);
    if (n >= arr.length) { io.disconnect(); sentinel.remove(); }
  };
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); }, { rootMargin: "700px" });
  g.appendChild(sentinel);
  more();
  if (n < arr.length) io.observe(sentinel);
}

function card(it) {
  const kids = [];
  if (it.thumb) {
    const img = el("img", { alt: "", referrerpolicy: "no-referrer", decoding: "async" });
    img.dataset.src = it.thumb;
    imgObserver.observe(img);
    kids.push(img);
  }
  const pub = it.publishedAt ? relative(Date.parse(it.publishedAt)) : it.publishedText || "";
  const meta = [it.author, pub ? "게시 " + pub : "", "수집 " + relative(it.collectedAt)].filter(Boolean).join(" · ");
  kids.push(el("div", { class: "body" }, [el("span", { class: "badge", text: SRC_LABELS[it.source] || it.source }), el("div", { class: "title", text: it.title }), el("div", { class: "meta", text: meta })]));
  const safe = /^https:\/\//.test(it.url || "") ? it.url : "#";
  // href를 달지 않아 브라우저가 마우스를 올렸을 때 왼쪽 아래에 주소 띠를 띄우지 않습니다. 열기는 클릭 처리로 대신합니다.
  const a = el("a", { class: "card", role: "link", tabindex: "0" }, kids);
  a._item = it;
  if (seen.has(it.id)) a.classList.add("seen");
  const outside = () => { if (safe !== "#") window.open(safe, "_blank", "noopener,noreferrer"); };
  // 일반 클릭은 이 페이지에서 보기/새 크롬 창으로, Ctrl·Shift·휠 클릭은 새 탭으로 엽니다.
  a.addEventListener("click", (e) => { if (e.button !== 0 || safe === "#") return; if (e.ctrlKey || e.metaKey || e.shiftKey) { outside(); return; } setViewCtx(a, it); openItem(it); });
  a.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); outside(); } });
  a.addEventListener("keydown", (e) => { if (e.key === "Enter" && safe !== "#") { e.preventDefault(); setViewCtx(a, it); openItem(it); } });
  return a;
}

// 한 줄(가로 스크롤) 채우기: 벤토 디자인에서는 미리보기 이미지가 있는 카드를 기본 크기로 두고,
// 이미지 없는 카드는 두 개씩 위아래로 묶어 이미지 카드 한 장 높이를 채웁니다(빈 공간 없이).
function fillRow(grid, arr) {
  const STACK_TEXT_CARDS = false; // true: 이미지 없는 카드를 두 개씩 묶음 / false: 모든 카드를 같은 높이로 늘림
  if (!STACK_TEXT_CARDS || document.documentElement.getAttribute("data-design") !== "bento") { arr.forEach((it) => grid.appendChild(card(it))); return; }
  let buf = [];
  const flush = () => { if (!buf.length) return; const st = el("div", { class: "cstack" }); buf.forEach((it) => st.appendChild(card(it))); grid.appendChild(st); buf = []; };
  arr.forEach((it) => { if (it.thumb) { flush(); grid.appendChild(card(it)); } else { buf.push(it); if (buf.length === 2) flush(); } });
  flush();
}
// 구역 머리: 이름 대신 매체 아이콘만 보여줍니다.
function srcIcon(k) {
  const pf = tabOf(k);
  const b = el("span", { class: "sicon", title: SRC_LABELS[k], role: "img", "aria-label": SRC_LABELS[k] });
  b.appendChild(typeof pIcon === "function" ? pIcon(pf) : el("span", { text: SRC_LABELS[k] }));
  return b;
}
const PARTNER = { "youtube-video": "youtube-post", "youtube-post": "youtube-video", x: "instagram", instagram: "x" };
function renderTabs() {
  const vis = items.filter(inPeriod);
  const counts = { all: vis.length };
  vis.forEach((it) => { const k = tabOf(it.source); counts[k] = (counts[k] || 0) + 1; });
  counts.people = new Set(tracked.filter((t) => t.kind !== "feed" && t.group).map((t) => t.group)).size;
  const nav = $("tabs");
  nav.textContent = "";
  Object.keys(LABELS).forEach((k) => {
    const ico = k === "people" ? el("span", { class: "tabico people", "aria-hidden": "true" }) : el("span", { class: "tabico sicon", "aria-hidden": "true" }, [typeof pIcon === "function" ? pIcon(k) : el("span")]);
    const b = el("button", { type: "button", class: k === activeTab ? "active" : "", title: LABELS[k], "aria-label": LABELS[k] }, [el("span", { class: "tabtxt", text: LABELS[k] }), ico, el("span", { class: "n", text: String(counts[k] || 0) })]);
    b.addEventListener("click", () => { if (k === "people") { personFocus = ""; personPlat = ""; } if (k !== activeTab) acctFocus = ""; activeTab = k; renderList(); });
    nav.appendChild(b);
  });
}
// 마우스로 잡아 끌어 좌우로 넘기기 (터치는 기본 스와이프). 끌었을 때는 링크가 열리지 않게 합니다.
function enableDrag(box) {
  let down = false, moved = false, startX = 0, startLeft = 0;
  box.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    // 휠 애니메이션이 아직 진행 중이면 멈춥니다(안 그러면 끄는 중에 원래 위치로 되돌아갑니다).
    { const st0 = wheelAnim.get(box); if (st0 && st0.raf) { cancelAnimationFrame(st0.raf); st0.raf = 0; box.classList.remove("wheeling"); } }
    // 아래쪽 스크롤바를 잡은 경우: 끌기/휠 애니메이션이 간섭하지 않게 하고 브라우저 기본 동작에 맡깁니다.
    const r = box.getBoundingClientRect();
    if (e.clientY > r.top + box.clientHeight) {
      const st = wheelAnim.get(box);
      if (st && st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
      box.classList.remove("wheeling"); box.classList.add("sb");
      const off = () => { box.classList.remove("sb"); window.removeEventListener("pointerup", off); window.removeEventListener("mouseup", off); };
      window.addEventListener("pointerup", off); window.addEventListener("mouseup", off);
      return;
    }
    down = true; moved = false; startX = e.clientX; startLeft = box.scrollLeft;
  });
  window.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) > 5) { moved = true; box.classList.add("dragging"); }
    if (moved) box.scrollLeft = startLeft - dx;
  });
  window.addEventListener("pointerup", () => { down = false; box.classList.remove("dragging"); });
  box.addEventListener("click", (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
  box.addEventListener("dragstart", (e) => e.preventDefault());
}
/* 사람별 프로필 사진: 계정별 사진은 이 브라우저에 작게 저장하고, 이름 옆에 쓸 사진(유튜브·X·인스타)은 사람마다 고릅니다. */
let picMap = {}, picPick = {};
try { picMap = JSON.parse(localStorage.getItem("snsPics") || "{}") || {}; picPick = JSON.parse(localStorage.getItem("snsPicPick") || "{}") || {}; } catch (e) {}
function savePics() { try { localStorage.setItem("snsPics", JSON.stringify(picMap)); localStorage.setItem("snsPicPick", JSON.stringify(picPick)); } catch (e) {} }
// 사진을 96px 정사각형으로 줄여 저장합니다(계정당 약 3~6KB).
function storePic(id, src) {
  return new Promise((resolve) => {
    if (!src) { resolve(false); return; }
    const im = new Image();
    im.onload = () => {
      try {
        const c = document.createElement("canvas"); c.width = c.height = 96;
        const w = im.naturalWidth, h = im.naturalHeight, m = Math.min(w, h);
        c.getContext("2d").drawImage(im, (w - m) / 2, (h - m) / 2, m, m, 0, 0, 96, 96);
        picMap[id] = c.toDataURL("image/jpeg", 0.85); savePics(); resolve(true);
      } catch (e) { resolve(false); }
    };
    im.onerror = () => resolve(false);
    im.src = src;
  });
}
function pickPicFile(id) {
  const f = el("input", { type: "file", accept: "image/*", hidden: "" });
  f.addEventListener("change", () => {
    const file = f.files && f.files[0]; f.remove();
    if (!file) return;
    const rd = new FileReader();
    rd.onload = async () => { if (await storePic(id, String(rd.result))) renderList(); };
    rd.readAsDataURL(file);
  });
  document.body.appendChild(f); f.click();
}
let acctFocus = ""; // 매체 탭에서 고른 계정(없으면 전체)
let favs = new Set();
try { favs = new Set(JSON.parse(localStorage.getItem("snsFavs") || "[]")); } catch (e) {}
function toggleFav(name) { if (favs.has(name)) favs.delete(name); else favs.add(name); try { localStorage.setItem("snsFavs", JSON.stringify([...favs])); } catch (e) {} renderList(); }
function favStar(name) {
  const on = favs.has(name);
  const b = el("button", { type: "button", class: "pstar" + (on ? " on" : ""), text: on ? "★" : "☆", title: on ? "즐겨찾기 해제" : "즐겨찾기에 추가", "aria-pressed": String(on), "aria-label": name + " 즐겨찾기" });
  b.addEventListener("click", (e) => { e.stopPropagation(); toggleFav(name); });
  return b;
}
const PIC_ORDER = ["youtube", "x", "instagram"];
function personAccounts(r) {
  return [...r.ids].map((id) => tracked.find((t) => t.id === id)).filter(Boolean).sort((a, b) => PIC_ORDER.indexOf(a.platform) - PIC_ORDER.indexOf(b.platform));
}
function picFace(t, name, cls) {
  const src = t && picMap[t.id];
  return src ? el("img", { class: cls, src, alt: "", referrerpolicy: "no-referrer" }) : el("span", { class: cls + " ph", text: (name || "?").trim().charAt(0).toUpperCase() });
}
function closePicMenu() { const m = document.getElementById("picMenu"); if (m) m.remove(); }
document.addEventListener("click", (e) => { if (!e.target.closest || !e.target.closest("#picMenu, .pav")) closePicMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePicMenu(); });
// 이름 옆 프로필 사진. 누르면 이 사람의 계정 중 어느 사진을 쓸지 고릅니다.
function personAvatar(r) {
  const accs = personAccounts(r);
  const chosen = accs.find((t) => t.platform === picPick[r.name]) || accs.find((t) => picMap[t.id]) || accs[0];
  const b = el("button", { type: "button", class: "pav", title: "프로필 사진 고르기", "aria-label": r.name + " 프로필 사진 고르기" }, [picFace(chosen, r.name, "pface")]);
  b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (document.getElementById("picMenu")) { closePicMenu(); return; }
    const menu = el("div", { id: "picMenu", role: "menu" }, [el("div", { class: "pm-h", text: "이름 옆에 보일 사진" })]);
    accs.forEach((t) => {
      const row = el("div", { class: "pm-row" + (t === chosen ? " on" : "") });
      const pick = el("button", { type: "button", class: "pm-pick", role: "menuitemradio", "aria-checked": String(t === chosen) }, [
        picFace(t, r.name, "pface"),
        el("span", { class: "pm-t" }, [el("b", { text: PLATFORM[t.platform] }), el("span", { text: t.handle ? "@" + t.handle : "" })]),
      ]);
      pick.addEventListener("click", () => { picPick[r.name] = t.platform; savePics(); closePicMenu(); renderList(); });
      const up = el("button", { type: "button", class: "pm-up", text: picMap[t.id] ? "변경" : "사진 올리기", title: "이 계정의 사진을 직접 올립니다" });
      up.addEventListener("click", () => { closePicMenu(); pickPicFile(t.id); });
      row.appendChild(pick); row.appendChild(up); menu.appendChild(row);
    });
    document.body.appendChild(menu);
    const rc = b.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rc.left, window.innerWidth - menu.offsetWidth - 8)) + "px";
    menu.style.top = Math.min(rc.bottom + 6, window.innerHeight - menu.offsetHeight - 8) + "px";
  });
  return b;
}
function renderList() {
  renderTabs();
  const q = $("q").value.trim().toLowerCase();
  let list = items.filter(inPeriod).filter((it) => activeTab === "all" || activeTab === "people" || tabOf(it.source) === activeTab);
  if (q) {
    // 통합 검색: 제목·본문·작성자·매체 이름·묶음 이름·계정을 한 번에 찾습니다(공백으로 나눈 단어가 모두 들어 있어야 함).
    const words = q.split(/\s+/).filter(Boolean);
    const hay = (it) => {
      const t = it.via ? tracked.find((x) => x.id === it.via) : null;
      return [it.title, it.text, it.preview, it.author, SRC_LABELS[it.source], PLATFORM[tabOf(it.source)], t && t.group, t && t.handle].filter(Boolean).join(" ").toLowerCase();
    };
    list = list.filter((it) => searchPlats.includes(tabOf(it.source)) && (() => { const h = hay(it); return words.every((w) => h.includes(w)); })());
  }
  const bySort = true; // 항상 게시 시각 순
  list.sort((a, b) => (bySort ? publishedMs(b) - publishedMs(a) : b.collectedAt - a.collectedAt));
  const g = $("grid");
  g.textContent = "";
  g.className = "";
  { const sp = $("sidePeople"); sp.textContent = ""; sp.hidden = true; }
  // 매체 탭(유튜브·X·인스타그램): 오른쪽 아래에 그 매체의 계정 목록(묶음 아님)을 보여주고, 누르면 그 계정 글만 봅니다.
  if (activeTab !== "people" && activeTab !== "all") {
    const accs = tracked.filter((t) => t.platform === activeTab);
    const cnt = (id) => list.filter((it) => it.via === id).length;
    if (acctFocus && !accs.some((t) => t.id === acctFocus)) acctFocus = "";
    if (document.documentElement.getAttribute("data-design") === "bento" && accs.length) {
      const bar = el("div", { class: "pbar" });
      const chip = (face, label, n, active, fn) => { const b = el("button", { type: "button", class: active ? "active" : "" }, [face, el("span", { class: "nm", text: label }), el("span", { class: "n", text: String(n) })].filter(Boolean)); b.addEventListener("click", fn); bar.appendChild(b); };
      chip(null, "모든 계정", list.length, !acctFocus, () => { acctFocus = ""; renderList(); });
      accs.map((t) => ({ t, n: cnt(t.id) })).sort((a, b) => b.n - a.n).forEach(({ t, n }) => {
        const nm = t.kind === "feed" ? FEED[t.platform] : t.handle ? "@" + t.handle : t.channelId || "";
        chip(picFace(t, t.handle || nm, "pface"), nm, n, acctFocus === t.id, () => { acctFocus = acctFocus === t.id ? "" : t.id; renderList(); });
      });
      const sp = $("sidePeople"); sp.hidden = false; sp.appendChild(bar);
    } else if (document.documentElement.getAttribute("data-design") === "bento") {
      // 이 매체에 추적 계정이 없어도 오른쪽 목록 카드를 같은 자리에 비어 있는 채로 보여줍니다
      const eb = el("div", { class: "pbar" }); eb.appendChild(el("button", { type: "button", class: "active" }, [el("span", { text: "모든 계정" }), el("span", { class: "n", text: "0" })]));
      const sp = $("sidePeople"); sp.hidden = false; sp.appendChild(eb);
    }
    if (acctFocus) list = list.filter((it) => it.via === acctFocus);
  }
  if (activeTab === "people") {
    // 사람별: 같은 묶음 이름을 가진 유튜브·X·인스타 계정의 글을 한 사람 기준으로 모아 봅니다.
    const people = new Map();
    tracked.filter((t) => t.kind !== "feed" && t.group).forEach((t) => {
      if (!people.has(t.group)) people.set(t.group, { name: t.group, ids: new Set(), plats: new Set() });
      const p = people.get(t.group);
      p.ids.add(t.id); p.plats.add(t.platform);
    });
    if (!people.size) {
      g.appendChild(el("p", { class: "hint", text: "아직 묶음이 없습니다. 왼쪽 '추적 계정'에서 같은 사람의 유튜브·X·인스타 계정에 같은 묶음 이름을 지정하면, 여기서 그 사람 기준으로 모아 볼 수 있습니다." }));
      $("empty").hidden = true;
      // 묶음이 하나도 없을 때도 오른쪽 사람 목록 카드를 같은 자리에 비어 있는 채로 보여줍니다
      if (document.documentElement.getAttribute("data-design") === "bento") { const eb = el("div", { class: "pbar" }); eb.appendChild(el("button", { type: "button", class: "active" }, [el("span", { text: "모든 묶음" }), el("span", { class: "n", text: "0" })])); const sp = $("sidePeople"); sp.hidden = false; sp.appendChild(eb); }
      return;
    }
    const platOf = (it) => (it.source.startsWith("youtube") ? "youtube" : it.source);
    const rows = [...people.values()].map((p) => ({ ...p, list: list.filter((it) => p.ids.has(it.via)).sort((a, b) => publishedMs(b) - publishedMs(a)) }));
    rows.sort((a, b) => (b.list[0] ? publishedMs(b.list[0]) : 0) - (a.list[0] ? publishedMs(a.list[0]) : 0));
    // 검색 중에는 어느 사람에도 묶이지 않은 계정(묶음 없음·피드 등)의 결과도 '그 밖의 결과'로 함께 보여줍니다.
    const personIds = new Set(); people.forEach((p) => p.ids.forEach((id) => personIds.add(id)));
    const others = q && page !== "fav" ? list.filter((it) => !personIds.has(it.via)) : [];
    if (q) {
      // 검색 중에는 검색에 걸린 글이 있는 사람만 보여줍니다(빈 사람 줄은 숨김).
      rows.splice(0, rows.length, ...rows.filter((r) => r.list.length));
      if (!rows.length && !others.length) { g.appendChild(el("p", { class: "hint", text: "검색 결과가 없습니다." })); $("empty").hidden = true; return; }
    }
    if (page === "fav") {
      rows.splice(0, rows.length, ...rows.filter((r) => favs.has(r.name)));
      if (!rows.length) {
        g.appendChild(el("p", { class: "hint", text: "즐겨찾기한 사람이 없습니다. 홈의 사람 이름 옆 ☆를 눌러 추가하세요." })); $("empty").hidden = true;
        // 오른쪽 사람 목록 카드도 같은 자리에 비어 있는 채로 보여줍니다(즐겨찾기가 생기면 여기에 뜸)
        if (document.documentElement.getAttribute("data-design") === "bento") { const eb = el("div", { class: "pbar" }); eb.appendChild(el("button", { type: "button", class: "active" }, [el("span", { text: "모든 묶음" }), el("span", { class: "n", text: "0" })])); const sp = $("sidePeople"); sp.hidden = false; sp.appendChild(eb); }
        return;
      }
    }
    if (personFocus && !rows.some((r) => r.name === personFocus)) personFocus = "";
    const bar = el("div", { class: "pbar" });
    const chip = (label, n, active, fn) => { const b = el("button", { type: "button", class: active ? "active" : "" }, [el("span", { text: label }), el("span", { class: "n", text: String(n) })]); b.addEventListener("click", fn); bar.appendChild(b); };
    chip("모든 묶음", rows.reduce((s, r) => s + r.list.length, 0), !personFocus, () => { personFocus = ""; personPlat = ""; renderList(); });
    rows.forEach((r) => chip(r.name, r.list.length, personFocus === r.name, () => { personFocus = r.name; personPlat = ""; renderList(); }));
    // 벤토 디자인: 사람 목록은 오른쪽 탭 카드 아래 빈 공간에 세로로 둡니다.
    if (document.documentElement.getAttribute("data-design") === "bento") { const sp = $("sidePeople"); sp.hidden = false; sp.appendChild(bar); } else g.appendChild(bar);
    const MEDIA = ["youtube-video", "youtube-post", "x", "instagram"];
    // 한 사람의 글을 매체별(유튜브 영상·유튜브 게시물·X·인스타그램) 줄로 나눠 보여줍니다.
    const mediaRows = (r, limit, onMore) => {
      const box = el("div", { class: "sections media-grid" });
      const has = (src) => r.list.some((it) => it.source === src);
      MEDIA.forEach((k) => {
        const part = r.list.filter((it) => it.source === k);
        if (!part.length) return;
        const head = el("div", { class: "sec-head", title: "여기서 휠을 돌리면 옆으로 넘어갑니다" }, [srcIcon(k), el("span", { class: "slabel", text: SRC_LABELS[k] }), el("span", { class: "n", text: part.length + "건" })]);
        if (onMore && part.length > limit) {
          const more = el("button", { type: "button", text: "전체 보기" });
          more.addEventListener("click", () => onMore(k));
          head.appendChild(more);
        }
        const grid = el("div", { class: "row-cards" });
        fillRow(grid, part.slice(0, limit));
        enableDrag(grid);
        const full = !has(PARTNER[k]); // 짝(영상↔게시물, X↔인스타)이 없으면 한 줄을 씁니다
        box.appendChild(el("div", { class: "sec" + (full ? " full" : ""), "data-plat": tabOf(k) }, [head, grid]));
      });
      if (!box.children.length) box.appendChild(el("p", { class: "hint", text: "이 기간에 수집된 글이 없습니다." }));
      return box;
    };
    const body = el("div", { class: "sections" });
    if (personFocus) {
      const r = rows.find((x) => x.name === personFocus);
      if (personPlat) {
        const back = el("button", { type: "button", text: "← " + r.name });
        back.addEventListener("click", () => { if (backCtx) {
          const c = backCtx; backCtx = null;
          activeTab = c.tab; personFocus = c.pf; personPlat = c.pp; acctFocus = c.af; groupFocus = c.gf;
          if (c.pg && c.pg !== page) { page = c.pg; try { applyPage(); } catch (e) {} }
          renderList();
          requestAnimationFrame(() => { const g = $("grid"); if (g) g.scrollTop = c.st || 0; }); // 보던 위치로
        } else { personPlat = ""; renderList(); }
      });
        const grid = el("div", { class: "cards" }, [el("div", { class: "sec-head", style: "grid-column: 1 / -1" }, [back, el("h3", { text: SRC_LABELS[personPlat] || PLATFORM[personPlat] || personPlat })])]);
        r.list.filter((it) => it.source === personPlat || tabOf(it.source) === personPlat).slice(0, 300).forEach((it) => grid.appendChild(card(it)));
        body.appendChild(grid);
      } else {
        body.appendChild(el("section", { class: "sec" }, [
          el("div", { class: "sec-head" }, [personAvatar(r), el("h3", { text: r.name }), favStar(r.name), platMeta(r)]),
          mediaRows(r, 30, (k) => { backCtx = null; personPlat = k; renderList(); }),
        ]));
      }
    } else {
      rows.forEach((r) => {
        // 이름을 누르면 이 사람만 보기 화면으로 갑니다.
        const nameBtn = el("h3", { class: "namelink", text: r.name, role: "button", tabindex: "0", title: "이 사람만 보기" });
        const go = () => { personFocus = r.name; personPlat = ""; renderList(); };
        nameBtn.addEventListener("click", go);
        nameBtn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
        const head = el("div", { class: "sec-head" }, [personAvatar(r), nameBtn, favStar(r.name), platMeta(r)]);
        body.appendChild(el("section", { class: "sec" }, [head, mediaRows(r, 20, null)]));
      });
    }
    if (others.length && !personFocus) {
      const o = { name: "그 밖의 결과", list: others, plats: new Set(others.map((it) => tabOf(it.source))) };
      body.appendChild(el("section", { class: "sec" }, [
        el("div", { class: "sec-head" }, [el("h3", { text: o.name }), el("span", { class: "n", text: others.length + "건" })]),
        mediaRows(o, 20, null),
      ]));
    }
    g.appendChild(body);
    $("empty").hidden = true;
    return;
  }
  if (activeTab !== "people" && !q ) {
    // 묶음·계정별: 묶음 이름이 같은 계정은 한 줄로, 묶음 없는 계정은 계정마다 한 줄로 보여줍니다.
    g.className = "sections";
    const groups = new Map();
    tracked.filter((t) => t.kind !== "feed").forEach((t) => {
      const key = t.group ? "g:" + t.group : "a:" + t.id;
      if (!groups.has(key)) groups.set(key, { name: t.group || PLATFORM[t.platform] + " @" + (t.handle || t.channelId || ""), ids: new Set(), plats: [] });
      const gr = groups.get(key);
      gr.ids.add(t.id);
      gr.plats.push(PLATFORM[t.platform]);
    });
    const rows = [...groups.values()].map((gr) => ({ ...gr, list: list.filter((it) => gr.ids.has(it.via)) }));
    const known = new Set(tracked.map((t) => t.id));
    const rest = list.filter((it) => !known.has(it.via));
    if (rest.length) rows.push({ name: "기타", plats: [], ids: new Set(), list: rest });
    rows.forEach((r) => r.list.sort((a, b) => publishedMs(b) - publishedMs(a)));
    rows.sort((a, b) => (b.list[0] ? publishedMs(b.list[0]) : 0) - (a.list[0] ? publishedMs(a.list[0]) : 0));
    const focused = groupFocus && rows.find((r) => r.name === groupFocus);
    if (groupFocus && !focused) groupFocus = "";
    if (focused) {
      // 한 묶음의 글을 전부 펼쳐서 보여줍니다.
      g.className = "cards";
      const back = el("button", { type: "button", text: "← 묶음 목록으로" });
      back.addEventListener("click", () => { groupFocus = ""; renderList(); });
      g.appendChild(el("div", { class: "sec-head", style: "grid-column: 1 / -1" }, [back, el("h3", { text: focused.name }), el("span", { class: "n", text: focused.list.length + "건" })]));
      appendProgressive(g, focused.list.slice(0, 300));
      $("empty").hidden = list.length > 0;
      return;
    }
    // 특정 매체 탭에서는 그 매체에 글이 없는 계정·묶음 줄은 숨깁니다.
    (activeTab === "all" ? rows : rows.filter((r) => r.list.length)).forEach((r) => {
      const head = el("div", { class: "sec-head" }, [...(r.ids.size ? [personAvatar(r)] : []), el("h3", { text: r.name }), el("span", { class: "n", text: r.list.length + "건" + (r.plats.length ? " · " + platOrder([...new Set(r.plats)].map((n) => Object.keys(PLATFORM).find((k) => PLATFORM[k] === n) || n)).map((k) => PLATFORM[k] || k).join("·") : "") })]);
      if (r.list.length > 30) {
        const more = el("button", { type: "button", text: "전체 보기" });
        more.addEventListener("click", () => { groupFocus = r.name; renderList(); });
        head.appendChild(more);
      }
      const grid = el("div", { class: "row-cards" });
      if (r.list.length) { fillRow(grid, r.list.slice(0, 30)); enableDrag(grid); }
      else grid.appendChild(el("p", { class: "hint", text: "이 기간에 수집된 글이 없습니다." }));
      g.appendChild(el("section", { class: "sec" }, [head, grid]));
    });
  } else if ((activeTab === "all" || activeTab === "youtube") && !q) {
    // 한눈에 보기: 출처별 구역으로 나눠 최신 글을 한 화면에 모아 보여줍니다.
    g.className = "sections media-grid";
    // 유튜브 탭에서는 영상과 게시물이 각각 따로 구역으로 나뉘어 보입니다.
    const lim = activeTab === "all" ? 30 : 80;
    if (activeTab === "youtube") {
      // 영상만 / 둘 다(각각 한 줄) / 게시물만
      const bar = el("div", { class: "segbar full", role: "group", "aria-label": "유튜브 보기 방식" });
      [["video", "영상만 보기"], ["both", "둘 다 보기"], ["post", "게시물만 보기"]].forEach(([m, label]) => {
        const b = el("button", { type: "button", class: ytMode === m ? "active" : "", text: label, "aria-pressed": String(ytMode === m) });
        b.addEventListener("click", () => { ytMode = m; try { localStorage.setItem("snsYtMode", m); } catch (e) {} renderList(); });
        bar.appendChild(b);
      });
      g.appendChild(bar);
    }
    Object.keys(SRC_LABELS).filter((k) => activeTab === "all" || (tabOf(k) === activeTab && (ytMode === "both" || k === "youtube-" + ytMode))).forEach((k) => {
      const part = list.filter((it) => it.source === k);
      if (!part.length) return;
      const head = el("div", { class: "sec-head" }, [srcIcon(k), el("span", { class: "slabel", text: SRC_LABELS[k] }), el("span", { class: "n", text: part.length + "건" })]);
      if (part.length > lim && activeTab === "all") {
        const more = el("button", { type: "button", text: "전체 보기" });
        more.addEventListener("click", () => { activeTab = tabOf(k); renderList(); });
        head.appendChild(more);
      }
      const grid = el("div", { class: "row-cards" });
      fillRow(grid, part.slice(0, lim));
      enableDrag(grid);
      const full = activeTab === "youtube" || !list.some((it) => it.source === PARTNER[k]);
      g.appendChild(el("section", { class: "sec" + (full ? " full" : ""), "data-plat": tabOf(k) }, [head, grid]));
    });
  } else {
    g.className = "cards";
    appendProgressive(g, list.slice(0, 300));
  }
  $("empty").hidden = list.length > 0;
  $("empty").textContent = connected ? "이 기간에 모은 글이 없습니다. 계정을 추가하고 '지금 최신화'를 눌러 보세요." : "아직 보여줄 글이 없습니다. 로그인하고 계정을 추가하면 설정한 기간(최대 60일)의 글이 여기에 모입니다.";
}
function renderTracked() {
  const box = $("tracked");
  box.textContent = "";
  tracked.forEach((t) => {
    const name = t.kind === "feed" ? FEED[t.platform] : t.handle ? "@" + t.handle : t.channelId || t.resolveUrl;
    const label = el("span", { class: "chip-name", role: "button", tabindex: "0", title: "눌러서 선택(여러 개 가능)", text: PLATFORM[t.platform] + " " + name + (t.group ? " · " + t.group : "") + (t.days ? " · " + t.days + "일" : "") });
    const toggle = () => { selIds = selIds.includes(t.id) ? selIds.filter((x) => x !== t.id) : selIds.concat(t.id); renderTracked(); };
    label.addEventListener("click", toggle);
    label.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    box.appendChild(el("span", { class: "chip" + (selIds.includes(t.id) ? " sel" : "") }, [label]));
  });
  // 고른 계정(누른 순서)을 한 줄 바에 차례로 보여줍니다. 거기서 묶거나 기간을 정합니다.
  selIds = selIds.filter((id) => tracked.some((t) => t.id === id));
  const bar = $("selBar");
  bar.textContent = "";
  if (!selIds.length) bar.appendChild(el("span", { class: "ph", text: "위의 계정을 눌러 선택하세요 (여러 개 가능)" }));
  selIds.forEach((id) => {
    const t = tracked.find((x) => x.id === id);
    const nm = PLATFORM[t.platform] + " " + (t.kind === "feed" ? FEED[t.platform] : t.handle ? "@" + t.handle : t.channelId || "");
    const x = el("button", { type: "button", class: "selx", "aria-label": nm + " 선택 해제", title: "이 계정만 선택 해제", text: "×" });
    x.addEventListener("click", () => { selIds = selIds.filter((v) => v !== id); renderTracked(); });
    bar.appendChild(el("span", { class: "selchip" }, [el("span", { text: nm }), x]));
  });
  $("selClear").hidden = !selIds.length;
  $("selAll").hidden = !tracked.length || selIds.length === tracked.length;
  // 한 개만 골랐다면 그 계정의 현재 기간을 기간 선택에 보여줍니다.
  if (document.activeElement !== $("dDays")) { const cur = selIds.length === 1 ? tracked.find((t) => t.id === selIds[0]) : null; $("dDays").value = String((cur && cur.days) || 0); }
  periodDays = winDays;
  $("dDays").options[0].textContent = "기본(" + winDays + "일)";
  $("checkNow").classList.toggle("busy", !!checkStatus.running || (typeof refreshing !== "undefined" && refreshing));
  $("checkNow").disabled = !!checkStatus.running || tracked.length === 0 || (typeof refreshing !== "undefined" && refreshing);
}
function renderSettings() {
}
function renderAll() {
  renderSettings(); renderTracked(); renderList();
  updateConnText(); renderWork();
}
function showErr(e) { const p = $("addError"); p.textContent = e.message; p.hidden = false; }


/* 오른쪽 아래 "현재 작업" 카드: 수집 상태·진행·마지막/다음 확인·글/계정 수·매체 로그인 상태를 한눈에 보여줍니다. */
function renderWork() {
  const w = $("workCard");
  if (!w) return;
  w.hidden = false;
  w.textContent = "";
  const st = checkStatus || {};
  let state = "idle", label = "대기 중";
  if (!connected) { state = "off"; label = "서버 연결 안 됨"; }
  else if (st.running && st.paused) { state = "pause"; label = "일시정지"; }
  else if (st.running) { state = "run"; label = "수집 중"; }
  const head = el("div", { class: "wk-head" }, [el("span", { class: "wk-dot " + state }), el("b", { text: "현재 작업" }), el("span", { class: "wk-state", text: label })]);
  w.appendChild(head);
  // 진행 상황: "확인 중: 유튜브 @계정 (3/10)" 형태면 진행 막대를 함께 보여줍니다.
  const msg = connected ? (st.message || "") : "로그인하면 수집 상태가 여기에 보입니다.";
  const m = /\((\d+)\/(\d+)\)/.exec(msg);
  if (st.running && m) {
    const pct = Math.round((Number(m[1]) / Math.max(1, Number(m[2]))) * 100);
    w.appendChild(el("div", { class: "wk-bar" }, [el("i", { style: "width:" + pct + "%" })]));
  }
  w.appendChild(el("p", { class: "wk-msg", text: msg || (st.lastRun ? "마지막 확인이 끝났습니다." : "아직 확인한 적이 없습니다.") }));
  const rows = [];
  if (connected) {
    if (st.lastRun) rows.push(["마지막 확인", relative(st.lastRun)]);
    if (!st.running && st.lastRun) {
      const left = Math.max(0, Math.round((st.lastRun + 3600000 - Date.now()) / 60000));
      rows.push(["다음 자동 확인", left <= 0 ? "곧" : left + "분 후"]);
    }
    rows.push(["수집한 글", items.length + "건"]);
    rows.push(["추적 계정", tracked.length + "개"]);
  }
  if (rows.length) w.appendChild(el("dl", { class: "wk-list" }, rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })])));
  for (const id of ["infoCard", "infoCard2"]) {
    const info = $(id);
    if (info) { info.textContent = ""; info.append(el("a", { class: "gh", href: TEAM_GITHUB, target: "_blank", rel: "noopener noreferrer", text: "Github - " + TEAM_NAME }), el("span", { class: "ver", text: "Web Version " + WEB_VERSION })); }
  }
  placeWork();
}
function placeWork() { const w = $("workCard"); if (w) w.style.top = ""; }
setInterval(() => { try { renderWork(); } catch (e) {} }, 15000);

/* 프로필 사진 최신화: '최신화'(수집)가 끝난 뒤, 사진이 없는 계정(5분 이상 지난 시도)이나 3일 넘은 계정부터 한 번에 최대 6개씩 사진을 다시 가져옵니다. */
let picAt = {}, picBusy = false;
try { picAt = JSON.parse(localStorage.getItem("snsPicAt") || "{}") || {}; } catch (e) {}
const savePicAt = () => { try { localStorage.setItem("snsPicAt", JSON.stringify(picAt)); } catch (e) {} };
async function refreshPics(max = 6) {
  if (picBusy || !connected) return;
  picBusy = true;
  try {
    const now = Date.now();
    const due = tracked
      .filter((t) => t.kind !== "feed" && (t.handle || t.channelId))
      .filter((t) => !picMap[t.id] ? now - (picAt[t.id] || 0) > 5 * 60000 : now - (picAt[t.id] || 0) > 3 * 86400000)
      .sort((a, b) => (picAt[a.id] || 0) - (picAt[b.id] || 0))
      .slice(0, max);
    for (const t of due) {
      if (checkStatus && checkStatus.running) break; // 수집이 다시 시작되면 멈춥니다
      picAt[t.id] = Date.now(); savePicAt(); // 실패해도 당분간 다시 시도하지 않게 먼저 기록
      let res = [];
      try { res = await call("searchAccount", { platform: t.platform, q: t.handle || t.channelId }); } catch (e) { continue; }
      const h = String(t.handle || "").replace(/^@/, "").toLowerCase();
      const hit = (res || []).find((r) => (h && String(r.handle || "").replace(/^@/, "").toLowerCase() === h) || (t.channelId && r.channelId === t.channelId));
      if (hit && hit.avatar && (await storePic(t.id, hit.avatar))) { renderList(); }
    }
  } finally { picBusy = false; }
}
