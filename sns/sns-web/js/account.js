/* ---------- 계정 : 아이디·비밀번호 로그인(서버 /api/auth) ---------- */
let sess = "", avWho = "";
// 프로필 이미지: 이 브라우저에 저장합니다(정사각형 128px로 줄여서).
function loadAvatar() {
  let d = ""; try { d = localStorage.getItem("snsAvatar") || ""; } catch (e) {}
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
    try { localStorage.setItem("snsAvatar", c.toDataURL("image/jpeg", 0.9)); } catch (e) {}
    loadAvatar();
  };
  im.onerror = () => URL.revokeObjectURL(url);
  im.src = url;
}
try { sess = localStorage.getItem("snsSess") || ""; } catch (e) {}
async function api(action, body) {
  const r = await apiPost("/api/auth", Object.assign({ action, session: sess }, body || {}));
  let j;
  try { j = await r.json(); } catch (e) { throw new Error("서버 응답을 읽지 못했습니다."); }
  if (!j.ok) throw new Error(j.error || "요청에 실패했습니다.");
  return j;
}
function acctSay(t, isErr) { const m = $("acctMsg"); m.textContent = t || ""; m.hidden = !t; m.className = isErr ? "error" : "hint"; }
function setSess(s) { sess = s || ""; try { if (sess) localStorage.setItem("snsSess", sess); else localStorage.removeItem("snsSess"); } catch (e) {} }
// 로그인되면 화면을 로그인 상태로 바꾸고 서버에 연결합니다(글·추적 계정은 서버에 있습니다).
async function afterLogin(uid) {
  $("acctForm").hidden = true; $("acctUser").hidden = false; $("acctWho").textContent = uid + " 로그인됨";
  try { localStorage.setItem("snsUid", uid); } catch (e) {}
  $("connAcct").hidden = false; setAvatarWho(uid); $("connOut").textContent = "로그아웃";
  acctSay("");
  pullSeen();
  await connect(true);
}
// 예전(크롬 확장 시절) 브라우저에 남은 값 정리
try { ["snsToken", "snsLocal", "snsLocalToken"].forEach((k) => localStorage.removeItem(k)); } catch (e) {}
async function initAccount() {
  $("acct").hidden = false;
  const doAuth = async (action) => {
    acctSay("");
    try {
      const j = await api(action, { id: $("acctEmail").value.trim(), password: $("acctPw").value });
      $("acctPw").value = "";
      setSess(j.session);
      afterLogin(j.id);
    } catch (e) { acctSay(e.message, true); }
  };
  $("acctForm").addEventListener("submit", (ev) => { ev.preventDefault(); doAuth("login"); });
  $("acctSignup").addEventListener("click", () => doAuth("signup"));
  const doLogout = async () => {
    if (sess) { try { await api("logout"); } catch (e) {} }
    setSess(""); $("acctForm").hidden = false; $("acctUser").hidden = true; $("acctMenu").hidden = true; $("connAcct").hidden = true; acctSay("");
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
  $("avClear").addEventListener("click", () => { try { localStorage.removeItem("snsAvatar"); } catch (e) {} loadAvatar(); });
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
      try { ["snsSess", "snsSeen", "snsUid"].forEach((k) => localStorage.removeItem(k)); } catch (e) {}
      location.reload();
    } catch (e) { say("delMsg", e.message, true); }
  });
  if (sess) {
    try { const j = await api("me"); afterLogin(j.id); }
    catch (e) {
      if (e && e.offline) {
        // 서버가 꺼져 있거나 닿지 않을 때: 로그인 상태는 유지하고, 서버가 다시 켜지면 자동으로 이어집니다(store.js의 반복 확인).
        let uid = ""; try { uid = localStorage.getItem("snsUid") || ""; } catch (x) {}
        $("acctForm").hidden = true; $("acctUser").hidden = false; $("connAcct").hidden = false; $("connOut").textContent = "로그아웃";
        $("acctWho").textContent = (uid ? uid + " " : "") + "로그인됨 (지금은 서버에 연결할 수 없습니다)";
        if (uid) setAvatarWho(uid);
      } else setSess("");
    }
  }
}
initAccount();

