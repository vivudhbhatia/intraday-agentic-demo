function qs(id){ return document.getElementById(id); }
function v(id){ return qs(id).value.trim(); }

function cfg(key, fallback){
  const val = window.APP_CONFIG && window.APP_CONFIG[key];
  return (val && String(val).trim()) ? String(val).trim() : (fallback || "");
}

function setCfgInputs(){
  qs("simUrl").value  = cfg("SIM_URL",  qs("simUrl").value);
  qs("riskUrl").value = cfg("RISK_URL", qs("riskUrl").value);
  qs("orchUrl").value = cfg("ORCH_URL", qs("orchUrl").value);
}

function SIM(){ return v("simUrl"); }
function RISK(){ return v("riskUrl"); }
function ORCH(){ return v("orchUrl"); }

function money(n){
  if(n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  const abs = Math.abs(x);
  const fmt = abs >= 1e9 ? (x/1e9).toFixed(2)+"B" :
              abs >= 1e6 ? (x/1e6).toFixed(2)+"M" :
              x.toLocaleString();
  return "$" + fmt;
}

async function get(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error(await r.text());
  return await r.json();
}

async function post(url, body){
  const r = await fetch(url, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify(body ?? {})
  });
  if(!r.ok) throw new Error(await r.text());
  return await r.json();
}

let chart = null;
let whatif = { shockPct: 0, delayMin: 0 };

function severity(minutesToBreach, warnMins, breachMins){
  if(minutesToBreach === null || minutesToBreach === undefined) return {level:"SAFE", css:"ok"};
  const mtb = Number(minutesToBreach);
  if(mtb <= breachMins) return {level:"IMMINENT BREACH", css:"bad"};
  if(mtb <= warnMins)   return {level:"EARLY WARNING", css:"warn"};
  return {level:"WATCH", css:"warn"};
}

function applyWhatifToForecast(risk){
  // UI-only overlay: increase outflows by shock% and delay inflows by delayMin by shifting IN event times in drivers
  // For simplicity: we adjust the forecast curve by subtracting a proportional amount based on shockPct.
  if(!risk || !risk.forecast) return risk;

  const shock = Number(whatif.shockPct || 0) / 100;
  const delay = Number(whatif.delayMin || 0);

  const outflowApprox = shock * 0.02; // small but visible adjustment on forecast (demo)
  const adjusted = structuredClone(risk);

  adjusted.forecast = adjusted.forecast.map((p, i) => {
    const base = Number(p.balance);
    const drift = base * outflowApprox * (i/Math.max(1, adjusted.forecast.length-1));
    return {...p, balance: base - drift};
  });

  // If delayMin applied, we "weaken" near-term inflow effect a bit (demo)
  if(delay > 0){
    adjusted.forecast = adjusted.forecast.map((p, i) => {
      const base = Number(p.balance);
      const penalty = base * 0.004 * Math.min(1, delay/60) * (1 - i/Math.max(1, adjusted.forecast.length-1));
      return {...p, balance: base - penalty};
    });
  }
  return adjusted;
}

function drawChart(risk){
  const ctx = qs("chart");
  const rr = applyWhatifToForecast(risk);

  const labels = rr.forecast.map(f => (f.t || "").slice(11,16));
  const balances = rr.forecast.map(f => Number(f.balance));
  const bufferLine = labels.map(() => Number(rr.early_warning_buffer));

  if(chart) chart.destroy();

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label:"Balance", data: balances, borderWidth: 2, tension: 0.25 },
        { label:"Early-warning buffer", data: bufferLine, borderDash:[6,6], borderWidth: 2 }
      ]
    },
    options: {
      responsive:true,
      plugins:{ legend:{display:true} },
      scales:{ y:{ ticks:{ callback:(val)=> money(val) } } }
    }
  });
}

function renderKPIs(r){
  qs("kpiBalance").textContent   = money(r.current_balance);
  qs("kpiBuffer").textContent    = money(r.early_warning_buffer);
  qs("kpiRemaining").textContent = money(r.buffer_remaining);
  qs("kpiMTB").textContent       = (r.minutes_to_breach === null || r.minutes_to_breach === undefined) ? "—" : `${r.minutes_to_breach} min`;
}

function renderDrivers(r){
  const tb = qs("driversTbl").querySelector("tbody");
  tb.innerHTML = "";
  (r.drivers || []).slice(0,8).forEach(d => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${(d.ts||"").slice(11,16)}</td>
      <td>${d.direction||""}</td>
      <td>${money(d.amount)}</td>
      <td>${d.rail||""}</td>
      <td>${d.status||""}</td>
      <td>${d.priority||""}</td>
    `;
    tb.appendChild(tr);
  });
}

function renderAlerts(r){
  const warnMins = Number(v("warnMins") || 60);
  const breachMins = Number(v("breachMins") || 30);

  const sev = severity(r.minutes_to_breach, warnMins, breachMins);
  const alerts = [];

  // Primary alert
  if(r.minutes_to_breach === null || r.minutes_to_breach === undefined){
    alerts.push({css:"ok", t:"Stable", d:"No early-warning breach projected in current horizon."});
  } else if(Number(r.minutes_to_breach) <= breachMins){
    alerts.push({css:"bad", t:"Imminent breach", d:`Projected breach in ${r.minutes_to_breach} min. Immediate action required.`});
  } else {
    alerts.push({css:"warn", t:"Early warning", d:`Projected breach in ${r.minutes_to_breach} min. Prepare playbooks.`});
  }

  // Secondary: large queued outflows
  const queued = (r.drivers||[]).filter(x => x.direction==="OUT" && x.status==="QUEUED");
  if(queued.length){
    const amt = queued.reduce((s,x)=>s+Number(x.amount||0),0);
    alerts.push({css:"warn", t:"Queued outflows", d:`${queued.length} queued outflows (~${money(amt)}). Queue management may help.`});
  }

  // What-if banner
  if(Number(whatif.shockPct)>0 || Number(whatif.delayMin)>0){
    alerts.push({css:"warn", t:"What-if overlay active", d:`Outflow shock ${whatif.shockPct}% | Inflow delay ${whatif.delayMin} min (visual overlay).`});
  }

  const box = qs("alerts");
  box.innerHTML = "";
  alerts.forEach(a => {
    const div = document.createElement("div");
    div.className = `alert ${a.css}`;
    div.innerHTML = `<div class="t">${a.t}</div><div class="d">${a.d}</div>`;
    box.appendChild(div);
  });

  // Header pill
  const pill = qs("statusPill");
  pill.textContent = sev.level;
  pill.style.borderColor =
    sev.css === "ok" ? "rgba(22,163,74,0.5)" :
    sev.css === "warn" ? "rgba(245,158,11,0.6)" :
    "rgba(220,38,38,0.6)";
}

function renderRecs(rec){
  const box = qs("recs");
  box.innerHTML = "";

  if(!rec || !rec.ranked_actions || rec.ranked_actions.length === 0){
    box.innerHTML = `<div class="actionCard"><div class="actionTop"><div class="actionName">No action required</div></div><div class="actionWhy">${rec?.explanation || ""}</div></div>`;
    return;
  }

  rec.ranked_actions.forEach((a, idx) => {
    const div = document.createElement("div");
    div.className = "actionCard";
    div.innerHTML = `
      <div class="actionTop">
        <div class="actionName">${idx+1}. ${a.action || "ACTION"}</div>
        <div class="hint">score: ${a.score ?? "—"}</div>
      </div>
      <div class="actionWhy">${a.rationale || a.reason || "—"}</div>
      <button class="btn actionBtn" data-action="${encodeURIComponent(JSON.stringify(a))}">Select for approval</button>
    `;
    div.querySelector("button").onclick = () => {
      qs("selectedAction").value = a.action || "ACTION";
      qs("selectedAction").dataset.payload = JSON.stringify(a);
    };
    box.appendChild(div);
  });
}

async function assessAndMaybeRunAgent({forceAgent=false}={}){
  const scenario = v("scenarioId");
  const entity_id = v("entity");
  const currency = v("currency");

  // 1) Risk state
  const risk = await get(`${RISK()}/risk_state?scenario_id=${encodeURIComponent(scenario)}&entity_id=${encodeURIComponent(entity_id)}&currency=${encodeURIComponent(currency)}`);

  renderKPIs(risk);
  drawChart(risk);
  renderDrivers(risk);
  renderAlerts(risk);

  // 2) Agent
  const warnMins = Number(v("warnMins") || 60);
  const mtb = risk.minutes_to_breach;
  const shouldRun = forceAgent || (qs("autoagent").checked && mtb !== null && mtb !== undefined && Number(mtb) <= warnMins);

  if(shouldRun){
    const rec = await post(`${ORCH()}/run_cycle?scenario_id=${encodeURIComponent(scenario)}&entity_id=${encodeURIComponent(entity_id)}&currency=${encodeURIComponent(currency)}`, {});
    renderRecs(rec);
  }
}

function wireWhatif(){
  const sp = qs("shockPct");
  const dm = qs("delayMin");
  qs("shockPctVal").textContent = sp.value;
  qs("delayMinVal").textContent = dm.value;

  sp.oninput = () => qs("shockPctVal").textContent = sp.value;
  dm.oninput = () => qs("delayMinVal").textContent = dm.value;

  qs("btnApplyWhatif").onclick = async () => {
    whatif.shockPct = Number(sp.value);
    whatif.delayMin = Number(dm.value);
    await assessAndMaybeRunAgent({forceAgent:false});
  };
  qs("btnClearWhatif").onclick = async () => {
    sp.value = 0; dm.value = 0;
    whatif = {shockPct:0, delayMin:0};
    qs("shockPctVal").textContent = "0";
    qs("delayMinVal").textContent = "0";
    await assessAndMaybeRunAgent({forceAgent:false});
  };
}

function wireButtons(){
  qs("btnStart").onclick = async () => {
    const scenario = v("scenarioId");
    const seed = parseInt(v("seed") || "42", 10);
    await post(`${SIM()}/scenario/start`, {scenario_id: scenario, seed});
    await assessAndMaybeRunAgent({forceAgent:true});
  };

  qs("btnStep").onclick = async () => {
    const scenario = v("scenarioId");
    await post(`${SIM()}/scenario/step`, {scenario_id: scenario, minutes: 5});
    await assessAndMaybeRunAgent({forceAgent:false});
  };

  qs("btnReset").onclick = async () => {
    const scenario = v("scenarioId");
    await post(`${SIM()}/scenario/reset?scenario_id=${encodeURIComponent(scenario)}`, {});
    await assessAndMaybeRunAgent({forceAgent:false});
  };

  qs("btnRun").onclick = async () => {
    await assessAndMaybeRunAgent({forceAgent:true});
  };

  qs("btnApprove").onclick = async () => {
    const payload = qs("selectedAction").dataset.payload;
    const scenario = v("scenarioId");
    const entity_id = v("entity");
    const currency = v("currency");
    if(!payload){
      qs("approvalResp").textContent = "Select an action first.";
      return;
    }
    const action = JSON.parse(payload);
    // Requires backend endpoint (section B)
    const resp = await post(`${ORCH()}/actions/approve`, {
      scenario_id: scenario,
      entity_id,
      currency,
      decision: "APPROVE",
      action
    });
    qs("approvalResp").textContent = JSON.stringify(resp, null, 2);
  };

  qs("btnReject").onclick = async () => {
    const payload = qs("selectedAction").dataset.payload;
    const scenario = v("scenarioId");
    const entity_id = v("entity");
    const currency = v("currency");
    if(!payload){
      qs("approvalResp").textContent = "Select an action first.";
      return;
    }
    const action = JSON.parse(payload);
    const resp = await post(`${ORCH()}/actions/approve`, {
      scenario_id: scenario,
      entity_id,
      currency,
      decision: "REJECT",
      action
    });
    qs("approvalResp").textContent = JSON.stringify(resp, null, 2);
  };
}

let timer = null;
function wireLiveMode(){
  qs("autorefresh").onchange = async () => {
    if(qs("autorefresh").checked){
      timer = setInterval(async () => {
        try { await assessAndMaybeRunAgent({forceAgent:false}); } catch(e) { /* ignore */ }
      }, 2000);
    } else {
      if(timer) clearInterval(timer);
      timer = null;
    }
  };
}

(function init(){
  setCfgInputs();
  wireWhatif();
  wireButtons();
  wireLiveMode();
})();
