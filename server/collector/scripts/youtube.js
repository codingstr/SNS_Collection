// 유튜브: 영상(홈·구독·채널·검색 등)과 커뮤니티 게시물(채널 게시물 탭, 구독 피드)을 수집합니다.
(function () {
  const { start, clip, relativeToIso } = SNS;

  const VIDEO_BOX = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-playlist-video-renderer",
    "yt-lockup-view-model",
  ].join(",");

  const TIME_TEXT = /(전|ago)$/;
  // 유튜브 이미지 주소 끝의 크기·자르기(-c-fcrop…) 표시를 떼고 원본 비율의 지정 크기로 바꿉니다(안 그러면 정사각형으로 잘린 그림이 옵니다).
  const bigImg = (u, n) => String(u || "").replace(/=(s|w)\d+[^/?#]*$/, "=s" + (n || 1200));

  function scanVideos(out) {
    document
      .querySelectorAll('a[href*="/watch?v="], a[href^="/shorts/"]')
      .forEach((a) => {
        const href = a.getAttribute("href") || "";
        const m = /[?&]v=([\w-]{11})/.exec(href) || /\/shorts\/([\w-]{11})/.exec(href);
        if (!m) return;
        const box = a.closest(VIDEO_BOX);
        if (!box) return; // 재생 중인 영상 자체 등은 제외
        const titleEl = box.querySelector(
          "#video-title, .yt-lockup-metadata-view-model__title, h3 a, h3"
        );
        const title = clip(
          (titleEl && (titleEl.getAttribute("title") || titleEl.textContent)) ||
            a.getAttribute("title") ||
            a.getAttribute("aria-label"),
          200
        );
        if (!title) return; // 제목이 아직 안 그려졌으면 다음 스캔에서 다시 봅니다
        // 유튜브가 클래스 이름 형식을 바꿔도 잡히도록 두 가지 형태를 모두 봅니다.
        const META = "[class*='ContentMetadataViewModelMetadataText'], .yt-content-metadata-view-model__metadata-text";
        const channelEl = box.querySelector("ytd-channel-name a, #channel-name a, " + META);
        const metaTexts = Array.from(box.querySelectorAll("#metadata-line span, " + META)).map((e) =>
          e.textContent.trim()
        );
        const isShort = href.startsWith("/shorts/");
        const pubText = clip(metaTexts.find((t) => TIME_TEXT.test(t)) || "", 40);
        out.push({
          id: "yt:" + m[1],
          source: "youtube-video",
          url: isShort
            ? "https://www.youtube.com/shorts/" + m[1]
            : "https://www.youtube.com/watch?v=" + m[1],
          title,
          author: clip(channelEl && channelEl.textContent, 80),
          thumb: "https://i.ytimg.com/vi/" + m[1] + "/hqdefault.jpg",
          publishedText: pubText,
          publishedAt: relativeToIso(pubText), // "3일 전" → 대략적인 날짜
        });
      });
  }

  function scanPosts(out) {
    document
      .querySelectorAll("ytd-backstage-post-renderer, ytd-post-renderer")
      .forEach((p) => {
        const link = p.querySelector('a[href*="/post/"]');
        if (!link) return;
        const m = /\/post\/([\w-]+)/.exec(link.getAttribute("href") || "");
        if (!m) return;
        const textEl = p.querySelector("#content-text");
        const text = clip(textEl && textEl.textContent, 280);
        const imgEl = Array.from(p.querySelectorAll("img")).find(
          (i) => !i.closest("#author-thumbnail") && i.src
        );
        if (!text && !imgEl) return;
        const authorEl = p.querySelector("#author-text");
        const timeEl = p.querySelector("#published-time-text");
        out.push({
          id: "ytpost:" + m[1],
          source: "youtube-post",
          url: "https://www.youtube.com/post/" + m[1],
          title: text || "(이미지 게시물)",
          author: clip(authorEl && authorEl.textContent, 80),
          thumb: imgEl ? imgEl.src : "",
          publishedText: clip(timeEl && timeEl.textContent, 40),
          publishedAt: relativeToIso(timeEl && timeEl.textContent),
          _noStop: !!p.querySelector("#pinned-header, ytd-pinned-header-renderer"), // 고정 게시물은 순서에서 벗어나므로 멈춤 판단에서 제외(추정 선택자)
        });
      });
  }

  function scan() {
    const out = [];
    scanVideos(out);
    scanPosts(out);
    return out;
  }

  // 로그인 여부: true / false / null(아직 모름)
  function login() {
    if (document.querySelector("#avatar-btn, button#avatar-btn")) return true;
    // 보이지 않는 탭에서는 상단 프로필 버튼이 아직 안 그려질 수 있어, 로그인하면 생기는 구글 쿠키로도 확인합니다.
    try { if (/(?:^|;\s*)(SAPISID|__Secure-3PAPISID|__Secure-1PAPISID)=/.test(document.cookie)) return true; } catch (e) { /* 무시 */ }
    if (document.querySelector('a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/v3/signin"]')) return false;
    return null;
  }

  // 이름으로 채널 검색(검색 결과 화면에서 채널만 읽음)
  async function search() {
    for (let i = 0; i < 32; i++) {
      if (document.querySelector("ytd-channel-renderer")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // 프로필 사진은 조금 늦게 불러와지므로, 모든 결과에 사진 주소가 생길 때까지 잠시(최대 약 4초) 기다립니다.
    const hasAvatar = (c) => Array.from(c.querySelectorAll("img")).some((im) => /^(https:)?\/\/(yt3\.ggpht\.com|yt3\.googleusercontent\.com)\//.test(im.currentSrc || im.src || ""));
    for (let i = 0; i < 12; i++) {
      const list = Array.from(document.querySelectorAll("ytd-channel-renderer"));
      if (list.length && list.every(hasAvatar)) break;
      list.forEach((c) => { try { c.scrollIntoView({ block: "nearest" }); } catch (e) { /* 무시 */ } });
      await new Promise((r) => setTimeout(r, 250));
    }
    const out = [];
    document.querySelectorAll("ytd-channel-renderer").forEach((c) => {
      const a = c.querySelector("a#main-link, a[href^='/@'], a[href^='/channel/']");
      const href = (a && a.getAttribute("href")) || "";
      let handle = "";
      let channelId = "";
      const hm = /^\/@([^/?#]+)/.exec(href);
      const cm = /^\/channel\/(UC[\w-]{22})/.exec(href);
      if (hm) { try { handle = decodeURIComponent(hm[1]); } catch (e) { handle = hm[1]; } }
      else if (cm) channelId = cm[1];
      else return;
      // 같은 글자가 두 번 붙어 읽히는 경우("이름 이름")를 한 번으로 줄입니다.
      const once = (t) => {
        const s = String(t || "").replace(/\s+/g, " ").trim();
        const h = Math.floor(s.length / 2);
        if (s.length > 1 && s.length % 2 === 1 && s[h] === " " && s.slice(0, h) === s.slice(h + 1)) return s.slice(0, h);
        if (s.length > 1 && s.length % 2 === 0 && s.slice(0, h) === s.slice(h)) return s.slice(0, h);
        return s;
      };
      const nameEl = c.querySelector("ytd-channel-name #text, ytd-channel-name yt-formatted-string, #text");
      const name = clip(once(nameEl && (nameEl.innerText || nameEl.textContent)), 80);
      let desc = once((c.querySelector("#metadata #subscribers, #subscribers") || {}).textContent);
      if (desc.replace(/^@/, "").toLowerCase() === String(handle || "").toLowerCase()) desc = "";
      desc = clip(desc, 60);
      let avatar = "";
      for (const im of c.querySelectorAll("#avatar img, yt-img-shadow img, img")) {
        let u = im.currentSrc || im.src || "";
        if (u.startsWith("//")) u = "https:" + u;
        if (/^https:\/\/(yt3\.ggpht\.com|yt3\.googleusercontent\.com)\//.test(u)) { avatar = u; break; }
        if (!avatar && /^https:\/\//.test(u)) avatar = u;
      }
      out.push({ handle, channelId, name, desc, avatar });
    });
    // 보이지 않는 탭에서는 아래쪽 결과의 사진이 아직 불러와지지 않으므로, 같은 검색 주소의 데이터에서 사진 주소를 보충합니다.
    if (out.some((r) => !r.avatar)) {
      try {
        const res = await fetch(location.href, { credentials: "include" });
        const html = await res.text();
        const mm = /var ytInitialData\s*=\s*(\{.*?\});<\/script>/s.exec(html);
        if (mm) {
          const map = {};
          const walk = (o, d) => {
            if (!o || typeof o !== "object" || d > 60) return;
            if (Array.isArray(o)) { o.forEach((x) => walk(x, d + 1)); return; }
            const c = o.channelRenderer;
            if (c && typeof c === "object") {
              const th = (c.thumbnail && c.thumbnail.thumbnails) || [];
              let u = (th[th.length - 1] || {}).url || "";
              if (u.startsWith("//")) u = "https:" + u;
              if (/^https:\/\//.test(u)) {
                if (c.channelId) map[c.channelId] = u;
                const base = (c.navigationEndpoint && c.navigationEndpoint.browseEndpoint && c.navigationEndpoint.browseEndpoint.canonicalBaseUrl) || "";
                let hd = base.replace(/^\/@?/, "");
                try { hd = decodeURIComponent(hd); } catch (e) { /* 그대로 */ }
                if (hd) map["@" + hd.toLowerCase()] = u;
              }
            }
            Object.keys(o).forEach((k) => walk(o[k], d + 1));
          };
          walk(JSON.parse(mm[1]), 0);
          out.forEach((r) => {
            if (r.avatar) return;
            r.avatar = (r.channelId && map[r.channelId]) || (r.handle && map["@" + r.handle.toLowerCase()]) || "";
          });
        }
      } catch (e) { /* 사진 없이 진행 */ }
    }
    return out.slice(0, 8);
  }

  // 게시물 한 개의 내용을 읽어 돌려줍니다(저장하지 않고, 사용자가 카드를 눌렀을 때만 화면에 보여주는 용도).
  // 게시물 페이지의 데이터(ytInitialData)에서 본문 전체와 모든 사진을 직접 읽습니다. 화면을 그리지 않는 탭에서도 되고,
  // '자세히 알아보기'를 누르지 않아도 전체 본문이 들어 있습니다. 못 읽으면 null → 화면에서 읽는 방식으로 넘어갑니다.
  async function postFromData() {
    try {
      const html = await (await fetch(location.href, { credentials: "include" })).text();
      const mm = /var ytInitialData\s*=\s*(\{.*?\});<\/script>/s.exec(html);
      if (!mm) return null;
      let p = null;
      const walk = (o, d) => {
        if (p || !o || typeof o !== "object" || d > 60) return;
        if (o.backstagePostRenderer && o.backstagePostRenderer.postId) { p = o.backstagePostRenderer; return; }
        for (const k in o) walk(o[k], d + 1);
      };
      walk(JSON.parse(mm[1]), 0);
      if (!p) return null;
      const rt = (t) => (t && (t.simpleText || (t.runs || []).map((r) => r.text).join(""))) || "";
      const images = [];
      const att = p.backstageAttachment || {};
      const addImg = (r) => {
        const th = (r && r.image && r.image.thumbnails) || [];
        const u = (th[th.length - 1] || {}).url;
        if (/^https:\/\//.test(u || "")) { const b = bigImg(u, 1000); if (!images.includes(b)) images.push(b); }
      };
      if (att.postMultiImageRenderer) (att.postMultiImageRenderer.images || []).forEach((i) => addImg(i.backstageImageRenderer));
      if (att.backstageImageRenderer) addImg(att.backstageImageRenderer);
      let video = null;
      const vm = JSON.stringify(att.videoRenderer || {}).match(/"videoId":"([\w-]{11})"/);
      if (vm) video = { id: vm[1], title: clip(rt((att.videoRenderer || {}).title), 120) };
      const av = (((p.authorThumbnail || {}).thumbnails) || []).slice(-1)[0];
      return {
        author: clip(rt(p.authorText), 80),
        time: clip(rt(p.publishedTimeText), 40),
        text: rt(p.contentText).replace(/\r/g, "").trim(),
        likes: clip(rt(p.voteCount), 20),
        avatar: (av && av.url) || "",
        images: images.slice(0, 10),
        video,
      };
    } catch (e) {
      return null;
    }
  }

  async function post() {
    const d = await postFromData();
    if (d && (d.text || d.images.length || d.video)) return d;
    return postFromDom();
  }

  async function postFromDom() {
    const sel = "ytd-backstage-post-renderer, ytd-post-renderer";
    for (let i = 0; i < 24; i++) {
      if (document.querySelector(sel)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 800));
    const p = document.querySelector(sel);
    if (!p) return null;
    const text = String((p.querySelector("#content-text") || {}).innerText || "").replace(/\r/g, "").trim();
    const avatarEl = p.querySelector("#author-thumbnail img");
    const images = [];
    const big = (u) => u.replace(/=(s|w)\d+[^/?#]*$/, "=s1200");
    const grab = () => {
      p.querySelectorAll("ytd-backstage-image-renderer img, ytd-post-multi-image-renderer img, #post-image img, #attachment img").forEach((img) => {
        const src = img.currentSrc || img.src || "";
        if (!/^https:\/\//.test(src) || (avatarEl && src === avatarEl.src)) return;
        const u = big(src);
        if (!images.includes(u)) images.push(u);
      });
    };
    grab();
    // 사진이 여러 장이면 '다음' 버튼을 눌러 가며 모읍니다.
    for (let i = 0; i < 8 && images.length < 6; i++) {
      const next = p.querySelector("#right-arrow button, #right-arrow");
      if (!next || next.offsetParent === null) break;
      const before = images.length;
      next.click();
      await new Promise((r) => setTimeout(r, 350));
      grab();
      if (images.length === before && i > 0) break;
    }
    // 게시물에 첨부된 영상(유튜브 영상/쇼츠)
    let video = null;
    const va = p.querySelector('#attachment a[href*="/watch?v="], #attachment a[href*="/shorts/"], ytd-video-renderer a[href*="/watch?v="], a[href*="/watch?v="]');
    if (va) {
      const m = /[?&]v=([\w-]{11})|\/shorts\/([\w-]{11})/.exec(va.href || "");
      if (m) video = { id: m[1] || m[2], title: clip((p.querySelector("#attachment #video-title") || va).textContent, 120) };
    }
    return {
      author: clip((p.querySelector("#author-text") || {}).textContent, 80),
      time: clip((p.querySelector("#published-time-text") || {}).textContent, 40),
      text,
      likes: clip((p.querySelector("#vote-count-middle") || {}).textContent, 20),
      avatar: (avatarEl && avatarEl.src) || "",
      images: images.slice(0, 6),
      video,
    };
  }

  // 채널 '동영상'·'쇼츠'·'게시물' 탭: 화면을 그리거나 스크롤하지 않고 유튜브가 화면용으로 쓰는 데이터 요청(youtubei browse)으로 목록을 이어서 받습니다.
  // 수집 창이 다른 창에 가려져 유튜브가 목록을 더 그리지 않아도 동작합니다. 실패하면 null → 기존 스크롤 방식으로 넘어갑니다(쇼츠는 제외).
  //
  // 쇼츠 탭 목록에는 게시 날짜가 없습니다. 날짜는 유튜브가 공개로 주는 채널 RSS(/feeds/videos.xml, 최근 업로드 15개·영상과 쇼츠 섞임)에서
  // 정확한 게시 시각을 받습니다(요청 1번). RSS에 없는 쇼츠는 RSS의 가장 오래된 글보다 더 오래된 것이므로:
  //   - 그 시각이 가져올 기간보다 오래됐으면 → 기간 밖이라 거기서 멈춤
  //   - 아니면 날짜를 알 수 없음 → 거기서 멈추고 저장하지 않음(날짜 없이 저장하면 최신 글로 잘못 정렬되기 때문)
  // 이미 모은 쇼츠(DB에 날짜가 있음)는 날짜 없이 보내도 서버가 예전 날짜를 그대로 둡니다.
  async function shortsDates(channelId) {
    const out = { ok: false, dates: {}, oldest: 0 };
    if (!/^UC[\w-]{22}$/.test(channelId || "")) return out;
    try {
      const res = await fetch("/feeds/videos.xml?channel_id=" + channelId, { credentials: "omit" });
      if (!res.ok) return out;
      const doc = new DOMParser().parseFromString(await res.text(), "application/xml");
      const entries = Array.from(doc.getElementsByTagName("entry"));
      for (const e of entries) {
        const idEl = e.getElementsByTagNameNS("http://www.youtube.com/xml/schemas/2015", "videoId")[0] || e.getElementsByTagName("yt:videoId")[0];
        const pubEl = e.getElementsByTagName("published")[0];
        const id = idEl && idEl.textContent.trim(), t = pubEl ? Date.parse(pubEl.textContent.trim()) : NaN;
        if (!/^[\w-]{11}$/.test(id || "") || Number.isNaN(t)) continue;
        out.dates[id] = new Date(t).toISOString();
        if (!out.oldest || t < out.oldest) out.oldest = t;
      }
      out.ok = entries.length > 0;
    } catch (e) { /* 날짜 없이 진행(새 쇼츠는 저장하지 않음) */ }
    return out;
  }

  async function collectApi({ maxPages, emit, timeUp, since, isKnown }) {
    const pm = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/(videos|shorts|posts|community)\/?$/.exec(location.pathname);
    if (!pm) return null;
    const isShorts = pm[2] === "shorts", isPosts = pm[2] === "posts" || pm[2] === "community";
    // 쇼츠는 실패해도 화면 스크롤 방식으로 넘어가지 않습니다(그 방식은 날짜를 몰라 잘못 정렬된 글을 모음)
    const fail = (why) => (isShorts ? { pages: 0, total: 0, why: "쇼츠 목록을 읽지 못함(" + why + ", 데이터 요청)" } : null);
    try {
      const html = await (await fetch(location.href, { credentials: "include" })).text();
      const key = (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(html) || [])[1];
      const ver = (/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/.exec(html) || [])[1];
      const mm = /var ytInitialData\s*=\s*(\{.*?\});<\/script>/s.exec(html);
      if (!key || !ver || !mm) return fail("페이지 데이터 없음");
      const data = JSON.parse(mm[1]);
      const chMeta = (data.metadata || {}).channelMetadataRenderer || {};
      const author = clip(chMeta.title, 80);
      const runsText = (t) => (t && (t.simpleText || (t.runs || []).map((r) => r.text).join(""))) || "";
      const rss = isShorts ? await shortsDates(chMeta.externalId) : null;

      // 쇼츠 한 개: 새 형식(shortsLockupViewModel)과 예전 형식(reelItemRenderer). 영상과 같이 '유튜브 영상'으로 저장합니다(날짜순으로 섞여 보이게).
      const toShort = (it) => {
        const c = it && it.richItemRenderer && it.richItemRenderer.content;
        if (!c) return null;
        let id = "", title = "", thumb = "";
        if (c.shortsLockupViewModel) {
          const s = c.shortsLockupViewModel;
          const ep = (((s.onTap || {}).innertubeCommand || {}).reelWatchEndpoint) || {};
          id = ep.videoId || String(s.entityId || "").replace(/^shorts-shelf-item-/, "");
          title = (((s.overlayMetadata || {}).primaryText) || {}).content || "";
          const src = ((((s.thumbnailViewModel || {}).thumbnailViewModel || {}).image || {}).sources) || [];
          thumb = (src[src.length - 1] || {}).url || "";
        } else if (c.reelItemRenderer) {
          const r = c.reelItemRenderer;
          id = r.videoId;
          title = runsText(r.headline);
          const th = ((r.thumbnail || {}).thumbnails) || [];
          thumb = (th[th.length - 1] || {}).url || "";
        } else return null;
        if (!/^[\w-]{11}$/.test(id || "") || !title) return null;
        return {
          id: "yt:" + id, source: "youtube-video",
          url: "https://www.youtube.com/shorts/" + id,
          title: clip(title, 200), author,
          thumb: /^https:\/\/i\.ytimg\.com\//.test(thumb) ? thumb : "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
          publishedText: "", publishedAt: (rss && rss.dates[id]) || "",
        };
      };

      const toVideo = (it) => {
        const v = it && it.richItemRenderer && it.richItemRenderer.content;
        if (!v) return null;
        let id = "", title = "", pub = "";
        if (v.lockupViewModel) {
          const l = v.lockupViewModel;
          if (l.contentType && l.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return null;
          id = l.contentId;
          const md = (l.metadata || {}).lockupMetadataViewModel || {};
          title = (md.title || {}).content;
          const rows = (((md.metadata || {}).contentMetadataViewModel || {}).metadataRows) || [];
          for (const r of rows) for (const p of r.metadataParts || []) {
            const t = ((p && p.text) || {}).content || "";
            if (TIME_TEXT.test(t)) pub = t;
          }
        } else if (v.videoRenderer) {
          const r = v.videoRenderer;
          id = r.videoId;
          title = runsText(r.title);
          pub = runsText(r.publishedTimeText);
        } else return null;
        if (!/^[\w-]{11}$/.test(id || "") || !title) return null;
        const pubText = clip(pub, 40);
        return {
          id: "yt:" + id, source: "youtube-video",
          url: "https://www.youtube.com/watch?v=" + id,
          title: clip(title, 200), author,
          thumb: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
          publishedText: pubText, publishedAt: relativeToIso(pubText),
        };
      };

      const toPost = (it) => {
        const p = it && it.backstagePostThreadRenderer && it.backstagePostThreadRenderer.post && it.backstagePostThreadRenderer.post.backstagePostRenderer;
        if (!p || !p.postId) return null;
        const text = clip(runsText(p.contentText), 280);
        // 첨부 사진: 첨부 데이터 안에서 처음 나오는 이미지 주소, 영상이면 그 영상의 썸네일
        let thumb = "";
        const att = p.backstageAttachment;
        if (att) {
          const walkImg = (o, d) => {
            if (thumb || !o || typeof o !== "object" || d > 12) return;
            if (Array.isArray(o.thumbnails) && o.thumbnails.length) { const u = (o.thumbnails[o.thumbnails.length - 1] || {}).url; if (/^https:\/\//.test(u || "")) { thumb = bigImg(u, 640); return; } }
            for (const k in o) walkImg(o[k], d + 1);
          };
          walkImg(att, 0);
          if (!thumb) { const vid = JSON.stringify(att).match(/"videoId":"([\w-]{11})"/); if (vid) thumb = "https://i.ytimg.com/vi/" + vid[1] + "/hqdefault.jpg"; }
        }
        if (!text && !thumb) return null;
        const pubText = clip(runsText(p.publishedTimeText), 40);
        return {
          id: "ytpost:" + p.postId, source: "youtube-post",
          url: "https://www.youtube.com/post/" + p.postId,
          title: text || "(이미지 게시물)", author: clip(runsText(p.authorText), 80) || author,
          thumb, publishedText: pubText, publishedAt: relativeToIso(pubText),
          _noStop: !!p.pinnedText, // 고정 게시물은 순서에서 벗어나므로 멈춤 판단에서 제외
        };
      };

      const conv = isPosts ? toPost : isShorts ? toShort : toVideo;
      const listOf = (arr) => (arr || []).map(conv).filter(Boolean);
      const nextToken = (arr) => {
        const c = (arr || []).find((x) => x.continuationItemRenderer);
        return c ? c.continuationItemRenderer.continuationEndpoint.continuationCommand.token : null;
      };

      // 첫 묶음: 영상은 richGridRenderer.contents, 게시물은 게시물 항목이 든 배열
      let first = null;
      const walk = (o, d) => {
        if (first || !o || typeof o !== "object" || d > 50) return;
        if (!isPosts && o.richGridRenderer && Array.isArray(o.richGridRenderer.contents)) { first = o.richGridRenderer.contents; return; }
        if (isPosts && Array.isArray(o) && o.some((x) => x && x.backstagePostThreadRenderer)) { first = o; return; }
        for (const k in o) walk(o[k], d + 1);
      };
      walk(data, 0);
      if (!first) return isShorts ? { pages: 0, total: 0, why: "목록 끝(쇼츠 없음, 데이터 요청)" } : null;

      let batch = first, pages = 0, total = 0;
      while (batch) {
        let items = listOf(batch);
        // 쇼츠: 날짜를 모르는 새 쇼츠가 나오면 그 앞까지만 보내고 멈춥니다(위 설명)
        let cut = -1;
        if (isShorts) {
          cut = items.findIndex((x) => !x.publishedAt && !(isKnown && isKnown(x.id)));
          if (cut >= 0) items = items.slice(0, cut);
        }
        total += items.length;
        if (emit(items)) return { pages, total, why: "기간 밖 글 도달(데이터 요청)" };
        if (cut >= 0) {
          const beyond = rss && rss.ok && rss.oldest && rss.oldest < (since || 0);
          return { pages, total, why: beyond ? "기간 밖 글 도달(데이터 요청 · 쇼츠 날짜는 RSS)" : "날짜 없음(쇼츠, RSS 범위 밖 · 데이터 요청)" };
        }
        const tok = nextToken(batch);
        if (!tok) return { pages, total, why: "목록 끝(데이터 요청)" };
        if (++pages >= maxPages) return { pages, total, why: "한도(데이터 요청)" };
        if (timeUp()) return { pages, total, why: "시간 한도(데이터 요청)" };
        const res = await fetch("/youtubei/v1/browse?key=" + encodeURIComponent(key) + "&prettyPrint=false", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: ver, hl: "ko", gl: "KR" } }, continuation: tok }),
        });
        if (!res.ok) return pages ? { pages, total, why: "요청 오류 " + res.status } : fail("요청 오류 " + res.status);
        const j = await res.json();
        const act = (j.onResponseReceivedActions || j.onResponseReceivedEndpoints || [])[0];
        batch = act && act.appendContinuationItemsAction ? act.appendContinuationItemsAction.continuationItems : null;
        if (!batch) return { pages, total, why: "목록 끝(데이터 요청)" };
        await new Promise((r) => setTimeout(r, 100 + Math.random() * 120));
      }
      return { pages, total, why: "목록 끝(데이터 요청)" };
    } catch (e) {
      return fail("오류");
    }
  }

  start({ source: "youtube", scan, login, search, post, collectApi });
})();
