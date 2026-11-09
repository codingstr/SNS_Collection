// X(트위터): 타임라인·프로필·검색 화면에 보이는 게시물을 수집합니다. 광고는 제외합니다.
(function () {
  const { start, clip } = SNS;

  function scan() {
    const out = [];
    document.querySelectorAll('article[data-testid="tweet"]').forEach((art) => {
      if (art.querySelector('[data-testid="placementTracking"]')) return; // 광고

      const timeEl = art.querySelector("time[datetime]");
      const link = timeEl && timeEl.closest("a");
      if (!link) return;
      const m = /^\/([^/]+)\/status\/(\d+)/.exec(link.getAttribute("href") || "");
      if (!m) return;

      const textEl = art.querySelector('[data-testid="tweetText"]');
      const text = clip(textEl && textEl.innerText, 280);

      const nameBox = art.querySelector('[data-testid="User-Name"]');
      const lines = ((nameBox && nameBox.innerText) || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const name = lines[0] || m[1];
      const handle = lines.find((s) => s.startsWith("@")) || "@" + m[1];

      const photo = art.querySelector('[data-testid="tweetPhoto"] img');
      const video = art.querySelector("video");
      const thumb = (photo && photo.src) || (video && video.poster) || "";

      // "고정됨", "~님이 리포스트함" 같은 표시가 붙은 글은 날짜 순서에서 벗어나 있을 수 있습니다.
      const orderBroken = !!art.querySelector('[data-testid="socialContext"]');

      out.push({
        id: "x:" + m[2],
        source: "x",
        url: "https://x.com/" + m[1] + "/status/" + m[2],
        title: text || "(미디어 게시물)",
        author: clip(name + " " + handle, 100),
        thumb,
        publishedAt: timeEl.getAttribute("datetime") || "",
        _noStop: orderBroken,
      });
    });
    return out;
  }

  function login() {
    if (document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"]')) return true;
    if (location.pathname.startsWith("/i/flow/login") || location.pathname.startsWith("/login")) return false;
    // 로그아웃 상태의 첫 화면("지금 일어나고 있는 일"): 가입/로그인 버튼, 아이디 입력칸, 소셜 로그인 버튼이 보임
    if (document.querySelector('a[href="/login"], a[href="/i/flow/signup"], [data-testid="loginButton"], [data-testid="signupButton"], [data-testid="google_sign_in_container"], input[autocomplete="username"]')) return false;
    if (/전화번호로 계속하기|Google로 계속하기|Continue with Google|Sign in with Google/.test((document.body && document.body.innerText) || "")) return false;
    return null;
  }


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

  // 이름으로 계정 검색(사람 검색 결과 화면에서 읽음). 옆의 "추천 계정" 칸은 제외하고 가운데 결과 칸만 읽습니다.
  async function search() {
    const cells = () => document.querySelectorAll('[data-testid="primaryColumn"] [data-testid="UserCell"]');
    for (let i = 0; i < 40; i++) {
      if (cells().length) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await new Promise((r) => setTimeout(r, 300)); // 결과가 더 불러와질 시간
    for (let i = 0; i < 12; i++) { // 프로필 사진이 채워질 때까지 잠시 기다림
      const cs = Array.from(cells());
      if (cs.length && cs.every((c) => c.querySelector('img[src*="profile_images"]'))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const out = [];
    const seen = new Set();
    cells().forEach((c) => {
      const a = c.querySelector('a[role="link"][href^="/"]');
      const m = /^\/([A-Za-z0-9_]{1,15})(\/|$)/.exec((a && a.getAttribute("href")) || "");
      if (!m || seen.has(m[1].toLowerCase())) return;
      seen.add(m[1].toLowerCase());
      const lines = String(c.innerText || "").split("\n").map((t) => t.trim()).filter(Boolean);
      const img = c.querySelector('[data-testid^="UserAvatar-Container"] img, img[src*="profile_images"]');
      out.push({
        handle: m[1],
        name: clip(lines[0], 80),
        desc: clip(lines.filter((l) => l !== lines[0] && !l.startsWith("@") && l !== "팔로우" && l !== "Follow" && l !== "팔로잉" && l !== "Following").join(" "), 80),
        avatar: (img && (img.currentSrc || img.src)) || "",
      });
    });
    return fillAvatars(out.slice(0, 8));
  }

  start({ source: "x", scan, login, search });
})();
