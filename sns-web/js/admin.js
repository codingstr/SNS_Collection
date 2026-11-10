/* ---------- 관리(관리자 전용) : 사용자 · SNS 계정 상태 · 서버 ----------
   서버의 /api/admin(server/admin.py)을 부릅니다. 관리자가 아니면 서버가 거절하므로 화면은 탭만 숨깁니다. */
const AD_RESET_PW = "000000"; // server/admin.py의 RESET_PW와 같은 값(안내 문구용)
const AD_STATE = {
  error: { t: "오류", c: "bad" }, login: { t: "로그인 필요", c: "bad" }, stale: { t: "오래됨", c: "warn" },
  never: { t: "아직 안 모음", c: "warn" }, running: { t: "수집 중", c: "run" }, ok: { t: "정상", c: "ok" }, off: { t: "수집 안 함", c: "off" },
};
const AD_STATE_ORDER = ["error", "login", "stale", "never", "running", "ok", "off"];
const AD_ACCT_NAME = { youtube: "유튜브", x: "X 수집용", instagram: "인스타 수집용", "x-search": "X 검색용", "instagram-search": "인스타 검색용" };

let adTab = "users", adUsers = [], adUid = "", adDetail = null, adSel = new Set(), adAccts = [], adServer = null, adTimer = 0, adGen = 0;

async function adminCall(action, body, ms) {
  const used = sess;
  const r = await apiPost("/api/admin", Object.assign({ session: used, action }, body || {}), ms);
  if (r.status === 401) throw sessionLost(used);
  let j;
  try { j = await r.json(); } catch (e) { const er = new Error("서버에 연결할 수 없습니다."); er.offline = true; throw er; }
  if (!j.ok) throw new Error(j.error || "요청에 실패했습니다.");
  return j.result;
}
function setAdmin(on) { isAdmin = !!on; applyPage(); }

// 보이는 동안만 15초마다 새로 읽습니다(입력 중이거나 확인 창이 떠 있으면 건너뜀).
function adminShown(on) {
  clearInterval(adTimer); adTimer = 0;
  if (!on) return;
  adLoad();
  adTimer = setInterval(() => {
    if (document.hidden || $("adminPanel").hidden || document.querySelector(".ad-modal") || (document.activeElement && document.activeElement.closest && document.activeElement.closest("#adminPanel input, #adminPanel select"))) return;
    adLoad(true);
  }, 15000);
}

function adAgo(ms) {
  if (!ms) return "없음";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return Math.floor(s / 60) + "분 전";
  if (s < 86400) return Math.floor(s / 3600) + "시간 전";
  return Math.floor(s / 86400) + "일 전";
}
const adDate = (ms) => (ms ? new Date(ms).toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const adWhen = (ms) => el("span", { class: "ad-when", text: adAgo(ms), title: adDate(ms) });
function adProfileUrl(a) {
  const h = encodeURIComponent(a.handle || "");
  if (a.platform === "youtube") return a.handle ? "https://www.youtube.com/@" + h : a.channelId ? "https://www.youtube.com/channel/" + a.channelId : "";
  if (a.platform === "x") return a.handle ? "https://x.com/" + h : "";
  if (a.platform === "instagram") return a.handle ? "https://www.instagram.com/" + h + "/" : "";
  return "";
}
function adBtn(text, fn, cls, title) {
  const b = el("button", { type: "button", class: "ad-btn" + (cls ? " " + cls : ""), text });
  if (title) b.title = title;
  b.addEventListener("click", async () => {
    if (b.disabled) return;
    b.disabled = true;
    try { await fn(); } catch (e) { showErr(e); } finally { b.disabled = false; }
  });
  return b;
}
const adBadge = (text, cls) => el("span", { class: "ad-badge" + (cls ? " " + cls : ""), text });

// 확인 창(input: 값을 받을 때 처음 값). 확인하면 true 또는 입력값, 취소하면 null.
function adAsk({ title, text, ok = "확인", danger = false, input = null, placeholder = "" }) {
  return new Promise((done) => {
    const back = el("div", { class: "modal-back ad-modal", role: "dialog", "aria-modal": "true", "aria-label": title });
    const box = el("div", { class: "modal" });
    const inp = input === null ? null : el("input", { type: "text", maxlength: "30", autocomplete: "off", placeholder });
    if (inp) inp.value = input;
    const finish = (v) => { back.remove(); document.removeEventListener("keydown", onKey, true); done(v); };
    const okB = el("button", { type: "button", class: danger ? "danger" : "primary", text: ok });
    const noB = el("button", { type: "button", text: "취소" });
    okB.addEventListener("click", () => finish(inp ? inp.value.trim() : true));
    noB.addEventListener("click", () => finish(null));
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); finish(null); }
      if (e.key === "Enter" && inp && document.activeElement === inp) { e.preventDefault(); okB.click(); }
    };
    document.addEventListener("keydown", onKey, true);
    back.addEventListener("click", (e) => { if (e.target === back) finish(null); });
    box.append(el("h2", { text: title }));
    if (text) box.append(el("p", { class: "hint", text }));
    if (inp) box.append(inp);
    box.append(el("div", { class: "foot" }, [noB, okB]));
    back.append(box);
    document.body.append(back);
    (inp || okB).focus();
  });
}

/* ----- 탭 ----- */
function adSetTab(t) {
  adTab = t;
  [["users", "adTabUsers", "adUsers"], ["accts", "adTabAccts", "adAccts"], ["server", "adTabServer", "adServer"]].forEach(([k, b, v]) => {
    $(b).classList.toggle("on", k === t); $(b).setAttribute("aria-selected", String(k === t)); $(v).hidden = k !== t;
  });
  adLoad();
}
async function adLoad(quiet) {
  const gen = ++adGen;
  try {
    if (adTab === "users") {
      const list = await adminCall("users");
      if (gen !== adGen) return;
      adUsers = list;
      renderAdUsers();
      if (adUid) await adOpenUser(adUid, true);
    } else if (adTab === "accts") {
      const list = await adminCall("accounts", {}, 20000);
      if (gen !== adGen) return;
      adAccts = list; renderAdAccts();
    } else {
      const s = await adminCall("server");
      if (gen !== adGen) return;
      adServer = s; renderAdServer();
    }
  } catch (e) { if (!quiet) showErr(e); }
}

/* ----- 사용자 목록 ----- */
function renderAdUsers() {
  const box = $("adUserList"), q = $("adFind").value.trim().toLowerCase();
  box.textContent = "";
  $("adCount").textContent = "사용자 " + adUsers.length + "명";
  const list = adUsers.filter((u) => !q || u.id.includes(q));
  if (!list.length) { box.append(el("p", { class: "hint", text: q ? "찾는 아이디가 없습니다." : "사용자가 없습니다." })); return; }
  list.forEach((u) => {
    const b = el("button", { type: "button", class: "ad-user" + (u.id === adUid ? " on" : ""), role: "option", "aria-selected": String(u.id === adUid) }, [
      el("span", { class: "ad-dot" + (u.running ? " run" : u.logins ? " live" : ""), title: u.running ? "수집 중" : u.logins ? "로그인된 기기 " + u.logins + "대" : "로그인된 기기 없음" }),
      el("span", { class: "ad-uid", text: u.id }),
    ]);
    if (u.admin) b.append(adBadge("관리자", "admin"));
    if (u.mustChange) b.append(adBadge("비번 초기화됨", "warn"));
    b.append(el("span", { class: "ad-umeta", text: "계정 " + u.accounts + (u.groups ? " · 묶음 " + u.groups : "") + (u.hidden ? " · 숨김 " + u.hidden : "") + " · 수집 " + adAgo(u.lastRun) }));
    b.addEventListener("click", () => { if (adUid !== u.id) adSel = new Set(); adUid = u.id; renderAdUsers(); adOpenUser(u.id); });
    box.append(b);
  });
}

async function adOpenUser(uid, quiet) {
  const d = $("adDetail");
  if (!quiet) { d.textContent = ""; d.append(el("p", { class: "hint", text: uid + " 불러오는 중…" })); }
  try {
    const u = await adminCall("user", { uid });
    if (adUid !== uid) return;
    adDetail = u;
    const ids = new Set(u.tracked.map((t) => t.id));
    adSel = new Set([...adSel].filter((id) => ids.has(id)));
    renderAdDetail();
  } catch (e) {
    if (adUid !== uid) return;
    if (/없는 사용자/.test(e.message)) { adUid = ""; adDetail = null; d.textContent = ""; d.append(el("p", { class: "hint", text: e.message })); return; }
    if (!quiet) showErr(e);
  }
}

// 사용자 데이터를 고친 뒤: 목록·상세를 다시 읽습니다.
async function adAfter(msg) { if (msg) toast(msg); await adLoad(true); }

/* ----- 사용자 상세 ----- */
function adGroups(tracked) {
  const groups = new Map(), singles = [];
  tracked.forEach((t) => { if (t.group) { if (!groups.has(t.group)) groups.set(t.group, []); groups.get(t.group).push(t); } else singles.push(t); });
  return { groups, singles };
}
function renderAdDetail() {
  const u = adDetail, d = $("adDetail");
  // 다시 그려도 입력 중이던 묶음 이름은 남깁니다
  const keepName = $("adGName") ? $("adGName").value : "";
  d.textContent = "";
  if (!u) return;
  const st = u.status || {};
  const head = el("div", { class: "ad-dhead" }, [el("h3", { text: u.id })]);
  if (u.admin) head.append(adBadge("관리자", "admin"));
  if (u.mustChange) head.append(adBadge("비밀번호 초기화됨 · 아직 안 바꿈", "warn"));
  if (st.running) head.append(adBadge("수집 중", "run"));
  d.append(head);
  d.append(el("p", { class: "ad-meta" }, [
    document.createTextNode("가입 " + adDate(u.createdAt) + " · 로그인된 기기 " + u.logins + "대 · 본 글 기록 " + u.seen + "개 · 마지막 수집 "), adWhen(st.lastRun),
  ]));
  if (st.message) d.append(el("p", { class: "ad-msg", text: st.message }));

  // 사용자 단위 작업
  const acts = el("div", { class: "ad-acts" });
  acts.append(adBtn("지금 수집", async () => { await adminCall("collect", { uid: u.id }); await adAfter(u.id + "의 추적 계정 수집을 요청했습니다."); }, "", "이 사용자의 추적 계정을 지금 모읍니다"));
  if (st.running) acts.append(adBtn("수집 멈추기", async () => { await adminCall("cancel", { uid: u.id }); await adAfter("수집을 멈추도록 했습니다."); }));
  acts.append(adBtn("수집한 글 비우기", async () => {
    if (!(await adAsk({ title: u.id + "의 수집한 글을 비울까요?", text: "지금까지 모은 글이 이 사용자에게 보이지 않게 됩니다(추적 계정은 그대로, 다음 수집부터 다시 모임). 다른 사용자의 글에는 영향이 없습니다.", ok: "비우기", danger: true }))) return;
    await adminCall("clearItems", { uid: u.id }); await adAfter("수집한 글을 비웠습니다.");
  }));
  acts.append(adBtn("본 글 기록 지우기", async () => {
    if (!(await adAsk({ title: u.id + "의 본 글 기록을 지울까요?", text: "읽은 글 표시(흐리게)가 모두 사라집니다.", ok: "지우기", danger: true }))) return;
    const n = await adminCall("clearSeen", { uid: u.id }); await adAfter("본 글 기록 " + n + "개를 지웠습니다.");
  }));
  const lockTip = u.admin ? "관리자 계정은 여기서 바꿀 수 없습니다(계정 메뉴 또는 서버 PC의 admin_setup)" : "";
  const rp = adBtn("비밀번호 초기화", async () => {
    if (!(await adAsk({ title: u.id + "의 비밀번호를 초기화할까요?", text: "비밀번호가 " + AD_RESET_PW + "(으)로 바뀌고 모든 기기에서 로그아웃됩니다. 사용자가 다음에 로그인하면 새 비밀번호로 바꾸라는 안내가 뜹니다.", ok: "초기화", danger: true }))) return;
    await adminCall("resetPassword", { uid: u.id }); await adAfter(u.id + "의 비밀번호를 " + AD_RESET_PW + "(으)로 초기화했습니다.");
  }, "", lockTip);
  const del = adBtn("사용자 삭제", async () => {
    const v = await adAsk({ title: u.id + " 사용자를 삭제할까요?", text: "아이디와 추적 계정·설정·본 글 기록이 모두 지워집니다. 되돌릴 수 없습니다. 확인하려면 아이디를 그대로 적으세요.", ok: "삭제", danger: true, input: "", placeholder: u.id });
    if (v === null) return;
    if (v !== u.id) { toast("아이디가 맞지 않아 삭제하지 않았습니다.", "error"); return; }
    await adminCall("deleteUser", { uid: u.id });
    adUid = ""; adDetail = null; adSel = new Set();
    $("adDetail").textContent = ""; $("adDetail").append(el("p", { class: "hint", text: "삭제했습니다. 왼쪽에서 사용자를 고르세요." }));
    await adAfter(u.id + " 사용자를 삭제했습니다.");
  }, "danger", lockTip);
  if (u.admin) { rp.disabled = true; del.disabled = true; }
  acts.append(rp, del);
  d.append(acts);

  // 매체별 수집 켜기·끄기, 기본 기간
  const set = el("div", { class: "ad-set" }, [el("b", { text: "수집 설정" })]);
  ["youtube", "x", "instagram"].forEach((p) => {
    const on = (u.settings || {})[p] !== false;
    const b = el("button", { type: "button", class: "ad-plat" + (on ? " on" : ""), "aria-pressed": String(on), title: PLATFORM[p] + (on ? " 수집 켜짐 (눌러서 끄기)" : " 수집 꺼짐 (눌러서 켜기)") }, [
      el("span", { class: "mg-pi" }, [pIcon(p)]), el("span", { text: PLATFORM[p] + (on ? " 켜짐" : " 꺼짐") }),
    ]);
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await adminCall("setUser", { uid: u.id, settings: { ...(u.settings || {}), [p]: !on } }); await adAfter(u.id + "의 " + PLATFORM[p] + " 수집을 " + (on ? "껐습니다." : "켰습니다.")); }
      catch (e) { showErr(e); } finally { b.disabled = false; }
    });
    set.append(b);
  });
  const wd = el("select", { "aria-label": "기본 가져올 기간" });
  [7, 14, 30, 60].forEach((n) => { const o = el("option", { value: String(n), text: "기본 기간 " + daysText(n) }); if (n === u.windowDays) o.selected = true; wd.append(o); });
  wd.addEventListener("change", async () => {
    try { await adminCall("setUser", { uid: u.id, windowDays: Number(wd.value) }); await adAfter("기본 기간을 " + daysText(Number(wd.value)) + "(으)로 바꿨습니다."); } catch (e) { showErr(e); }
  });
  set.append(wd);
  d.append(set);

  // 묶음·계정
  const { groups, singles } = adGroups(u.tracked);
  d.append(el("div", { class: "ad-sub" }, [el("b", { text: "추적 계정 " + u.tracked.length + "개" + (groups.size ? " · 묶음 " + groups.size + "개" : "") }),
    el("span", { class: "hint", text: "계정이나 묶음 이름을 눌러 고른 뒤 아래 막대에서 고칩니다." })]));
  if (!u.tracked.length) d.append(el("p", { class: "hint", text: "추적 중인 계정이 없습니다." }));
  const list = el("div", { class: "mg-list ad-glist" });
  [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([g, accs]) => list.append(adGroupCard(g, accs)));
  if (singles.length) list.append(adGroupCard("", singles));
  d.append(list);
  d.append(adSelBar(keepName));
}

function adToggle(ids) {
  const all = ids.every((id) => adSel.has(id));
  ids.forEach((id) => (all ? adSel.delete(id) : adSel.add(id)));
  renderAdDetail();
}
function adGroupCard(group, accs) {
  const u = adDetail, ids = accs.map((t) => t.id);
  const nSel = ids.filter((id) => adSel.has(id)).length, all = nSel === ids.length;
  const hidden = group ? accs.every((t) => t.hidden) : false;
  const days = [...new Set(accs.map((t) => t.days || 0))];
  const sel = el("button", { type: "button", class: "mg-gsel", "aria-pressed": String(all), "aria-label": (group ? "‘" + group + "’ 묶음" : "묶지 않은 계정") + " " + ids.length + "개 " + (all ? "모두 풀기" : "모두 고르기") }, [
    el("span", { class: "mg-check" + (all ? " on" : nSel ? " part" : ""), "aria-hidden": "true" }),
    el("span", { class: "mg-gtext" }, [
      el("span", { class: "mg-gname", text: group || "묶지 않은 계정" }),
      el("span", { class: "mg-gmeta", text: "계정 " + ids.length + (group ? " · " + (days.length === 1 ? daysText(days[0]) : "기간 섞임") : "") }),
    ]),
  ]);
  sel.addEventListener("click", () => adToggle(ids));
  const head = el("div", { class: "mg-ghead" }, [sel]);
  if (group) {
    if (hidden) head.append(el("span", { class: "mg-badge", text: "숨김 · 수집 안 함" }));
    head.append(iconBtn("rename", "‘" + group + "’ 묶음 이름 바꾸기", "ar:" + group, async () => {
      const v = await adAsk({ title: "‘" + group + "’ 묶음 이름 바꾸기", ok: "저장", input: group, placeholder: "새 묶음 이름" });
      if (!v || v === group) return;
      try { await adminCall("editTracked", { uid: u.id, ids, change: { group: v } }); await adAfter("묶음 이름을 ‘" + v + "’(으)로 바꿨습니다."); } catch (e) { showErr(e); }
    }));
    head.append(iconBtn(hidden ? "hidden" : "shown", "‘" + group + "’ 묶음 " + (hidden ? "다시 보이게 하기" : "숨기기"), "ae:" + group, async () => {
      try { await adminCall("editTracked", { uid: u.id, ids, change: { hidden: !hidden } }); await adAfter("‘" + group + "’ 묶음을 " + (hidden ? "다시 보이게 했습니다." : "숨겼습니다(수집하지 않음).")); } catch (e) { showErr(e); }
    }));
  }
  const chips = accs.map((t) => {
    const on = adSel.has(t.id), c = (u.counts || {})[t.id];
    const b = el("button", { type: "button", class: "mg-acc" + (on ? " sel" : "") + (t.hidden ? " off" : ""), "aria-pressed": String(on),
      title: PLATFORM[t.platform] + " " + accName(t) + " · 글 " + (c ? c.n : 0) + "개" + (t.hidden ? " · 숨김(수집 안 함)" : "") },
    [el("span", { class: "mg-pi" }, [pIcon(t.platform)]), el("span", { class: "mg-an", text: accName(t) }), el("span", { class: "mg-ad", text: (t.hidden ? "숨김 · " : "") + daysText(t.days) + " · 글 " + (c ? c.n : 0) })]);
    b.addEventListener("click", () => adToggle([t.id]));
    return b;
  });
  return el("section", { class: "mg-group" + (group ? "" : " mg-singles") + (hidden ? " off" : "") + (nSel ? " has-sel" : "") }, [head, el("div", { class: "mg-accs" }, chips)]);
}

function adSelBar(keepName) {
  const u = adDetail, ids = [...adSel];
  const bar = el("div", { class: "mg-bar ad-bar" + (ids.length ? "" : " empty") });
  const info = el("div", { class: "mg-selinfo" });
  if (!ids.length) info.append(el("span", { class: "ph", text: "계정이나 묶음 이름을 눌러 고르세요 (여러 개 가능)" }));
  else info.append(el("b", { text: ids.length + "개 계정 선택" }));
  const row = el("div", { class: "mg-selrow" }, [info]);
  if (ids.length) {
    const clr = el("button", { type: "button", class: "mg-link", text: "선택 해제" });
    clr.addEventListener("click", () => { adSel = new Set(); renderAdDetail(); });
    row.append(clr);
  }
  bar.append(row);
  if (!ids.length) return bar;
  const edit = async (change, msg) => {
    await adminCall("editTracked", { uid: u.id, ids, change });
    if (change.remove) adSel = new Set();
    await adAfter(msg);
  };
  const dd = el("select", { "aria-label": "고른 계정의 가져올 기간" });
  [[0, "기본(사용자 기본 기간)"], [7, "1주 (7일)"], [14, "2주 (14일)"], [30, "1개월 (30일)"], [60, "2개월 (60일)"]].forEach(([v, t]) => dd.append(el("option", { value: String(v), text: t })));
  const gName = el("input", { id: "adGName", type: "text", maxlength: "30", placeholder: "묶음 이름", autocomplete: "off", "aria-label": "묶을 묶음 이름" });
  gName.value = keepName || "";
  const allHidden = ids.every((id) => (u.tracked.find((t) => t.id === id) || {}).hidden);
  bar.append(el("div", { class: "mg-actions" }, [
    el("div", { class: "mg-act" }, [dd, adBtn("기간 적용", () => edit({ days: Number(dd.value) }, "기간을 바꿨습니다."))]),
    el("div", { class: "mg-act" }, [gName,
      adBtn("묶기", () => { const g = gName.value.trim(); if (!g) { toast("묶음 이름을 적으세요.", "error"); return; } return edit({ group: g }, "‘" + g + "’ 묶음으로 묶었습니다.").then(() => { if ($("adGName")) $("adGName").value = ""; }); }),
      adBtn("묶음 풀기", () => edit({ group: "" }, "묶음에서 뺐습니다."))]),
    el("div", { class: "mg-act" }, [
      adBtn(allHidden ? "다시 보이기" : "숨기기", () => edit({ hidden: !allHidden }, allHidden ? "다시 보이게 했습니다(숨긴 동안 못 모은 글을 모읍니다)." : "숨겼습니다(수집하지 않음).")),
      adBtn("제거", async () => {
        if (!(await adAsk({ title: "고른 계정 " + ids.length + "개를 제거할까요?", text: u.id + "의 추적 목록에서 빠집니다. 되돌릴 수 없습니다.", ok: "제거", danger: true }))) return;
        await edit({ remove: true }, "계정 " + ids.length + "개를 제거했습니다.");
      }, "danger"),
    ]),
  ]));
  return bar;
}

/* ----- SNS 계정 상태 ----- */
function renderAdAccts() {
  const box = $("adAcctList"), stSel = $("adAcctState"), plat = $("adAcctPlat").value, q = $("adAcctFind").value.trim().toLowerCase();
  const n = {};
  adAccts.forEach((a) => { n[a.state] = (n[a.state] || 0) + 1; });
  const cur = stSel.value;
  stSel.textContent = "";
  stSel.append(el("option", { value: "", text: "모든 상태 (" + adAccts.length + ")" }));
  AD_STATE_ORDER.forEach((k) => { if (n[k]) stSel.append(el("option", { value: k, text: AD_STATE[k].t + " (" + n[k] + ")" })); });
  stSel.value = n[cur] ? cur : "";
  $("adCount").textContent = "SNS 계정 " + adAccts.length + "개";
  $("adAcctSum").textContent = AD_STATE_ORDER.filter((k) => n[k]).map((k) => AD_STATE[k].t + " " + n[k]).join(" · ");
  const list = adAccts.filter((a) => (!stSel.value || a.state === stSel.value) && (!plat || a.platform === plat) &&
    (!q || (a.handle || a.channelId || "").toLowerCase().includes(q) || a.owners.some((o) => o.uid.includes(q) || (o.group || "").toLowerCase().includes(q))))
    .sort((a, b) => AD_STATE_ORDER.indexOf(a.state) - AD_STATE_ORDER.indexOf(b.state) || a.platform.localeCompare(b.platform) || (a.handle || "").localeCompare(b.handle || ""));
  box.textContent = "";
  if (!list.length) { box.append(el("p", { class: "hint", text: adAccts.length ? "조건에 맞는 계정이 없습니다." : "추적 중인 SNS 계정이 없습니다." })); return; }
  list.forEach((a) => {
    const s = AD_STATE[a.state] || { t: a.state, c: "" };
    const url = adProfileUrl(a);
    const name = el(url ? "a" : "span", { class: "ad-aname", text: a.handle ? "@" + a.handle : a.channelId || a.id });
    if (url) { name.href = url; name.target = "_blank"; name.rel = "noopener noreferrer"; }
    const owners = el("div", { class: "ad-owners" }, a.owners.map((o) => {
      const b = el("button", { type: "button", class: "ad-owner" + (o.hidden || o.off ? " off" : ""), title: o.uid + (o.group ? " · 묶음 ‘" + o.group + "’" : "") + (o.hidden ? " · 숨김" : "") + (o.off ? " · 이 매체 수집 꺼짐" : "") + " (눌러서 사용자 보기)" },
        [el("span", { text: o.uid }), ...(o.group ? [el("small", { text: o.group })] : []), ...(o.hidden ? [el("small", { text: "숨김" })] : o.off ? [el("small", { text: "꺼짐" })] : [])]);
      b.addEventListener("click", () => { adUid = o.uid; adSel = new Set(); adSetTab("users"); });
      return b;
    }));
    const pages = el("div", { class: "ad-pages" }, a.pages.map((p) => el("div", { class: "ad-page" + (p.error ? " bad" : "") }, [
      el("span", { class: "ad-ptab", text: p.tab || "페이지" }),
      ...(p.active ? [adBadge("수집 중", "run")] : p.at ? [adWhen(p.at)] : []),
      el("span", { class: "ad-pwhy", text: p.at ? (p.error || p.why || "결과 없음") + (!p.error && !p.old ? " · 본 글 " + p.found + " · 새 글 " + p.added : "") + (p.mode ? " · " + (p.mode === "deep" ? "사용자 수집" : "자동 수집") : "") : "아직 모으지 않음" }),
      ...(p.error && p.okAt ? [el("span", { class: "hint", text: "마지막 성공 " + adAgo(p.okAt) })] : []),
    ])));
    box.append(el("section", { class: "ad-acct st-" + s.c }, [
      el("div", { class: "ad-ahead" }, [el("span", { class: "mg-pi" }, [pIcon(a.platform)]), name, adBadge(s.t, s.c),
        el("span", { class: "ad-ameta", text: "글 " + a.items + "개" + (a.lastPost ? " · 최근 글 " + String(a.lastPost).slice(0, 10) : "") })]),
      owners, pages,
    ]));
  });
}

/* ----- 서버 ----- */
function renderAdServer() {
  const s = adServer, box = $("adServer");
  box.textContent = "";
  if (!s) return;
  $("adCount").textContent = "";
  const login = el("section", { class: "ad-card" }, [el("h3", { text: "서버 테스트 계정 로그인" })]);
  s.loginAccts.forEach((a) => {
    const v = s.login[a] || {};
    const state = a === "youtube" ? ["로그인 없이 수집", "ok"] : v.loggedIn === true ? ["로그인됨", "ok"] : v.loggedIn === false ? ["로그인 필요", "bad"] : ["모름", "warn"];
    login.append(el("div", { class: "ad-row" }, [el("span", { class: "ad-k", text: AD_ACCT_NAME[a] || a }), adBadge(state[0], state[1]),
      el("span", { class: "hint", text: v.at ? "확인 " + adAgo(v.at) : "" })]));
  });
  login.append(el("p", { class: "hint", text: "로그인이 필요하면 서버 PC에서 login_setup.bat <계정> 으로 로그인합니다(예: login_setup.bat x-search)." }));
  login.append(el("div", { class: "ad-acts" }, [adBtn("로그인 상태 다시 확인", async () => { await adminCall("checkLogin"); toast("확인을 요청했습니다. 잠시 뒤 새로 읽습니다."); setTimeout(() => adLoad(true), 8000); })]));
  const auto = el("section", { class: "ad-card" }, [el("h3", { text: "수집기" }),
    el("div", { class: "ad-row" }, [el("span", { class: "ad-k", text: "작업 스레드" }), adBadge(s.thread ? "실행 중" : "멈춤", s.thread ? "ok" : "bad")]),
    el("div", { class: "ad-row" }, [el("span", { class: "ad-k", text: "자동 수집" }), el("span", { text: s.autoMinutes + "분마다 · 지난 수집 " }), adWhen(s.lastAuto),
      el("span", { text: s.nextAuto ? " · 다음 " + (s.nextAuto > Date.now() ? Math.max(1, Math.round((s.nextAuto - Date.now()) / 60000)) + "분 뒤" : "곧") : "" })]),
    el("div", { class: "ad-row" }, [el("span", { class: "ad-k", text: "기다리는 일" }), el("span", { text: s.queued + "개" + (s.users.length ? " · 수집 대기·진행 사용자: " + s.users.join(", ") : "") })]),
    el("div", { class: "ad-row" }, [el("span", { class: "ad-k", text: "쓰는 중인 창" }), el("span", { text: s.busy.length ? s.busy.join(", ") : "없음" })]),
  ]);
  const c = s.counts;
  const stats = el("section", { class: "ad-card" }, [el("h3", { text: "데이터" }),
    el("div", { class: "ad-row" }, [el("span", { class: "ad-k", text: "사용자" }), el("span", { text: c.users + "명" })]),
    el("div", { class: "ad-row" }, [el("span", { class: "ad-k", text: "저장된 글" }), el("span", { text: c.items + "개" })]),
    el("div", { class: "ad-row" }, [el("span", { class: "ad-k", text: "수집 기록이 있는 페이지" }), el("span", { text: c.pages + "곳" + (c.errors ? " · 마지막 수집이 오류인 곳 " + c.errors : "") })]),
  ]);
  box.append(el("div", { class: "ad-cards" }, [login, auto, stats]));
}

/* ----- 이벤트 ----- */
$("adTabUsers").addEventListener("click", () => adSetTab("users"));
$("adTabAccts").addEventListener("click", () => adSetTab("accts"));
$("adTabServer").addEventListener("click", () => adSetTab("server"));
$("adFind").addEventListener("input", renderAdUsers);
["adAcctState", "adAcctPlat"].forEach((i) => $(i).addEventListener("change", renderAdAccts));
$("adAcctFind").addEventListener("input", renderAdAccts);
