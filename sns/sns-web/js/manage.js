/* ---------- 추적 계정 관리 화면 ----------
   묶음마다 카드 하나. 묶음 이름을 누르면 그 묶음의 계정이 한꺼번에 골라지고(다시 누르면 풀림), 계정을 누르면 하나씩 고릅니다.
   아래 막대에서 고른 계정에: 가져올 기간 적용 · 묶기/묶음 풀기 · 묶음 숨기기/보이기 · 제거.
   묶음 카드 오른쪽: ✎ 이름 바꾸기, 눈 버튼 숨기기/보이기. 묶지 않은 계정은 맨 아래 '묶지 않은 계정' 카드에 모입니다.
   (사람(묶음) 계산은 list.js의 peopleMap, 숨기기는 tracking.js의 setPeopleHidden) */

const accName = (t) => (t.kind === "feed" ? FEED[t.platform] : t.handle ? "@" + t.handle : t.channelId || t.resolveUrl || "");
const daysText = (d) => ({ 7: "1주", 14: "2주", 30: "1개월", 60: "2개월" })[d] || "기본";
const ICONS = {
  rename: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  shown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  hidden: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2" opacity=".55"/><path d="M4 4l16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
};
function iconBtn(kind, label, key, fn) {
  const b = el("button", { type: "button", class: "mg-ib mg-ib-" + kind, "aria-label": label, title: label });
  b.innerHTML = ICONS[kind];
  b.dataset.k = key;
  b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  return b;
}

function needPick() {
  const b = $("mgBar");
  b.classList.add("need"); setTimeout(() => b.classList.remove("need"), 900);
  toast("먼저 계정을 고르세요. 계정이나 묶음 이름을 누르면 골라집니다.", "error");
}
// 주어진 계정들이 모두 골라져 있으면 모두 풀고, 아니면 모두 고릅니다(묶음 이름 누르기 · 계정 하나 누르기)
function toggleIds(ids) {
  const allOn = ids.length > 0 && ids.every((id) => selIds.includes(id));
  selIds = allOn ? selIds.filter((id) => !ids.includes(id)) : selIds.concat(ids.filter((id) => !selIds.includes(id)));
  renderTracked();
}
// 고른 계정이 속한 묶음들
function selectedPeople() {
  const set = new Set(selIds);
  return [...peopleMap().values()].filter((p) => [...p.ids].some((id) => set.has(id)));
}

function accChip(t, person) {
  const on = selIds.includes(t.id);
  const b = el("button", {
    type: "button", class: "mg-acc" + (on ? " sel" : "") + (t.hidden ? " off" : ""), "aria-pressed": String(on),
    "aria-label": PLATFORM[t.platform] + " " + accName(t) + ", 가져올 기간 " + daysText(t.days) + (t.hidden ? ", 숨김" : ""),
  }, [el("span", { class: "mg-pi" }, [pIcon(t.platform)]), el("span", { class: "mg-an", text: accName(t) }), el("span", { class: "mg-ad", text: daysText(t.days) })]);
  b.dataset.k = "a:" + t.id;
  b.addEventListener("click", () => toggleIds([t.id]));
  if (!person) return b;
  // 묶지 않은 계정: 계정 하나가 한 묶음이라 옆에 숨기기 버튼을 둡니다
  const eye = iconBtn(person.hidden ? "hidden" : "shown", accName(t) + (person.hidden ? " 다시 보이게 하기" : " 숨기기"), "e:" + person.name, () => setPeopleHidden([person.name], !person.hidden));
  return el("span", { class: "mg-accwrap" + (person.hidden ? " off" : "") }, [b, eye]);
}

function groupCard(p) {
  const accs = personAccounts(p), ids = accs.map((t) => t.id), group = p.accs[0].group;
  const nSel = ids.filter((id) => selIds.includes(id)).length, all = nSel === ids.length;
  const days = [...new Set(accs.map((t) => t.days || 0))];
  const sel = el("button", {
    type: "button", class: "mg-gsel", "aria-pressed": String(all),
    "aria-label": "‘" + group + "’ 묶음의 계정 " + ids.length + "개 " + (all ? "모두 풀기" : "모두 고르기"),
  }, [
    el("span", { class: "mg-check" + (all ? " on" : nSel ? " part" : ""), "aria-hidden": "true" }),
    picFace(accs.find((t) => picMap[t.id]) || accs[0], group, "pface"),
    el("span", { class: "mg-gtext" }, [
      el("span", { class: "mg-gname", text: group }),
      el("span", { class: "mg-gmeta", text: "계정 " + ids.length + " · " + (days.length === 1 ? daysText(days[0]) : "기간 섞임") }),
    ]),
  ]);
  sel.dataset.k = "g:" + p.name;
  sel.addEventListener("click", () => toggleIds(ids));
  const head = el("div", { class: "mg-ghead" }, [sel]);
  if (p.hidden) head.appendChild(el("span", { class: "mg-badge", text: "숨김 · 수집 안 함" }));
  head.appendChild(iconBtn("rename", "‘" + group + "’ 묶음 이름 바꾸기", "r:" + p.name, () => openRename(group)));
  head.appendChild(iconBtn(p.hidden ? "hidden" : "shown", "‘" + group + "’ 묶음 " + (p.hidden ? "다시 보이게 하기" : "숨기기"), "e:" + p.name, () => setPeopleHidden([p.name], !p.hidden)));
  return el("section", { class: "mg-group" + (p.hidden ? " off" : "") + (nSel ? " has-sel" : "") }, [head, el("div", { class: "mg-accs" }, accs.map((t) => accChip(t)))]);
}

function singlesCard(singles) {
  const accs = singles.map((p) => p.accs[0]).sort((a, b) => PIC_ORDER.indexOf(a.platform) - PIC_ORDER.indexOf(b.platform) || accName(a).localeCompare(accName(b)));
  const ids = accs.map((t) => t.id);
  const nSel = ids.filter((id) => selIds.includes(id)).length, all = nSel === ids.length;
  const sel = el("button", { type: "button", class: "mg-gsel", "aria-pressed": String(all), "aria-label": "묶지 않은 계정 " + ids.length + "개 " + (all ? "모두 풀기" : "모두 고르기") }, [
    el("span", { class: "mg-check" + (all ? " on" : nSel ? " part" : ""), "aria-hidden": "true" }),
    el("span", { class: "mg-gtext" }, [el("span", { class: "mg-gname", text: "묶지 않은 계정" }), el("span", { class: "mg-gmeta", text: "계정 " + ids.length })]),
  ]);
  sel.dataset.k = "g:*singles";
  sel.addEventListener("click", () => toggleIds(ids));
  const byId = new Map(singles.map((p) => [p.accs[0].id, p]));
  return el("section", { class: "mg-group mg-singles" + (nSel ? " has-sel" : "") }, [
    el("div", { class: "mg-ghead" }, [sel]),
    el("div", { class: "mg-accs" }, accs.map((t) => accChip(t, byId.get(t.id)))),
  ]);
}

function renderSelBar() {
  const info = $("selBar"), n = selIds.length;
  info.textContent = "";
  $("mgBar").classList.toggle("empty", !n);
  if (!n) info.appendChild(el("span", { class: "ph", text: "계정이나 묶음 이름을 눌러 고르세요 (여러 개 가능)" }));
  else {
    info.appendChild(el("b", { text: n + "개 계정 선택" }));
    info.appendChild(el("span", { class: "mg-selnames", text: selIds.map((id) => trackedOf(id)).filter(Boolean).map((t) => PLATFORM[t.platform] + " " + accName(t)).join(", ") }));
  }
  $("selClear").hidden = !n;
  $("selAll").hidden = !tracked.length || n === tracked.length;
  ["dApply", "selHide", "selRemove", "gClear", "dDays", "gName"].forEach((id) => { $(id).disabled = !n; });
  if (!n) { const sg = $("gName").parentElement.querySelector(".gsuggest"); if (sg) sg.hidden = true; } // 칸이 꺼지면 열려 있던 묶음 이름 추천 목록도 닫음(포커스가 있던 칸을 끄면 blur가 오지 않음)
  $("groupForm").querySelector("button[type=submit]").disabled = !n;
  // 기간 칸: 고른 계정의 기간이 모두 같으면 그 값을 보여 줍니다(다르면 그대로 둠)
  if (n && document.activeElement !== $("dDays")) {
    const ds = [...new Set(selIds.map((id) => (trackedOf(id) || {}).days || 0))];
    if (ds.length === 1) $("dDays").value = String(ds[0]);
  }
  // 묶음 숨기기/보이기: 고른 계정이 속한 묶음이 모두 숨김이면 '보이기'
  const ps = selectedPeople(), allHidden = ps.length > 0 && ps.every((p) => p.hidden);
  $("selHide").textContent = allHidden ? "묶음 보이기" : "묶음 숨기기";
  $("selHide").title = "고른 계정이 속한 묶음 전체를 " + (allHidden ? "다시 보이게 합니다(바로 글을 모읍니다)" : "숨깁니다(홈에 안 나오고 글도 모으지 않음)");
  // 묶음 이름 칸: 고른 계정이 모두 같은 묶음이면 그 이름을 흐리게 보여 줌
  const gs = [...new Set(selIds.map((id) => (trackedOf(id) || {}).group || ""))];
  $("gName").placeholder = gs.length === 1 && gs[0] ? "지금: " + gs[0] : "묶음 이름";
}

function renderTracked() {
  selIds = selIds.filter((id) => tracked.some((t) => t.id === id));
  const list = $("mgList");
  if (!list) return;
  // 다시 그려도 보던 위치와 키보드 포커스를 유지합니다(수집 중에는 몇 초마다 다시 그려짐)
  const keep = list.scrollTop, act = document.activeElement, fk = act && list.contains(act) ? act.dataset.k : "";
  const people = [...peopleMap().values()];
  const groups = people.filter((p) => p.accs[0] && p.accs[0].group).sort((a, b) => personLabel(a).localeCompare(personLabel(b), "ko"));
  const singles = people.filter((p) => !(p.accs[0] && p.accs[0].group));
  const nHidden = people.filter((p) => p.hidden).length;
  $("mgCount").textContent = tracked.length ? "계정 " + tracked.length + "/" + MAX_TRACKED + " · 묶음 " + groups.length + (nHidden ? " · 숨김 " + nHidden : "") : "";
  list.textContent = "";
  if (!tracked.length) list.appendChild(el("p", { class: "mg-empty", text: "추적 중인 계정이 없습니다. 위쪽 검색창에 이름·@아이디·프로필 주소를 넣고 Enter로 찾아 추가하세요." }));
  groups.forEach((p) => list.appendChild(groupCard(p)));
  if (singles.length) list.appendChild(singlesCard(singles));
  list.scrollTop = keep;
  if (fk) { const b = Array.from(list.querySelectorAll("[data-k]")).find((x) => x.dataset.k === fk); if (b) b.focus({ preventScroll: true }); }
  renderSelBar();
  periodDays = winDays;
  $("dDays").options[0].textContent = "기본 (" + winDays + "일)";
  paintCheckNow();
}

// 묶음 숨기기/보이기(묶음의 모든 계정에 한꺼번에). 숨긴 묶음은 홈·묶음 줄에 안 나오고 서버도 수집하지 않습니다.
// 다시 보이게 하면 숨긴 동안 못 모은 글을 바로 모읍니다.
async function setPersonHidden(name, hide) { return setPeopleHidden([name], hide); }
async function setPeopleHidden(names, hide) {
  const set = new Set(names);
  const m = peopleMap();
  const labels = names.map((n) => (m.get(n) ? personLabel(m.get(n)) : n));
  const ids = tracked.filter((t) => t.kind !== "feed" && set.has(personKey(t)) && !!t.hidden !== hide).map((t) => t.id);
  if (!ids.length) return;
  const before = tracked;
  if (hide) names.forEach((n) => storySel.delete(n)); // 숨긴 묶음은 고른 목록에서도 뺍니다(다시 보이게 했을 때 저절로 골라져 있지 않게)
  tracked = tracked.map((t) => {
    if (t.kind === "feed" || !set.has(personKey(t))) return t;
    const c = { ...t };
    if (hide) c.hidden = true; else delete c.hidden;
    return c;
  });
  renderTracked(); renderList();
  const what = labels.length === 1 ? "‘" + labels[0] + "’ 묶음을" : "묶음 " + labels.length + "개를";
  try {
    await saveTracked();
    if (hide) toast(what + " 숨겼습니다. 홈에 나오지 않고, 숨긴 동안은 글도 모으지 않습니다.");
    else {
      toast(what + " 다시 보이게 했습니다 · 숨긴 동안 못 모은 글을 모으는 중입니다.");
      for (const id of ids) await call("checkNow", { only: id }).catch(() => {});
    }
  } catch (e) { tracked = before; renderTracked(); renderList(); showErr(e); }
}

// 고른 계정 전부에 적용합니다.
async function applyToSelected(change) {
  if (!selIds.length) { needPick(); return false; }
  const ids = new Set(selIds), before = tracked;
  tracked = tracked.map((t) => (ids.has(t.id) ? change({ ...t }) : t));
  renderTracked(); renderList();
  try { await saveTracked(); return true; } catch (e) { tracked = before; renderTracked(); renderList(); showErr(e); return false; }
}

$("selAll").addEventListener("click", () => { selIds = tracked.map((t) => t.id); renderTracked(); });
$("selClear").addEventListener("click", () => { selIds = []; renderTracked(); });
$("dApply").addEventListener("click", async () => {
  const d = Number($("dDays").value), n = selIds.length;
  if (await applyToSelected((c) => { if (d) c.days = d; else delete c.days; return c; })) toast("고른 계정 " + n + "개의 가져올 기간을 " + (d ? daysText(d) + "(" + d + "일)" : "기본(" + winDays + "일)") + "로 정했습니다.");
});
$("groupForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $("gName").value.trim().slice(0, 30);
  if (!selIds.length) { needPick(); return; }
  if (!name) { toast("묶음 이름을 적어 주세요. 묶음에서 빼려면 '묶음 풀기'를 누르세요.", "error"); $("gName").focus(); return; }
  // 숨김 상태 맞추기: 이미 있는 묶음에 넣으면 그 묶음을 따르고, 새 묶음이면 고른 계정이 모두 숨김일 때만 숨김
  const sel = new Set(selIds);
  const others = tracked.filter((t) => t.group === name && !sel.has(t.id));
  const hide = others.length ? others.every((t) => t.hidden) : selIds.every((id) => (trackedOf(id) || {}).hidden);
  const n = selIds.length;
  if (await applyToSelected((c) => { c.group = name; if (hide) c.hidden = true; else delete c.hidden; return c; })) {
    $("gName").value = "";
    toast("계정 " + n + "개를 ‘" + name + "’ 묶음에 넣었습니다." + (hide ? " (숨긴 묶음이라 홈에 보이지 않고 글도 모으지 않습니다)" : ""));
  }
});
$("gClear").addEventListener("click", async () => {
  const n = selIds.filter((id) => (trackedOf(id) || {}).group).length;
  if (!n) { toast("고른 계정 중 묶음에 든 계정이 없습니다.", "error"); return; }
  if (await applyToSelected((c) => { delete c.group; return c; })) toast("계정 " + n + "개를 묶음에서 뺐습니다.");
});
$("selHide").addEventListener("click", () => {
  const ps = selectedPeople();
  if (!ps.length) { needPick(); return; }
  setPeopleHidden(ps.map((p) => p.name), !ps.every((p) => p.hidden));
});

// 묶음 이름 바꾸기(✎): 그 묶음의 모든 계정 이름이 바뀝니다(즐겨찾기·위쪽 묶음 줄에서 고른 것도 따라감).
const gmClose = () => { $("gmModal").hidden = true; };
function openRename(group) {
  const sel = $("gmSel"), inp = $("gmName"), cnt = new Map();
  tracked.forEach((t) => { if (t.group) cnt.set(t.group, (cnt.get(t.group) || 0) + 1); });
  if (!cnt.size) return;
  sel.textContent = "";
  cnt.forEach((n, name) => sel.appendChild(el("option", { value: name, text: name + " (" + n + "개 계정)" })));
  sel.value = cnt.has(group) ? group : sel.options[0].value;
  inp.value = sel.value; $("gmErr").hidden = true;
  $("gmModal").hidden = false; inp.focus(); inp.select();
}
{
  const sel = $("gmSel"), inp = $("gmName"), err = $("gmErr");
  const say = (m) => { err.textContent = m; err.hidden = !m; };
  sel.addEventListener("change", () => { inp.value = sel.value; say(""); inp.focus(); inp.select(); });
  $("gmX").addEventListener("click", gmClose); $("gmCancel").addEventListener("click", gmClose);
  $("gmModal").addEventListener("click", (e) => { if (e.target === $("gmModal")) gmClose(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("gmModal").hidden) gmClose(); });
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("gmOk").click(); } });
  $("gmOk").addEventListener("click", async () => {
    const old = sel.value, neu = inp.value.trim().slice(0, 30);
    if (!neu) { say("새 이름을 적어 주세요."); inp.focus(); return; }
    if (neu === old) { say("현재 이름과 같습니다."); return; }
    if (tracked.some((t) => t.group === neu)) { say("‘" + neu + "’ 묶음이 이미 있습니다. 합치려면 계정을 골라 '묶기'를 쓰세요."); return; }
    const before = tracked;
    tracked = tracked.map((t) => (t.group === old ? { ...t, group: neu } : t));
    if (favs.has(old)) { favs.delete(old); favs.add(neu); saveFavs(); }
    if (groupFocus === old) groupFocus = neu;
    if (personFocus === old) personFocus = neu;
    if (storySel.has(old)) { storySel.delete(old); storySel.add(neu); } // 위쪽 묶음 줄에서 고른 묶음도 따라감
    if (picPick[old]) { picPick[neu] = picPick[old]; delete picPick[old]; savePics(); } // 이름 옆 사진 고른 것도 따라감
    gmClose(); renderTracked(); renderList();
    try { await saveTracked(); toast("‘" + old + "’ 묶음 이름을 ‘" + neu + "’(으)로 바꿨습니다."); } catch (e) { tracked = before; renderTracked(); renderList(); showErr(e); }
  });
}

// 제거: 고른 계정을 추적 목록에서 지웁니다(그 계정으로 모은 글도 함께). 확인 창에서 한 번 더 확인합니다.
const closeRm = () => { $("rmModal").hidden = true; };
$("selRemove").addEventListener("click", () => {
  if (!selIds.length) { needPick(); return; }
  $("rmList").textContent = selIds.map((id) => trackedOf(id)).filter(Boolean).map((t) => PLATFORM[t.platform] + " " + accName(t)).join(" · ");
  $("rmModal").hidden = false;
  $("rmCancel").focus();
});
$("rmX").addEventListener("click", closeRm);
$("rmCancel").addEventListener("click", closeRm);
$("rmModal").addEventListener("click", (e) => { if (e.target === $("rmModal")) closeRm(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("rmModal").hidden) closeRm(); });
$("rmOk").addEventListener("click", async () => { closeRm(); await removeTrackedIds(selIds.slice()); });
