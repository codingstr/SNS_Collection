// 공통 수집 로직: 내가 보고 있는 화면에서 글을 찾아 background로 보냅니다.
// - 일반 탭: 눈에 보일 때만 동작합니다 (자동 스크롤·클릭 없음).
// - 확장이 "계정 확인"을 위해 연 탭/창에서만: 설정한 기간(기본 30일, 최대 60일) 글이 나올 때까지 몇 번 스크롤하며 수집합니다.
// - 제목/본문은 짧은 미리보기만 저장하고, 원문은 링크로 연결합니다.
(function () {
  const SCAN_DELAY_MS = 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function clip(text, max) {
    const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  // "3일 전", "2 weeks ago" 같은 상대 시각을 대략적인 날짜(ISO)로 바꿉니다.
  const UNIT_MS = {
    초: 1e3, 분: 6e4, 시간: 36e5, 일: 864e5, 주: 6048e5, 개월: 2592e6, 년: 31536e6,
    second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6,
  };

  function relativeToIso(text) {
    const s = String(text || "");
    const m =
      /(\d+)\s*(초|분|시간|일|주|개월|년)\s*전/.exec(s) ||
      /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/i.exec(s);
    if (!m) return "";
    const unit = UNIT_MS[m[2].toLowerCase()];
    return unit ? new Date(Date.now() - Number(m[1]) * unit).toISOString() : "";
  }

  function start({ source, scan, login, search, post, collectApi }) {
    const seen = new Set();
    let enabled = true;
    let timer = null;
    let auto = false; // 확장이 계정 확인용으로 연 탭이면 true
    let mode = ""; // "deep": 지금 확인(보이는 창, 깊게) / "shallow": 자동 확인(백그라운드, 얕게)
    let since = 0; // 이 시각보다 오래된 글은 가져오지 않음
    let helloTries = 0;
    let collecting = false;
    let found = 0; // 진단용: 화면에서 본 글 수(최대), 보낸 새 글 수
    let sentCount = 0;

    // 로그인 여부를 확장에 알립니다(모르면 몇 번 더 확인). 이 페이지에서 한 번만 보냅니다.
    let loginSent = false;
    async function reportLogin() {
      if (loginSent || typeof login !== "function") return;
      for (let i = 0; i < 4; i++) {
        let state = null;
        try { state = login(); } catch (e) { /* 무시 */ }
        if (state === true || state === false) {
          loginSent = true;
          try { chrome.runtime.sendMessage({ type: "login", loggedIn: state }); } catch (e) { /* 연결 끊김 */ }
          return;
        }
        await sleep(1500);
      }
    }

    function hello() {
      helloTries += 1;
      try {
        chrome.runtime.sendMessage({ type: "hello" }, (res) => {
          void chrome.runtime.lastError;
          if (res && res.auto && res.mode === "post") {
            // 게시물 보기용 탭: 내용을 읽어 알리고 끝냅니다.
            collecting = true;
            (async () => {
              let data = null;
              try { if (typeof post === "function") data = await post(); } catch (e) { /* 빈 결과 */ }
              try { chrome.runtime.sendMessage({ type: "autoDone", found: 0, sent: 0, post: data }); } catch (e) { /* 무시 */ }
            })();
            return;
          }
          if (res && res.auto && res.mode === "search") {
            // 이름 검색용 탭: 결과만 읽어 알리고 끝냅니다.
            collecting = true;
            (async () => {
              let results = [];
              // 창이 다른 창에 가려져 화면이 그려지지 않는 경우에만 앞으로 가져오도록 요청합니다.
              // 시작하자마자 창을 오른쪽 아래 구석으로 옮깁니다(포커스는 가져오지 않음).
              try { chrome.runtime.sendMessage({ type: "needFocus", place: true, sl: screen.availLeft || 0, st: screen.availTop || 0, sw: screen.availWidth || 0, sh: screen.availHeight || 0 }); } catch (e) { /* 무시 */ }
              await sleep(700);
              if (document.visibilityState === "hidden") {
                try { chrome.runtime.sendMessage({ type: "needFocus", sl: screen.availLeft || 0, st: screen.availTop || 0, sw: screen.availWidth || 0, sh: screen.availHeight || 0 }); } catch (e) { /* 무시 */ }
                await sleep(400);
              }
              try { if (typeof search === "function") results = (await search(res.q || "")) || []; } catch (e) { /* 빈 결과 */ }
              try { chrome.runtime.sendMessage({ type: "autoDone", found: 0, sent: 0, results }); } catch (e) { /* 무시 */ }
            })();
            return;
          }
          if (res && res.auto && res.mode === "login") {
            // 로그인 상태만 확인하는 탭: 수집 없이 상태를 알리고 끝냅니다.
            collecting = true;
            sleep(2500).then(reportLogin).then(() => {
              try { chrome.runtime.sendMessage({ type: "autoDone", found: 0, sent: 0 }); } catch (e) { /* 무시 */ }
            });
            return;
          }
          if (res && res.auto) {
            auto = true;
            mode = res.mode || "shallow";
            since = Number(res.since) || 0;
            if (!collecting) autoCollect();
          }
          schedule();
        });
      } catch (e) {
        /* 확장이 갱신되어 연결이 끊긴 경우 */
      }
    }

    let feedOn = false;
    function readFeed() {
      try {
        chrome.storage.local.get("tracked", (res) => {
          feedOn = ((res && res.tracked) || []).some((t) => t && t.kind === "feed" && t.platform === source);
          if (feedOn) schedule();
        });
      } catch (e) {
        /* 무시 */
      }
    }

    function readSettings() {
      try {
        chrome.storage.local.get("settings", (res) => {
          const s = (res && res.settings) || {};
          enabled = s[source] !== false;
          if (enabled) schedule();
        });
      } catch (e) {
        /* 무시 */
      }
    }

    // 화면의 글을 찾아 새 글만 보냅니다. raw는 중단 조건 판단용으로 돌려줍니다.
    function collectOnce() {
      let raw = [];
      try {
        raw = scan() || [];
      } catch (e) {
        console.debug("[sns-collector] 스캔 오류", e);
        return { raw: [], fresh: 0 };
      }
      found = Math.max(found, raw.length);
      const fresh = [];
      let hitOld = false;
      // 화면에 보이는 순서대로 하나씩 가져옵니다. 기간 안의 글은 모두 가져오고, 가져오다가 기간보다 오래된 글을 만나면 거기서 멈춥니다.
      // (오래된 글이 화면에 "보인다"는 이유만으로 먼저 멈추지 않습니다.)
      for (const item of raw) {
        if (!item || !item.id) continue;
        const old = auto && item.publishedAt && Date.parse(item.publishedAt) < since;
        if (old) {
          if (item._noStop) continue; // 고정글·리포스트처럼 순서에서 벗어난 글은 건너뛰기만 합니다
          hitOld = true;
          break;
        }
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        fresh.push(item);
      }
      if (fresh.length) {
        sentCount += fresh.length;
        try {
          chrome.runtime.sendMessage({ type: "items", items: fresh });
        } catch (e) {
          /* 연결 끊김 */
        }
      }
      return { raw, fresh: fresh.length, hitOld };
    }

    function run() {
      timer = null;
      if (!enabled) return;
      if (!auto && helloTries < 5) hello(); // 확장이 연 확인용 탭인지 몇 번만 물어봅니다
      if (document.visibilityState !== "visible" && !auto) return;
      if (collecting) return; // 계정 확인 중에는 autoCollect가 수집을 맡습니다
      // 내가 직접 둘러보는 화면(홈·추천 등)은 "피드"를 추적 계정으로 추가한 경우에만 모읍니다.
      if (!auto && !feedOn) return;
      collectOnce();
    }

    // 확장이 연 확인용 탭에서만: 설정한 기간(기본 30일, 최대 60일) 글이 나올 때까지 스크롤하며 수집하고, 끝나면 background에 알립니다.
    async function autoCollect() {
      collecting = true;
      let diag = {};
      const deep = mode === "deep";
      // 지금 확인(deep)은 "정한 기간보다 오래된 글이 나오거나 목록 끝에 닿을 때까지" 계속 내려갑니다(안전 한도: 600번·8분).
      const maxScrolls = deep ? 600 : 4;
      let deadline = Date.now() + (deep ? 480000 : 25000);
      try {
        // 시작할 때 한 번, 창을 오른쪽 아래 구석 최소 크기로 옮깁니다(포커스는 가져오지 않음).
        if (deep) { try { chrome.runtime.sendMessage({ type: "needFocus", place: true, sl: screen.availLeft || 0, st: screen.availTop || 0, sw: screen.availWidth || 0, sh: screen.availHeight || 0 }); } catch (e) { /* 무시 */ } }
        // 화면이 필요 없는 방법(유튜브 채널 동영상 탭의 데이터 요청)이 있으면 먼저 씁니다. 안 되면 아래 스크롤 방식으로 넘어갑니다.
        if (typeof collectApi === "function") {
          const api = await collectApi({
            maxPages: deep ? 80 : 4,
            timeUp: () => Date.now() >= deadline,
            // 앞에서부터 차례로: 기간 안의 글은 모두 보내고, 기간보다 오래된 글을 만나면 true(멈춤)
            emit: (items) => {
              const fresh = [];
              let hitOld = false;
              for (const item of items) {
                if (!item || !item.id) continue;
                found += 1;
                if (item.publishedAt && Date.parse(item.publishedAt) < since) {
                  if (item._noStop) continue; // 고정 게시물은 건너뛰기만
                  hitOld = true;
                  break;
                }
                if (seen.has(item.id)) continue;
                seen.add(item.id);
                fresh.push(item);
              }
              if (fresh.length) {
                sentCount += fresh.length;
                try { chrome.runtime.sendMessage({ type: "items", items: fresh }); } catch (e) { /* 연결 끊김 */ }
              }
              return hitOld;
            },
          });
          if (api) {
            diag = { why: api.why + " · 요청 " + api.pages + "회", scrolls: api.pages, api: true };
            return;
          }
        }
        // 첫 글이 화면에 나타나는 즉시 시작합니다(최대 약 6초 대기).
        for (let w = 0; w < 40; w++) {
          await sleep(250);
          let n = 0;
          try { n = (scan() || []).length; } catch (e) { /* 무시 */ }
          if (n > 0) break;
        }
        let idle = 0, lastHeight = -1, lastCount = -1, why = "한도", scrolls = 0, slow = 1;
        // 수집창이 다른 창에 가려져(hidden) 화면이 안 그려지면, 창을 앞으로 끌어오지 않고 수집을 일시정지합니다.
        // 웹 화면이 안내 모달(이어서 수집/닫기)을 띄우고, 창이 다시 보이면 이어서 수집합니다. 멈춘 시간은 제한 시간에 넣지 않습니다.
        const waitVisible = async () => {
          if (!deep || document.visibilityState !== "hidden") return;
          await sleep(1500); // 잠깐 가려진 건 무시
          if (document.visibilityState !== "hidden") return;
          const t0 = Date.now();
          try { chrome.runtime.sendMessage({ type: "paused", on: true }); } catch (e) { /* 무시 */ }
          while (document.visibilityState === "hidden") await sleep(700);
          try { chrome.runtime.sendMessage({ type: "paused", on: false }); } catch (e) { /* 무시 */ }
          deadline += Date.now() - t0;
          await sleep(600);
        };
        await waitVisible();
        for (let i = 0; i < maxScrolls && Date.now() < deadline; i++) {
          await waitVisible();
          const { raw, fresh, hitOld } = collectOnce();
          // 고정/리포스트처럼 날짜 순서에서 벗어난 글은 중단 판단에서 제외합니다.
          const reachedOld = hitOld;
          if (reachedOld) { why = "기간 밖 글 도달"; break; }
          // 날짜가 없는 화면(인스타그램 프로필 격자)은 어디까지가 기간 안인지 알 수 없어서, 기간에 비례한 횟수까지만 내려갑니다.
          if (deep && raw.length && raw.every((it) => !it.publishedAt)) {
            const d = Math.max(1, (Date.now() - since) / 86400000);
            if (i >= Math.max(14, Math.round(d * 2))) { why = "날짜 없음(횟수 제한)"; break; }
          }
          if (deep) {
            // 새 글도, 목록 길이 변화도 없으면 끝에 닿았다고 보고 여러 번 확인한 뒤 멈춥니다.
            const h = document.documentElement.scrollHeight;
            const stalled = !fresh && h === lastHeight && raw.length === lastCount;
            lastHeight = h; lastCount = raw.length;
            idle = stalled ? idle + 1 : 0;
            if (idle >= 5) { why = "더 안 나옴(끝/로딩 정지)"; break; }
          } else {
            idle = fresh || !raw.length ? 0 : idle + 1;
            if (idle >= 2) { why = "더 안 나옴"; break; }
          }
          scrolls += 1;
          if (source === "youtube") {
            // 유튜브는 맨 아래로 내리면 다음 목록을 불러옵니다(창이 작아도 동작).
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
          } else {
            window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: "instant" });
          }
          // 고정 시간만 기다리지 않고, 새 글이 실제로 불러와질 때까지 기다립니다(빠른 환경에선 곧바로, 느린 컴퓨터·인터넷에선 그만큼 더).
          // 최소 대기는 사이트 부담을 줄이는 값(인스타그램은 더 길게)이고, 최대 대기는 느릴수록 자동으로 늘어납니다.
          {
            const minMs = source === "instagram" ? (deep ? 850 : 700) : (deep ? 450 : 350);
            const maxMs = Math.min(15000, (source === "instagram" ? 2200 : 1800) * slow);
            const h0 = document.documentElement.scrollHeight, c0 = (() => { try { return (scan() || []).length; } catch (e) { return 0; } })();
            const t0 = Date.now();
            await sleep(minMs + Math.random() * 250);
            let grew = false;
            while (Date.now() - t0 < maxMs) {
              let n = c0;
              try { n = (scan() || []).length; } catch (e) { /* 무시 */ }
              if (document.documentElement.scrollHeight !== h0 || n !== c0) { grew = true; break; }
              if (document.visibilityState === "hidden") break; // 가려진 창은 기다려도 안 그려집니다(위에서 일시정지 처리)
              await sleep(150);
            }
            if (grew) slow = Math.min(6, Math.max(1, (Date.now() - t0) / 900)); // 실제로 걸린 시간에 맞춰 다음 대기 한도를 정함(끝 도달 시 헛대기가 늘지 않게, 못 받았을 땐 그대로)
            if (grew) await sleep(120); // 불러온 직후 잠깐 더 안정될 시간
          }
        }
        collectOnce();
        diag = { why: why + " · 위치 " + Math.round((document.scrollingElement || document.documentElement).scrollTop || 0) + "px", scrolls };
      } finally {
        try {
          chrome.runtime.sendMessage({ type: "autoDone", found, sent: sentCount, vis: diag.api ? "visible" : document.visibilityState, why: diag.why || "중단", scrolls: diag.scrolls || 0 });
        } catch (e) {
          /* 연결 끊김 */
        }
      }
    }

    function schedule() {
      if (timer) return;
      timer = setTimeout(run, SCAN_DELAY_MS);
    }

    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    window.addEventListener("scroll", schedule, { passive: true });
    document.addEventListener("visibilitychange", schedule);
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.settings) readSettings();
        if (area === "local" && changes.tracked) readFeed();
      });
    } catch (e) {
      /* 무시 */
    }
    hello();
    readSettings(); readFeed();
    schedule();
    setTimeout(() => { if (document.visibilityState === "visible" || auto) reportLogin(); }, 4000);
  }

  globalThis.SNS = { start, clip, relativeToIso };
})();
