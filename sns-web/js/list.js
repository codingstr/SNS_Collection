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
// 추적 계정 ID → 계정. 글마다 tracked.find를 하면 (글 5000 × 계정 30)번 비교하므로, 목록이 바뀔 때만 한 번 만듭니다.
// (tracked는 늘 새 배열로 바꿔 끼우므로 배열이 같으면 내용도 같습니다)
let _tmapOf = null, _tmap = new Map();
function trackedOf(id) {
  if (_tmapOf !== tracked) { _tmapOf = tracked; _tmap = new Map(tracked.map((t) => [t.id, t])); }
  return _tmap.get(id) || null;
}
// 글이 이어진 이 사용자의 모든 추적 계정. 인스타 공동 게시물처럼 한 글이 두 계정에 올라오면 둘 다(서버의 vias). 예전 형식은 via 하나.
const viasOf = (it) => (it.vias && it.vias.length ? it.vias : it.via ? [it.via] : []);
// 계정별 기간이 있으면 그 계정의 글은 그 기간으로, 없으면 맨 위 기간으로 거릅니다.
const inPeriod = (it) => {
  const t = it.via ? trackedOf(it.via) : null;
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
// 줄인 그림은 최근에 쓴 것부터 SMALL_MAX장만 기억하고, 밀려난 것은 메모리에서 풉니다(URL.revokeObjectURL).
const SMALL_MAX = 600;
const smallCache = new Map(); // 원본 주소 -> 줄인 그림 주소 (Map 순서 = 최근에 쓴 순서)
function smallGet(url) {
  const u = smallCache.get(url);
  if (u !== undefined) { smallCache.delete(url); smallCache.set(url, u); } // 최근에 씀으로 표시
  return u;
}
function smallPut(url, u) {
  smallCache.delete(url);
  smallCache.set(url, u);
  while (smallCache.size > SMALL_MAX) {
    const [k, v] = smallCache.entries().next().value;
    smallCache.delete(k);
    if (v.startsWith("blob:")) URL.revokeObjectURL(v);
  }
}
// 그림을 다른 사이트에서 읽어 줄이는 것(CORS)을 허용하지 않는 곳(인스타그램 CDN 등): 몇 번 실패하면 그 곳은 바로 원본으로 띄웁니다.
// (예전에는 그림마다 받기 실패 → 다른 방법 실패 → 원본, 이렇게 요청이 세 번씩 갔습니다)
const noCorsHits = new Map();
const hostOf = (u) => { try { return new URL(u).host; } catch (e) { return ""; } };
const smallQueue = [];
let smallActive = 0;
function pumpSmall() {
  while (smallActive < 3 && smallQueue.length) {
    const { url, img } = smallQueue.shift();
    const hit = smallGet(url);
    if (hit !== undefined) { if (img.isConnected) img.src = hit; continue; }
    if (!img.isConnected) continue; // 기다리는 사이 화면에서 사라진 카드
    smallActive++;
    const host = hostOf(url);
    const done = () => { smallActive--; pumpSmall(); };
    const direct = () => { if (img.isConnected) { img.addEventListener("error", () => img.remove(), { once: true }); img.src = url; } done(); };
    const corsFailed = () => { noCorsHits.set(host, (noCorsHits.get(host) || 0) + 1); direct(); };
    if ((noCorsHits.get(host) || 0) >= 3) { direct(); continue; }
    // 받아서 줄이는 것(디코딩·인코딩)을 메인 화면 작업과 따로(비동기) 처리합니다.
    if (typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function") {
      fetch(url, { mode: "cors", referrerPolicy: "no-referrer", credentials: "omit" })
        .then((r) => { if (!r.ok) throw new Error("http"); return r.blob(); }, (e) => { e.cors = true; throw e; })
        .then((blob) => createImageBitmap(blob, { resizeWidth: 520, resizeQuality: "medium" }))
        .then((bm) => {
          const oc = new OffscreenCanvas(bm.width, bm.height);
          oc.getContext("2d").drawImage(bm, 0, 0);
          if (bm.close) bm.close();
          return oc.convertToBlob({ type: "image/jpeg", quality: 0.82 });
        })
        .then((b2) => { const u = URL.createObjectURL(b2); smallPut(url, u); if (img.isConnected) img.src = u; done(); })
        .catch((e) => { if (e && e.cors) corsFailed(); else direct(); }); // 받기 자체가 막혔으면(CORS) 다른 방법도 똑같이 막히므로 바로 원본으로
      continue;
    }
    // 오래된 브라우저: 그림을 불러와 캔버스로 줄입니다.
    const t = new Image();
    t.crossOrigin = "anonymous"; t.referrerPolicy = "no-referrer"; t.decoding = "async";
    t.onerror = corsFailed;
    t.onload = () => {
      try {
        const w = Math.min(520, t.naturalWidth || 520);
        if (!t.naturalWidth || t.naturalWidth <= 560) { smallPut(url, url); if (img.isConnected) img.src = url; done(); return; } // 이미 작으면 그대로
        const c = document.createElement("canvas");
        c.width = w; c.height = Math.max(1, Math.round((t.naturalHeight * w) / t.naturalWidth));
        c.getContext("2d").drawImage(t, 0, 0, c.width, c.height);
        c.toBlob((b) => {
          if (!b) { direct(); return; }
          const u = URL.createObjectURL(b);
          smallPut(url, u);
          if (img.isConnected) img.src = u;
          done();
        }, "image/jpeg", 0.82);
      } catch (e) { direct(); }
    };
    t.src = url;
  }
}
function loadSmall(url, img) {
  const hit = smallGet(url);
  if (hit !== undefined) { img.src = hit; return; }
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
  // 쇼츠는 세로 화면(9:16)으로 보여 줍니다
  if (it.source === "youtube-video" && (m = /youtube\.com\/shorts\/([\w-]{11})/.exec(u))) return { src: "https://www.youtube-nocookie.com/embed/" + m[1] + "?autoplay=1&rel=0", ratio: "9 / 16", kind: "short" };
  if (it.source === "x" && (m = /\/status\/(\d+)/.exec(u))) return { src: "https://platform.twitter.com/embed/Tweet.html?id=" + m[1] + "&dnt=true&lang=ko&theme=" + (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"), h: 420, tweet: m[1] };
  if (it.source === "instagram" && (m = /instagram\.com\/(p|reel|tv)\/([\w-]+)/.exec(u))) return { src: "https://www.instagram.com/" + m[1] + "/" + m[2] + "/embed", h: 700 };
  return null;
}
function openWindow(url) { if (/^https:\/\//.test(url || "")) window.open(url, "_blank", "noopener"); }
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
function closeViewer() { $("viewer").hidden = true; $("vBody").textContent = ""; setViewerKind(""); }
// 보기 창 모양: X 글은 글 폭(최대 550px)에 맞춘 좁은 창, 쇼츠는 세로 영상 크기에 꼭 맞춘 창, 그 밖은 기본
function setViewerKind(k) { const v = document.querySelector("#viewer .viewer"); v.classList.toggle("vx", k === "x"); v.classList.toggle("vig", k === "instagram"); v.classList.toggle("vshort", k === "short"); $("viewer").classList.toggle("vshort", k === "short"); }
// X 공식 위젯(widgets.js): 글 내용 높이에 꼭 맞게 띄웁니다. 못 불러오면 iframe으로 대신합니다.
let twttrLoad = null;
function loadTwttr() {
  if (window.twttr && window.twttr.widgets && window.twttr.widgets.createTweet) return Promise.resolve(window.twttr);
  if (!twttrLoad) {
    twttrLoad = new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "https://platform.twitter.com/widgets.js"; sc.async = true; sc.charset = "utf-8";
      const t = setTimeout(() => reject(new Error("timeout")), 8000);
      sc.onload = () => { clearTimeout(t); window.twttr && window.twttr.widgets && window.twttr.widgets.createTweet ? resolve(window.twttr) : reject(new Error("no twttr")); };
      sc.onerror = () => { clearTimeout(t); reject(new Error("load")); };
      document.head.appendChild(sc);
    }).catch((e) => { twttrLoad = null; throw e; });
  }
  return twttrLoad;
}
// 임베드 iframe이 알려 주는 실제 높이로 맞춥니다(X: twttr.private.resize, 인스타: MEASURE). 고정 높이로 생기던 빈 여백을 없앱니다.
window.addEventListener("message", (e) => {
  if (e.origin !== "https://platform.twitter.com" && e.origin !== "https://www.instagram.com") return;
  let d = e.data;
  if (typeof d === "string") { try { d = JSON.parse(d); } catch (x) { return; } }
  if (!d || typeof d !== "object") return;
  let h = 0;
  const tw = d["twttr.embed"];
  if (tw && tw.method === "twttr.private.resize" && tw.params && tw.params[0]) h = Number(tw.params[0].height) || 0;
  if (d.type === "MEASURE" && d.details) h = Number(d.details.height) || 0;
  if (!h) return;
  document.querySelectorAll("#vBody iframe").forEach((f) => { if (f.contentWindow === e.source) f.style.height = Math.ceil(h) + "px"; });
});
const postCache = new Map();
function renderPost(p, it) {
  const wrap = el("div", { class: "post" });
  const head = el("div", { class: "ph2" });
  if (p.avatar) head.appendChild(el("img", { class: "av", src: p.avatar, alt: "", referrerpolicy: "no-referrer" }));
  const when = it.publishedAt && !Number.isNaN(Date.parse(it.publishedAt)) ? relative(Date.parse(it.publishedAt)) : p.time || it.publishedText || "";
  head.appendChild(el("div", { class: "who" }, [el("b", { text: p.author || it.author || "" }), el("span", { text: when })]));
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
  setViewerKind("");
  updateNav();
  $("vTitle").textContent = it.author || "유튜브 게시물";
  const body = $("vBody");
  body.textContent = "";
  const wait = el("p", { class: "hint", style: "padding:24px", text: "게시물을 불러오는 중…" });
  body.appendChild(wait);
  $("viewer").hidden = false;
  // 보통은 서버가 저장해 둔 내용을 바로 돌려줍니다. 저장된 내용이 없는 예전 게시물만 서버가 직접 읽어 와서 오래 걸립니다.
  setTimeout(() => { if (wait.isConnected) wait.textContent = "서버에서 게시물을 읽어 오는 중… (처음 여는 예전 게시물은 10~30초 걸릴 수 있습니다)"; }, 1500);
  try {
    let p = postCache.get(it.url);
    if (!p) { p = await call("fetchPost", { url: it.url }, LONG_WAIT); postCache.set(it.url, p); }
    if ($("viewer").hidden || viewerUrl !== it.url) return;
    body.textContent = "";
    body.appendChild(renderPost(p, it));
  } catch (e) {
    if (viewerUrl !== it.url) return;
    body.textContent = "";
    body.appendChild(el("p", { class: "error", style: "padding:24px", text: "게시물을 불러오지 못했습니다. " + (e && e.message ? e.message : "") + " 위의 '새 창으로 열기'로 원본을 열어 주세요." }));
  }
}
function openItem(it) {
  markSeen(it);
  if (it.source === "youtube-post" && /^https:\/\/www\.youtube\.com\/post\//.test(it.url || "")) { openPost(it); return; }
  const e = embedFor(it);
  if (!e) { openWindow(it.url); return; }
  viewerUrl = it.url;
  updateNav();
  setViewerKind(e.kind || (it.source === "x" ? "x" : it.source === "instagram" ? "instagram" : ""));
  $("vTitle").textContent = it.title || it.author || "";
  const body = $("vBody");
  body.textContent = "";
  $("viewer").hidden = false;
  const frame = () => {
    const f = el("iframe", { src: e.src, title: "글 보기", allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: "", referrerpolicy: "strict-origin-when-cross-origin" });
    if (e.ratio) f.style.aspectRatio = e.ratio; else f.style.height = e.h + "px";
    return f;
  };
  if (it.source === "x" && e.tweet) {
    const wrap = el("div", { class: "xwrap" }, [el("p", { class: "hint", text: "글을 불러오는 중…" })]);
    body.appendChild(wrap);
    const url = it.url;
    const fallback = () => { if (viewerUrl !== url || !wrap.isConnected) return; wrap.textContent = ""; wrap.appendChild(frame()); };
    loadTwttr()
      .then((t) => t.widgets.createTweet(e.tweet, wrap, { theme: document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light", align: "center", dnt: true, conversation: "none", lang: "ko" }))
      .then((node) => { if (!wrap.isConnected) return; if (!node) fallback(); else { const h = wrap.querySelector(".hint"); if (h) h.remove(); } })
      .catch(fallback);
    return;
  }
  body.appendChild(frame());
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
  const a = el("a", { class: "card", role: "link", tabindex: "0", "data-plat": tabOf(it.source), "data-src": it.source }, kids);
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
  const vis = homeItems();
  const counts = { all: vis.length };
  vis.forEach((it) => { const k = tabOf(it.source); counts[k] = (counts[k] || 0) + 1; });
  counts.people = effSel().size || visiblePeople().length;
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
  // 끄는 동안의 이동·놓기는 이 줄에서만 받습니다. 줄 밖으로 끌고 나가도 놓치지 않게, 실제로 끌기 시작하면 포인터를 이 줄에 붙잡습니다.
  // (예전에는 window에 리스너를 붙였는데, 화면을 다시 그릴 때마다 줄 수만큼 쌓이고 지워진 옛 줄을 메모리에 붙잡고 있었습니다.)
  box.addEventListener("pointermove", (e) => {
    if (!down) return;
    if (!e.buttons) { down = false; box.classList.remove("dragging"); return; } // 끌기 전에 줄 밖에서 버튼을 놓은 경우
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) > 5) {
      moved = true; box.classList.add("dragging");
      try { box.setPointerCapture(e.pointerId); } catch (er) { /* 무시 */ }
    }
    if (moved) box.scrollLeft = startLeft - dx;
  });
  const endDrag = () => { down = false; box.classList.remove("dragging"); };
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);
  box.addEventListener("lostpointercapture", endDrag);
  box.addEventListener("click", (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } }, true);
  box.addEventListener("dragstart", (e) => e.preventDefault());
}
// 사람별 화면에서 한 줄의 이름: 그룹 이름, 그룹이 없으면 "매체 @계정"
const personKey = (t) => t.group || PLATFORM[t.platform] + " @" + (t.handle || t.channelId || t.resolveUrl || "");
// 이야기 줄·숨김 목록에 쓰는 짧은 이름: 그룹 이름, 그룹이 없으면 "@계정"
const personLabel = (p) => (p.accs[0] && p.accs[0].group) || (p.accs[0] ? (p.accs[0].handle ? "@" + p.accs[0].handle : p.accs[0].channelId || "") : p.name);

/* ---------- 사람(그룹) ----------
   같은 그룹 이름을 가진 계정들이 한 사람이고, 그룹이 없는 계정은 그 계정 하나가 한 사람입니다.
   숨긴 그룹(추적 계정 관리에서 숨김)은 홈 화면과 위쪽 그룹 줄에 나오지 않고, 서버도 수집하지 않습니다.
   그룹의 모든 계정이 숨김일 때 숨긴 그룹으로 봅니다. 숨기기·보이기는 그룹의 모든 계정에 한꺼번에 적용합니다. */
let _peopleOf = null, _people = new Map(), _hiddenVias = new Set();
function peopleMap() {
  if (_peopleOf !== tracked) {
    _peopleOf = tracked; _people = new Map(); _hiddenVias = new Set();
    tracked.filter((t) => t.kind !== "feed").forEach((t) => {
      const name = personKey(t);
      if (!_people.has(name)) _people.set(name, { name, ids: new Set(), plats: new Set(), accs: [] });
      const p = _people.get(name);
      p.ids.add(t.id); p.plats.add(t.platform); p.accs.push(t);
    });
    _people.forEach((p) => { p.hidden = p.accs.every((t) => t.hidden); if (p.hidden) p.ids.forEach((id) => _hiddenVias.add(id)); });
  }
  return _people;
}
function hiddenVias() { peopleMap(); return _hiddenVias; }
// 지금 화면(홈·즐겨찾기)에 보일 수 있는 사람: 숨기지 않았고, 즐겨찾기 화면이면 즐겨찾기한 사람만
function visiblePeople() {
  return [...peopleMap().values()].filter((p) => !p.hidden && (page !== "fav" || favs.has(p.name)));
}
// 위쪽 그룹 줄에서 고른 그룹(이름). 비어 있으면 모든 그룹을 보여 줍니다.
let storySel = new Set();
// 실제로 적용되는 선택: 고른 그룹 중 지금 화면에 보일 수 있는 것만(숨겼거나 즐겨찾기 화면에서 빠진 그룹은 제외. 고른 기록은 남겨 둠)
function effSel() {
  if (!storySel.size) return storySel;
  const vis = new Set(visiblePeople().map((p) => p.name));
  return new Set([...storySel].filter((n) => vis.has(n)));
}
function selectedVias() {
  const sel = effSel();
  if (!sel.size) return null;
  const out = new Set(), m = peopleMap();
  sel.forEach((n) => { const p = m.get(n); if (p) p.ids.forEach((id) => out.add(id)); });
  return out;
}
// 홈에 보일 글: 기간 안 + 숨긴 그룹 제외 + 고른 그룹만(고른 게 있으면)
function homeItems() {
  const hid = hiddenVias(), sel = selectedVias();
  return items.filter((it) => inPeriod(it) && viasOf(it).some((v) => !hid.has(v) && (!sel || sel.has(v))));
}
// 홈에 보일 추적 계정(매체 탭의 계정 목록·그룹 줄에 씀)
function homeAccounts() {
  const hid = hiddenVias(), sel = selectedVias();
  return tracked.filter((t) => t.kind !== "feed" && !hid.has(t.id) && (!sel || sel.has(t.id)));
}
/* 사람별 프로필 사진: 계정별 사진은 이 브라우저에 작게 저장하고, 이름 옆에 쓸 사진(유튜브·X·인스타)은 사람마다 고릅니다. */
let picMap = {}, picPick = {};
try { picMap = JSON.parse(lsGet("snsPics", "{}")) || {}; picPick = JSON.parse(lsGet("snsPicPick", "{}")) || {}; } catch (e) {}
function savePics() { lsSet("snsPics", JSON.stringify(picMap)); lsSet("snsPicPick", JSON.stringify(picPick)); }
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
try { favs = new Set(JSON.parse(lsGet("snsFavs", "[]"))); } catch (e) {}
const saveFavs = () => lsSet("snsFavs", JSON.stringify([...favs]));
function toggleFav(name) { if (favs.has(name)) favs.delete(name); else favs.add(name); saveFavs(); renderList(); }
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
// 사람별 화면에서 그 사람의 줄로 스크롤합니다(위에 붙어 있는 그룹 줄에 가려지지 않게).
function jumpToPerson(name) {
  const g = $("grid");
  const sec = Array.from(g.querySelectorAll(".sections > .sec")).find((s) => s._person === name);
  if (!sec) return;
  const bar = $("storyBar"), barH = bar ? bar.offsetHeight + 12 : 0;
  const dy = sec.getBoundingClientRect().top - (g.scrollHeight > g.clientHeight + 1 ? g.getBoundingClientRect().top : 0) - barH - 8;
  if (g.scrollHeight > g.clientHeight + 1) g.scrollBy({ top: dy, behavior: "smooth" }); else window.scrollBy({ top: dy, behavior: "smooth" });
}
/* 화면 밖 섹션의 자리 높이 맞추기(스크롤 떨림 방지)
   bento.css는 렉을 줄이려고 화면 밖 섹션을 그리지 않고(content-visibility:auto) 고정 높이(420px)로 자리만 잡아 둡니다.
   실제 높이는 블록 줄 수에 따라 제각각(예: 342px·616px)이라, 섹션이 화면에 들어와 그려지는 순간 페이지 높이가 바뀌며
   스크롤 위치·스크롤바가 튀고 화면이 떨렸습니다. 그래서 섹션 하나를 실제로 재서 줄 높이를 구하고, 나머지 섹션의 자리 높이를
   블록 줄 수로 계산해 넣습니다("auto"라 한 번 그려진 섹션은 실제 높이를 기억). */
function sizeSections(g) {
  if (!g || !g.isConnected) return;
  const secs = [...g.querySelectorAll(":scope > .sections > .sec, :scope > .sec")];
  if (secs.length < 2) return;
  const rowsOf = (s) => { const mg = s.querySelector(":scope > .media-grid, :scope > .sections.media-grid"); return mg ? { mg, n: Math.ceil(mg.querySelectorAll(":scope > .sec").length / 2) } : null; };
  const measure = (s) => { const o = s.style.contentVisibility; s.style.contentVisibility = "visible"; const h = s.getBoundingClientRect().height; const r = rowsOf(s); const mgH = r ? r.mg.getBoundingClientRect().height : 0; s.style.contentVisibility = o; return { h, r, mgH }; };
  let ref = null, single = 0;
  for (const s of secs) {
    const m = measure(s);
    if (m.r && m.r.n > 0 && !ref) ref = m;
    if (!m.r && !single) single = m.h;
    if ((ref || !secs.some(rowsOf)) && (single || secs.every(rowsOf))) break;
  }
  const gap = ref ? parseFloat(getComputedStyle(ref.r.mg).rowGap) || 0 : 0;
  const rowH = ref ? (ref.mgH - (ref.r.n - 1) * gap) / ref.r.n : 0, base = ref ? ref.h - ref.mgH : 0;
  // 자리 높이(contain-intrinsic-size)는 안쪽 높이라 위아래 여백·테두리를 뺍니다.
  const cs = getComputedStyle(secs[0]);
  const pad = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"].reduce((t, k) => t + (parseFloat(cs[k]) || 0), 0);
  secs.forEach((s) => {
    const r = rowsOf(s);
    const est = (r ? (r.n ? base + r.n * rowH + (r.n - 1) * gap : 0) : single) - pad;
    if (est > 0) s.style.containIntrinsicSize = "auto " + Math.round(est) + "px";
  });
}
let sizeT = 0;
window.addEventListener("resize", () => { clearTimeout(sizeT); sizeT = setTimeout(() => sizeSections($("grid")), 200); });

function renderList() {
  queueMicrotask(() => sizeSections($("grid")));   // 다 그린 뒤에 섹션 자리 높이를 맞춤
  renderTabs();
  const q = $("q").value.trim().toLowerCase();
  let list = homeItems().filter((it) => activeTab === "all" || activeTab === "people" || tabOf(it.source) === activeTab);
  if (q) {
    // 통합 검색: 제목·본문·작성자·매체 이름·그룹 이름·계정을 한 번에 찾습니다(공백으로 나눈 단어가 모두 들어 있어야 함).
    const words = q.split(/\s+/).filter(Boolean);
    const hay = (it) => {
      const t = it.via ? trackedOf(it.via) : null;
      return [it.title, it.text, it.preview, it.author, SRC_LABELS[it.source], PLATFORM[tabOf(it.source)], t && t.group, t && t.handle].filter(Boolean).join(" ").toLowerCase();
    };
    list = list.filter((it) => searchPlats.includes(tabOf(it.source)) && (() => { const h = hay(it); return words.every((w) => h.includes(w)); })());
  }
  const bySort = true; // 항상 게시 시각 순
  list.sort((a, b) => (bySort ? publishedMs(b) - publishedMs(a) : b.collectedAt - a.collectedAt));
  const g = $("grid");
  g.querySelectorAll("img[data-src]").forEach((img) => imgObserver.unobserve(img)); // 지울 카드의 그림은 더 지켜보지 않습니다
  { const ob = $("storyBar"); if (ob && typeof storyScroll !== "undefined") storyScroll = ob.scrollLeft; } // 그룹 줄을 옆으로 넘겨 둔 위치 유지
  g.textContent = "";
  g.className = "";
  // 위쪽 그룹 줄(인스타 스토리 모양): 글 영역 맨 위에 붙어 있고, 글을 내려도 위에 남습니다(stories.js)
  if (typeof storyBar === "function") { const sb = storyBar(); if (sb) { g.appendChild(sb); sb.scrollLeft = storyScroll; } }
  let ytBar = null;
  { const sp = $("sidePeople"); sp.textContent = ""; sp.hidden = true; }
  // 매체 탭(유튜브·X·인스타그램): 오른쪽 아래에 그 매체의 계정 목록(그룹 아님)을 보여주고, 누르면 그 계정 글만 봅니다.
  if (activeTab !== "people" && activeTab !== "all") {
    const accs = homeAccounts().filter((t) => t.platform === activeTab);
    const counts = new Map();
    list.forEach((it) => viasOf(it).forEach((v) => counts.set(v, (counts.get(v) || 0) + 1))); // 계정마다 전체 글을 다시 세지 않고 한 번에
    const cnt = (id) => counts.get(id) || 0;
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
    if (acctFocus) list = list.filter((it) => viasOf(it).includes(acctFocus));
    // 유튜브 탭: 영상만 / 둘 다 / 게시물만
    if (activeTab === "youtube") {
      const bar = el("div", { class: "segbar", role: "group", "aria-label": "유튜브 보기 방식" });
      [["video", "영상만"], ["both", "영상+게시물"], ["post", "게시물만"]].forEach(([m, label]) => {
        const b = el("button", { type: "button", class: ytMode === m ? "active" : "", text: label, "aria-pressed": String(ytMode === m) });
        b.addEventListener("click", () => { ytMode = m; try { localStorage.setItem("snsYtMode", m); } catch (e) {} renderList(); });
        bar.appendChild(b);
      });
      ytBar = bar;
      if (ytMode !== "both") list = list.filter((it) => it.source === "youtube-" + ytMode);
    }
  }
  if (activeTab === "people") {
    // 사람별: 같은 그룹 이름을 가진 유튜브·X·인스타 계정의 글을 한 사람 기준으로 모아 봅니다.
    // 그룹이 없는 계정은 그 계정 하나를 한 사람처럼 보여 줍니다(그룹화하지 않아도 홈에서 바로 보이게).
    // 볼 사람은 위쪽 그룹 줄에서 고릅니다(여러 명 가능). 아무도 고르지 않으면 모두 보여 줍니다.
    const all = [...peopleMap().values()];
    const hint = (text) => { g.appendChild(el("p", { class: "hint", text })); $("empty").hidden = true; };
    if (!all.length && sess && !connected) { hint(loadingText()); return; }   // 저장된 로그인으로 들어온 직후(서버에서 받기 전)
    if (!all.length) { hint("추적할 계정이 없습니다. 위쪽 검색창에 이름·@아이디·프로필 주소를 넣고 Enter로 계정을 찾아 추가하세요. 같은 사람의 유튜브·X·인스타 계정에 같은 그룹 이름을 주면 여기서 한 사람으로 모아 봅니다."); return; }
    const vp = visiblePeople();
    if (!vp.length) {
      hint(page === "fav" ? "즐겨찾기한 사람이 없습니다. 홈의 사람 이름 옆 ☆를 눌러 추가하세요." : "모든 그룹을 숨겼습니다. 추적 계정 관리의 '홈에 보일 그룹'에서 다시 보이게 할 수 있습니다.");
      return;
    }
    const sel = effSel();
    const rows = (sel.size ? vp.filter((p) => sel.has(p.name)) : vp).map((p) => ({ ...p, list: list.filter((it) => viasOf(it).some((v) => p.ids.has(v))).sort((a, b) => publishedMs(b) - publishedMs(a)) }));
    rows.sort((a, b) => (b.list[0] ? publishedMs(b.list[0]) : 0) - (a.list[0] ? publishedMs(a.list[0]) : 0));
    // 검색 중에는 어느 그룹에도 속하지 않은 계정(피드 등)의 결과도 '그 밖의 결과'로 함께 보여줍니다(그룹을 골랐으면 그 그룹만).
    const personIds = new Set(); all.forEach((p) => p.ids.forEach((id) => personIds.add(id)));
    const others = q && page !== "fav" && !sel.size ? list.filter((it) => !viasOf(it).some((v) => personIds.has(v))) : [];
    if (q) {
      // 검색 중에는 검색에 걸린 글이 있는 사람만 보여줍니다(빈 사람 줄은 숨김).
      rows.splice(0, rows.length, ...rows.filter((r) => r.list.length));
      if (!rows.length && !others.length) { hint("“" + q + "”에 맞는 글이 없습니다." + (sel.size ? " 위쪽에서 고른 그룹 안에서만 찾았습니다." : "") + " 검색창을 비우면 모든 글이 보입니다. (계정을 찾으려면 Enter)"); return; }
    }
    // 매체 이름을 눌러 들어간 '한 사람의 한 매체 전체 보기'는 그 사람이 지금 보이는 동안만 유지합니다.
    if (personPlat && !rows.some((r) => r.name === personFocus)) { personFocus = ""; personPlat = ""; }
    // 한 사람만 볼 때(그룹을 하나만 골랐거나, 매체 전체 보기 중): 그 사람의 글을 더 많이 보여 줍니다.
    const focusName = personPlat ? personFocus : sel.size === 1 && rows.length === 1 ? rows[0].name : "";
    // 오른쪽 칸: 지금 보이는 그룹 목록(글 수·안 읽은 글 빨간 점). 누르면 그 그룹 줄로 바로 내려갑니다. 고르기는 위쪽 그룹 줄에서 합니다.
    {
      const sp = $("sidePeople");
      const head = el("div", { class: "pb-head" }, [el("b", { text: (sel.size ? "고른 그룹 " : "모든 그룹 ") + rows.length + "개" })]);
      if (sel.size) {
        const clr = el("button", { type: "button", class: "pb-clear", text: "선택 풀기" });
        clr.addEventListener("click", () => { storySel = new Set(); afterStorySelect(""); });
        head.appendChild(clr);
      }
      const bar = el("div", { class: "pbar" });
      rows.forEach((r) => {
        const label = personLabel(r), accs = personAccounts(r);
        const chosen = accs.find((t) => t.platform === picPick[r.name]) || accs.find((t) => picMap[t.id]) || accs[0];
        const unread = r.list.some((it) => !seen.has(it.id));
        const b = el("button", { type: "button", class: (focusName === r.name ? "active" : "") + (unread ? " new" : ""), "aria-label": label + " " + r.list.length + "건" + (unread ? ", 안 읽은 글 있음" : "") + (focusName ? "" : " · 눌러서 그 줄로 이동") },
          [picFace(chosen, label.replace(/^@/, ""), "pface"), el("span", { class: "nm", text: label }), el("span", { class: "n", text: String(r.list.length) })]);
        b._ids = r.list.map((it) => it.id);   // 읽음이 바뀌면 refreshSideUnread가 빨간 점을 다시 맞춥니다
        b._label = label; b._n = r.list.length; b._jump = !focusName;
        if (!focusName) b.addEventListener("click", () => jumpToPerson(r.name));
        bar.appendChild(b);
      });
      sp.append(head, bar);
      sp.hidden = false;
    }
    const MEDIA = ["youtube-video", "youtube-post", "x", "instagram"];
    // 한 사람의 글을 매체별(유튜브 영상·유튜브 게시물·X·인스타그램) 줄로 나눠 보여줍니다.
    // 한 그룹에 같은 매체의 계정이 여럿이면(예: 유튜브 채널 2개) 계정마다 따로 줄을 둡니다(섞이지 않게).
    //   줄은 모두 반 칸(한 줄에 두 개)이고, 개수가 홀수면 마지막 하나만 한 줄을 다 씁니다.
    const mediaRows = (r, limit, onMore) => {
      const box = el("div", { class: "sections media-grid" });
      const nAcc = {};   // 이 사람(그룹)의 매체별 계정 수
      (r.accs || []).forEach((t) => { nAcc[t.platform] = (nAcc[t.platform] || 0) + 1; });
      // 매체(k)별 블록: 그 매체 계정이 여럿이면 계정(via)마다, 아니면 하나. 최근 글이 있는 계정부터.
      const blocks = (k) => {
        const part = r.list.filter((it) => it.source === k);
        if (!part.length) return [];
        if ((nAcc[tabOf(k)] || 0) < 2) return [{ k, via: "", part }];
        const by = new Map();
        // 공동 게시물처럼 이 그룹의 두 계정에 함께 이어진 글은 두 계정의 줄에 모두 넣습니다. r.list가 최신순이라 각 줄도 최신순
        part.forEach((it) => { const vs = viasOf(it).filter((v) => r.ids && r.ids.has(v)); (vs.length ? vs : [it.via]).forEach((v) => { if (!by.has(v)) by.set(v, []); by.get(v).push(it); }); });
        return [...by].map(([via, p]) => ({ k, via, part: p })).sort((a, b) => publishedMs(b.part[0]) - publishedMs(a.part[0]));
      };
      const sec = (b, full) => {
        const t = b.via ? trackedOf(b.via) : null;
        const who = b.via ? (b.part[0].author || (t && t.handle ? "@" + t.handle : (t && t.channelId) || "")) : "";
        const head = el("div", { class: "sec-head" }, [srcIcon(b.k), el("span", { class: "slabel", text: SRC_LABELS[b.k] + (who ? " · " + who : "") }), el("span", { class: "n", text: b.part.length + "건" })]);
        if (onMore && b.part.length > limit) {
          const more = el("button", { type: "button", text: "전체 보기" });
          more.addEventListener("click", () => onMore(b.via ? b.k + "|" + b.via : b.k));
          head.appendChild(more);
        }
        const grid = el("div", { class: "row-cards" });
        fillRow(grid, b.part.slice(0, limit));
        enableDrag(grid);
        box.appendChild(el("div", { class: "sec" + (full ? " full" : ""), "data-plat": tabOf(b.k) }, [head, grid]));
      };
      // 놓는 순서: 유튜브는 계정마다 [영상, 게시물], 그다음 X, 인스타. 모두 반 칸씩 두 개가 한 줄이고,
      // 개수가 홀수면 마지막 하나만 한 줄 전체를 씁니다(같은 매체 줄이 많아도 공간을 덜 차지하게).
      const order = [];
      const vids = blocks("youtube-video"), posts = blocks("youtube-post");
      vids.forEach((v) => { order.push(v); const i = posts.findIndex((p) => p.via === v.via); if (i >= 0) order.push(posts.splice(i, 1)[0]); });
      order.push(...posts, ...blocks("x"), ...blocks("instagram"));
      order.forEach((b, i) => sec(b, order.length % 2 === 1 && i === order.length - 1));
      if (!box.children.length) box.appendChild(el("p", { class: "hint", text: "이 기간에 수집된 글이 없습니다." }));
      return box;
    };
    const body = el("div", { class: "sections" });
    if (focusName) {
      const r = rows.find((x) => x.name === focusName);
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
        // personPlat: 매체(예: youtube, x) 또는 줄 종류(youtube-video …). 같은 매체 계정이 여럿인 줄의 '전체 보기'는 "줄 종류|계정"
        const [pk, pv] = personPlat.split("|");
        const mine = r.list.filter((it) => (it.source === pk || tabOf(it.source) === pk) && (!pv || viasOf(it).includes(pv)));
        const who = pv && mine[0] ? " · " + (mine[0].author || "") : "";
        const grid = el("div", { class: "cards" }, [el("div", { class: "sec-head", style: "grid-column: 1 / -1" }, [back, el("h3", { text: (SRC_LABELS[pk] || PLATFORM[pk] || pk) + who })])]);
        mine.slice(0, 300).forEach((it) => grid.appendChild(card(it)));
        body.appendChild(grid);
      } else {
        body.appendChild(el("section", { class: "sec" }, [
          el("div", { class: "sec-head" }, [personAvatar(r), el("h3", { text: r.name }), favStar(r.name), platMeta(r)]),
          mediaRows(r, 30, (k) => { backCtx = null; personFocus = r.name; personPlat = k; renderList(); }),
        ]));
      }
    } else {
      rows.forEach((r) => {
        // 이름을 누르면 위쪽 그룹 줄에서 이 사람만 고른 것과 같습니다.
        const nameBtn = el("h3", { class: "namelink", text: r.name, role: "button", tabindex: "0", title: "이 사람만 보기" });
        const go = () => { storySel = new Set([r.name]); personFocus = ""; personPlat = ""; renderList(); const g2 = $("grid"); if (g2) g2.scrollTop = 0; };
        nameBtn.addEventListener("click", go);
        nameBtn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
        const head = el("div", { class: "sec-head" }, [personAvatar(r), nameBtn, favStar(r.name), platMeta(r)]);
        const sec = el("section", { class: "sec" }, [head, mediaRows(r, 20, null)]);
        sec._person = r.name;
        body.appendChild(sec);
      });
    }
    if (others.length && !focusName) {
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
  if (!q) {
    // 그룹·계정별: 그룹 이름이 같은 계정은 한 줄로, 그룹 없는 계정은 계정마다 한 줄로 보여줍니다.
    // 매체 탭(유튜브·X·인스타)에서 한 그룹에 그 매체 계정이 여럿이면 계정마다 따로 줄을 둡니다(섞이지 않게).
    g.classList.add("sections");
    const groups = new Map();
    const accs = homeAccounts();   // 숨긴 그룹은 빼고, 위쪽에서 그룹을 골랐으면 그 그룹만
    const many = (t) => activeTab === t.platform && accs.filter((o) => o.group === t.group && o.platform === t.platform).length > 1;
    accs.forEach((t) => {
      const split = t.group && many(t);
      const key = t.group ? "g:" + t.group + (split ? "|" + t.id : "") : "a:" + t.id;
      const tag = "@" + (t.handle || t.channelId || "");
      if (!groups.has(key)) groups.set(key, { name: t.group ? t.group + (split ? " · " + tag : "") : PLATFORM[t.platform] + " " + tag, ids: new Set(), plats: [] });
      const gr = groups.get(key);
      gr.ids.add(t.id);
      gr.plats.push(PLATFORM[t.platform]);
    });
    // 오른쪽 목록에서 계정 하나를 골랐으면 그 계정의 줄만(공동 게시물로 다른 계정 줄에도 걸리는 글이 그 줄을 따로 띄우지 않게)
    const rows = [...groups.values()].filter((gr) => !acctFocus || gr.ids.has(acctFocus)).map((gr) => ({ ...gr, list: list.filter((it) => viasOf(it).some((v) => gr.ids.has(v))) }));
    const known = new Set(tracked.map((t) => t.id));
    const rest = list.filter((it) => !viasOf(it).some((v) => known.has(v)));
    if (rest.length) rows.push({ name: "기타", plats: [], ids: new Set(), list: rest });
    rows.forEach((r) => r.list.sort((a, b) => publishedMs(b) - publishedMs(a)));
    rows.sort((a, b) => (b.list[0] ? publishedMs(b.list[0]) : 0) - (a.list[0] ? publishedMs(a.list[0]) : 0));
    const focused = groupFocus && rows.find((r) => r.name === groupFocus);
    if (groupFocus && !focused) groupFocus = "";
    if (focused) {
      // 한 그룹의 글을 전부 펼쳐서 보여줍니다.
      g.className = "cards";
      if (ytBar) g.appendChild(el("div", { style: "grid-column: 1 / -1" }, [ytBar]));
      const back = el("button", { type: "button", text: "← 그룹 목록으로" });
      back.addEventListener("click", () => { groupFocus = ""; renderList(); });
      g.appendChild(el("div", { class: "sec-head", style: "grid-column: 1 / -1" }, [back, el("h3", { text: focused.name }), el("span", { class: "n", text: focused.list.length + "건" })]));
      appendProgressive(g, focused.list.slice(0, 300));
      $("empty").hidden = list.length > 0;
      return;
    }
    if (ytBar) g.appendChild(el("div", { class: "segwrap" }, [ytBar]));
    // 특정 매체 탭에서는 그 매체에 글이 없는 계정·그룹 줄은 숨깁니다.
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
  } else {
    g.className = "cards";
    if (ytBar) g.appendChild(el("div", { style: "grid-column: 1 / -1" }, [ytBar]));
    appendProgressive(g, list.slice(0, 300));
  }
  const emptyMsg = q ? "“" + q + "”에 맞는 글이 없습니다. 검색창을 비우면 모든 글이 보입니다."
    : ytBar && ytMode !== "both" ? "이 기간에 모은 유튜브 " + (ytMode === "video" ? "영상" : "게시물") + "이 없습니다."
    : connected ? (tracked.length ? "이 기간에 모은 글이 없습니다. '지금 최신화'를 눌러 보세요." : "추적할 계정이 없습니다. 위쪽 검색창에 이름·@아이디·프로필 주소를 넣고 Enter로 계정을 찾아 추가하세요.")
    : sess ? loadingText()
    : "아직 보여줄 글이 없습니다. 로그인하고 계정을 추가하면 설정한 기간(최대 60일)의 글이 여기에 모입니다.";
  if (ytBar && !list.length) {
    // 영상/게시물 선택 막대가 가려지지 않게, 빈 안내는 글 영역 안(막대 아래)에 둡니다.
    g.appendChild(el("p", { class: "hint", style: "grid-column: 1 / -1; padding: 24px 4px", text: emptyMsg }));
    $("empty").hidden = true;
    return;
  }
  $("empty").hidden = list.length > 0;
  $("empty").textContent = emptyMsg;
}
// 추적 계정 관리 화면(renderTracked 등)은 js/manage.js에 있습니다.
// 새로고침(지금 최신화) 버튼: 수집 중이면 돌고(busy), 누르면 '멈추기'로 씁니다.
function paintCheckNow() {
  const b = $("checkNow"), run = !!(checkStatus && checkStatus.running), wait = typeof refreshing !== "undefined" && refreshing;
  b.classList.toggle("busy", run || wait);
  b.disabled = wait || (!run && tracked.length === 0) || !connected;
  const t = run ? "수집 중 · 눌러서 멈추기" : tracked.length ? "지금 최신화" : "지금 최신화 (먼저 추적할 계정을 추가하세요)";
  b.title = t; b.setAttribute("aria-label", t);
}
function renderSettings() {
}
function renderAll() {
  renderSettings(); renderTracked(); renderList();
  updateConnText(); renderWork();
}
function showErr(e) { if (e && e.authLost) return; toast((e && e.message) || String(e), "error"); }


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
    if (nextAuto) {
      const left = Math.round((nextAuto - Date.now()) / 60000);
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

/* 프로필 사진: 서버에 저장된 계정 사진(검색할 때 받아 둔 것)을 받아 이 브라우저에 작게 저장합니다.
   서버에도 없는 유튜브 계정만, 하루에 한 번까지 유튜브에서 다시 찾아 봅니다.
   (X·인스타는 서버 테스트 계정으로 반복 검색하면 계정이 잠길 수 있어 자동으로 찾지 않습니다. 필요하면 '사진 올리기'로 직접 올립니다.) */
let picAt = {}, picBusy = false;
const avAsked = new Set();
try { picAt = JSON.parse(lsGet("snsPicAt", "{}")) || {}; } catch (e) {}
const savePicAt = () => lsSet("snsPicAt", JSON.stringify(picAt));
async function fetchAvatars() {
  if (!connected) return false;
  const ids = tracked.map((t) => t.id).filter((id) => !picMap[id] && !avAsked.has(id));
  if (!ids.length) return false;
  ids.forEach((id) => avAsked.add(id));
  let got = {};
  try { got = (await call("avatars", { ids })) || {}; } catch (e) { ids.forEach((id) => avAsked.delete(id)); return false; }
  let n = 0;
  for (const [id, data] of Object.entries(got)) if (!picMap[id] && (await storePic(id, data))) n++;
  if (n) renderList();
  return n > 0;
}
async function refreshPics(max = 3) {
  if (picBusy || !connected) return;
  picBusy = true;
  try {
    await fetchAvatars();
    const now = Date.now();
    const due = tracked
      .filter((t) => t.platform === "youtube" && !t.hidden && (t.handle || t.channelId) && !picMap[t.id] && now - (picAt[t.id] || 0) > 86400000)
      .slice(0, max);
    for (const t of due) {
      if (checkStatus && checkStatus.running) break; // 수집이 다시 시작되면 멈춥니다
      picAt[t.id] = Date.now(); savePicAt(); // 실패해도 하루 동안은 다시 시도하지 않게 먼저 기록
      let res = [];
      try { res = await call("searchAccount", { platform: t.platform, q: t.handle ? "@" + t.handle : t.channelId }, LONG_WAIT); } catch (e) { continue; }
      const h = String(t.handle || "").toLowerCase();
      const hit = (res || []).find((r) => (h && String(r.handle || "").toLowerCase() === h) || (t.channelId && r.channelId === t.channelId));
      if (hit && hit.avatar && (await storePic(t.id, hit.avatar))) renderList();
    }
  } finally { picBusy = false; }
}
