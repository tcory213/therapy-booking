import { useState, useMemo, useCallback, useEffect } from "react";
import { db } from "./firebase.js";
import { collection, doc, onSnapshot, addDoc, deleteDoc, updateDoc, setDoc, writeBatch } from "firebase/firestore";

/* ═══════════════════════════════════════════ Constants ═══════════════════════════════════════════ */
const THERAPISTS = [
  { id: "A", name: "王治療師", color: "#C2563A" },
  { id: "B", name: "盧治療師", color: "#2E7D6F" },
  { id: "C", name: "蔡治療師", color: "#5B6ABF" },
  { id: "D", name: "吳治療師", color: "#B8860B" },
  { id: "E", name: "東治療師", color: "#8B5C9E" },
];
const TH_MAP = Object.fromEntries(THERAPISTS.map(t => [t.id, t]));
TH_MAP["X"] = { id: "X", name: "不指定", color: "#8B7355" };
const DURATIONS = [15, 30, 45, 60];
const TREAT_TYPES = [
  { id: "manual", label: "徒手治療" },
  { id: "taping", label: "貼紮" },
  { id: "shockwave", label: "體外震波" },
  { id: "laser", label: "高能雷射" },
];
const TREAT_MAP = Object.fromEntries(TREAT_TYPES.map(t => [t.id, t.label]));
const ADMIN_PW = "hapi719";
const SLOT_START = "08:30", MORN_END = "12:00", AFT_START = "14:00", EVE_START = "18:00", SLOT_END = "21:30";
// Pre-computed minute values for constants (avoid repeated toM parsing)
const M_SLOT_START = 510, M_MORN_END = 720, M_AFT_START = 840, M_EVE_START = 1080, M_SLOT_END = 1290;

// 盧獨立時段
const LU_START = "14:00", LU_END = "20:45";
const M_LU_START = 840, M_LU_END = 1245;
const LU_COLOR = "#1A6B5A";

function genSlots(s, e) { const r = []; let c = toM(s); const end = toM(e); while (c < end) { r.push(fM(c)); c += 15; } return r; }
function genMainSlots() { const r = []; let c = toM(SLOT_START); while (c < toM(MORN_END)) { r.push(fM(c)); c += 15; } c = toM(AFT_START); while (c < toM(SLOT_END)) { r.push(fM(c)); c += 15; } return r; }
const SLOTS = genMainSlots();
const LU_SLOTS = genSlots(LU_START, LU_END);

function toM(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function fM(m) { return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }
function fd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function maskN(n) { if (!n || n.length < 2) return n || ""; if (n.length === 2) return n[0] + "O"; return n[0] + "O".repeat(n.length - 2) + n[n.length - 1]; }
function sortByDateTime(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : toM(a.time) - toM(b.time); }
function weekDates(base) { const d = new Date(base), day = d.getDay(); const mon = new Date(d); mon.setDate(d.getDate() - day + (day === 0 ? -6 : 1)); return Array.from({ length: 6 }, (_, i) => { const x = new Date(mon); x.setDate(mon.getDate() + i); return x; }); }
const WDAY = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];

/* ═══════════════════════════════════════════ Shifts ═══════════════════════════════════════════ */
const EMPTY_SHIFT = [];
function getShiftArr(tid, date, cs) { const k = `${tid}-${fd(date)}`; return cs[k] !== undefined ? cs[k] : EMPTY_SHIFT; }
function timePeriod(time) { const m = toM(time); if (m < M_MORN_END) return "m"; if (m < M_EVE_START) return "a"; return "e"; }
function getPeriodState(arr, pk) { if (arr.includes(pk)) return "on"; if (arr.includes(pk + "o")) return "off"; return null; }
function getPeriodStateAt(tid, date, time, cs) { const arr = getShiftArr(tid, date, cs); return getPeriodState(arr, timePeriod(time)); }
function validRange(st, dur) { const s = toM(st); for (let i = 0; i < dur / 15; i++) { const m = s + i * 15; if (!((m >= M_SLOT_START && m < M_MORN_END) || (m >= M_AFT_START && m < M_SLOT_END))) return false; } return true; }
function luValidRange(st, dur) { const s = toM(st); for (let i = 0; i < dur / 15; i++) { const m = s + i * 15; if (m < M_LU_START || m >= M_LU_END) return false; } return true; }
// 盧獨立時段僅週一(1)、週二(2)、週四(4)；開放隔天～次月底
function luWeekDates(base) { const all = weekDates(base); return [all[0], all[1], all[3]]; }
function isLuDateOpen(ds) { const today = new Date(); const tom = new Date(today); tom.setDate(today.getDate() + 1); const nextMonthEnd = new Date(today.getFullYear(), today.getMonth() + 2, 0); return ds >= fd(tom) && ds <= fd(nextMonthEnd); }
function isLuSlotClosed(ds, time, luSlotCfg) { return luSlotCfg[`${ds}-${time}`] === false; }

/* ═══════════════════════════════════════════ Conflicts ═══════════════════════════════════════════ */
function slotConflict(appts, ds, time, dur, exId, filterFn) {
  const st = toM(time);
  const dayAppts = appts.filter(a => a.id !== exId && a.date === ds && filterFn(a));
  for (let i = 0; i < dur / 15; i++) { const m = st + i * 15; if (dayAppts.some(a => { const as = toM(a.time); return m >= as && m < as + a.duration; })) return true; }
  return false;
}
function onDutySlotConflict(appts, ds, time, dur, exId) { return slotConflict(appts, ds, time, dur, exId, a => a.onDuty); }
function luSlotOccupied(appts, ds, time, dur, exId) { return slotConflict(appts, ds, time, dur, exId, () => true); }
function bufferConflictGeneric(appts, ds, time, dur, exId, filterFn) {
  const ns = toM(time), ne = ns + dur;
  return appts.some(a => a.id !== exId && a.date === ds && filterFn(a) && (toM(a.time) + a.duration === ns || ne === toM(a.time)));
}
function bufferConflict(appts, ds, time, dur, tid, exId) { return bufferConflictGeneric(appts, ds, time, dur, exId, a => a.therapist === tid); }
function luBufferConflict(appts, ds, time, dur, exId) { return bufferConflictGeneric(appts, ds, time, dur, exId, () => true); }

/* ═══════════════════════════════════════════ Demo data removed — using Firestore ═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════ Shared UI ═══════════════════════════════════════════ */
function Modal({ open, onClose, children, title }) {
  if (!open) return null;
  return (<div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)", backdropFilter: "blur(2px)" }} />
    <div style={{ position: "relative", background: "#FFFDF5", borderRadius: 14, boxShadow: "0 24px 80px rgba(0,0,0,0.18)", padding: 26, maxWidth: 520, width: "94%", maxHeight: "90vh", overflowY: "auto", border: "1px solid #E8DCC8" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#3D2B1F", fontFamily: "'Noto Serif TC', serif" }}>{title}</h2>
        <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#8B7355" }}>✕</button>
      </div>{children}
    </div>
  </div>);
}
function AlertModal({ open, message, onClose }) {
  if (!open) return null;
  return (<div style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}>
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.3)" }} />
    <div style={{ position: "relative", background: "#FFFDF5", borderRadius: 12, padding: "28px 32px", maxWidth: 360, width: "88%", boxShadow: "0 16px 60px rgba(0,0,0,0.2)", textAlign: "center" }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
      <p style={{ fontSize: 15, fontWeight: 600, color: "#3D2B1F", margin: "0 0 18px 0", lineHeight: 1.5 }}>{message}</p>
      <button onClick={onClose} style={{ padding: "9px 28px", borderRadius: 8, border: "none", background: "#C2563A", color: "white", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "'Noto Sans TC', sans-serif" }}>確認</button>
    </div>
  </div>);
}
// Confirm modal with OK + Cancel
function ConfirmModal({ open, message, onOk, onCancel }) {
  if (!open) return null;
  return (<div style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}>
    <div onClick={onCancel} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.3)" }} />
    <div style={{ position: "relative", background: "#FFFDF5", borderRadius: 12, padding: "28px 32px", maxWidth: 380, width: "88%", boxShadow: "0 16px 60px rgba(0,0,0,0.2)", textAlign: "center" }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
      <p style={{ fontSize: 14, fontWeight: 600, color: "#3D2B1F", margin: "0 0 18px 0", lineHeight: 1.5 }}>{message}</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        <button onClick={onOk} style={{ padding: "9px 24px", borderRadius: 8, border: "none", background: "#C2563A", color: "white", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Noto Sans TC', sans-serif" }}>仍要預約</button>
        <button onClick={onCancel} style={{ padding: "9px 24px", borderRadius: 8, border: "1.5px solid #D4C5A9", background: "#FFFDF5", color: "#5A4A3A", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Noto Sans TC', sans-serif" }}>取消</button>
      </div>
    </div>
  </div>);
}
function NavCtrl({ selDate, setSelDate, viewMode, setViewMode, showDayView, extra }) {
  const nav = dir => setSelDate(d => { const n = new Date(d); n.setDate(n.getDate() + dir * (viewMode === "week" ? 7 : 1)); return n; });
  return (<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <button onClick={() => nav(-1)} style={navBtn}>◀</button>
      <div style={{ padding: "5px 12px", background: "#FFFDF5", borderRadius: 6, border: "1px solid #D4C5A9", fontWeight: 700, color: "#3D2B1F", fontSize: 12, minWidth: 140, textAlign: "center" }}>
        {viewMode === "week" ? (() => { const w = weekDates(selDate); return `${w[0].getMonth() + 1}/${w[0].getDate()} — ${w[5].getMonth() + 1}/${w[5].getDate()}`; })()
          : `${selDate.getFullYear()}/${selDate.getMonth() + 1}/${selDate.getDate()} ${WDAY[(selDate.getDay() + 6) % 7]}`}
      </div>
      <button onClick={() => nav(1)} style={navBtn}>▶</button>
      <button onClick={() => setSelDate(new Date())} style={{ ...navBtn, color: "#C2563A", fontWeight: 600, fontSize: 11 }}>今天</button>
    </div>
    <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
      {showDayView && [{ k: "day", l: "日" }, { k: "week", l: "週" }].map(v => (
        <button key={v.k} onClick={() => setViewMode(v.k)} style={{ padding: "5px 12px", borderRadius: 6, border: `1.5px solid ${viewMode === v.k ? "#C2563A" : "#D4C5A9"}`, background: viewMode === v.k ? "#FFF0EB" : "#FFFDF5", color: viewMode === v.k ? "#C2563A" : "#5A4A3A", cursor: "pointer", fontWeight: 600, fontSize: 11, fontFamily: "'Noto Sans TC', sans-serif" }}>{v.l}</button>
      ))}{extra}
    </div>
  </div>);
}
const navBtn = { padding: "5px 10px", borderRadius: 6, border: "1px solid #D4C5A9", background: "#FFFDF5", cursor: "pointer", fontSize: 13, fontFamily: "'Noto Sans TC', sans-serif" };
const inp = { width: "100%", padding: "8px 11px", borderRadius: 7, border: "1.5px solid #D4C5A9", fontSize: 13, background: "#FFFDF5", fontFamily: "'Noto Sans TC', sans-serif", boxSizing: "border-box", outline: "none" };
const lbl = { display: "block", marginBottom: 4, fontSize: 11, fontWeight: 600, color: "#5A4A3A" };
const actionBtn = { flex: 1, padding: 9, borderRadius: 7, cursor: "pointer", fontWeight: 600, fontSize: 11, fontFamily: "'Noto Sans TC', sans-serif" };

/* ═══════════════════════════════════════════ Main Booking Form ═══════════════════════════════════════════ */
function BookingForm({ date, time, appts, onBook, onClose, isAdmin, cs, mainSlotCfg, addExtra }) {
  const [patient, setPatient] = useState(""); const [bday, setBday] = useState(""); const [idNum, setIdNum] = useState(""); const [dur, setDur] = useState(15);
  const [treatType, setTreatType] = useState("manual");
  const [selTh, setSelTh] = useState(""); const [selfRef, setSelfRef] = useState(false); const [err, setErr] = useState("");
  const [confirmData, setConfirmData] = useState(null);
  const [confirmBook, setConfirmBook] = useState(null);
  const ds = fd(date);

  const effectiveDurs = treatType === "manual" ? DURATIONS : [15];

  // Auto-fix duration when switching treat type
  const curDur = treatType !== "manual" ? 15 : dur;

  const slotClosed = useMemo(() => {
    if (isAdmin) return false;
    for (let i = 0; i < curDur / 15; i++) {
      const t = fM(toM(time) + i * 15);
      if (mainSlotCfg[`${ds}-${t}`] === false) return true;
    }
    return false;
  }, [ds, time, curDur, mainSlotCfg, isAdmin]);

  const onDutyOccupied = useMemo(() => onDutySlotConflict(appts, ds, time, curDur, null), [appts, ds, time, curDur]);

  const availList = useMemo(() => THERAPISTS.map(t => {
    const st = getPeriodStateAt(t.id, date, time, cs);
    if (!st) return { ...t, available: false, adminOverride: false, reason: "無班", isOff: false };
    if (addExtra) {
      // Show all therapists with shifts, warnings for conflicts but all selectable
      const isOff = st === "off";
      const hasBuf = bufferConflict(appts, ds, time, curDur, t.id, null);
      const hasExisting = appts.some(a => a.date === ds && a.therapist === t.id && toM(time) >= toM(a.time) && toM(time) < toM(a.time) + a.duration);
      const warns = [];
      if (hasExisting) warns.push("已有患者");
      if (hasBuf) warns.push("需緩衝");
      if (!isOff && onDutyOccupied) warns.push("班內已佔");
      return { ...t, available: true, adminOverride: warns.length > 0, warn: warns.join("·"), isOff };
    }
    if (st === "off" && !isAdmin) return { ...t, available: false, adminOverride: false, reason: "班外", isOff: true };
    const isOff = st === "off";
    const hasBuf = bufferConflict(appts, ds, time, curDur, t.id, null);
    const hasSlotConf = !isOff && onDutyOccupied;
    if (isAdmin) {
      if (hasSlotConf) return { ...t, available: true, adminOverride: true, warn: "時段已佔", isOff: false };
      if (hasBuf) return { ...t, available: true, adminOverride: true, warn: "需緩衝", isOff };
      return { ...t, available: true, adminOverride: false, isOff };
    } else {
      if (hasSlotConf) return { ...t, available: false, adminOverride: false, reason: "時段已佔", isOff: false };
      if (hasBuf) return { ...t, available: false, adminOverride: false, reason: "需緩衝", isOff };
      return { ...t, available: true, adminOverride: false, isOff };
    }
  }), [date, time, curDur, appts, ds, cs, isAdmin, onDutyOccupied, addExtra]);

  const anyAvail = !slotClosed && availList.some(t => t.available);
  const selInfo = selTh === "X" ? null : availList.find(t => t.id === selTh);

  const finalBook = (data) => { onBook(data); onClose(); };
  const doBook = (data) => { finalBook(data); };

  const submit = () => {
    if (!patient.trim()) { setErr("請輸入患者姓名"); return; }
    if (!bday.trim() || bday.length !== 6) { setErr("請輸入民國年月日六碼"); return; }
    if (!isAdmin && !idNum.trim()) { setErr("請輸入身分證字號"); return; }
    if (!selTh) { setErr("請選擇治療師"); return; }
    if (!validRange(time, curDur)) { setErr("超出營業時間"); return; }
    const isUnspecified = selTh === "X";
    const onDuty = isUnspecified ? true : !selInfo?.isOff;
    const apptData = { id: Date.now(), date: ds, time, duration: curDur, therapist: selTh, patient: patient.trim(), birthday: bday.trim(), idNum: idNum.trim(), onDuty, selfRef, treatType };

    if (isAdmin && !isUnspecified && selInfo?.adminOverride) {
      const warnings = [];
      if (selInfo.warn === "時段已佔") warnings.push("此時段已有其他班內治療師");
      if (selInfo.warn === "需緩衝") warnings.push("違反同治療師 15 分鐘緩衝規定");
      setConfirmData({ message: warnings.join("，且") + "，確定仍要預約嗎？", apptData });
      return;
    }
    doBook(apptData);
  };

  const thBtnStyle = (sel2, color, avail) => ({
    padding: "6px 12px", borderRadius: 7, cursor: avail ? "pointer" : "not-allowed",
    border: sel2 ? `2px solid ${color}` : "1.5px solid #D4C5A9",
    background: sel2 ? `${color}18` : avail ? "#FFFDF5" : "#EEE9DF",
    color: avail ? (sel2 ? color : "#5A4A3A") : "#B5A898",
    fontWeight: sel2 ? 700 : 500, fontSize: 11, opacity: avail ? 1 : 0.5,
    fontFamily: "'Noto Sans TC', sans-serif",
  });

  return (<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div style={{ background: "#F5EDDC", borderRadius: 7, padding: "8px 12px", display: "flex", gap: 14, fontSize: 12, color: "#5A4A3A" }}><span>📅 {ds}</span><span>🕐 {time}</span></div>
    <div><label style={lbl}>患者姓名 *</label><input value={patient} onChange={e => setPatient(e.target.value)} style={inp} placeholder="請輸入全名" /></div>
    <div><label style={lbl}>生日（民國年月日六碼）*</label><input value={bday} onChange={e => setBday(e.target.value.replace(/\D/g, "").slice(0, 6))} style={inp} placeholder="如 800515" maxLength={6} /></div>
    <div><label style={lbl}>身分證字號 {isAdmin ? "" : "*"}</label><input value={idNum} onChange={e => setIdNum(e.target.value.toUpperCase())} style={inp} placeholder={isAdmin ? "（後台選填）" : "請輸入身分證字號"} maxLength={10} /></div>

    <div><label style={lbl}>治療項目</label>
      <div style={{ display: "flex", gap: 5 }}>
        {TREAT_TYPES.map(tt => (
          <button key={tt.id} onClick={() => { setTreatType(tt.id); if (tt.id !== "manual") setDur(15); setSelTh(""); setErr(""); }} style={{
            flex: 1, padding: "7px 0", borderRadius: 7, cursor: "pointer", fontSize: 12,
            border: treatType === tt.id ? "2px solid #C2563A" : "1.5px solid #D4C5A9",
            background: treatType === tt.id ? "#FFF0EB" : "#FFFDF5",
            color: treatType === tt.id ? "#C2563A" : "#5A4A3A",
            fontWeight: treatType === tt.id ? 700 : 500, fontFamily: "'Noto Sans TC', sans-serif",
          }}>{tt.label}</button>
        ))}
      </div>
    </div>

    <div><label style={lbl}>治療時長</label>
      <div style={{ display: "flex", gap: 5 }}>
        {effectiveDurs.map(d => (
          <button key={d} onClick={() => { setDur(d); setSelTh(""); setErr(""); }} style={{
            flex: 1, padding: "7px 0", borderRadius: 7, cursor: "pointer", fontSize: 12,
            border: curDur === d ? "2px solid #C2563A" : "1.5px solid #D4C5A9",
            background: curDur === d ? "#FFF0EB" : "#FFFDF5",
            color: curDur === d ? "#C2563A" : "#5A4A3A",
            fontWeight: curDur === d ? 700 : 500, fontFamily: "'Noto Sans TC', sans-serif",
          }}>{d} 分</button>
        ))}
      </div>
    </div>

    <div><label style={lbl}>選擇治療師</label>
      {slotClosed ? <div style={{ padding: 8, background: "#FFF5F2", borderRadius: 7, fontSize: 11, color: "#C2563A", border: "1px solid #E8C8C0" }}>此時段未開放預約</div>
      : !anyAvail && !isAdmin ? <div style={{ padding: 8, background: "#FFF5F2", borderRadius: 7, fontSize: 11, color: "#C2563A", border: "1px solid #E8C8C0" }}>此時段無可預約的治療師</div>
      : <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {availList.map(t => { const sel2 = selTh === t.id; return (
            <button key={t.id} disabled={!t.available} onClick={() => { setSelTh(t.id); setErr(""); }} style={thBtnStyle(sel2, t.color, t.available)}>
              {t.name}
              {t.available && t.isOff && <span style={{ display: "block", fontSize: 8, color: "#C2563A" }}>班外</span>}
              {t.available && t.adminOverride && <span style={{ display: "block", fontSize: 8, color: "#B8860B" }}>⚠ {t.warn}</span>}
              {!t.available && <span style={{ display: "block", fontSize: 8, color: "#B5A898" }}>{t.reason}</span>}
            </button>
          ); })}
          {!addExtra && <button onClick={() => { setSelTh("X"); setErr(""); }}
            style={thBtnStyle(selTh === "X", "#8B7355", true)}>
            不指定
          </button>}
        </div>}
    </div>

    {isAdmin && <div><label style={lbl}>自轉／非自轉</label><div style={{ display: "flex", gap: 5 }}>{[{ v: true, l: "自轉" }, { v: false, l: "非自轉" }].map(o => (<button key={String(o.v)} onClick={() => setSelfRef(o.v)} style={{ flex: 1, padding: "7px 0", borderRadius: 7, cursor: "pointer", fontSize: 12, border: selfRef === o.v ? "2px solid #5B6ABF" : "1.5px solid #D4C5A9", background: selfRef === o.v ? "#EEEEFF" : "#FFFDF5", color: selfRef === o.v ? "#5B6ABF" : "#5A4A3A", fontWeight: selfRef === o.v ? 700 : 500, fontFamily: "'Noto Sans TC', sans-serif" }}>{o.l}</button>))}</div></div>}
    {err && <div style={{ color: "#C2563A", fontSize: 11, background: "#FFF0EB", padding: "5px 9px", borderRadius: 5 }}>{err}</div>}
    <button onClick={submit} disabled={!anyAvail && !isAdmin} style={{ padding: 11, borderRadius: 9, border: "none", cursor: (anyAvail || isAdmin) ? "pointer" : "not-allowed", background: (anyAvail || isAdmin) ? "linear-gradient(135deg, #C2563A, #A8432B)" : "#CCBFB0", color: "white", fontSize: 14, fontWeight: 700, fontFamily: "'Noto Sans TC', sans-serif" }}>確認預約</button>
    <ConfirmModal open={!!confirmData} message={confirmData?.message || ""} onOk={() => { doBook(confirmData.apptData); setConfirmData(null); }} onCancel={() => setConfirmData(null)} />

  </div>);
}

/* ═══════════════════════════════════════════ 盧老師 Booking Form ═══════════════════════════════════════════ */
function LuBookingForm({ date, time, appts, onBook, onClose, isAdmin, luSlotCfg }) {
  const [patient, setPatient] = useState(""); const [bday, setBday] = useState(""); const [idNum, setIdNum] = useState(""); const [dur, setDur] = useState(15);
  const [selfRef, setSelfRef] = useState(false);
  const [err, setErr] = useState(""); const [confirmBuf, setConfirmBuf] = useState(null);
  const ds = fd(date);
  const occupied = useMemo(() => luSlotOccupied(appts, ds, time, dur, null), [appts, ds, time, dur]);
  const allOpen = useMemo(() => {
    for (let i = 0; i < dur / 15; i++) {
      const t = fM(toM(time) + i * 15);
      if (isLuSlotClosed(ds, t, luSlotCfg)) return false;
    }
    return true;
  }, [ds, time, dur, luSlotCfg]);
  const hasBuf = useMemo(() => luBufferConflict(appts, ds, time, dur, null), [appts, ds, time, dur]);
  const canBook = !occupied && (isAdmin || (isLuDateOpen(ds) && allOpen && !hasBuf));

  const finalBook = (data) => { onBook(data); onClose(); };
  const doBook = () => {
    if (!patient.trim()) { setErr("請輸入患者姓名"); return; }
    if (!bday.trim() || bday.length !== 6) { setErr("請輸入民國年月日六碼"); return; }
    if (!isAdmin && !idNum.trim()) { setErr("請輸入身分證字號"); return; }
    if (!luValidRange(time, dur)) { setErr("超出盧獨立時段"); return; }
    finalBook({ id: Date.now(), date: ds, time, duration: dur, patient: patient.trim(), birthday: bday.trim(), idNum: idNum.trim(), selfRef });
  };
  const submit = () => {
    if (!patient.trim()) { setErr("請輸入患者姓名"); return; }
    if (!bday.trim() || bday.length !== 6) { setErr("請輸入民國年月日六碼"); return; }
    if (!isAdmin && !idNum.trim()) { setErr("請輸入身分證字號"); return; }
    if (isAdmin && hasBuf && !occupied) { setConfirmBuf({ patient: patient.trim(), birthday: bday.trim(), idNum: idNum.trim() }); return; }
    doBook();
  };

  return (<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div style={{ background: "#E8F5F0", borderRadius: 7, padding: "8px 12px", display: "flex", gap: 14, fontSize: 12, color: "#1A6B5A" }}><span>📅 {ds}</span><span>🕐 {time}</span><span style={{ marginLeft: "auto", fontWeight: 600 }}>盧獨立時段</span></div>
    <div><label style={lbl}>患者姓名 *</label><input value={patient} onChange={e => setPatient(e.target.value)} style={inp} placeholder="請輸入全名" /></div>
    <div><label style={lbl}>生日（民國年月日六碼）*</label><input value={bday} onChange={e => setBday(e.target.value.replace(/\D/g, "").slice(0, 6))} style={inp} placeholder="如 800515" maxLength={6} /></div>
    <div><label style={lbl}>身分證字號 {isAdmin ? "" : "*"}</label><input value={idNum} onChange={e => setIdNum(e.target.value.toUpperCase())} style={inp} placeholder={isAdmin ? "（後台選填）" : "請輸入身分證字號"} maxLength={10} /></div>
    <div><label style={lbl}>治療時長</label><div style={{ display: "flex", gap: 5 }}>{DURATIONS.map(d => (<button key={d} onClick={() => { setDur(d); setErr(""); }} style={{ flex: 1, padding: "7px 0", borderRadius: 7, cursor: "pointer", fontSize: 12, border: dur === d ? `2px solid ${LU_COLOR}` : "1.5px solid #D4C5A9", background: dur === d ? "#E8F5F0" : "#FFFDF5", color: dur === d ? LU_COLOR : "#5A4A3A", fontWeight: dur === d ? 700 : 500, fontFamily: "'Noto Sans TC', sans-serif" }}>{d} 分</button>))}</div></div>
    {isAdmin && <div><label style={lbl}>自轉／非自轉</label><div style={{ display: "flex", gap: 5 }}>{[{ v: true, l: "自轉" }, { v: false, l: "非自轉" }].map(o => (<button key={String(o.v)} onClick={() => setSelfRef(o.v)} style={{ flex: 1, padding: "7px 0", borderRadius: 7, cursor: "pointer", fontSize: 12, border: selfRef === o.v ? `2px solid ${LU_COLOR}` : "1.5px solid #D4C5A9", background: selfRef === o.v ? "#E8F5F0" : "#FFFDF5", color: selfRef === o.v ? LU_COLOR : "#5A4A3A", fontWeight: selfRef === o.v ? 700 : 500, fontFamily: "'Noto Sans TC', sans-serif" }}>{o.l}</button>))}</div></div>}
    {occupied && <div style={{ padding: 8, background: "#FFF5F2", borderRadius: 7, fontSize: 11, color: "#C2563A", border: "1px solid #E8C8C0" }}>此時段已有預約</div>}
    {!occupied && !allOpen && !isAdmin && <div style={{ padding: 8, background: "#FFF5F2", borderRadius: 7, fontSize: 11, color: "#C2563A", border: "1px solid #E8C8C0" }}>此時段未開放</div>}
    {!occupied && hasBuf && !isAdmin && <div style={{ padding: 8, background: "#FFF8E6", borderRadius: 7, fontSize: 11, color: "#B8860B", border: "1px solid #E8DCC0" }}>此時段需間隔緩衝</div>}
    {err && <div style={{ color: "#C2563A", fontSize: 11, background: "#FFF0EB", padding: "5px 9px", borderRadius: 5 }}>{err}</div>}
    <button onClick={submit} disabled={!canBook} style={{ padding: 11, borderRadius: 9, border: "none", cursor: canBook ? "pointer" : "not-allowed", background: canBook ? `linear-gradient(135deg, ${LU_COLOR}, #145A4A)` : "#CCBFB0", color: "white", fontSize: 14, fontWeight: 700, fontFamily: "'Noto Sans TC', sans-serif" }}>確認預約</button>
    <ConfirmModal open={!!confirmBuf} message="此預約違反 15 分鐘間隔規定，確定仍要預約嗎？" onOk={() => { setConfirmBuf(null); finalBook({ id: Date.now(), date: ds, time, duration: dur, patient: confirmBuf.patient, birthday: confirmBuf.birthday, idNum: confirmBuf.idNum || "", selfRef }); }} onCancel={() => setConfirmBuf(null)} />
  </div>);
}

/* ═══════════════════════════════════════════ Admin Detail (main) ═══════════════════════════════════════════ */
function AdminDetail({ appt, appts, onClose, onDelete, onUpdate, onAlert, onCopyDates, onAddExtra }) {
  const [editing, setEditing] = useState(false); const [showCopy, setShowCopy] = useState(false); const [copySelected, setCopySelected] = useState([]);
  const [th, setTh] = useState(appt.therapist); const [onDuty, setOnDuty] = useState(appt.onDuty); const [dur, setDur] = useState(appt.duration); const [selfRef, setSelfRef] = useState(appt.selfRef ?? false);
  const [treatType, setTreatType] = useState(appt.treatType || "manual");
  const [note, setNote] = useState(appt.note || "");
  const [reconfirm, setReconfirm] = useState(appt.reconfirm ?? false);
  const [confirmSave, setConfirmSave] = useState(null);
  const t = TH_MAP[appt.therapist] || TH_MAP["X"];
  const sel = { padding: "6px 9px", borderRadius: 7, border: "1.5px solid #D4C5A9", fontSize: 12, background: "#FFFDF5", fontFamily: "'Noto Sans TC', sans-serif", outline: "none", cursor: "pointer", width: "100%" };
  const futureDates = useMemo(() => { const d = new Date(appt.date), dow = d.getDay(), y = d.getFullYear(), mo = d.getMonth(); const dim = new Date(y, mo + 1, 0).getDate(), dates = []; for (let day = d.getDate() + 1; day <= dim; day++) { const c = new Date(y, mo, day); if (c.getDay() === dow) dates.push(fd(c)); } return dates; }, [appt.date]);

  const effectiveDur = treatType !== "manual" ? 15 : dur;
  const allThOpts = [...THERAPISTS.map(t2 => ({ v: t2.id, l: t2.name })), { v: "X", l: "不指定" }];
  const durOpts = treatType === "manual" ? DURATIONS.map(d => ({ v: String(d), l: `${d} 分鐘` })) : [{ v: "15", l: "15 分鐘" }];

  const doSave = () => { onUpdate(appt.id, { therapist: th, onDuty, duration: effectiveDur, selfRef, treatType, note, reconfirm }); setEditing(false); };

  const save = () => {
    if (!validRange(appt.time, effectiveDur)) { onAlert("修改後的時長超出營業時間"); return; }
    if (th === "X") { doSave(); return; }
    const warnings = [];
    if (onDuty && onDutySlotConflict(appts, appt.date, appt.time, effectiveDur, appt.id)) warnings.push("此時段已有其他班內治療師");
    if (bufferConflict(appts, appt.date, appt.time, effectiveDur, th, appt.id)) warnings.push("違反同治療師 15 分鐘緩衝規定");
    if (warnings.length > 0) { setConfirmSave(warnings.join("，且") + "，確定仍要儲存嗎？"); return; }
    doSave();
  };
  return (<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div style={{ background: `${t.color}12`, border: `1.5px solid ${t.color}40`, borderRadius: 9, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ width: 28, height: 28, borderRadius: "50%", background: t.color, color: "white", fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>{t.id === "X" ? "?" : t.id}</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, color: "#3D2B1F", fontSize: 15 }}>{appt.patient}</span>
            <input value={note} onChange={e => { setNote(e.target.value); }} onBlur={() => onUpdate(appt.id, { note })} placeholder="附註" style={{ padding: "3px 8px", borderRadius: 5, border: "1.5px solid #D4C5A9", fontSize: 12, background: "#FFFDF5", fontFamily: "'Noto Sans TC', sans-serif", outline: "none", width: 100 }} />
            <label style={{ display: "flex", alignItems: "center", gap: 3, cursor: "pointer", fontSize: 12, color: reconfirm ? "#2E7D6F" : "#8B7355", fontWeight: 600 }}>
              <input type="checkbox" checked={reconfirm} onChange={e => { setReconfirm(e.target.checked); onUpdate(appt.id, { reconfirm: e.target.checked }); }} style={{ accentColor: "#2E7D6F" }} />再確認
            </label>
          </div>
          <div style={{ fontSize: 12, color: "#8B7355" }}>生日：{appt.birthday}</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 13 }}><div><span style={{ color: "#8B7355" }}>日期：</span>{appt.date}</div><div><span style={{ color: "#8B7355" }}>時間：</span>{appt.time}</div></div>
    </div>
    {!editing && !showCopy && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 13, padding: "0 2px" }}>
      <div><span style={{ color: "#8B7355" }}>治療師：</span><strong>{TH_MAP[th]?.name || "不指定"}</strong></div>
      <div><span style={{ color: "#8B7355" }}>項目：</span><strong>{TREAT_MAP[treatType] || "徒手治療"}</strong></div>
      <div><span style={{ color: "#8B7355" }}>時長：</span><strong>{effectiveDur} 分</strong></div>
      <div><span style={{ color: "#8B7355" }}>班別：</span><strong style={{ color: onDuty ? "#2E7D6F" : "#C2563A" }}>{onDuty ? "班內" : "班外"}</strong></div>
      <div><span style={{ color: "#8B7355" }}>轉介：</span><strong style={{ color: selfRef ? "#5B6ABF" : "#B8860B" }}>{selfRef ? "自轉" : "非自轉"}</strong></div>
    </div>}
    {editing && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "0 2px" }}>{[
      { l: "治療師", v: th, set: setTh, opts: allThOpts },
      { l: "治療項目", v: treatType, set: v => { setTreatType(v); if (v !== "manual") setDur(15); }, opts: TREAT_TYPES.map(t2 => ({ v: t2.id, l: t2.label })) },
      { l: "時長", v: String(effectiveDur), set: v => setDur(Number(v)), opts: durOpts },
      { l: "班內／班外", v: onDuty ? "on" : "off", set: v => setOnDuty(v === "on"), opts: [{ v: "on", l: "班內" }, { v: "off", l: "班外" }] },
      { l: "自轉／非自轉", v: selfRef ? "self" : "other", set: v => setSelfRef(v === "self"), opts: [{ v: "self", l: "自轉" }, { v: "other", l: "非自轉" }] },
    ].map(f => (<div key={f.l}><label style={{ fontSize: 11, fontWeight: 600, color: "#5A4A3A", display: "block", marginBottom: 3 }}>{f.l}</label><select value={f.v} onChange={e => f.set(e.target.value)} style={sel}>{f.opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select></div>))}</div>}
    {showCopy && <div style={{ background: "#F5EDDC", borderRadius: 8, padding: 14 }}><div style={{ fontSize: 13, fontWeight: 600, color: "#3D2B1F", marginBottom: 10 }}>複製到本月其他{WDAY[(new Date(appt.date).getDay() + 6) % 7]}：</div>{futureDates.length === 0 ? <div style={{ fontSize: 13, color: "#8B7355" }}>本月已無後續相同星期</div> : <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>{futureDates.map(ds2 => { const sel2 = copySelected.includes(ds2); const conflict = appt.onDuty ? onDutySlotConflict(appts, ds2, appt.time, appt.duration, null) : false; const d = new Date(ds2); return (<button key={ds2} disabled={conflict} onClick={() => !conflict && setCopySelected(p => p.includes(ds2) ? p.filter(x => x !== ds2) : [...p, ds2])} style={{ padding: "8px 14px", borderRadius: 8, cursor: conflict ? "not-allowed" : "pointer", border: sel2 ? "2px solid #5B6ABF" : "1.5px solid #D4C5A9", background: conflict ? "#EDE5D5" : sel2 ? "#EEEEFF" : "#FFFDF5", color: conflict ? "#B5A898" : sel2 ? "#5B6ABF" : "#3D2B1F", fontWeight: sel2 ? 700 : 500, fontSize: 14, opacity: conflict ? 0.5 : 1, fontFamily: "'Noto Sans TC', sans-serif" }}>{`${d.getMonth() + 1}/${d.getDate()}`}{conflict && <span style={{ display: "block", fontSize: 9, color: "#B5A898" }}>衝突</span>}</button>); })}</div>}<div style={{ display: "flex", gap: 6 }}><button onClick={() => { if (copySelected.length) { onCopyDates(appt, copySelected); setShowCopy(false); setCopySelected([]); } }} disabled={!copySelected.length} style={{ flex: 1, padding: 9, borderRadius: 7, border: "none", background: copySelected.length ? "linear-gradient(135deg, #5B6ABF, #4A59A8)" : "#CCBFB0", color: "white", cursor: copySelected.length ? "pointer" : "not-allowed", fontWeight: 600, fontSize: 13, fontFamily: "'Noto Sans TC', sans-serif" }}>確認 ({copySelected.length})</button><button onClick={() => { setShowCopy(false); setCopySelected([]); }} style={{ padding: "9px 14px", borderRadius: 7, border: "1.5px solid #D4C5A9", background: "#FFFDF5", color: "#5A4A3A", cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "'Noto Sans TC', sans-serif" }}>取消</button></div></div>}
    {!editing && !showCopy && <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
      <button onClick={() => onUpdate(appt.id, { checkedIn: !appt.checkedIn })} style={{ flex: 1, padding: 9, borderRadius: 7, border: appt.checkedIn ? "1.5px solid #2E7D6F" : "1.5px solid #D4C5A9", background: appt.checkedIn ? "#E6F5EE" : "#FFFDF5", color: appt.checkedIn ? "#2E7D6F" : "#5A4A3A", cursor: "pointer", fontWeight: 600, fontSize: 14, fontFamily: "'Noto Sans TC', sans-serif" }}>{appt.checkedIn ? "✅ 報到成功" : "📋 報到"}</button>
      <button onClick={() => setEditing(true)} style={{ flex: 1, padding: 9, borderRadius: 7, border: "1.5px solid #D4C5A9", background: "#FFFDF5", color: "#5A4A3A", cursor: "pointer", fontWeight: 600, fontSize: 14, fontFamily: "'Noto Sans TC', sans-serif" }}>✏️ 編輯</button>
      <button onClick={() => setShowCopy(true)} style={{ flex: 1, padding: 9, borderRadius: 7, border: "1.5px solid #5B6ABF", background: "#EEEEFF", color: "#5B6ABF", cursor: "pointer", fontWeight: 600, fontSize: 14, fontFamily: "'Noto Sans TC', sans-serif" }}>📋 複製</button>
      <button onClick={() => { onAddExtra(appt); onClose(); }} style={{ flex: 1, padding: 9, borderRadius: 7, border: "1.5px solid #B8860B", background: "#FFF8E6", color: "#B8860B", cursor: "pointer", fontWeight: 600, fontSize: 14, fontFamily: "'Noto Sans TC', sans-serif" }}>外加</button>
      <button onClick={() => { onDelete(appt.id); onClose(); }} style={{ flex: 1, padding: 9, borderRadius: 7, border: "1.5px solid #E8C8C0", background: "#FFF5F2", color: "#C2563A", cursor: "pointer", fontWeight: 600, fontSize: 14, fontFamily: "'Noto Sans TC', sans-serif" }}>🗑 刪除</button>
    </div>}
    {editing && <div style={{ display: "flex", gap: 6 }}><button onClick={save} style={{ flex: 1, padding: 9, borderRadius: 7, border: "none", background: "linear-gradient(135deg, #2E7D6F, #1F5C50)", color: "white", cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "'Noto Sans TC', sans-serif" }}>✓ 儲存</button><button onClick={() => setEditing(false)} style={{ flex: 1, padding: 9, borderRadius: 7, border: "1.5px solid #D4C5A9", background: "#FFFDF5", color: "#5A4A3A", cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "'Noto Sans TC', sans-serif" }}>取消</button></div>}
    <ConfirmModal open={!!confirmSave} message={confirmSave || ""} onOk={() => { setConfirmSave(null); doSave(); }} onCancel={() => setConfirmSave(null)} />
  </div>);
}

/* ═══════════════════════════════════════════ Front Week Grids ═══════════════════════════════════════════ */
function FrontWeekGrid({ appts, selDate, onCellClick, mainSlotCfg, filterTh, cs }) {
  const wd = useMemo(() => weekDates(selDate), [selDate]);
  const today = useMemo(() => fd(new Date()), []);
  const dsArr = useMemo(() => wd.map(d => fd(d)), [wd]);
  const dayData = useMemo(() => wd.map((date, di) => { const ds = dsArr[di]; const isPast = ds <= today; return SLOTS.map(time => {
    if (isPast) return { time, blocked: true, dimmed: false };
    const occ = appts.some(a => a.date === ds && a.onDuty && toM(time) >= toM(a.time) && toM(time) < toM(a.time) + a.duration);
    const closed = mainSlotCfg[`${ds}-${time}`] === false;
    const blocked = occ || closed;
    let dimmed = false;
    if (filterTh && !blocked) {
      const st = getPeriodStateAt(filterTh, date, time, cs);
      if (st !== "on") dimmed = true;
      else if (bufferConflict(appts, ds, time, 15, filterTh, null)) dimmed = true;
      else if (onDutySlotConflict(appts, ds, time, 15, null)) dimmed = true;
    }
    return { time, blocked, dimmed };
  }); }), [wd, dsArr, appts, mainSlotCfg, filterTh, cs, today]);
  const renderMap = useMemo(() => { const map = {}; for (let di = 0; di < 6; di++) { const col = dayData[di]; let i = 0; while (i < col.length) { if (col[i].blocked) { let j = i; while (j < col.length && col[j].blocked) j++; map[`${i}-${di}`] = { render: true, span: j - i, type: "blocked" }; for (let k = i + 1; k < j; k++) map[`${k}-${di}`] = { render: false }; i = j; } else { map[`${i}-${di}`] = { render: true, span: 1, type: "free", time: col[i].time, dimmed: col[i].dimmed }; i++; } } } return map; }, [dayData]);
  return (<div style={{ overflowX: "auto", borderRadius: 9, border: "1px solid #E0D5C1" }}><table style={{ borderCollapse: "collapse", width: "100%", minWidth: 520, fontSize: 13, fontFamily: "'Noto Sans TC', sans-serif" }}>
    <thead><tr><th style={{ padding: "8px 4px", background: "#3D2B1F", color: "#F5EDDC", position: "sticky", left: 0, zIndex: 10, minWidth: 48, width: 48, borderRight: "2px solid #5A4A3A", fontSize: 13 }}>時間</th>
      {wd.map((date, di) => { const isT = dsArr[di] === today; return (<th key={di} style={{ padding: "6px 3px", background: isT ? "#5A3A2A" : "#3D2B1F", color: "#F5EDDC", borderLeft: "1px solid #5A4A3A", fontSize: 12, minWidth: 58, width: "16%" }}><div>{`${date.getMonth() + 1}/${date.getDate()}`}</div><div style={{ fontSize: 12, color: isT ? "#F0A080" : "#C4B49A", marginTop: 1 }}>{WDAY[di]}{isT && " 今"}</div></th>); })}</tr></thead>
    <tbody>{SLOTS.map((time, si) => { const isH = time.endsWith(":00"); const isBr = time === "14:00"; return (<tr key={time} style={{ ...(isBr ? { borderTop: "3px solid #C2563A" } : {}) }}><td style={{ padding: "2px 3px", textAlign: "center", background: isH ? "#F0E8D8" : "#F8F2E6", position: "sticky", left: 0, zIndex: 5, borderRight: "2px solid #D4C5A9", borderTop: isH ? "1px solid #D4C5A9" : "1px solid #EDE5D5", fontWeight: isH ? 700 : 400, color: isH ? "#3D2B1F" : "#8B7355", fontSize: isH ? 13 : 12, height: 28 }}>{time}</td>
      {wd.map((date, di) => { const cell = renderMap[`${si}-${di}`]; if (!cell || !cell.render) return null; if (cell.type === "blocked") return (<td key={di} rowSpan={cell.span} style={{ background: "#2A2A2A", color: "rgba(255,255,255,0.75)", textAlign: "center", verticalAlign: "middle", fontSize: 12, borderLeft: "1px solid #2A2A2A", borderTop: "none", padding: "4px 2px" }}>{cell.span >= 2 ? <span>未開放<br />或已占用</span> : <span>已占用</span>}</td>);
        const dim = cell.dimmed;
        return (<td key={di} style={{ borderLeft: "1px solid #EDE5D5", borderTop: isH ? "1px solid #D4C5A9" : "1px solid #EDE5D5", padding: 0, height: 28, cursor: dim ? "default" : "pointer", background: dim ? "#E8E3D8" : "#FFFDF5", opacity: dim ? 0.65 : 1 }} onClick={() => !dim && onCellClick(date, cell.time)} onMouseEnter={e => { if (!dim) e.currentTarget.style.background = "#F0E0C8"; }} onMouseLeave={e => { if (!dim) e.currentTarget.style.background = "#FFFDF5"; }} />); })}</tr>); })}</tbody>
  </table></div>);
}

function LuFrontWeekGrid({ appts, selDate, onCellClick, luSlotCfg }) {
  const wd = useMemo(() => luWeekDates(selDate), [selDate]);
  const dsArr = useMemo(() => wd.map(d => fd(d)), [wd]);
  const LU_WDAY = ["週一", "週二", "週四"];
  const dayData = useMemo(() => wd.map((date, di) => { const ds = dsArr[di]; const open = isLuDateOpen(ds); return LU_SLOTS.map(time => {
    if (!open) return { time, blocked: true };
    const m = toM(time); const occ = appts.some(a => a.date === ds && m >= toM(a.time) && m < toM(a.time) + a.duration);
    const closed = isLuSlotClosed(ds, time, luSlotCfg);
    return { time, blocked: occ || closed };
  }); }), [wd, dsArr, appts, luSlotCfg]);
  const renderMap = useMemo(() => { const map = {}; for (let di = 0; di < 3; di++) { const col = dayData[di]; let i = 0; while (i < col.length) { if (col[i].blocked) { let j = i; while (j < col.length && col[j].blocked) j++; map[`${i}-${di}`] = { render: true, span: j - i, type: "blocked" }; for (let k = i + 1; k < j; k++) map[`${k}-${di}`] = { render: false }; i = j; } else { map[`${i}-${di}`] = { render: true, span: 1, type: "free", time: col[i].time }; i++; } } } return map; }, [dayData]);
  const todayStr = useMemo(() => fd(new Date()), []);
  return (<div style={{ overflowX: "auto", borderRadius: 9, border: `1px solid ${LU_COLOR}40` }}><table style={{ borderCollapse: "collapse", width: "100%", minWidth: 320, fontSize: 13, fontFamily: "'Noto Sans TC', sans-serif" }}>
    <thead><tr><th style={{ padding: "8px 4px", background: LU_COLOR, color: "white", position: "sticky", left: 0, zIndex: 10, minWidth: 48, width: 48, borderRight: `2px solid ${LU_COLOR}`, fontSize: 13 }}>時間</th>
      {wd.map((date, di) => { const ds = dsArr[di]; const isT = ds === todayStr; return (<th key={di} style={{ padding: "6px 3px", background: isT ? "#1D8068" : LU_COLOR, color: "white", borderLeft: `1px solid ${LU_COLOR}88`, fontSize: 12, minWidth: 80, width: "33%" }}><div>{`${date.getMonth() + 1}/${date.getDate()}`}</div><div style={{ fontSize: 12, color: isT ? "#A0E8D0" : "#88CCB8", marginTop: 1 }}>{LU_WDAY[di]}{isT && " 今"}</div></th>); })}</tr></thead>
    <tbody>{LU_SLOTS.map((time, si) => { const isH = time.endsWith(":00"); return (<tr key={time}><td style={{ padding: "2px 3px", textAlign: "center", background: isH ? "#E8F5F0" : "#F2FAF7", position: "sticky", left: 0, zIndex: 5, borderRight: `2px solid ${LU_COLOR}40`, borderTop: isH ? `1px solid ${LU_COLOR}30` : "1px solid #E0EDE8", fontWeight: isH ? 700 : 400, color: isH ? LU_COLOR : "#6BA898", fontSize: isH ? 13 : 12, height: 28 }}>{time}</td>
      {wd.map((date, di) => { const cell = renderMap[`${si}-${di}`]; if (!cell || !cell.render) return null; if (cell.type === "blocked") return (<td key={di} rowSpan={cell.span} style={{ background: "#2A2A2A", color: "rgba(255,255,255,0.75)", textAlign: "center", verticalAlign: "middle", fontSize: 12, borderLeft: "1px solid #2A2A2A", borderTop: "none", padding: "4px 2px" }}>{cell.span >= 2 ? <span>未開放<br />或已占用</span> : <span>已占用</span>}</td>); return (<td key={di} style={{ borderLeft: "1px solid #E0EDE8", borderTop: isH ? `1px solid ${LU_COLOR}30` : "1px solid #E0EDE8", padding: 0, height: 28, cursor: "pointer", background: "#F8FDFB" }} onClick={() => onCellClick(date, cell.time)} onMouseEnter={e => e.currentTarget.style.background = "#DDF0E8"} onMouseLeave={e => e.currentTarget.style.background = "#F8FDFB"} />); })}</tr>); })}</tbody>
  </table></div>);
}

/* ═══════════════════════════════════════════ Front Phone Lookup ═══════════════════════════════════════════ */
function PhoneLookup({ appts, luAppts, onDelete, onLuDelete }) {
  const [idNum, setIdNum] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const q = idNum.trim().toUpperCase();
  const results = useMemo(() => {
    if (q.length < 2) return [];
    const today = fd(new Date());
    const mainR = appts.filter(a => a.onDuty && a.idNum && a.idNum.toUpperCase() === q && a.date >= today).map(a => ({ ...a, sys: "main" }));
    const luR = luAppts.filter(a => a.idNum && a.idNum.toUpperCase() === q && a.date >= today).map(a => ({ ...a, sys: "lu" }));
    return [...mainR, ...luR].sort(sortByDateTime);
  }, [q, appts, luAppts]);
  const handleDelete = () => {
    if (!deleteTarget) return;
    if (deleteTarget.sys === "lu") onLuDelete(deleteTarget.id);
    else onDelete(deleteTarget.id);
    setDeleteTarget(null);
  };
  return (<div style={{ maxWidth: 500, margin: "0 auto" }}>
    <div style={{ textAlign: "center", marginBottom: 20 }}><div style={{ fontSize: 42, marginBottom: 8 }}>🔍</div><h2 style={{ margin: 0, fontFamily: "'Noto Serif TC', serif", color: "#3D2B1F", fontSize: 21 }}>預約查詢及取消</h2><p style={{ color: "#8B7355", fontSize: 15, margin: "6px 0 0 0" }}>輸入身分證字號查詢今日起的預約</p></div>
    <input value={idNum} onChange={e => setIdNum(e.target.value.toUpperCase())} placeholder="輸入身分證字號" style={{ width: "100%", padding: "14px 18px", borderRadius: 10, border: "1.5px solid #D4C5A9", fontSize: 19, background: "#FFFDF5", fontFamily: "'Noto Sans TC', sans-serif", boxSizing: "border-box", outline: "none", textAlign: "center", letterSpacing: 2 }} maxLength={10} />
    {q.length > 0 && q.length < 2 && <p style={{ textAlign: "center", fontSize: 14, color: "#B5A898", margin: "8px 0 0 0" }}>請輸入身分證字號</p>}
    {q.length >= 2 && results.length === 0 && <div style={{ textAlign: "center", padding: "30px 0", color: "#8B7355" }}><div style={{ fontSize: 38, marginBottom: 8 }}>📭</div><p style={{ margin: 0, fontSize: 16 }}>查無今日以後的預約紀錄</p></div>}
    {results.length > 0 && <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}><p style={{ fontSize: 15, color: "#8B7355", margin: 0 }}>找到 {results.length} 筆</p>
      {results.map(a => { const isLu = a.sys === "lu"; const thObj = isLu ? null : (TH_MAP[a.therapist] || TH_MAP["X"]); const color = isLu ? LU_COLOR : thObj.color; return (<div key={a.id} style={{ background: "#FFFDF5", border: `1.5px solid ${color}40`, borderRadius: 10, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}><div style={{ width: 28, height: 28, borderRadius: "50%", background: color, color: "white", fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>{isLu ? "盧" : (a.therapist === "X" ? "?" : a.therapist)}</div><span style={{ fontWeight: 700, color: "#3D2B1F", fontSize: 17 }}>{isLu ? "盧獨立時段" : thObj.name}</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 15 }}><div><span style={{ color: "#8B7355" }}>日期：</span><strong>{a.date}</strong></div><div><span style={{ color: "#8B7355" }}>時間：</span><strong>{a.time}</strong></div><div><span style={{ color: "#8B7355" }}>時長：</span>{a.duration} 分鐘</div><div><span style={{ color: "#8B7355" }}>患者：</span>{maskN(a.patient)}</div></div>
        <button onClick={() => setDeleteTarget(a)} style={{ marginTop: 10, width: "100%", padding: "8px 0", borderRadius: 7, border: "1.5px solid #E8C8C0", background: "#FFF5F2", color: "#C2563A", cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "'Noto Sans TC', sans-serif" }}>🗑 取消此預約</button>
      </div>); })}</div>}
    {deleteTarget && (<div style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={() => setDeleteTarget(null)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.3)" }} />
      <div style={{ position: "relative", background: "#FFFDF5", borderRadius: 12, padding: "28px 32px", maxWidth: 380, width: "88%", boxShadow: "0 16px 60px rgba(0,0,0,0.2)", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
        <p style={{ fontSize: 14, fontWeight: 600, color: "#3D2B1F", margin: "0 0 6px 0", lineHeight: 1.5 }}>確定要取消以下預約嗎？</p>
        <p style={{ fontSize: 13, color: "#C2563A", margin: "0 0 18px 0" }}>{deleteTarget.date} {deleteTarget.time}｜{maskN(deleteTarget.patient)}</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button onClick={handleDelete} style={{ padding: "9px 24px", borderRadius: 8, border: "none", background: "#C2563A", color: "white", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Noto Sans TC', sans-serif" }}>確認取消</button>
          <button onClick={() => setDeleteTarget(null)} style={{ padding: "9px 24px", borderRadius: 8, border: "1.5px solid #D4C5A9", background: "#FFFDF5", color: "#5A4A3A", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Noto Sans TC', sans-serif" }}>返回</button>
        </div>
      </div>
    </div>)}
  </div>);
}

/* ═══════════════════════════════════════════ Admin Grids (main) ═══════════════════════════════════════════ */
function AdminWeekGrid({ appts, selDate, onCellClick, onApptClick, filterTh, cs }) {
  const wd = useMemo(() => weekDates(selDate), [selDate]);
  const dsArr = useMemo(() => wd.map(d => fd(d)), [wd]);
  const todayStr = useMemo(() => fd(new Date()), []);
  const getStart = useCallback((ds, t) => appts.find(a => a.date === ds && a.time === t), [appts]); const getAt = useCallback((ds, t) => { const m = toM(t); return appts.find(a => a.date === ds && m >= toM(a.time) && m < toM(a.time) + a.duration); }, [appts]);
  return (<div style={{ overflowX: "auto", borderRadius: 9, border: "1px solid #E0D5C1" }}><table style={{ borderCollapse: "collapse", width: "100%", minWidth: 520, fontSize: 15, fontFamily: "'Noto Sans TC', sans-serif" }}>
    <thead><tr><th style={{ padding: "7px 4px", background: "#3D2B1F", color: "#F5EDDC", position: "sticky", left: 0, zIndex: 10, minWidth: 48, width: 48, borderRight: "2px solid #5A4A3A", fontSize: 15 }}>時間</th>{wd.map((date, di) => { const isT = dsArr[di] === todayStr; return (<th key={di} style={{ padding: "5px 3px", background: isT ? "#5A3A2A" : "#3D2B1F", color: "#F5EDDC", borderLeft: "1px solid #5A4A3A", fontSize: 14, minWidth: 58, width: "15%" }}><div>{`${date.getMonth() + 1}/${date.getDate()}`}</div><div style={{ fontSize: 14, color: isT ? "#F0A080" : "#C4B49A", marginTop: 1 }}>{WDAY[di]}{isT && " 今"}</div></th>); })}</tr></thead>
    <tbody>{SLOTS.map((time) => { const isH = time.endsWith(":00"); const isBr = time === "14:00"; return (<tr key={time} style={{ ...(isBr ? { borderTop: "3px solid #C2563A" } : {}) }}><td style={{ padding: "1px 3px", textAlign: "center", background: isH ? "#F0E8D8" : "#F8F2E6", position: "sticky", left: 0, zIndex: 5, borderRight: "2px solid #D4C5A9", borderTop: isH ? "1px solid #D4C5A9" : "1px solid #EDE5D5", fontWeight: isH ? 700 : 400, color: isH ? "#3D2B1F" : "#8B7355", fontSize: isH ? 12 : 11, height: 26 }}>{time}</td>
      {wd.map((date, di) => { const ds = dsArr[di]; const as = getStart(ds, time); const aa = getAt(ds, time); const occ = !!aa; const th = aa ? (TH_MAP[aa.therapist] || TH_MAP["X"]) : null;
        const fState = filterTh && !occ ? getPeriodStateAt(filterTh, date, time, cs) : null;
        const dim = filterTh && !occ && fState !== "on" && fState !== "off";
        return (<td key={di} onClick={() => occ ? onApptClick(aa) : !dim && onCellClick(date, time)} style={{ borderLeft: "1px solid #EDE5D5", borderTop: isH ? "1px solid #D4C5A9" : "1px solid #EDE5D5", padding: 0, height: 26, cursor: dim ? "default" : "pointer", position: "relative", background: dim ? "#E8E3D8" : occ ? `${th.color}18` : "#FFFDF5", opacity: dim ? 0.5 : 1 }} onMouseEnter={e => { if (!occ && !dim) e.currentTarget.style.background = "#F0E0C8"; }} onMouseLeave={e => { if (!occ && !dim) e.currentTarget.style.background = "#FFFDF5"; }}>{as && (()=>{ const asth = TH_MAP[as.therapist] || TH_MAP["X"]; return (<div style={{ position: "absolute", top: 1, left: 1, right: 1, height: (as.duration / 15) * 26 - 2, background: `linear-gradient(135deg, ${asth.color}EE, ${asth.color}AA)`, borderRadius: 3, zIndex: 2, padding: "2px 4px", color: "white", fontSize: 10, fontWeight: 600, overflow: "hidden", display: "flex", flexDirection: "column", border: as.checkedIn ? "2px solid #FFD700" : as.onDuty ? "none" : "1.5px dashed rgba(255,255,255,0.6)" }}><div style={{ display: "flex", justifyContent: "space-between" }}><span>{as.patient.slice(0, 3)}</span><span style={{ opacity: 0.8, fontSize: 9 }}>{asth.id === "X" ? "?" : asth.id}</span></div>{as.duration >= 30 && <span style={{ fontSize: 9, opacity: 0.75 }}>{as.duration}m·{as.onDuty ? "內" : "外"}</span>}</div>);})()}</td>); })}</tr>); })}</tbody>
  </table></div>);
}

function AdminDayView({ appts, selDate, onApptClick, onCellClick, mainSlotCfg, setMainSlotCfg }) {
  const ds = fd(selDate); const dayA = useMemo(() => appts.filter(a => a.date === ds), [appts, ds]);
  const getStarts = useCallback(time => dayA.filter(a => a.time === time), [dayA]);
  const getAllAt = useCallback(time => { const m = toM(time); return dayA.filter(a => m >= toM(a.time) && m < toM(a.time) + a.duration); }, [dayA]);
  const stats = useMemo(() => ({ t: dayA.length, m: dayA.reduce((s, a) => s + a.duration, 0), on: dayA.filter(a => a.onDuty).length, off: dayA.filter(a => !a.onDuty).length, sr: dayA.filter(a => a.selfRef).length }), [dayA]);
  const toggleSlot = (time) => { const k = `${ds}-${time}`; setMainSlotCfg(prev => ({ ...prev, [k]: prev[k] === false ? undefined : false })); };
  const [showPrint, setShowPrint] = useState(false);
  const printContent = useMemo(() => {
    const dateLabel = `${selDate.getFullYear()}/${selDate.getMonth() + 1}/${selDate.getDate()} ${WDAY[(selDate.getDay() + 6) % 7]}`;
    const rows = []; SLOTS.forEach(time => { const starts = dayA.filter(a => a.time === time); starts.forEach(a => { const th = TH_MAP[a.therapist] || TH_MAP["X"]; const tid = th.id === "X" ? "?" : th.id; const ttLabel = a.treatType === "shockwave" ? "震波" : a.treatType === "laser" ? "雷射" : a.treatType === "taping" ? "貼紮" : "徒手"; rows.push({ time: a.time, tid, color: th.color, patient: a.patient, birthday: a.birthday, duration: a.duration, ttLabel, onDuty: a.onDuty, selfRef: a.selfRef }); }); });
    return { dateLabel, rows };
  }, [selDate, dayA]);
  return (<div>
    <div style={{ display: "flex", gap: 12, marginBottom: 10, padding: "8px 14px", background: "#FFFDF5", borderRadius: 7, border: "1px solid #E0D5C1", fontSize: 14, color: "#5A4A3A", flexWrap: "wrap", alignItems: "center" }}>
      <span>預約：<strong>{stats.t}</strong></span><span>時數：<strong>{stats.m}</strong>分</span><span style={{ color: "#2E7D6F" }}>班內：<strong>{stats.on}</strong></span><span style={{ color: "#C2563A" }}>班外：<strong>{stats.off}</strong></span><span style={{ color: "#5B6ABF" }}>自轉：<strong>{stats.sr}</strong></span>
      <button onClick={() => setShowPrint(true)} style={{ marginLeft: "auto", padding: "5px 14px", borderRadius: 6, border: "1.5px solid #3D2B1F", background: "#FFFDF5", color: "#3D2B1F", cursor: "pointer", fontWeight: 600, fontSize: 14, fontFamily: "'Noto Sans TC', sans-serif" }}>🖨️ 列印</button>
    </div>
    <div style={{ borderRadius: 9, border: "1px solid #E0D5C1", overflow: "hidden" }}><table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14, fontFamily: "'Noto Sans TC', sans-serif" }}><thead><tr><th style={{ padding: "9px 8px", background: "#3D2B1F", color: "#F5EDDC", width: 55, textAlign: "center", borderRight: "2px solid #5A4A3A" }}>時間</th><th style={{ padding: "9px 8px", background: "#3D2B1F", color: "#F5EDDC", textAlign: "left" }}>預約內容</th><th style={{ padding: "9px 8px", background: "#3D2B1F", color: "#F5EDDC", width: 50, textAlign: "center" }}>開關</th></tr></thead><tbody>
      {SLOTS.map(time => { const isH = time.endsWith(":00"); const isBr = time === "14:00"; const starts = getStarts(time); const all = getAllAt(time); const occ = all.length > 0;
        const closed = mainSlotCfg[`${ds}-${time}`] === false;
        return (<tr key={time} style={{ cursor: "pointer", ...(isBr ? { borderTop: "3px solid #C2563A" } : {}) }}><td onClick={() => !occ && !closed && onCellClick(selDate, time)} style={{ padding: "3px 8px", textAlign: "center", background: isH ? "#F0E8D8" : "#F8F2E6", borderRight: "2px solid #D4C5A9", borderTop: isH ? "1px solid #D4C5A9" : "1px solid #EDE5D5", fontWeight: isH ? 700 : 400, color: isH ? "#3D2B1F" : "#8B7355", height: 30 }}>{time}</td>
          <td style={{ padding: 0, minHeight: 30, borderTop: isH ? "1px solid #D4C5A9" : "1px solid #EDE5D5", background: closed ? "#F5F0E5" : occ ? "#FAFAF5" : "#FFFDF5" }} onMouseEnter={e => { if (!occ && !closed) e.currentTarget.style.background = "#F0E0C8"; }} onMouseLeave={e => { if (!occ && !closed) e.currentTarget.style.background = closed ? "#F5F0E5" : "#FFFDF5"; }}>
            {starts.map(as => { const th = TH_MAP[as.therapist] || TH_MAP["X"]; return (<div key={as.id} onClick={() => onApptClick(as)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", cursor: "pointer", borderLeft: as.checkedIn ? "3px solid #FFD700" : "3px solid transparent" }}><div style={{ width: 22, height: 22, borderRadius: "50%", background: th.color, flexShrink: 0, color: "white", fontWeight: 700, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>{th.id === "X" ? "?" : th.id}</div><span style={{ fontWeight: 700, color: "#3D2B1F", fontSize: 14 }}>{as.patient}</span>{as.note && <span style={{ color: "#8B7355", fontSize: 12, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>({as.note})</span>}{as.reconfirm && <span style={{ fontSize: 12, fontWeight: 700, color: "#2E7D6F" }}>✓再確認</span>}<span style={{ color: "#8B7355", fontSize: 12 }}>{as.birthday}</span><span style={{ color: "#8B7355", fontSize: 12 }}>{as.duration}分</span><span style={{ fontSize: 12, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: "#F5F0E5", color: "#5A4A3A" }}>{TREAT_MAP[as.treatType] || "徒手"}</span><span style={{ fontSize: 12, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: as.onDuty ? "#E6F5EE" : "#FFF0EB", color: as.onDuty ? "#2E7D6F" : "#C2563A" }}>{as.onDuty ? "班內" : "班外"}</span><span style={{ fontSize: 12, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: as.selfRef ? "#EEEEFF" : "#FFF8E6", color: as.selfRef ? "#5B6ABF" : "#B8860B" }}>{as.selfRef ? "自轉" : "非自轉"}</span>{as.checkedIn && <span style={{ fontSize: 12, fontWeight: 700, color: "#FFD700" }}>✓到</span>}</div>); })}
            {occ && starts.length === 0 && all.map(aa => { const th = TH_MAP[aa.therapist] || TH_MAP["X"]; return <div key={aa.id} onClick={() => onApptClick(aa)} style={{ padding: "2px 10px", display: "flex", alignItems: "center", cursor: "pointer" }}><div style={{ height: 1, width: 20, background: `${th.color}50` }} /><span style={{ fontSize: 9, color: `${th.color}88`, marginLeft: 6 }}>{aa.patient} 治療中</span></div>; })}
            {!occ && closed && <div style={{ padding: "0 10px", height: 30, display: "flex", alignItems: "center", fontSize: 13, color: "#B5A898" }}>已關閉</div>}
            {!occ && !closed && <div onClick={() => onCellClick(selDate, time)} style={{ padding: "0 10px", height: 30, display: "flex", alignItems: "center", fontSize: 13, color: "#C4B49A" }}>可預約</div>}
          </td>
          <td style={{ textAlign: "center", borderTop: isH ? "1px solid #D4C5A9" : "1px solid #EDE5D5" }}>
            <button onClick={() => toggleSlot(time)} style={{ padding: "2px 8px", borderRadius: 4, border: "none", cursor: "pointer", background: closed ? "#EDE5D5" : "#3D2B1FDD", color: closed ? "#B5A898" : "white", fontSize: 9, fontWeight: 600, fontFamily: "'Noto Sans TC', sans-serif" }}>{closed ? "關" : "開"}</button>
          </td>
        </tr>); })}</tbody></table></div>
    {showPrint && (
      <div style={{ position: "fixed", inset: 0, zIndex: 1200, background: "white", overflowY: "auto", padding: 24 }}>
        <style>{`@media print { body * { visibility: hidden !important; } .print-overlay, .print-overlay * { visibility: visible !important; } .print-overlay { position: fixed !important; left: 0; top: 0; right: 0; bottom: 0; overflow: visible !important; padding: 20px; } .no-print { display: none !important; } }`}</style>
        <div className="print-overlay">
        <div className="no-print" style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <button onClick={() => { window.print(); }} style={{ padding: "10px 28px", borderRadius: 8, border: "none", background: "#3D2B1F", color: "white", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "'Noto Sans TC', sans-serif" }}>🖨️ 列印此頁</button>
          <button onClick={() => setShowPrint(false)} style={{ padding: "10px 20px", borderRadius: 8, border: "1.5px solid #D4C5A9", background: "white", color: "#5A4A3A", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "'Noto Sans TC', sans-serif" }}>✕ 關閉</button>
        </div>
        <h1 style={{ fontSize: 18, margin: "0 0 4px", fontFamily: "'Noto Sans TC', sans-serif", color: "#333" }}>🤲 徒手治療預約 — 日報表</h1>
        <h2 style={{ fontSize: 13, color: "#888", margin: "0 0 14px", fontWeight: "normal" }}>{printContent.dateLabel}</h2>
        <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 12, color: "#555" }}>
          <span>預約：<strong style={{ color: "#222" }}>{stats.t}</strong></span>
          <span>時數：<strong style={{ color: "#222" }}>{stats.m}</strong>分</span>
          <span style={{ color: "#2E7D6F" }}>班內：<strong>{stats.on}</strong></span>
          <span style={{ color: "#C2563A" }}>班外：<strong>{stats.off}</strong></span>
        </div>
        <table style={{ borderCollapse: "collapse", width: "100%", fontFamily: "'Noto Sans TC', sans-serif", fontSize: 13 }}>
          <thead><tr>
            <th style={{ padding: "8px 10px", border: "1px solid #ccc", background: "#f5f0e5", width: 70, textAlign: "center" }}>時間</th>
            <th style={{ padding: "8px 10px", border: "1px solid #ccc", background: "#f5f0e5", textAlign: "left" }}>預約</th>
          </tr></thead>
          <tbody>
            {printContent.rows.map((r, i) => (
              <tr key={i}>
                <td style={{ padding: "6px 10px", border: "1px solid #ccc", textAlign: "center", fontWeight: 700 }}>{r.time}</td>
                <td style={{ padding: "6px 10px", border: "1px solid #ccc" }}>
                  <span style={{ display: "inline-block", width: 20, height: 20, borderRadius: "50%", background: r.color, color: "white", textAlign: "center", lineHeight: "20px", fontSize: 11, fontWeight: 700, marginRight: 8 }}>{r.tid}</span>
                  <strong>{r.patient}</strong>
                  <span style={{ color: "#888", marginLeft: 10 }}>{r.birthday}</span>
                  <span style={{ marginLeft: 10 }}>{r.duration}分</span>
                  <span style={{ marginLeft: 10, padding: "2px 6px", borderRadius: 3, fontSize: 11, background: "#f5f0e5" }}>{r.ttLabel}</span>
                  <span style={{ marginLeft: 6, padding: "2px 6px", borderRadius: 3, fontSize: 11, background: r.onDuty ? "#e6f5ee" : "#fff0eb", color: r.onDuty ? "#2E7D6F" : "#C2563A" }}>{r.onDuty ? "班內" : "班外"}</span>
                  <span style={{ marginLeft: 6, padding: "2px 6px", borderRadius: 3, fontSize: 11, background: r.selfRef ? "#eeeeff" : "#fff8e6", color: r.selfRef ? "#5B6ABF" : "#B8860B" }}>{r.selfRef ? "自轉" : "非自轉"}</span>
                </td>
              </tr>
            ))}
            {printContent.rows.length === 0 && <tr><td colSpan={2} style={{ padding: 20, textAlign: "center", color: "#aaa", border: "1px solid #ccc" }}>今日無預約</td></tr>}
          </tbody>
        </table>
      </div></div>
    )}
  </div>);
}

/* ═══════════════════════════════════════════ Admin 盧老師 Day View + Slot Control ═══════════════════════════════════════════ */
function LuAdminDayView({ appts, selDate, onCellClick, onApptClick, luSlotCfg, setLuSlotCfg }) {
  const ds = fd(selDate); const dayA = useMemo(() => appts.filter(a => a.date === ds), [appts, ds]);
  const getStart = useCallback(time => dayA.find(a => a.time === time), [dayA]);
  const getAt = useCallback(time => { const m = toM(time); return dayA.find(a => m >= toM(a.time) && m < toM(a.time) + a.duration); }, [dayA]);
  const toggleSlot = (time) => { const k = `${ds}-${time}`; setLuSlotCfg(prev => ({ ...prev, [k]: prev[k] === false ? undefined : false })); };
  const stats = useMemo(() => ({ t: dayA.length, m: dayA.reduce((s, a) => s + a.duration, 0) }), [dayA]);

  return (<div>
    <div style={{ display: "flex", gap: 12, marginBottom: 10, padding: "8px 14px", background: "#F8FDFB", borderRadius: 7, border: `1px solid ${LU_COLOR}30`, fontSize: 14, color: "#5A4A3A", flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontWeight: 700, color: LU_COLOR }}>盧獨立時段</span><span>預約：<strong>{stats.t}</strong></span><span>時數：<strong>{stats.m}</strong>分</span>
      <span style={{ marginLeft: "auto", fontSize: 10, color: "#8B7355" }}>點「開/關」切換時段開放</span>
    </div>
    <div style={{ borderRadius: 9, border: `1px solid ${LU_COLOR}30`, overflow: "hidden" }}><table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11, fontFamily: "'Noto Sans TC', sans-serif" }}><thead><tr><th style={{ padding: "9px 8px", background: LU_COLOR, color: "white", width: 55, textAlign: "center", borderRight: `2px solid ${LU_COLOR}` }}>時間</th><th style={{ padding: "9px 8px", background: LU_COLOR, color: "white", textAlign: "left" }}>預約 / 時段控制</th><th style={{ padding: "9px 8px", background: LU_COLOR, color: "white", width: 50, textAlign: "center" }}>開關</th></tr></thead><tbody>
      {LU_SLOTS.map(time => { const isH = time.endsWith(":00"); const as = getStart(time); const aa = getAt(time); const occ = !!aa; const closed = isLuSlotClosed(ds, time, luSlotCfg);
        return (<tr key={time} style={{ cursor: "pointer" }}><td style={{ padding: "3px 8px", textAlign: "center", background: isH ? "#E8F5F0" : "#F2FAF7", borderRight: `2px solid ${LU_COLOR}30`, borderTop: isH ? `1px solid ${LU_COLOR}30` : "1px solid #E0EDE8", fontWeight: isH ? 700 : 400, color: isH ? LU_COLOR : "#6BA898", height: 30 }}>{time}</td>
          <td onClick={() => occ ? onApptClick(aa) : !closed && onCellClick(selDate, time)} style={{ padding: 0, height: 30, borderTop: isH ? `1px solid ${LU_COLOR}30` : "1px solid #E0EDE8", background: closed ? "#F5F0E5" : occ ? `${LU_COLOR}10` : "#F8FDFB" }}
            onMouseEnter={e => { if (!occ && !closed) e.currentTarget.style.background = "#DDF0E8"; }} onMouseLeave={e => { if (!occ && !closed) e.currentTarget.style.background = "#F8FDFB"; }}>
            {as && <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 10px", height: "100%", borderLeft: as.checkedIn ? "3px solid #FFD700" : "3px solid transparent" }}><div style={{ width: 20, height: 20, borderRadius: "50%", background: LU_COLOR, flexShrink: 0, color: "white", fontWeight: 700, fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>盧</div><span style={{ fontWeight: 700, color: "#3D2B1F" }}>{as.patient}</span><span style={{ color: "#8B7355", fontSize: 10 }}>{as.birthday}</span><span style={{ color: "#8B7355", fontSize: 10 }}>{as.duration}分</span>{as.checkedIn && <span style={{ fontSize: 9, fontWeight: 700, color: "#FFD700" }}>✓到</span>}</div>}
            {occ && !as && <div style={{ padding: "0 10px", height: "100%", display: "flex", alignItems: "center" }}><span style={{ fontSize: 9, color: `${LU_COLOR}88` }}>{aa.patient} 治療中</span></div>}
            {!occ && closed && <div style={{ padding: "0 10px", height: "100%", display: "flex", alignItems: "center", fontSize: 13, color: "#B5A898" }}>已關閉</div>}
            {!occ && !closed && <div style={{ padding: "0 10px", height: "100%", display: "flex", alignItems: "center", fontSize: 13, color: "#88CCB8" }}>可預約</div>}
          </td>
          <td style={{ textAlign: "center", borderTop: isH ? `1px solid ${LU_COLOR}30` : "1px solid #E0EDE8" }}>
            <button onClick={() => toggleSlot(time)} style={{ padding: "2px 8px", borderRadius: 4, border: "none", cursor: "pointer", background: closed ? "#EDE5D5" : `${LU_COLOR}DD`, color: closed ? "#B5A898" : "white", fontSize: 9, fontWeight: 600, fontFamily: "'Noto Sans TC', sans-serif" }}>{closed ? "關" : "開"}</button>
          </td></tr>); })}</tbody></table></div></div>);
}

/* ═══════════════════════════════════════════ Shift Editor ═══════════════════════════════════════════ */
/* ═══════════════════════════════════════════ Admin 盧老師 Week Grid ═══════════════════════════════════════════ */
function LuAdminWeekGrid({ appts, selDate, onCellClick, onApptClick, luSlotCfg }) {
  const wd = useMemo(() => luWeekDates(selDate), [selDate]);
  const dsArr = useMemo(() => wd.map(d => fd(d)), [wd]);
  const todayStr = useMemo(() => fd(new Date()), []);
  const LU_WDAY = ["週一", "週二", "週四"];
  const getStart = useCallback((ds, t) => appts.find(a => a.date === ds && a.time === t), [appts]);
  const getAt = useCallback((ds, t) => { const m = toM(t); return appts.find(a => a.date === ds && m >= toM(a.time) && m < toM(a.time) + a.duration); }, [appts]);
  return (<div style={{ overflowX: "auto", borderRadius: 9, border: `1px solid ${LU_COLOR}40` }}><table style={{ borderCollapse: "collapse", width: "100%", minWidth: 320, fontSize: 10, fontFamily: "'Noto Sans TC', sans-serif" }}>
    <thead><tr><th style={{ padding: "7px 3px", background: LU_COLOR, color: "white", position: "sticky", left: 0, zIndex: 10, minWidth: 42, width: 42, borderRight: `2px solid ${LU_COLOR}`, fontSize: 10 }}>時間</th>
      {wd.map((date, di) => { const isT = dsArr[di] === todayStr; return (<th key={di} style={{ padding: "5px 2px", background: isT ? "#1D8068" : LU_COLOR, color: "white", borderLeft: `1px solid ${LU_COLOR}88`, fontSize: 9, minWidth: 80, width: "33%" }}><div>{`${date.getMonth() + 1}/${date.getDate()}`}</div><div style={{ fontSize: 9, color: isT ? "#A0E8D0" : "#88CCB8", marginTop: 1 }}>{LU_WDAY[di]}{isT && " 今"}</div></th>); })}</tr></thead>
    <tbody>{LU_SLOTS.map((time) => { const isH = time.endsWith(":00"); return (<tr key={time}><td style={{ padding: "1px 2px", textAlign: "center", background: isH ? "#E8F5F0" : "#F2FAF7", position: "sticky", left: 0, zIndex: 5, borderRight: `2px solid ${LU_COLOR}40`, borderTop: isH ? `1px solid ${LU_COLOR}30` : "1px solid #E0EDE8", fontWeight: isH ? 700 : 400, color: isH ? LU_COLOR : "#6BA898", fontSize: isH ? 10 : 9, height: 22 }}>{time}</td>
      {wd.map((date, di) => {
        const ds = dsArr[di]; const as = getStart(ds, time); const aa = getAt(ds, time); const occ = !!aa;
        const closed = isLuSlotClosed(ds, time, luSlotCfg);
        return (<td key={di} onClick={() => occ ? onApptClick(aa) : !closed && onCellClick(date, time)}
          style={{ borderLeft: "1px solid #E0EDE8", borderTop: isH ? `1px solid ${LU_COLOR}30` : "1px solid #E0EDE8", padding: 0, height: 22, cursor: occ || !closed ? "pointer" : "default", position: "relative", background: closed ? "#F0EBE0" : occ ? `${LU_COLOR}15` : "#F8FDFB" }}
          onMouseEnter={e => { if (!occ && !closed) e.currentTarget.style.background = "#DDF0E8"; }} onMouseLeave={e => { if (!occ && !closed) e.currentTarget.style.background = "#F8FDFB"; }}>
          {as && (<div style={{ position: "absolute", top: 1, left: 1, right: 1, height: (as.duration / 15) * 22 - 2, background: `linear-gradient(135deg, ${LU_COLOR}EE, ${LU_COLOR}AA)`, borderRadius: 3, zIndex: 2, padding: "1px 3px", color: "white", fontSize: 8, fontWeight: 600, overflow: "hidden", display: "flex", flexDirection: "column", border: as.checkedIn ? "2px solid #FFD700" : "none" }}>
            <span>{as.patient.slice(0, 3)}</span>
            {as.duration >= 30 && <span style={{ fontSize: 7, opacity: 0.75 }}>{as.duration}m</span>}
          </div>)}
          {closed && !occ && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#B5A898" }}>關</div>}
        </td>);
      })}</tr>); })}</tbody>
  </table></div>);
}

function ShiftEditor({ customShifts, setCustomShifts }) {
  const [selTh, setSelTh] = useState("A"); const [month, setMonth] = useState(() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; });
  const [y, mo] = month.split("-").map(Number); const dim = new Date(y, mo, 0).getDate(); const fDow = new Date(y, mo - 1, 1).getDay();
  const dates = useMemo(() => Array.from({ length: dim }, (_, i) => { const d = new Date(y, mo - 1, i + 1); return { date: d, ds: fd(d), dow: d.getDay() }; }), [y, mo, dim]);
  const getShift = (ds, date) => { const k = `${selTh}-${ds}`; return customShifts[k] !== undefined ? customShifts[k] : EMPTY_SHIFT; };
  const cycle = (ds, pk) => { const k = `${selTh}-${ds}`, cur = [...getShift(ds, new Date(ds))]; const hasOn = cur.includes(pk), hasOff = cur.includes(pk + "o"); let next; if (!hasOn && !hasOff) next = [...cur, pk]; else if (hasOn) { next = cur.filter(c => c !== pk); next.push(pk + "o"); } else next = cur.filter(c => c !== pk + "o"); setCustomShifts(prev => ({ ...prev, [k]: next })); };
  const th = TH_MAP[selTh];
  return (<div>
    <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
      <div style={{ display: "flex", gap: 4 }}>{THERAPISTS.map(t => (<button key={t.id} onClick={() => setSelTh(t.id)} style={{ width: 36, height: 36, borderRadius: "50%", cursor: "pointer", background: selTh === t.id ? t.color : `${t.color}20`, color: selTh === t.id ? "white" : t.color, border: selTh === t.id ? `2px solid ${t.color}` : "2px solid transparent", fontWeight: 700, fontSize: 14, fontFamily: "'Noto Sans TC', sans-serif" }}>{t.id}</button>))}</div>
      <input type="month" value={month} onChange={e => setMonth(e.target.value)} style={{ padding: "6px 10px", borderRadius: 7, border: "1.5px solid #D4C5A9", fontSize: 13, background: "#FFFDF5", fontFamily: "'Noto Sans TC', sans-serif", outline: "none" }} />
      <button onClick={() => { const u = {}; dates.forEach(({ ds }) => { u[`${selTh}-${ds}`] = []; }); setCustomShifts(prev => ({ ...prev, ...u })); }} style={{ padding: "6px 12px", borderRadius: 6, border: "1.5px solid #C2563A", background: "#FFF0EB", color: "#C2563A", cursor: "pointer", fontWeight: 600, fontSize: 14, fontFamily: "'Noto Sans TC', sans-serif" }}>全月清除</button>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, padding: "8px 14px", background: `${th.color}12`, borderRadius: 8, border: `1.5px solid ${th.color}30` }}><div style={{ width: 28, height: 28, borderRadius: "50%", background: th.color, color: "white", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>{th.id}</div><span style={{ fontWeight: 700, color: "#3D2B1F", fontSize: 17 }}>{th.name}</span><span style={{ fontSize: 13, color: "#8B7355", marginLeft: "auto" }}>無班 → 班內 → 班外 → 無班</span></div>
    <div style={{ display: "flex", gap: 14, marginBottom: 10, fontSize: 14, color: "#5A4A3A" }}><span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ display: "inline-block", width: 16, height: 16, borderRadius: 3, background: `${th.color}DD` }} /> 班內</span><span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ display: "inline-block", width: 16, height: 16, borderRadius: 3, background: `${th.color}40` }} /> 班外</span><span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ display: "inline-block", width: 16, height: 16, borderRadius: 3, background: "#EDE5D5" }} /> 無班</span></div>
    <div style={{ background: "#FFFDF5", borderRadius: 10, border: "1px solid #E0D5C1", overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", background: "#3D2B1F" }}>{["日", "一", "二", "三", "四", "五", "六"].map(d => (<div key={d} style={{ padding: "8px 0", textAlign: "center", color: "#F5EDDC", fontSize: 15, fontWeight: 600 }}>{d}</div>))}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
        {Array.from({ length: fDow }, (_, i) => (<div key={`e${i}`} style={{ padding: 8, background: "#F8F2E6", borderTop: "1px solid #EDE5D5", borderRight: "1px solid #EDE5D5" }} />))}
        {dates.map(({ date, ds, dow }) => { const shift = getShift(ds, date); const isT = ds === fd(new Date()); return (<div key={ds} style={{ padding: "5px 3px", borderTop: "1px solid #EDE5D5", borderRight: "1px solid #EDE5D5", background: isT ? "#FFF8E6" : "#FFFDF5", minHeight: 72 }}><div style={{ fontSize: 14, fontWeight: isT ? 700 : 400, color: dow === 0 || dow === 6 ? "#C2563A" : "#3D2B1F", marginBottom: 3, textAlign: "center" }}>{date.getDate()}</div><div style={{ display: "flex", flexDirection: "column", gap: 2 }}>{[{ k: "m", l: "上午" }, { k: "a", l: "下午" }, { k: "e", l: "晚上" }].map(({ k, l }) => { const st = getPeriodState(shift, k); let bg, color; if (st === "on") { bg = `${th.color}DD`; color = "white"; } else if (st === "off") { bg = `${th.color}40`; color = "#3D2B1F"; } else { bg = "#EDE5D5"; color = "#B5A898"; } return (<button key={k} onClick={() => cycle(ds, k)} style={{ padding: "2px 0", borderRadius: 3, border: "none", cursor: "pointer", background: bg, color, fontSize: 12, fontWeight: 600, fontFamily: "'Noto Sans TC', sans-serif" }}>{l}</button>); })}</div></div>); })}
      </div>
    </div>
  </div>);
}

/* ═══════════════════════════════════════════ Salary ═══════════════════════════════════════════ */
/* ═══════════════════════════════════════════ Lu Admin Detail (edit/copy/delete/報到) ═══════════════════════════════════════════ */
function LuAdminDetail({ appt, appts, onClose, onDelete, onUpdate, onAlert, onCopyDates }) {
  const [editing, setEditing] = useState(false); const [showCopy, setShowCopy] = useState(false); const [copySelected, setCopySelected] = useState([]);
  const [dur, setDur] = useState(appt.duration); const [patient, setPatient] = useState(appt.patient); const [bday, setBday] = useState(appt.birthday);
  const [selfRef, setSelfRef] = useState(appt.selfRef ?? false);
  const sel = { padding: "6px 9px", borderRadius: 7, border: "1.5px solid #D4C5A9", fontSize: 12, background: "#FFFDF5", fontFamily: "'Noto Sans TC', sans-serif", outline: "none", cursor: "pointer", width: "100%" };
  const futureDates = useMemo(() => { const d = new Date(appt.date), dow = d.getDay(), y = d.getFullYear(), mo = d.getMonth(); const dim = new Date(y, mo + 1, 0).getDate(), dates = []; for (let day = d.getDate() + 1; day <= dim; day++) { const c = new Date(y, mo, day); if (c.getDay() === dow) dates.push(fd(c)); } return dates; }, [appt.date]);

  const doSave = () => { onUpdate(appt.id, { duration: dur, patient, birthday: bday, selfRef }); setEditing(false); };
  const save = () => {
    if (!patient.trim()) { onAlert("請輸入患者姓名"); return; }
    if (!luValidRange(appt.time, dur)) { onAlert("超出盧獨立時段"); return; }
    if (luSlotOccupied(appts, appt.date, appt.time, dur, appt.id)) { onAlert("此時段已有預約"); return; }
    doSave();
  };

  return (<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div style={{ background: `${LU_COLOR}12`, border: `1.5px solid ${LU_COLOR}40`, borderRadius: 9, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ width: 28, height: 28, borderRadius: "50%", background: LU_COLOR, color: "white", fontWeight: 700, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" }}>盧</div>
        <div><div style={{ fontWeight: 700, color: "#3D2B1F", fontSize: 14 }}>{appt.patient}</div><div style={{ fontSize: 11, color: "#8B7355" }}>生日：{appt.birthday}</div></div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12 }}><div><span style={{ color: "#8B7355" }}>日期：</span>{appt.date}</div><div><span style={{ color: "#8B7355" }}>時間：</span>{appt.time}</div></div>
    </div>

    {!editing && !showCopy && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12, padding: "0 2px" }}>
      <div><span style={{ color: "#8B7355" }}>時長：</span><strong>{appt.duration} 分</strong></div>
      <div><span style={{ color: "#8B7355" }}>轉介：</span><strong style={{ color: appt.selfRef ? "#5B6ABF" : "#B8860B" }}>{appt.selfRef ? "自轉" : "非自轉"}</strong></div>
      <div><span style={{ color: "#8B7355" }}>報到：</span><strong style={{ color: appt.checkedIn ? "#2E7D6F" : "#B5A898" }}>{appt.checkedIn ? "已報到" : "未報到"}</strong></div>
    </div>}

    {editing && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "0 2px" }}>
      <div><label style={{ fontSize: 10, fontWeight: 600, color: "#5A4A3A", display: "block", marginBottom: 3 }}>患者姓名</label><input value={patient} onChange={e => setPatient(e.target.value)} style={{ ...sel, cursor: "text" }} /></div>
      <div><label style={{ fontSize: 10, fontWeight: 600, color: "#5A4A3A", display: "block", marginBottom: 3 }}>生日</label><input value={bday} onChange={e => setBday(e.target.value.replace(/\D/g, "").slice(0, 6))} style={{ ...sel, cursor: "text" }} maxLength={6} /></div>
      <div><label style={{ fontSize: 10, fontWeight: 600, color: "#5A4A3A", display: "block", marginBottom: 3 }}>時長</label><select value={String(dur)} onChange={e => setDur(Number(e.target.value))} style={sel}>{DURATIONS.map(d => <option key={d} value={String(d)}>{d} 分鐘</option>)}</select></div>
      <div><label style={{ fontSize: 10, fontWeight: 600, color: "#5A4A3A", display: "block", marginBottom: 3 }}>自轉／非自轉</label><select value={selfRef ? "self" : "other"} onChange={e => setSelfRef(e.target.value === "self")} style={sel}><option value="self">自轉</option><option value="other">非自轉</option></select></div>
    </div>}

    {showCopy && <div style={{ background: "#E8F5F0", borderRadius: 8, padding: 14 }}><div style={{ fontSize: 12, fontWeight: 600, color: "#3D2B1F", marginBottom: 10 }}>複製到本月其他{WDAY[(new Date(appt.date).getDay() + 6) % 7]}：</div>
      {futureDates.length === 0 ? <div style={{ fontSize: 12, color: "#8B7355" }}>本月已無後續相同星期</div> : <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>{futureDates.map(ds2 => {
        const sel2 = copySelected.includes(ds2); const conflict = luSlotOccupied(appts, ds2, appt.time, appt.duration, null); const d = new Date(ds2);
        return (<button key={ds2} disabled={conflict} onClick={() => !conflict && setCopySelected(p => p.includes(ds2) ? p.filter(x => x !== ds2) : [...p, ds2])} style={{ padding: "8px 14px", borderRadius: 8, cursor: conflict ? "not-allowed" : "pointer", border: sel2 ? `2px solid ${LU_COLOR}` : "1.5px solid #D4C5A9", background: conflict ? "#EDE5D5" : sel2 ? "#E8F5F0" : "#FFFDF5", color: conflict ? "#B5A898" : sel2 ? LU_COLOR : "#3D2B1F", fontWeight: sel2 ? 700 : 500, fontSize: 13, opacity: conflict ? 0.5 : 1, fontFamily: "'Noto Sans TC', sans-serif" }}>{`${d.getMonth() + 1}/${d.getDate()}`}{conflict && <span style={{ display: "block", fontSize: 8, color: "#B5A898" }}>衝突</span>}</button>);
      })}</div>}
      <div style={{ display: "flex", gap: 6 }}><button onClick={() => { if (copySelected.length) { onCopyDates(appt, copySelected); setShowCopy(false); setCopySelected([]); } }} disabled={!copySelected.length} style={{ flex: 1, padding: 9, borderRadius: 7, border: "none", background: copySelected.length ? `linear-gradient(135deg, ${LU_COLOR}, #145A4A)` : "#CCBFB0", color: "white", cursor: copySelected.length ? "pointer" : "not-allowed", fontWeight: 600, fontSize: 12, fontFamily: "'Noto Sans TC', sans-serif" }}>確認 ({copySelected.length})</button><button onClick={() => { setShowCopy(false); setCopySelected([]); }} style={{ padding: "9px 14px", borderRadius: 7, border: "1.5px solid #D4C5A9", background: "#FFFDF5", color: "#5A4A3A", cursor: "pointer", fontWeight: 600, fontSize: 12, fontFamily: "'Noto Sans TC', sans-serif" }}>取消</button></div>
    </div>}

    {!editing && !showCopy && <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
      <button onClick={() => onUpdate(appt.id, { checkedIn: !appt.checkedIn })} style={{ flex: 1, padding: 9, borderRadius: 7, border: appt.checkedIn ? `1.5px solid ${LU_COLOR}` : "1.5px solid #D4C5A9", background: appt.checkedIn ? "#E8F5F0" : "#FFFDF5", color: appt.checkedIn ? LU_COLOR : "#5A4A3A", cursor: "pointer", fontWeight: 600, fontSize: 11, fontFamily: "'Noto Sans TC', sans-serif" }}>{appt.checkedIn ? "✅ 報到成功" : "📋 報到"}</button>
      <button onClick={() => setEditing(true)} style={{ flex: 1, padding: 9, borderRadius: 7, border: "1.5px solid #D4C5A9", background: "#FFFDF5", color: "#5A4A3A", cursor: "pointer", fontWeight: 600, fontSize: 11, fontFamily: "'Noto Sans TC', sans-serif" }}>✏️ 編輯</button>
      <button onClick={() => setShowCopy(true)} style={{ flex: 1, padding: 9, borderRadius: 7, border: `1.5px solid ${LU_COLOR}`, background: "#E8F5F0", color: LU_COLOR, cursor: "pointer", fontWeight: 600, fontSize: 11, fontFamily: "'Noto Sans TC', sans-serif" }}>📋 複製</button>
      <button onClick={() => { onDelete(appt.id); onClose(); }} style={{ flex: 1, padding: 9, borderRadius: 7, border: "1.5px solid #E8C8C0", background: "#FFF5F2", color: "#C2563A", cursor: "pointer", fontWeight: 600, fontSize: 11, fontFamily: "'Noto Sans TC', sans-serif" }}>🗑 刪除</button>
    </div>}
    {editing && <div style={{ display: "flex", gap: 6 }}><button onClick={save} style={{ flex: 1, padding: 9, borderRadius: 7, border: "none", background: `linear-gradient(135deg, ${LU_COLOR}, #145A4A)`, color: "white", cursor: "pointer", fontWeight: 600, fontSize: 12, fontFamily: "'Noto Sans TC', sans-serif" }}>✓ 儲存</button><button onClick={() => setEditing(false)} style={{ flex: 1, padding: 9, borderRadius: 7, border: "1.5px solid #D4C5A9", background: "#FFFDF5", color: "#5A4A3A", cursor: "pointer", fontWeight: 600, fontSize: 12, fontFamily: "'Noto Sans TC', sans-serif" }}>取消</button></div>}
  </div>);
}

function calcRevenue(dur, tt) { return (dur / 15) * (tt === "taping" ? 150 : 300); }
function calcPay(a) {
  if (!a.checkedIn) return 0;
  const tt = a.treatType || "manual";
  if (tt === "shockwave" || tt === "laser") return 100;
  const rate = a.onDuty ? (a.selfRef ? 0.7 : 0.4) : (a.selfRef ? 0.9 : 0.6);
  return Math.round(calcRevenue(a.duration, tt) * rate);
}
function calcLuPay(a) {
  if (!a.checkedIn) return 0;
  return Math.round(calcRevenue(a.duration, "manual") * (a.selfRef ? 0.9 : 0.6));
}

function SalarySummary({ appts, luAppts, cs }) {
  const [month, setMonth] = useState(() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`; });
  const [selTh, setSelTh] = useState(null);
  const [salaryUnlocked, setSalaryUnlocked] = useState(false);
  const [salaryPw, setSalaryPw] = useState("");
  const [salaryPwErr, setSalaryPwErr] = useState(false);
  const SALARY_PW = "tcory213";

  const [y, mo] = month.split("-").map(Number);
  const monthStart = `${y}-${String(mo).padStart(2, "0")}-01`;
  const monthEnd = `${y}-${String(mo).padStart(2, "0")}-${String(new Date(y, mo, 0).getDate()).padStart(2, "0")}`;

  const monthAppts = useMemo(() => appts.filter(a => a.date >= monthStart && a.date <= monthEnd), [appts, monthStart, monthEnd]);
  const monthLuAppts = useMemo(() => luAppts.filter(a => a.date >= monthStart && a.date <= monthEnd), [luAppts, monthStart, monthEnd]);

  const summaries = useMemo(() => THERAPISTS.map(t => {
    const all = monthAppts.filter(a => a.therapist === t.id);
    const checked = all.filter(a => a.checkedIn);
    const totalPay = checked.reduce((s, a) => s + calcPay(a), 0);
    const manualChecked = checked.filter(a => (a.treatType || "manual") === "manual");
    const tapingChecked = checked.filter(a => a.treatType === "taping");
    const otherChecked = checked.filter(a => a.treatType === "shockwave" || a.treatType === "laser");
    return {
      ...t, allCount: all.length, checkedCount: checked.length, totalPay,
      manualCount: manualChecked.length, tapingCount: tapingChecked.length, otherCount: otherChecked.length,
      onCount: manualChecked.filter(a => a.onDuty).length, offCount: manualChecked.filter(a => !a.onDuty).length,
      selfCount: manualChecked.filter(a => a.selfRef).length, nsCount: manualChecked.filter(a => !a.selfRef).length,
      manualMin: manualChecked.reduce((s, a) => s + a.duration, 0),
      manualPay: manualChecked.reduce((s, a) => s + calcPay(a), 0),
      tapingPay: tapingChecked.reduce((s, a) => s + calcPay(a), 0),
      otherPay: otherChecked.length * 100,
    };
  }), [monthAppts]);

  const luSummary = useMemo(() => {
    const all = monthLuAppts;
    const checked = all.filter(a => a.checkedIn);
    const selfChecked = checked.filter(a => a.selfRef);
    const nsChecked = checked.filter(a => !a.selfRef);
    const totalPay = checked.reduce((s, a) => s + calcLuPay(a), 0);
    return {
      allCount: all.length, checkedCount: checked.length, totalPay,
      selfCount: selfChecked.length, nsCount: nsChecked.length,
      selfPay: selfChecked.reduce((s, a) => s + calcLuPay(a), 0),
      nsPay: nsChecked.reduce((s, a) => s + calcLuPay(a), 0),
      totalMin: checked.reduce((s, a) => s + a.duration, 0),
    };
  }, [monthLuAppts]);

  // Co-duty bonus: for each checked manual/taping therapy, other on-duty therapists get 5% of revenue
  const coDutyBonus = useMemo(() => {
    const bonus = {};
    THERAPISTS.forEach(t => { bonus[t.id] = 0; });
    const checkedEligible = monthAppts.filter(a => a.checkedIn && ((a.treatType || "manual") === "manual" || a.treatType === "taping") && a.therapist !== "X");
    if (!checkedEligible.length) return bonus;
    const dateCache = {};
    checkedEligible.forEach(a => {
      const tt = a.treatType || "manual";
      const revenue = calcRevenue(a.duration, tt);
      if (!dateCache[a.date]) dateCache[a.date] = new Date(a.date);
      const apptDate = dateCache[a.date];
      THERAPISTS.forEach(t => {
        if (t.id === a.therapist) return;
        if (getPeriodStateAt(t.id, apptDate, a.time, cs) === "on") {
          bonus[t.id] += Math.round(revenue * 0.05);
        }
      });
    });
    return bonus;
  }, [monthAppts, cs]);

  const selDetail = useMemo(() => {
    if (!selTh) return null;
    if (selTh === "LU") return monthLuAppts.filter(a => a.checkedIn).sort(sortByDateTime);
    return monthAppts.filter(a => a.therapist === selTh && a.checkedIn).sort(sortByDateTime);
  }, [selTh, monthAppts, monthLuAppts]);

  const selSummary = selTh === "LU" ? luSummary : summaries.find(s => s.id === selTh);
  const selColor = selTh === "LU" ? LU_COLOR : (TH_MAP[selTh]?.color || "#888");
  const selName = selTh === "LU" ? "盧獨立時段" : (TH_MAP[selTh]?.name || "");

  return (<div>
    {/* Month selector */}
    <div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
      <input type="month" value={month} onChange={e => { setMonth(e.target.value); setSelTh(null); }}
        style={{ padding: "6px 12px", borderRadius: 7, border: "1.5px solid #D4C5A9", fontSize: 14, background: "#FFFDF5", fontFamily: "'Noto Sans TC', sans-serif", outline: "none" }} />
      <span style={{ fontSize: 12, color: "#8B7355" }}>僅計入已報到個案</span>
      <div style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center" }}>
        {salaryUnlocked ? (
          <span style={{ fontSize: 11, color: "#2E7D6F", fontWeight: 600 }}>🔓 金額已解鎖 <button onClick={() => setSalaryUnlocked(false)} style={{ marginLeft: 4, padding: "2px 8px", borderRadius: 4, border: "1px solid #D4C5A9", background: "#FFFDF5", color: "#8B7355", cursor: "pointer", fontSize: 10, fontFamily: "'Noto Sans TC', sans-serif" }}>鎖定</button></span>
        ) : (
          <><input type="password" value={salaryPw} onChange={e => { setSalaryPw(e.target.value); setSalaryPwErr(false); }} onKeyDown={e => { if (e.key === "Enter") { if (salaryPw === SALARY_PW) { setSalaryUnlocked(true); setSalaryPw(""); } else { setSalaryPwErr(true); setSalaryPw(""); } } }} placeholder="輸入管理密碼查看金額" style={{ padding: "5px 10px", borderRadius: 6, border: `1.5px solid ${salaryPwErr ? "#C2563A" : "#D4C5A9"}`, fontSize: 12, background: "#FFFDF5", fontFamily: "'Noto Sans TC', sans-serif", outline: "none", width: 150 }} />
          <button onClick={() => { if (salaryPw === SALARY_PW) { setSalaryUnlocked(true); setSalaryPw(""); } else { setSalaryPwErr(true); setSalaryPw(""); } }} style={{ padding: "5px 12px", borderRadius: 6, border: "none", background: "#3D2B1F", color: "#F5EDDC", cursor: "pointer", fontWeight: 600, fontSize: 11, fontFamily: "'Noto Sans TC', sans-serif" }}>🔓 解鎖</button>
          {salaryPwErr && <span style={{ fontSize: 10, color: "#C2563A" }}>密碼錯誤</span>}</>
        )}
      </div>
    </div>

    {/* Overview cards */}
    <div style={{ background: "#FFFDF5", borderRadius: 10, border: "1px solid #E0D5C1", overflow: "hidden", marginBottom: selTh ? 16 : 0 }}>
      <div style={{ background: "#3D2B1F", color: "#F5EDDC", padding: "11px 16px", fontSize: 13, fontWeight: 700 }}>
        {y}年{mo}月 薪資統計
      </div>
      <div style={{ padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        {summaries.map(s2 => (
          <div key={s2.id} onClick={() => setSelTh(selTh === s2.id ? null : s2.id)}
            style={{ border: `1.5px solid ${selTh === s2.id ? s2.color : s2.color + "40"}`, borderRadius: 9, padding: 12, background: selTh === s2.id ? `${s2.color}15` : `${s2.color}08`, cursor: "pointer", transition: "all 0.15s" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: "50%", background: s2.color, color: "white", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>{s2.id}</div>
              <span style={{ fontWeight: 700, color: "#3D2B1F", fontSize: 13 }}>{s2.name}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: "#8B7355" }}>點擊展開 ▾</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, fontSize: 11 }}>
              <div style={{ color: "#8B7355" }}>總預約</div><div style={{ fontWeight: 700, textAlign: "right" }}>{s2.allCount} 筆</div>
              <div style={{ color: "#2E7D6F" }}>已報到</div><div style={{ fontWeight: 700, textAlign: "right", color: "#2E7D6F" }}>{s2.checkedCount} 筆</div>
              <div style={{ color: "#8B7355" }}>徒手治療</div><div style={{ fontWeight: 600, textAlign: "right" }}>{s2.manualCount} 次 · {s2.manualMin} 分</div>
              <div style={{ color: "#8B7355" }}>貼紮</div><div style={{ fontWeight: 600, textAlign: "right" }}>{s2.tapingCount} 次</div>
              <div style={{ color: "#8B7355" }}>震波/雷射</div><div style={{ fontWeight: 600, textAlign: "right" }}>{s2.otherCount} 次</div>
              {salaryUnlocked && coDutyBonus[s2.id] > 0 && <><div style={{ color: "#B8860B" }}>共班分潤</div><div style={{ fontWeight: 600, textAlign: "right", color: "#B8860B" }}>+${coDutyBonus[s2.id].toLocaleString()}</div></>}
              <div style={{ gridColumn: "1/3", borderTop: "1px solid #E0D5C1", paddingTop: 8, marginTop: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#8B7355", fontSize: 12 }}>應發薪資</span>
                  <strong style={{ color: "#C2563A", fontSize: 16 }}>{salaryUnlocked ? `NT$ ${(s2.totalPay + coDutyBonus[s2.id]).toLocaleString()}` : "🔒 已隱藏"}</strong>
                </div>
              </div>
            </div>
          </div>
        ))}
        {/* 盧老師 card */}
        <div onClick={() => setSelTh(selTh === "LU" ? null : "LU")}
          style={{ border: `1.5px solid ${selTh === "LU" ? LU_COLOR : LU_COLOR + "40"}`, borderRadius: 9, padding: 12, background: selTh === "LU" ? `${LU_COLOR}15` : `${LU_COLOR}08`, cursor: "pointer", transition: "all 0.15s" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: "50%", background: LU_COLOR, color: "white", fontWeight: 700, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>盧</div>
            <span style={{ fontWeight: 700, color: "#3D2B1F", fontSize: 13 }}>盧獨立時段</span>
            <span style={{ marginLeft: "auto", fontSize: 10, color: "#8B7355" }}>點擊展開 ▾</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, fontSize: 11 }}>
            <div style={{ color: "#8B7355" }}>總預約</div><div style={{ fontWeight: 700, textAlign: "right" }}>{luSummary.allCount} 筆</div>
            <div style={{ color: "#2E7D6F" }}>已報到</div><div style={{ fontWeight: 700, textAlign: "right", color: "#2E7D6F" }}>{luSummary.checkedCount} 筆</div>
            <div style={{ color: "#8B7355" }}>治療時數</div><div style={{ fontWeight: 600, textAlign: "right" }}>{luSummary.totalMin} 分</div>
            <div style={{ color: "#C2563A" }}>班別</div><div style={{ fontWeight: 600, textAlign: "right", color: "#C2563A" }}>一律班外</div>
            <div style={{ gridColumn: "1/3", borderTop: "1px solid #E0D5C1", paddingTop: 8, marginTop: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "#8B7355", fontSize: 12 }}>應發薪資</span>
                <strong style={{ color: "#C2563A", fontSize: 16 }}>{salaryUnlocked ? `NT$ ${luSummary.totalPay.toLocaleString()}` : "🔒 已隱藏"}</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    {/* Detail panel */}
    {selTh && selSummary && selDetail && (
      <div style={{ background: "#FFFDF5", borderRadius: 10, border: `1.5px solid ${selColor}40`, overflow: "hidden" }}>
        <div style={{ background: selColor, color: "white", padding: "12px 16px", fontSize: 14, fontWeight: 700, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>{selName} — {y}年{mo}月明細</span>
          <button onClick={() => setSelTh(null)} style={{ background: "rgba(255,255,255,0.2)", border: "none", color: "white", padding: "3px 10px", borderRadius: 5, cursor: "pointer", fontSize: 12 }}>✕</button>
        </div>

        {/* Salary breakdown */}
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #E0D5C1", fontSize: 12 }}>
          <div style={{ fontWeight: 700, color: "#3D2B1F", marginBottom: 10, fontSize: 13 }}>薪資計算明細</div>
          {!salaryUnlocked ? <div style={{ textAlign: "center", padding: "16px 0", color: "#B5A898", fontSize: 13 }}>🔒 金額已隱藏，請輸入管理密碼查看</div> : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "6px 14px", alignItems: "center" }}>
            <div style={{ fontWeight: 600, color: "#5A4A3A", borderBottom: "1px solid #EDE5D5", paddingBottom: 4 }}>類別</div>
            <div style={{ fontWeight: 600, color: "#5A4A3A", textAlign: "right", borderBottom: "1px solid #EDE5D5", paddingBottom: 4 }}>次數</div>
            <div style={{ fontWeight: 600, color: "#5A4A3A", textAlign: "right", borderBottom: "1px solid #EDE5D5", paddingBottom: 4 }}>金額</div>

            {selTh === "LU" ? (<>
              {luSummary.nsCount > 0 && <><div style={{ color: "#C2563A" }}>班外非自轉 (60%)</div><div style={{ textAlign: "right" }}>{luSummary.nsCount}</div><div style={{ textAlign: "right" }}>NT$ {luSummary.nsPay.toLocaleString()}</div></>}
              {luSummary.selfCount > 0 && <><div style={{ color: "#B8860B" }}>班外自轉 (90%)</div><div style={{ textAlign: "right" }}>{luSummary.selfCount}</div><div style={{ textAlign: "right" }}>NT$ {luSummary.selfPay.toLocaleString()}</div></>}
            </>) : (<>
            {(() => { const items = selDetail.filter(a => (a.treatType||"manual")==="manual" && a.onDuty && !a.selfRef); return items.length > 0 ? <><div style={{ color: "#2E7D6F" }}>徒手·班內非自轉 (40%)</div><div style={{ textAlign: "right" }}>{items.length}</div><div style={{ textAlign: "right" }}>NT$ {items.reduce((s,a)=>s+calcPay(a),0).toLocaleString()}</div></> : null; })()}
            {(() => { const items = selDetail.filter(a => (a.treatType||"manual")==="manual" && !a.onDuty && !a.selfRef); return items.length > 0 ? <><div style={{ color: "#C2563A" }}>徒手·班外非自轉 (60%)</div><div style={{ textAlign: "right" }}>{items.length}</div><div style={{ textAlign: "right" }}>NT$ {items.reduce((s,a)=>s+calcPay(a),0).toLocaleString()}</div></> : null; })()}
            {(() => { const items = selDetail.filter(a => (a.treatType||"manual")==="manual" && a.onDuty && a.selfRef); return items.length > 0 ? <><div style={{ color: "#5B6ABF" }}>徒手·班內自轉 (70%)</div><div style={{ textAlign: "right" }}>{items.length}</div><div style={{ textAlign: "right" }}>NT$ {items.reduce((s,a)=>s+calcPay(a),0).toLocaleString()}</div></> : null; })()}
            {(() => { const items = selDetail.filter(a => (a.treatType||"manual")==="manual" && !a.onDuty && a.selfRef); return items.length > 0 ? <><div style={{ color: "#B8860B" }}>徒手·班外自轉 (90%)</div><div style={{ textAlign: "right" }}>{items.length}</div><div style={{ textAlign: "right" }}>NT$ {items.reduce((s,a)=>s+calcPay(a),0).toLocaleString()}</div></> : null; })()}
            {(() => { const items = selDetail.filter(a => a.treatType==="taping" && a.onDuty && !a.selfRef); return items.length > 0 ? <><div style={{ color: "#2E7D6F" }}>貼紮·班內非自轉 (40%)</div><div style={{ textAlign: "right" }}>{items.length}</div><div style={{ textAlign: "right" }}>NT$ {items.reduce((s,a)=>s+calcPay(a),0).toLocaleString()}</div></> : null; })()}
            {(() => { const items = selDetail.filter(a => a.treatType==="taping" && !a.onDuty && !a.selfRef); return items.length > 0 ? <><div style={{ color: "#C2563A" }}>貼紮·班外非自轉 (60%)</div><div style={{ textAlign: "right" }}>{items.length}</div><div style={{ textAlign: "right" }}>NT$ {items.reduce((s,a)=>s+calcPay(a),0).toLocaleString()}</div></> : null; })()}
            {(() => { const items = selDetail.filter(a => a.treatType==="taping" && a.onDuty && a.selfRef); return items.length > 0 ? <><div style={{ color: "#5B6ABF" }}>貼紮·班內自轉 (70%)</div><div style={{ textAlign: "right" }}>{items.length}</div><div style={{ textAlign: "right" }}>NT$ {items.reduce((s,a)=>s+calcPay(a),0).toLocaleString()}</div></> : null; })()}
            {(() => { const items = selDetail.filter(a => a.treatType==="taping" && !a.onDuty && a.selfRef); return items.length > 0 ? <><div style={{ color: "#B8860B" }}>貼紮·班外自轉 (90%)</div><div style={{ textAlign: "right" }}>{items.length}</div><div style={{ textAlign: "right" }}>NT$ {items.reduce((s,a)=>s+calcPay(a),0).toLocaleString()}</div></> : null; })()}
            {selSummary.otherCount > 0 && <><div style={{ color: "#8B7355" }}>震波/雷射 (固定100)</div><div style={{ textAlign: "right" }}>{selSummary.otherCount}</div><div style={{ textAlign: "right" }}>NT$ {selSummary.otherPay.toLocaleString()}</div></>}
            {coDutyBonus[selTh] > 0 && <><div style={{ color: "#B8860B" }}>共班分潤 (5%)</div><div style={{ textAlign: "right" }}>—</div><div style={{ textAlign: "right" }}>NT$ {coDutyBonus[selTh].toLocaleString()}</div></>}
            </>)}

            <div style={{ gridColumn: "1/3", borderTop: "2px solid #3D2B1F", paddingTop: 8, marginTop: 4, fontWeight: 700, fontSize: 14, color: "#3D2B1F" }}>合計</div>
            <div style={{ borderTop: "2px solid #3D2B1F", paddingTop: 8, marginTop: 4, textAlign: "right", fontWeight: 700, fontSize: 14, color: "#C2563A" }}>NT$ {(selTh === "LU" ? luSummary.totalPay : selSummary.totalPay + (coDutyBonus[selTh] || 0)).toLocaleString()}</div>
          </div>)}
        </div>

        {/* Individual records */}
        <div style={{ padding: "14px 16px" }}>
          <div style={{ fontWeight: 700, color: "#3D2B1F", marginBottom: 10, fontSize: 13 }}>報到個案明細（{selDetail.length} 筆）</div>
          {selDetail.length === 0 ? <div style={{ color: "#B5A898", fontSize: 12, padding: 10 }}>本月無已報到個案</div> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11, fontFamily: "'Noto Sans TC', sans-serif" }}>
                <thead><tr style={{ background: "#F5F0E5" }}>
                  {(selTh === "LU"
                    ? (salaryUnlocked ? ["日期", "時間", "患者", "生日", "時長", "轉介", "收費", "薪資"] : ["日期", "時間", "患者", "生日", "時長", "轉介"])
                    : (salaryUnlocked ? ["日期", "時間", "患者", "生日", "項目", "時長", "班別", "轉介", "收費", "薪資"] : ["日期", "時間", "患者", "生日", "項目", "時長", "班別", "轉介"])
                  ).map(h => (
                    <th key={h} style={{ padding: "6px 8px", borderBottom: "1.5px solid #D4C5A9", textAlign: "left", fontWeight: 600, color: "#5A4A3A", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {selDetail.map(a => {
                    const isLu = selTh === "LU";
                    const tt = a.treatType || "manual";
                    const ttLabel = tt === "shockwave" ? "震波" : tt === "laser" ? "雷射" : tt === "taping" ? "貼紮" : "徒手";
                    const revenue = (isLu || tt === "manual" || tt === "taping") ? calcRevenue(a.duration, tt) : "-";
                    const pay = isLu ? calcLuPay(a) : calcPay(a);
                    return (
                      <tr key={a.id} style={{ borderBottom: "1px solid #EDE5D5" }}>
                        <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{a.date}</td>
                        <td style={{ padding: "5px 8px" }}>{a.time}</td>
                        <td style={{ padding: "5px 8px", fontWeight: 600 }}>{a.patient}</td>
                        <td style={{ padding: "5px 8px", color: "#8B7355" }}>{a.birthday}</td>
                        {!isLu && <td style={{ padding: "5px 8px" }}><span style={{ padding: "1px 5px", borderRadius: 3, background: "#F5F0E5", fontSize: 10 }}>{ttLabel}</span></td>}
                        <td style={{ padding: "5px 8px" }}>{a.duration}分</td>
                        {!isLu && <td style={{ padding: "5px 8px" }}><span style={{ color: a.onDuty ? "#2E7D6F" : "#C2563A", fontWeight: 600 }}>{a.onDuty ? "班內" : "班外"}</span></td>}
                        <td style={{ padding: "5px 8px" }}><span style={{ color: a.selfRef ? "#5B6ABF" : "#B8860B", fontWeight: 600 }}>{a.selfRef ? "自轉" : "非自轉"}</span></td>
                        {salaryUnlocked && <td style={{ padding: "5px 8px", textAlign: "right" }}>{typeof revenue === "number" ? `$${revenue}` : "-"}</td>}
                        {salaryUnlocked && <td style={{ padding: "5px 8px", textAlign: "right", fontWeight: 700, color: "#C2563A" }}>${pay}</td>}
                      </tr>
                    );
                  })}
                </tbody>
                {salaryUnlocked && <tfoot>
                  <tr style={{ background: "#F5F0E5", fontWeight: 700 }}>
                    <td colSpan={selTh === "LU" ? 7 : 9} style={{ padding: "8px", textAlign: "right", color: "#3D2B1F" }}>治療小計</td>
                    <td style={{ padding: "8px", textAlign: "right", color: "#3D2B1F", fontSize: 13 }}>NT$ {(selTh === "LU" ? luSummary.totalPay : selSummary.totalPay).toLocaleString()}</td>
                  </tr>
                  {selTh !== "LU" && coDutyBonus[selTh] > 0 && <tr style={{ background: "#FFF8E6" }}>
                    <td colSpan={9} style={{ padding: "6px 8px", textAlign: "right", color: "#B8860B", fontSize: 11 }}>共班分潤 (5%)</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", color: "#B8860B", fontWeight: 700, fontSize: 12 }}>+NT$ {coDutyBonus[selTh].toLocaleString()}</td>
                  </tr>}
                  <tr style={{ background: "#F0E8D8", fontWeight: 700 }}>
                    <td colSpan={selTh === "LU" ? 7 : 9} style={{ padding: "8px", textAlign: "right", color: "#3D2B1F", fontSize: 13 }}>應發合計</td>
                    <td style={{ padding: "8px", textAlign: "right", color: "#C2563A", fontSize: 14 }}>NT$ {(selTh === "LU" ? luSummary.totalPay : selSummary.totalPay + (coDutyBonus[selTh] || 0)).toLocaleString()}</td>
                  </tr>
                </tfoot>}
              </table>
            </div>
          )}
        </div>
      </div>
    )}
  </div>);
}

function ThFilterBar({ filterTh, setFilterTh, showNames, onLuClick }) {
  return (<div style={{ display: "flex", gap: 4, alignItems: "center", padding: "5px 12px", background: "#FFFDF5", borderRadius: 7, border: "1px solid #E0D5C1", marginBottom: 8, fontSize: showNames ? 12 : 10, flexWrap: "wrap" }}>
    <span style={{ color: "#8B7355", marginRight: 4 }}>篩選：</span>
    {THERAPISTS.map(t => { const sel = filterTh === t.id; return (
      <button key={t.id} onClick={() => {
        if (onLuClick && t.id === "B" && !sel) { onLuClick(); return; }
        setFilterTh(sel ? null : t.id);
      }} style={{ display: "flex", alignItems: "center", gap: 3, padding: showNames ? "4px 10px" : "0", width: showNames ? "auto" : 26, height: showNames ? 30 : 26, borderRadius: showNames ? 15 : "50%", cursor: "pointer", background: sel ? t.color : `${t.color}20`, color: sel ? "white" : t.color, border: sel ? `2px solid ${t.color}` : "2px solid transparent", fontWeight: 700, fontSize: showNames ? 12 : 10, fontFamily: "'Noto Sans TC', sans-serif", transition: "all 0.15s" }}>
        <span style={{ width: showNames ? "auto" : "100%", textAlign: "center" }}>{t.id}</span>
        {showNames && <span style={{ fontWeight: 500, fontSize: showNames ? 11 : 9 }}>{t.name}</span>}
      </button>
    ); })}
    {filterTh && <button onClick={() => setFilterTh(null)} style={{ padding: "4px 10px", borderRadius: 5, border: "1px solid #D4C5A9", background: "#FFFDF5", color: "#8B7355", cursor: "pointer", fontSize: showNames ? 11 : 9, fontFamily: "'Noto Sans TC', sans-serif", marginLeft: 4 }}>清除</button>}
  </div>);
}

function PwGate({ onAuth }) {
  const [pw, setPw] = useState(""); const [err, setErr] = useState(false);
  const go = () => { if (pw === ADMIN_PW) onAuth(); else { setErr(true); setPw(""); } };
  return (<div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "55vh", gap: 14 }}><div style={{ fontSize: 36 }}>🔒</div><h2 style={{ margin: 0, fontFamily: "'Noto Serif TC', serif", color: "#3D2B1F", fontSize: 18 }}>後台管理登入</h2><div style={{ display: "flex", gap: 6 }}><input type="password" value={pw} onChange={e => { setPw(e.target.value); setErr(false); }} onKeyDown={e => e.key === "Enter" && go()} placeholder="請輸入密碼" style={{ padding: "9px 12px", borderRadius: 7, border: `1.5px solid ${err ? "#C2563A" : "#D4C5A9"}`, fontSize: 13, background: "#FFFDF5", fontFamily: "'Noto Sans TC', sans-serif", outline: "none", width: 180 }} /><button onClick={go} style={{ padding: "9px 16px", borderRadius: 7, border: "none", cursor: "pointer", background: "linear-gradient(135deg, #3D2B1F, #5A3A2A)", color: "#F5EDDC", fontWeight: 600, fontSize: 13, fontFamily: "'Noto Sans TC', sans-serif" }}>進入</button></div>{err && <span style={{ color: "#C2563A", fontSize: 11 }}>密碼錯誤</span>}</div>);
}

/* ═══════════════════════════════════════════ MAIN ═══════════════════════════════════════════ */
export default function App() {
  const [appts, setAppts] = useState([]);
  const [luAppts, setLuAppts] = useState([]);
  const [cs, setCs] = useState({});
  const [luSlotCfg, setLuSlotCfg] = useState({});
  const [mainSlotCfg, setMainSlotCfg] = useState({});

  // ── Firestore listeners ──
  const [fireErr, setFireErr] = useState("");
  useEffect(() => {
    const onErr = (e) => { console.error("Firestore listener error:", e); setFireErr("Firestore 連線錯誤：" + e.message); };
    const unsub1 = onSnapshot(collection(db, "appts"), snap => {
      console.log("appts loaded:", snap.docs.length);
      setAppts(snap.docs.map(d => ({ ...d.data(), id: d.id })));
    }, onErr);
    const unsub2 = onSnapshot(collection(db, "luAppts"), snap => {
      console.log("luAppts loaded:", snap.docs.length);
      setLuAppts(snap.docs.map(d => ({ ...d.data(), id: d.id })));
    }, onErr);
    const unsub3 = onSnapshot(doc(db, "config", "shifts"), snap => {
      console.log("shifts loaded:", snap.exists());
      setCs(snap.exists() ? snap.data() : {});
    }, onErr);
    const unsub4 = onSnapshot(doc(db, "config", "luSlotCfg"), snap => {
      setLuSlotCfg(snap.exists() ? snap.data() : {});
    }, onErr);
    const unsub5 = onSnapshot(doc(db, "config", "mainSlotCfg"), snap => {
      setMainSlotCfg(snap.exists() ? snap.data() : {});
    }, onErr);
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); };
  }, []);
  const [selDate, setSelDate] = useState(() => { const now = new Date(); const dow = now.getDay(); if (dow === 6) { now.setDate(now.getDate() + 2); } else if (dow === 0) { now.setDate(now.getDate() + 1); } return now; });
  const [page, setPage] = useState("front"); // front | admin-gate | admin
  const [frontTab, setFrontTab] = useState("book"); // book | lu | lookup
  const [adminTab, setAdminTab] = useState("schedule"); // schedule | lu | salary | shifts
  const [adminView, setAdminView] = useState("day");
  const [luAdminView, setLuAdminView] = useState("day");
  const [filterTh, setFilterTh] = useState(null); // therapist id to highlight
  const [bookingModal, setBookingModal] = useState(null);
  const [luBookingModal, setLuBookingModal] = useState(null);
  const [adminDetailModal, setAdminDetailModal] = useState(null);
  const [luDetailModal, setLuDetailModal] = useState(null);
  const [alertMsg, setAlertMsg] = useState("");
  const [luChoiceModal, setLuChoiceModal] = useState(false);

  // ── Main appts handlers ──
  const handleBook = async (appt) => {
    try {
      const { id, ...data } = appt;
      await addDoc(collection(db, "appts"), data);
      console.log("appt written OK");
    } catch (e) {
      console.error("handleBook error:", e);
      setAlertMsg("預約寫入失敗：" + e.message);
    }
  };
  const handleDelete = async (id) => {
    try {
      await deleteDoc(doc(db, "appts", id));
      setAdminDetailModal(null);
    } catch (e) { console.error("delete error:", e); setAlertMsg("刪除失敗：" + e.message); }
  };
  const handleFrontDelete = async (id) => {
    try { await deleteDoc(doc(db, "appts", id)); } catch (e) { console.error("front delete error:", e); setAlertMsg("取消失敗：" + e.message); }
  };
  const handleFrontLuDelete = async (id) => {
    try { await deleteDoc(doc(db, "luAppts", id)); } catch (e) { console.error("front lu delete error:", e); setAlertMsg("取消失敗：" + e.message); }
  };
  const handleUpdate = async (id, ch) => {
    try {
      await updateDoc(doc(db, "appts", id), ch);
      setAdminDetailModal(prev => prev?.id === id ? { ...prev, ...ch } : prev);
    } catch (e) { console.error("update error:", e); setAlertMsg("更新失敗：" + e.message); }
  };
  const handleCopyDates = async (appt, targets) => {
    const batch = writeBatch(db);
    let sk = 0;
    const { id, ...base } = appt;
    targets.forEach(ds => {
      if (base.onDuty && onDutySlotConflict(appts, ds, base.time, base.duration, null)) { sk++; return; }
      const ref = doc(collection(db, "appts"));
      batch.set(ref, { ...base, date: ds, checkedIn: false });
    });
    await batch.commit();
    const added = targets.length - sk;
    setAlertMsg(`已複製 ${added} 筆${sk ? `（${sk} 筆跳過）` : ""}`);
  };

  // ── Lu appts handlers ──
  const handleLuBook = async (appt) => {
    try {
      const { id, ...data } = appt;
      await addDoc(collection(db, "luAppts"), data);
      console.log("luAppt written OK");
    } catch (e) {
      console.error("handleLuBook error:", e);
      setAlertMsg("預約寫入失敗：" + e.message);
    }
  };
  const handleLuDelete = async (id) => {
    try {
      await deleteDoc(doc(db, "luAppts", id));
      setLuDetailModal(null);
    } catch (e) { console.error("lu delete error:", e); setAlertMsg("刪除失敗：" + e.message); }
  };
  const handleLuUpdate = async (id, ch) => {
    try {
      await updateDoc(doc(db, "luAppts", id), ch);
      setLuDetailModal(prev => prev?.id === id ? { ...prev, ...ch } : prev);
    } catch (e) { console.error("lu update error:", e); setAlertMsg("更新失敗：" + e.message); }
  };
  const handleLuCopyDates = async (appt, targets) => {
    const batch = writeBatch(db);
    let sk = 0;
    const { id, ...base } = appt;
    targets.forEach(ds => {
      if (luSlotOccupied(luAppts, ds, base.time, base.duration, null)) { sk++; return; }
      const ref = doc(collection(db, "luAppts"));
      batch.set(ref, { ...base, date: ds, checkedIn: false });
    });
    await batch.commit();
    const added = targets.length - sk;
    setAlertMsg(`已複製 ${added} 筆${sk ? `（${sk} 筆跳過）` : ""}`);
  };

  // ── Config writers (wrap setters to sync to Firestore) ──
  const fireSetMainSlotCfg = (updater) => {
    const next = typeof updater === "function" ? updater(mainSlotCfg) : updater;
    const clean = {}; Object.entries(next).forEach(([k, v]) => { if (v !== undefined) clean[k] = v; });
    setDoc(doc(db, "config", "mainSlotCfg"), clean).catch(e => { console.error("mainSlotCfg write error:", e); setAlertMsg("寫入失敗：" + e.message); });
  };
  const fireSetLuSlotCfg = (updater) => {
    const next = typeof updater === "function" ? updater(luSlotCfg) : updater;
    const clean = {}; Object.entries(next).forEach(([k, v]) => { if (v !== undefined) clean[k] = v; });
    setDoc(doc(db, "config", "luSlotCfg"), clean).catch(e => { console.error("luSlotCfg write error:", e); setAlertMsg("寫入失敗：" + e.message); });
  };
  const fireSetCs = (updater) => {
    const next = typeof updater === "function" ? updater(cs) : updater;
    setDoc(doc(db, "config", "shifts"), next).catch(e => { console.error("shifts write error:", e); setAlertMsg("寫入失敗：" + e.message); });
  };

  const isAdmin = page === "admin";

  return (<div style={{ minHeight: "100vh", background: "#F8F2E6", fontFamily: "'Noto Sans TC', sans-serif" }}>
    <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;600;700&family=Noto+Serif+TC:wght@400;700&display=swap" rel="stylesheet" />
    <header style={{ background: "linear-gradient(135deg, #3D2B1F, #5A3A2A)", padding: "10px 18px", boxShadow: "0 4px 20px rgba(0,0,0,0.15)" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ width: 32, height: 32, borderRadius: 7, background: "#C2563A", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🤲</div><h1 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#F5EDDC", fontFamily: "'Noto Serif TC', serif", letterSpacing: 1 }}>徒手治療預約{isAdmin && " — 後台"}</h1></div>
        <div style={{ display: "flex", gap: 3, alignItems: "center", flexWrap: "wrap" }}>
          {isAdmin ? (<>
            {[{ k: "schedule", l: "排程表" }, { k: "lu", l: "盧獨立時段" }, { k: "salary", l: "薪資" }, { k: "shifts", l: "班表" }].map(t => (<button key={t.k} onClick={() => setAdminTab(t.k)} style={{ padding: "5px 10px", borderRadius: 5, border: "none", cursor: "pointer", background: adminTab === t.k ? (t.k === "lu" ? LU_COLOR : "#C2563A") : "rgba(255,255,255,0.1)", color: adminTab === t.k ? "white" : "#C4B49A", fontWeight: 600, fontSize: 14, fontFamily: "'Noto Sans TC', sans-serif" }}>{t.l}</button>))}
            <div style={{ width: 1, height: 18, background: "#5A4A3A", margin: "0 4px" }} /><button onClick={() => setPage("front")} style={{ padding: "5px 10px", borderRadius: 5, border: "1px solid #C4B49A55", background: "transparent", color: "#C4B49A", cursor: "pointer", fontSize: 13 }}>返回前台</button>
          </>) : (<>
            {[{ k: "book", l: "📅 預約" }, { k: "lookup", l: "🔍 查詢及取消" }].map(t => (<button key={t.k} onClick={() => setFrontTab(t.k)} style={{ padding: "6px 12px", borderRadius: 5, border: "none", cursor: "pointer", background: frontTab === t.k ? "#C2563A" : "rgba(255,255,255,0.1)", color: frontTab === t.k ? "white" : "#C4B49A", fontWeight: 600, fontSize: 14, fontFamily: "'Noto Sans TC', sans-serif" }}>{t.l}</button>))}
            <div style={{ width: 1, height: 18, background: "#5A4A3A", margin: "0 4px" }} /><button onClick={() => setPage("admin-gate")} style={{ padding: "5px 10px", borderRadius: 5, border: "1px solid #C4B49A55", background: "transparent", color: "#C4B49A", cursor: "pointer", fontSize: 10 }}>🔐 後台</button>
          </>)}
        </div>
      </div>
    </header>

    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "14px 10px" }}>
      {fireErr && <div style={{ background: "#FEE2E2", border: "1.5px solid #EF4444", borderRadius: 8, padding: "10px 14px", marginBottom: 12, color: "#991B1B", fontSize: 13, fontWeight: 600 }}>⚠️ {fireErr}</div>}
      {/* ── FRONT ── */}
      {page === "front" && frontTab === "book" && (<>
        <div style={{ background: "#FFFDF5", border: "1.5px solid #E0D5C1", borderRadius: 10, padding: "14px 16px", marginBottom: 12, fontSize: 17, color: "#5A4A3A", lineHeight: 1.8 }}>
          <div style={{ fontWeight: 700, color: "#3D2B1F", fontSize: 19, marginBottom: 8, fontFamily: "'Noto Serif TC', serif" }}>📋 預約說明</div>
          <div style={{ paddingLeft: 4 }}>
            <div style={{ marginBottom: 4 }}><span style={{ color: "#C2563A", fontWeight: 700 }}>1.</span> 初診患者請務必經過門診才可預約治療。若未經過門診，報到時本院可能取消您的預約。</div>
            <div style={{ marginBottom: 4 }}><span style={{ color: "#C2563A", fontWeight: 700 }}>2.</span> 點選空白時段或特定治療師進行預約。當日不開放線上預約，請來電洽詢。</div>
            <div style={{ marginBottom: 4 }}><span style={{ color: "#C2563A", fontWeight: 700 }}>3.</span> 預約完成後，為保護個資，該空格將轉為黑色。請點選「查詢及取消」，並輸入身分證字號查詢預約是否成功。</div>
            <div style={{ marginBottom: 4 }}><span style={{ color: "#C2563A", fontWeight: 700 }}>4.</span> 預約後若無法報到，請至少於一天前線上取消。若反覆未報到且未取消，將收回您預約的權限，以維護所有患者的權益。</div>
            <div><span style={{ color: "#C2563A", fontWeight: 700 }}>5.</span> 若連續顯示「此時段無可預約的治療師」，可能當月班表尚未安排，請耐心等待。謝謝。</div>
          </div>
        </div>
        <NavCtrl selDate={selDate} setSelDate={setSelDate} viewMode="week" setViewMode={() => {}} showDayView={false} /><div style={{ display: "flex", gap: 10, marginBottom: 10, padding: "7px 12px", background: "#FFFDF5", borderRadius: 7, border: "1px solid #E0D5C1", fontSize: 14 }}><span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ display: "inline-block", width: 16, height: 12, borderRadius: 2, background: "#2A2A2A" }} /><span>未開放或已占用</span></span><span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ display: "inline-block", width: 16, height: 12, borderRadius: 2, background: "#FFFDF5", border: "1px solid #D4C5A9" }} /><span>可預約（點擊）</span></span>{filterTh && <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ display: "inline-block", width: 16, height: 12, borderRadius: 2, background: "#E8E3D8", opacity: 0.65 }} /><span>無班或須緩衝</span></span>}</div><ThFilterBar filterTh={filterTh} setFilterTh={setFilterTh} showNames onLuClick={() => setLuChoiceModal(true)} /><FrontWeekGrid appts={appts} selDate={selDate} onCellClick={(d, t) => setBookingModal({ date: d, time: t })} mainSlotCfg={mainSlotCfg} filterTh={filterTh} cs={cs} /></>)}

      {page === "front" && frontTab === "lu" && (<><NavCtrl selDate={selDate} setSelDate={setSelDate} viewMode="week" setViewMode={() => {}} showDayView={false} /><div style={{ display: "flex", gap: 10, marginBottom: 10, padding: "7px 12px", background: "#F8FDFB", borderRadius: 7, border: `1px solid ${LU_COLOR}30`, fontSize: 14, alignItems: "center" }}><span style={{ fontWeight: 700, color: LU_COLOR }}>盧獨立時段</span><span style={{ color: "#8B7355" }}>14:00 - 20:45</span></div><LuFrontWeekGrid appts={luAppts} selDate={selDate} onCellClick={(d, t) => setLuBookingModal({ date: d, time: t })} luSlotCfg={luSlotCfg} /></>)}

      {page === "front" && frontTab === "lookup" && <div style={{ paddingTop: 20 }}><PhoneLookup appts={appts} luAppts={luAppts} onDelete={handleFrontDelete} onLuDelete={handleFrontLuDelete} /></div>}
      {page === "admin-gate" && <PwGate onAuth={() => setPage("admin")} />}

      {/* ── ADMIN ── */}
      {isAdmin && adminTab === "schedule" && (<><NavCtrl selDate={selDate} setSelDate={setSelDate} viewMode={adminView} setViewMode={setAdminView} showDayView={true} /><ThFilterBar filterTh={filterTh} setFilterTh={setFilterTh} /><div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10, padding: "5px 12px", background: "#FFFDF5", borderRadius: 7, border: "1px solid #E0D5C1", fontSize: 13, alignItems: "center" }}>{THERAPISTS.map(t => (<span key={t.id} style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ display: "inline-flex", width: 14, height: 14, borderRadius: "50%", background: t.color, color: "white", fontSize: 8, fontWeight: 700, alignItems: "center", justifyContent: "center" }}>{t.id}</span><span>{t.name}</span></span>))}<span style={{ borderLeft: "1px solid #D4C5A9", paddingLeft: 8, display: "flex", gap: 6 }}><span style={{ color: "#2E7D6F", fontWeight: 600 }}>■班內</span><span style={{ color: "#C2563A", fontWeight: 600 }}>┈班外</span><span style={{ color: "#FFD700", fontWeight: 600 }}>▮已報到</span></span></div>
        {adminView === "day" ? <AdminDayView appts={appts} selDate={selDate} onCellClick={(d, t) => setBookingModal({ date: d, time: t })} onApptClick={a => setAdminDetailModal(a)} mainSlotCfg={mainSlotCfg} setMainSlotCfg={fireSetMainSlotCfg} /> : <AdminWeekGrid appts={appts} selDate={selDate} onCellClick={(d, t) => setBookingModal({ date: d, time: t })} onApptClick={a => setAdminDetailModal(a)} filterTh={filterTh} cs={cs} />}</>)}

      {isAdmin && adminTab === "lu" && (<><NavCtrl selDate={selDate} setSelDate={setSelDate} viewMode={luAdminView} setViewMode={setLuAdminView} showDayView={true} />
        {luAdminView === "day" ? <LuAdminDayView appts={luAppts} selDate={selDate} onCellClick={(d, t) => setLuBookingModal({ date: d, time: t })} onApptClick={a => setLuDetailModal(a)} luSlotCfg={luSlotCfg} setLuSlotCfg={fireSetLuSlotCfg} />
        : <LuAdminWeekGrid appts={luAppts} selDate={selDate} onCellClick={(d, t) => setLuBookingModal({ date: d, time: t })} onApptClick={a => setLuDetailModal(a)} luSlotCfg={luSlotCfg} />}</>)}

      {isAdmin && adminTab === "salary" && <SalarySummary appts={appts} luAppts={luAppts} cs={cs} />}
      {isAdmin && adminTab === "shifts" && <ShiftEditor customShifts={cs} setCustomShifts={fireSetCs} />}
    </main>

    {/* ── MODALS ── */}
    <Modal open={!!bookingModal} onClose={() => setBookingModal(null)} title={bookingModal?.addExtra ? "外加預約" : "新增預約"}>{bookingModal && <BookingForm date={bookingModal.date} time={bookingModal.time} appts={appts} onBook={handleBook} onClose={() => setBookingModal(null)} isAdmin={isAdmin} cs={cs} mainSlotCfg={mainSlotCfg} addExtra={bookingModal.addExtra} />}</Modal>
    <Modal open={!!luBookingModal} onClose={() => setLuBookingModal(null)} title="盧獨立時段預約">{luBookingModal && <LuBookingForm date={luBookingModal.date} time={luBookingModal.time} appts={luAppts} onBook={handleLuBook} onClose={() => setLuBookingModal(null)} isAdmin={isAdmin} luSlotCfg={luSlotCfg} />}</Modal>
    <Modal open={!!adminDetailModal} onClose={() => setAdminDetailModal(null)} title="預約管理">{adminDetailModal && <AdminDetail appt={adminDetailModal} appts={appts} onClose={() => setAdminDetailModal(null)} onDelete={handleDelete} onUpdate={handleUpdate} onAlert={setAlertMsg} onCopyDates={handleCopyDates} onAddExtra={(a) => { setAdminDetailModal(null); setBookingModal({ date: new Date(a.date), time: a.time, addExtra: true }); }} />}</Modal>
    <Modal open={!!luDetailModal} onClose={() => setLuDetailModal(null)} title="盧獨立時段預約管理">{luDetailModal && <LuAdminDetail appt={luDetailModal} appts={luAppts} onClose={() => setLuDetailModal(null)} onDelete={handleLuDelete} onUpdate={handleLuUpdate} onAlert={setAlertMsg} onCopyDates={handleLuCopyDates} />}</Modal>
    <AlertModal open={!!alertMsg} message={alertMsg} onClose={() => setAlertMsg("")} />
    {/* Lu morning/afternoon choice */}
    <Modal open={luChoiceModal} onClose={() => setLuChoiceModal(false)} title="請問想預約盧老師上午或午後時段？">
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "10px 0" }}>
        <p style={{ fontSize: 14, color: "#3D2B1F", margin: "0 0 8px 0", textAlign: "center" }}>請選擇盧治療師的預約時段</p>
        <button onClick={() => { setLuChoiceModal(false); setFilterTh("B"); }} style={{ padding: 14, borderRadius: 9, border: "1.5px solid #2E7D6F", background: "#FFFDF5", color: "#2E7D6F", cursor: "pointer", fontWeight: 700, fontSize: 15, fontFamily: "'Noto Sans TC', sans-serif" }}>🌅 上午（一般預約時段）</button>
        <button onClick={() => { setLuChoiceModal(false); setFilterTh(null); setFrontTab("lu"); }} style={{ padding: 14, borderRadius: 9, border: `1.5px solid ${LU_COLOR}`, background: "#E8F5F0", color: LU_COLOR, cursor: "pointer", fontWeight: 700, fontSize: 15, fontFamily: "'Noto Sans TC', sans-serif" }}>🌆 午後（盧獨立時段 14:00-20:45）</button>
      </div>
    </Modal>
  </div>);
}
