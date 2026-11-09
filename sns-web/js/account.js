/* ---------- 계정 : 아이디·비밀번호 로그인(서버 /api/auth) ---------- */
let sess = "", avWho = "";
// 프로필 이미지: 이 브라우저에 저장합니다(정사각형 128px로 줄여서).
function loadAvatar() {
  const d = lsGet("snsAvatar", "");
  const img = $("avImg");
  if (d) { img.src = d; img.hidden = false; $("avLetter").hidden = true; } else { img.removeAttribute("src"); img.hidden = true; $("avLetter").hidden = false; }
  $("avClear").hidden = !d;
  const pi = $("avPrevImg");
  if (d) { pi.src = d; pi.hidden = false; $("avPrevLetter").hidden = true; } else { pi.removeAttribute("src"); pi.hidden = true; $("avPrevLetter").hidden = false; }
  $("avPrevLetter").textContent = (avWho || "?").slice(0, 1).toUpperCase();
}
function setAvatarWho(uid) { avWho = uid; $("avLetter").textContent = (uid || "?").slice(0, 1).toUpperCase(); $("menuWho").textContent = uid; $("connAcct").title = uid; loadAvatar(); }
function pickAvatar(file) {
  if (!file || !/^image\//.test(file.type)) return;
  const url = URL.createObjectURL(file), im = new Image();
  im.onload = () => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const x = c.getContext("2d"), m = Math.min(im.naturalWidth, im.naturalHeight);
    x.drawImage(im, (im.naturalWidth - m) / 2, (im.naturalHeight - m) / 2, m, m, 0, 0, 128, 128); // 가운데를 정사각형으로 잘라 꽉 채웁니다
    URL.revokeObjectURL(url);
    lsSet("snsAvatar", c.toDataURL("image/jpeg", 0.9));
    loadAvatar();
  };
  im.onerror = () => URL.revokeObjectURL(url);
  im.src = url;
}
try { sess = localStorage.getItem("snsSess") || ""; } catch (e) {}
async function api(action, body) {
  const r = await apiPost("/api/auth", Object.assign({ action, session: sess }, body || {}));
  let j;
  // JSON이 아닌 응답(ngrok 오류 화면 등)은 서버 PC가 꺼져 있는 것으로 봅니다(로그인 상태는 유지).
  try { j = await r.json(); } catch (e) { const er = new Error("서버에 연결할 수 없습니다."); er.offline = true; throw er; }
  if (!j.ok) throw new Error(j.error || "요청에 실패했습니다.");
  return j;
}
function acctSay(t, isErr) { const m = $("acctMsg"); m.textContent = t || ""; m.hidden = !t; m.className = isErr ? "error" : "hint"; }
function setSess(s) { sess = s || ""; try { if (sess) localStorage.setItem("snsSess", sess); else localStorage.removeItem("snsSess"); } catch (e) {} }
// 로그인되면 화면을 로그인 상태로 바꾸고 서버에 연결합니다(글·추적 계정은 서버에 있습니다).
// 이 브라우저에 마지막으로 로그인했던 아이디와 다르면, 그 아이디의 저장값(본 글 기록·사진·즐겨찾기)을 쓰도록 한 번 다시 엽니다.
async function afterLogin(uid) {
  if (uid !== UID0) {
    let saved = false;
    try { localStorage.setItem("snsUid", uid); saved = localStorage.getItem("snsUid") === uid; } catch (e) {}
    if (saved) { location.reload(); return; } // 저장소를 못 쓰는 브라우저(사생활 보호 모드 등)는 다시 열지 않고 그대로 씁니다
  }
  $("acctForm").hidden = true; $("acctUser").hidden = false; $("acctWho").textContent = uid + " 로그인됨";
  $("connAcct").hidden = false; setAvatarWho(uid); $("connOut").textContent = "로그아웃";
  acctSay("");
  pullSeen();
  await connect(true);
}
// 예전(크롬 확장 시절) 브라우저에 남은 값 정리
try { ["snsToken", "snsLocal", "snsLocalToken"].forEach((k) => localStorage.removeItem(k)); } catch (e) {}
async function initAccount() {
  $("acct").hidden = false;
  // 세션이 끝나 로그인 화면으로 돌아온 경우 그 이유를 보여 줍니다.
  try { const m = sessionStorage.getItem("snsAuthMsg"); if (m) { sessionStorage.removeItem("snsAuthMsg"); acctSay(m, true); if (UID0) $("acctEmail").value = UID0; } } catch (e) {}
  const doAuth = async (action) => {
    acctSay("");
    const btns = $("acctForm").querySelectorAll("button");
    btns.forEach((b) => { b.disabled = true; });
    try {
      const j = await api(action, { id: $("acctEmail").value.trim(), password: $("acctPw").value });
      $("acctPw").value = "";
      setSess(j.session);
      await afterLogin(j.id);
    } catch (e) { acctSay(e.message, true); }
    finally { btns.forEach((b) => { b.disabled = false; }); }
  };
  $("acctForm").addEventListener("submit", (ev) => { ev.preventDefault(); doAuth("login"); });
  $("acctSignup").addEventListener("click", () => doAuth("signup"));
  const doLogout = async () => {
    if (seenQueue.size) await flushSeen().catch(() => {}); // 아직 안 보낸 본 글 기록을 먼저 보냅니다
    if (sess) { try { await api("logout"); } catch (e) {} }
    setSess("");
    try { localStorage.removeItem("snsUid"); } catch (e) {} // 이 아이디의 저장값은 남겨 두고(다시 로그인하면 이어서 씀), 다음 로그인 아이디로 전환
    location.reload();
  };
  $("acctOut").addEventListener("click", doLogout);
  $("connOut").addEventListener("click", doLogout);
  // 계정 관리(비밀번호 변경 · 계정 삭제)
  const say = (id, t, err) => { const m = $(id); m.textContent = t || ""; m.hidden = !t; m.className = err ? "error" : "hint"; };
  const openAcct = () => { $("acctModal").hidden = false; say("pwMsg", ""); say("delMsg", ""); };
  const closeAcct = () => { $("acctModal").hidden = true; };
  const setMenu = (on) => { $("acctMenu").hidden = !on; $("connAcct").setAttribute("aria-expanded", String(on)); };
  $("connAcct").addEventListener("click", (e) => { e.stopPropagation(); setMenu($("acctMenu").hidden); });
  $("avPick").addEventListener("click", () => $("avFile").click());
  $("avFile").addEventListener("change", () => { pickAvatar($("avFile").files[0]); $("avFile").value = ""; });
  $("avClear").addEventListener("click", () => { try { localStorage.removeItem(ukey("snsAvatar")); } catch (e) {} loadAvatar(); });
  $("menuSettings").addEventListener("click", () => { setMenu(false); openAcct(); });
  $("connOut").addEventListener("click", () => setMenu(false));
  document.addEventListener("click", (e) => { if (!e.target.closest(".acctwrap")) setMenu(false); });
  $("amX").addEventListener("click", closeAcct);
  $("acctModal").addEventListener("click", (e) => { if (e.target === $("acctModal")) closeAcct(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeAcct(); setMenu(false); } });
  $("pwForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if ($("pwNew").value !== $("pwNew2").value) { say("pwMsg", "새 비밀번호 두 칸이 서로 다릅니다.", true); return; }
    try {
      const j = await api("changePassword", { password: $("pwOld").value, newPassword: $("pwNew").value });
      setSess(j.session);
      $("pwOld").value = $("pwNew").value = $("pwNew2").value = "";
      say("pwMsg", "비밀번호를 변경했습니다.");
    } catch (e) { say("pwMsg", e.message, true); }
  });
  let delArmed = 0;
  $("delBtn").addEventListener("click", async () => {
    if (!$("delPw").value) { say("delMsg", "비밀번호를 입력하세요.", true); return; }
    if (!delArmed) { // 두 번 눌러야 삭제합니다
      $("delBtn").textContent = "정말 삭제하려면 한 번 더";
      delArmed = setTimeout(() => { delArmed = 0; $("delBtn").textContent = "계정 삭제"; }, 5000);
      return;
    }
    clearTimeout(delArmed); delArmed = 0; $("delBtn").textContent = "계정 삭제";
    try {
      await api("deleteAccount", { password: $("delPw").value });
      try { PER_USER_KEYS.forEach((k) => localStorage.removeItem(ukey(k))); ["snsSess", "snsUid"].forEach((k) => localStorage.removeItem(k)); } catch (e) {}
      location.reload();
    } catch (e) { say("delMsg", e.message, true); }
  });
  if (sess) {
    // 저장된 로그인을 확인하는 사이에 사용자가 새로 로그인했으면(느린 연결에서 생길 수 있음), 늦게 온 옛 확인 결과는 무시합니다.
    // (예전에는 옛 세션의 '만료' 응답이 방금 받은 새 세션까지 지워, 새로고침하면 로그아웃되어 있었음)
    const used = sess;
    try { const j = await api("me"); if (sess === used) await afterLogin(j.id); }
    catch (e) {
      if (sess !== used) return;
      if (e && e.offline) {
        // 서버가 꺼져 있거나 닿지 않을 때: 로그인 상태는 유지하고, 서버가 다시 켜지면 자동으로 이어집니다(아래 connect의 반복 확인).
        $("acctForm").hidden = true; $("acctUser").hidden = false; $("connAcct").hidden = false; $("connOut").textContent = "로그아웃";
        $("acctWho").textContent = (UID0 ? UID0 + " " : "") + "로그인됨 (지금은 서버에 연결할 수 없습니다. 다시 켜지면 자동으로 이어집니다)";
        if (UID0) setAvatarWho(UID0);
        connect(false);
      } else { setSess(""); if (e && e.message) acctSay("로그인이 만료되었습니다. 다시 로그인해 주세요.", true); }
    }
  }
}
initAccount();

