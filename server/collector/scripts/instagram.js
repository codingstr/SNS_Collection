// 인스타그램: 피드/상세 화면의 게시물(article)과 프로필 격자의 게시물·릴스를 수집합니다.
// 인스타그램 화면 구조는 자주 바뀌므로, 안 잡히면 아래 선택자를 손봐야 할 수 있습니다.
(function () {
  const { start, clip } = SNS;

  const CODE = /\/(p|reel)\/([\w-]+)/;

  function bestImage(root) {
    const imgs = Array.from(root.querySelectorAll("img")).filter(
      (i) => !i.closest("header") && (i.currentSrc || i.src)
    );
    imgs.sort((a, b) => (b.naturalWidth || b.width) - (a.naturalWidth || a.width));
    return imgs[0] || null;
  }

  function scanArticles(out) {
    document.querySelectorAll("article").forEach((art) => {
      const timeEl = art.querySelector("time[datetime]");
      const link =
        (timeEl && timeEl.closest("a")) ||
        art.querySelector('a[href*="/p/"], a[href*="/reel/"]');
      if (!link) return;
      const m = CODE.exec(link.getAttribute("href") || "");
      if (!m) return;

      const img = bestImage(art);
      const video = art.querySelector("video");
      const thumb = (img && (img.currentSrc || img.src)) || (video && video.poster) || "";
      if (!thumb) return; // 이미지가 아직 안 불러와졌으면 다음 스캔에서 다시 봅니다

      const authorEl = art.querySelector("header a[href^='/']");
      const author = clip(authorEl && authorEl.textContent, 60);

      const h1 = art.querySelector("h1");
      let caption = clip(h1 && h1.textContent, 280);
      if (!caption) {
        const spans = Array.from(art.querySelectorAll('span[dir="auto"]')).filter(
          (s) => !s.closest("header")
        );
        spans.sort((a, b) => b.textContent.length - a.textContent.length);
        caption = clip(spans[0] && spans[0].textContent, 280);
      }

      out.push({
        id: "ig:" + m[2],
        source: "instagram",
        url: "https://www.instagram.com/" + m[1] + "/" + m[2] + "/",
        title: caption || clip(img && img.alt, 200) || "(게시물)",
        author,
        thumb,
        publishedAt: (timeEl && timeEl.getAttribute("datetime")) || "",
      });
    });
  }

  // 프로필 격자에는 게시 날짜가 보이지 않습니다. 서버 수집기가 이 화면이 받아 온 응답에서 읽은 날짜를
  // window.__snsIgDates({게시물 코드: {t: 초, pin: 고정 여부}})로 넣어 줍니다(사이트에 따로 요청하지 않음).
  // 날짜를 아직 모르는 글은 날짜 없이 보내고, 서버가 나중에 알게 되면 채웁니다.
  const PIN_ICON = 'svg[aria-label*="고정"], svg[aria-label*="Pinned"], svg[aria-label*="pinned"]';
  function scanGrid(out) {
    const profile = /^\/([\w.]+)\/?$/.exec(location.pathname);
    const dates = window.__snsIgDates || {};
    document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach((a) => {
      if (a.closest("article")) return;
      const m = CODE.exec(a.getAttribute("href") || "");
      const img = a.querySelector("img");
      if (!m || !img || !(img.currentSrc || img.src)) return;
      const d = dates[m[2]];
      out.push({
        id: "ig:" + m[2],
        source: "instagram",
        url: "https://www.instagram.com/" + m[1] + "/" + m[2] + "/",
        title: clip(img.alt, 200) || "(게시물)",
        author: profile ? profile[1] : "",
        thumb: img.currentSrc || img.src,
        publishedAt: d && d.t ? new Date(d.t * 1000).toISOString() : "",
        _noStop: !!((d && d.pin) || a.querySelector(PIN_ICON)), // 고정 게시물은 날짜 순서에서 벗어나므로 멈춤 판단에서 제외
      });
    });
  }

  function scan() {
    const out = [];
    scanArticles(out);
    scanGrid(out);
    return out;
  }

  function login() {
    // 로그인되면 읽을 수 있는 계정 번호 쿠키(ds_user_id)가 생깁니다. 가장 확실한 신호입니다.
    try { if (/(?:^|;\s*)ds_user_id=\d+/.test(document.cookie)) return true; } catch (e) { /* 무시 */ }
    // 로그인 후 화면의 메뉴 아이콘/링크
    if (document.querySelector('a[href="/direct/inbox/"], a[href="/explore/"], svg[aria-label="홈"], svg[aria-label="Home"], svg[aria-label="새로운 게시물"], svg[aria-label="New post"]')) return true;
    // 로그인 입력창이 보일 때만 '로그아웃 상태'로 판단합니다(푸터의 로그인 링크 등은 무시).
    if (document.querySelector('input[name="username"], input[name="email"]')) return false;
    return null;
  }

  // 이름으로 계정 검색(로그인된 상태로 인스타그램 검색 주소를 호출). 사이트 사정으로 막힐 수 있음

  // 사진 주소를 못 읽은 계정은 그 계정 프로필 페이지의 대표 이미지(og:image)에서 보충합니다.
  async function fillAvatars(list) {
    await Promise.all(list.filter((r) => !r.avatar && r.handle).map(async (r) => {
      try {
        const res = await fetch("/" + encodeURIComponent(r.handle) + "/", { credentials: "include" });
        const html = await res.text();
        const m = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html) || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(html);
        const u = m ? m[1].replace(/&amp;/g, "&") : "";
        if (/^https:\/\//.test(u)) r.avatar = u;
      } catch (e) { /* 사진 없이 진행 */ }
    }));
    return list;
  }

  // 계정 주소처럼 보이지만 계정이 아닌 경로(메뉴·푸터 링크 등)
  const NOT_USER = new Set(["explore", "reels", "direct", "accounts", "p", "reel", "reels", "tv", "stories", "about", "legal", "web", "api",
    "emails", "challenge", "your_activity", "settings", "popular", "privacy", "terms", "developer", "directory", "locations", "lite",
    "blog", "jobs", "help", "press", "session", "topics", "contact", "download", "meta", "threads", "verified", "notifications", "create"]);
  const userOfHref = (href) => { const m = /^\/([\w.]{1,30})\/$/.exec(href || ""); return m && !NOT_USER.has(m[1].toLowerCase()) ? m[1] : ""; };

  // 인스타그램 화면의 검색창에 직접 입력해서 결과 목록을 읽습니다(사이트가 보여주는 그대로).
  // 검색어를 넣기 전부터 화면에 있던 링크(메뉴·피드·푸터의 계정 링크 등)는 결과로 치지 않고,
  // 검색어를 넣은 뒤 검색창 근처(검색 패널)에 새로 나타난 계정만 읽습니다.
  async function searchByUi(q) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const findInput = () => document.querySelector('input[aria-label="검색 입력"], input[aria-label="Search input"], input[placeholder="검색"], input[placeholder="Search"], input[type="search"]');
    let input = findInput();
    for (let i = 0; i < 24 && !input; i++) {
      // 검색 아이콘을 눌러 검색창을 엽니다.
      const icon = document.querySelector('svg[aria-label="검색"], svg[aria-label="Search"]');
      const btn = icon && (icon.closest("a, button, [role='link'], [role='button']") || icon.parentElement);
      if (btn && i % 6 === 0) { try { btn.click(); } catch (e) { /* 무시 */ } }
      await wait(250);
      input = findInput();
    }
    if (!input) return [];
    await wait(300);
    const before = new Set(Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")));
    // 검색 패널: 검색창을 감싼 요소 중 링크를 담을 만큼 큰 조상(없으면 문서 전체)
    const panelOf = () => {
      let el = input;
      for (let i = 0; i < 12 && el && el.parentElement; i++) {
        el = el.parentElement;
        if (el.querySelectorAll("a[href]").length && el.getBoundingClientRect().height > 200) return el;
      }
      return document;
    };
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, q);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const read = () => {
      const out = [], seen = new Set();
      panelOf().querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href") || "";
        const h = userOfHref(href);
        if (!h || before.has(href) || seen.has(h.toLowerCase())) return;
        if (a.closest("header, nav, footer") || /프로필|Profile/.test(a.getAttribute("aria-label") || "")) return;
        const lines = String(a.innerText || "").split("\n").map((t) => t.trim()).filter(Boolean);
        if (!lines.length || /^(프로필|Profile|더 보기|More)$/.test(lines[0])) return;
        const img = a.querySelector("img");
        seen.add(h.toLowerCase());
        out.push({ handle: h, name: clip(lines[1] || lines[0], 80), desc: clip(lines.slice(2).join(" "), 80), avatar: (img && (img.currentSrc || img.src)) || "" });
      });
      return out;
    };
    let last = -1;
    for (let i = 0; i < 32; i++) {
      await wait(250);
      const n = read().length;
      if (n && n === last) return read().slice(0, 8); // 결과 수가 한 번 더 같으면(다 그려졌으면) 읽습니다
      last = n;
    }
    return read().slice(0, 8);
  }

  // 검색어와 아이디가 정확히 같은 계정을 맨 앞으로(없고 아이디 모양이면 그 계정을 직접 찾아 맨 앞에 넣음)
  async function exactFirst(q, list, lookup) {
    const name = q.replace(/^@/, "").trim().toLowerCase();
    const i = list.findIndex((r) => r.handle.toLowerCase() === name);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
    if (i < 0 && /^[\w.]{1,30}$/.test(name)) { const u = await lookup(name); if (u) list.unshift(u); }
    return list.slice(0, 8);
  }

  async function search(q) {
    const csrf = (/(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie) || [])[1] || "";
    const headers = { "x-ig-app-id": "936619743392459", "x-requested-with": "XMLHttpRequest", "x-asbd-id": "129477", "x-csrftoken": csrf };
    const mapUser = (u) => ({
      handle: (u && u.username) || "",
      name: clip(u && u.full_name, 80),
      desc: u && u.is_verified ? "인증된 계정" : "",
      avatar: (u && u.profile_pic_url) || "",
    });
    const lookup = async (name) => {
      try {
        const r = await fetch("/api/v1/users/web_profile_info/?username=" + encodeURIComponent(name), { credentials: "include", headers });
        if (!r.ok) return null;
        const j = await r.json();
        const u = j && j.data && j.data.user;
        return u && u.username ? mapUser(u) : null;
      } catch (e) { return null; }
    };
    // 1) 인스타그램 검색 주소(로그인된 테스트 계정으로): 화면 상태와 상관없이 검색 결과만 받아 옵니다.
    for (const base of ["/api/v1/web/search/topsearch/?context=blended&include_reel=false&query=", "/web/search/topsearch/?context=blended&include_reel=false&query="]) {
      try {
        const r = await fetch(base + encodeURIComponent(q), { credentials: "include", headers });
        if (!r.ok) continue;
        const j = await r.json();
        const list = (j.users || []).map((x) => mapUser(x.user)).filter((x) => x.handle && !NOT_USER.has(x.handle.toLowerCase()));
        if (list.length) return fillAvatars(await exactFirst(q, list, lookup));
      } catch (e) { /* 다음 방법 */ }
    }
    // 2) 화면의 검색창에 직접 입력
    try {
      const ui = await searchByUi(q);
      if (ui.length) return fillAvatars(await exactFirst(q, ui, lookup));
    } catch (e) { /* 다음 방법 */ }
    // 3) 아이디 모양이면 프로필 조회로 한 건이라도 찾아 봅니다.
    const name = q.replace(/^@/, "").trim();
    if (/^[\w.]{1,30}$/.test(name)) { const u = await lookup(name); if (u) return fillAvatars([u]); }
    return [];
  }

  start({ source: "instagram", scan, login, search });
})();
