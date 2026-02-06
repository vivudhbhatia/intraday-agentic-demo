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

function severity(minutesToBreach, warnMins, breachMins){
  if(minutesToBreach === null || minutesToBreach === undefined) return {level:"SAFE", css:"ok"};
  const mtb = Number(minutesToBreach);
  if(mtb <= breachMins) return {level:"IMMINENT BREACH", css:"bad"};
  if(mtb <= warnMins)   return {level:"EARLY WARNING", css:"warn"};
  return {level:"WATCH", css:"warn"};
}

let chart = null;
function drawMainChart(risk){
  const ctx = qs("chart");
  const labels = (risk.forecast||[]).map(f => (f.t||"").slice(11,16));
  const balances = (risk.forecast||[]).map(f => Number(f.balance));
  const bufferLine = labels.map(() => Number(risk.early_warning_buffer));

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
  if(r.minutes_to_breach === null || r.minutes_to_breach === undefined){
    alerts.push({css:"ok", t:"Stable", d:"No early-warning breach projected in current horizon."});
  } else if(Number(r.minutes_to_breach) <= breachMins){
    alerts.push({css:"bad", t:"Imminent breach", d:`Projected breach in ${r.minutes_to_breach} min. Immediate action required.`});
  } else {
    alerts.push({css:"warn", t:"Early warning", d:`Projected breach in ${r.minutes_to_breach} min. Prepare playbooks.`});
  }

  const queued = (r.drivers||[]).filter(x => x.direction==="OUT" && x.status==="QUEUED");
  if(queued.length){
    const amt = queued.reduce((s,x)=>s+Number(x.amount||0),0);
    alerts.push({css:"warn", t:"Queued outflows", d:`${queued.length} queued outflows (~${money(amt)}). Queue management may help.`});
  }

  const box = qs("alerts");
  box.innerHTML = "";
  alerts.forEach(a => {
    const div = document.createElement("div");
    div.className = `alert ${a.css}`;
    div.innerHTML = `<div class="t">${a.t}</div><div class="d">${a.d}</div>`;
    box.appendChild(div);
  });

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
      <button class="btn actionBtn">Select for approval</button>
    `;
    div.querySelector("button").onclick = () => {
      qs("selectedAction").value = a.action || "ACTION";
      qs("selectedAction").dataset.payload = JSON.stringify(a);
    };
    box.appendChild(div);
  });
}

function setLastRefresh(){
  const d = new Date();
  qs("lastRef").textContent = `Last refresh: ${d.toLocaleTimeString()}`;
}

async function riskState(entity_id, currency){
  const scenario = v("scenarioId");
  return await get(`${RISK()}/risk_state?scenario_id=${encodeURIComponent(scenario)}&entity_id=${encodeURIComponent(entity_id)}&currency=${encodeURIComponent(currency)}`);
}

/* ----- Portfolio tiles + sparklines ----- */

const PORT_ENTITIES = ["E1","E2","E3"];
const PORT_CCY = ["USD","EUR"];
const tileCharts = new Map();

function tileKey(e,c){ return `${e}__${c}`; }

function drawSpark(canvas, forecast, buffer){
  const labels = forecast.map(f => (f.t||"").slice(11,16));
  const balances = forecast.map(f => Number(f.balance));
  const buf = labels.map(()=>Number(buffer));

  const existing = tileCharts.get(canvas);
  if(existing) existing.destroy();

  const ch = new Chart(canvas, {
    type:"line",
    data:{ labels, datasets:[
      {label:"b", data:balances, borderWidth:1.5, tension:0.3, pointRadius:0},
      {label:"buf", data:buf, borderDash:[4,4], borderWidth:1.2, pointRadius:0}
    ]},
    options:{
      responsive:true,
      plugins:{legend:{display:false}, tooltip:{enabled:false}},
      scales:{x:{display:false}, y:{display:false}}
    }
  });
  tileCharts.set(canvas, ch);
}

function renderPortfolio(tiles){
  const grid = qs("portfolioGrid");
  grid.innerHTML = "";

  tiles.forEach(t => {
    const sev = t.sev;
    const div = document.createElement("div");
    div.className = "tile";
    div.innerHTML = `
      <div class="tileTop">
        <div class="tileTitle">${t.entity} • ${t.currency}</div>
        <div class="chip ${sev.css}">${sev.level === "IMMINENT BREACH" ? "IMMINENT" : sev.level === "EARLY WARNING" ? "WARNING" : "SAFE"}</div>
      </div>
      <div class="tileMid">
        <div>
          <div class="tileNum">${money(t.balance)}</div>
          <div class="tileSub">buffer left ${money(t.remaining)}</div>
        </div>
        <div>
          <div class="tileNum">${t.mtb == null ? "—" : t.mtb+"m"}</div>
          <div class="tileSub">to breach</div>
        </div>
      </div>
      <div class="sparkWrap"><canvas class="spark"></canvas></div>
    `;

    div.onclick = async () => {
      qs("entity").value = t.entity;
      qs("currency").value = t.currency;
      await assessAndMaybeRunAgent({forceAgent:false});
    };

    grid.appendChild(div);

    const canvas = div.querySelector("canvas");
    drawSpark(canvas, t.forecast, t.buffer);
  });
}

function renderExecStrip(tiles){
  const warnMins = Number(v("warnMins") || 60);
  const breachMins = Number(v("breachMins") || 30);

  let warnCount = 0, breachCount = 0;
  let worst = null;

  tiles.forEach(t=>{
    const mtb = t.mtb;
    if(mtb != null){
      if(mtb <= breachMins) breachCount++;
      else if(mtb <= warnMins) warnCount++;
      worst = (worst == null) ? mtb : Math.min(worst, mtb);
    }
  });

  const status =
    breachCount > 0 ? "IMMINENT BREACH RISK" :
    warnCount > 0 ? "ELEVATED / EARLY WARNING" :
    "STABLE";

  qs("execStatus").textContent = status;
  qs("execWorstMTB").textContent = worst == null ? "—" : `${worst} min`;
  qs("execWarnCount").textContent = String(warnCount);
  qs("execBreachCount").textContent = String(breachCount);
}

async function refreshPortfolio(){
  const warnMins = Number(v("warnMins") || 60);
  const breachMins = Number(v("breachMins") || 30);

  const tiles = [];
  for(const e of PORT_ENTITIES){
    for(const c of PORT_CCY){
      try{
        const r = await riskState(e,c);
        const sev = severity(r.minutes_to_breach, warnMins, breachMins);
        tiles.push({
          entity:e, currency:c,
          balance:r.current_balance,
          remaining:r.buffer_remaining,
          buffer:r.early_warning_buffer,
          mtb:r.minutes_to_breach,
          forecast:r.forecast || [],
          sev
        });
      }catch(err){
        tiles.push({
          entity:e, currency:c, balance:null, remaining:null, buffer:null, mtb:null, forecast:[],
          sev:{level:"OFFLINE", css:"bad"}
        });
      }
    }
  }

  renderPortfolio(tiles);
  renderExecStrip(tiles);
}

/* ----- Main assess ----- */

async function assessAndMaybeRunAgent({forceAgent=false}={}){
  const scenario = v("scenarioId");
  const entity_id = v("entity");
  const currency = v("currency");

  const risk = await get(`${RISK()}/risk_state?scenario_id=${encodeURIComponent(scenario)}&entity_id=${encodeURIComponent(entity_id)}&currency=${encodeURIComponent(currency)}`);

  renderKPIs(risk);
  drawMainChart(risk);
  renderDrivers(risk);
  renderAlerts(risk);

  const warnMins = Number(v("warnMins") || 60);
  const mtb = risk.minutes_to_breach;
  const shouldRun = forceAgent || (qs("autoagent").checked && mtb !== null && mtb !== undefined && Number(mtb) <= warnMins);

  if(shouldRun){
    const rec = await post(`${ORCH()}/run_cycle?scenario_id=${encodeURIComponent(scenario)}&entity_id=${encodeURIComponent(entity_id)}&currency=${encodeURIComponent(currency)}`, {});
    renderRecs(rec);
  }

  setLastRefresh();
  await refreshPortfolio();
}

/* ----- Playback ----- */

let playTimer = null;

async function doStep(){
  const scenario = v("scenarioId");
  const step = Number(qs("stepSize").value || 5);
  await post(`${SIM()}/scenario/step`, {scenario_id: scenario, minutes: step});
  await assessAndMaybeRunAgent({forceAgent:false});
}

function play(){
  const interval = Number(qs("playSpeed").value || 2000);
  if(playTimer) clearInterval(playTimer);
  playTimer = setInterval(async ()=>{ try{ await doStep(); }catch(e){} }, interval);
}
function pause(){
  if(playTimer) clearInterval(playTimer);
  playTimer = null;
}

/* ----- Demo tour ----- */

function tour(){
  alert(
`Demo tour (60 seconds):
1) Start scenario → portfolio tiles populate (multi-entity / multi-ccy)
2) Press Play → forecast curves move in near real time
3) Watch status chip flip SAFE → WARNING → IMMINENT
4) Auto-run agent on warnings to show playbooks
5) Select an action → Approve to show governance + audit trail`
  );
}

/* ----- Buttons ----- */

function wireButtons(){
  qs("btnStart").onclick = async () => {
    const scenario = v("scenarioId");
    const seed = parseInt(v("seed") || "42", 10);
    await post(`${SIM()}/scenario/start`, {scenario_id: scenario, seed});
    await assessAndMaybeRunAgent({forceAgent:true});
  };

  qs("btnRun").onclick = async () => {
    await assessAndMaybeRunAgent({forceAgent:true});
  };

  qs("btnStep").onclick = doStep;

  qs("btnPlay").onclick = play;
  qs("btnPause").onclick = pause;

  qs("btnReset").onclick = async () => {
    pause();
    const scenario = v("scenarioId");
    await post(`${SIM()}/scenario/reset?scenario_id=${encodeURIComponent(scenario)}`, {});
    await assessAndMaybeRunAgent({forceAgent:false});
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
    const resp = await post(`${ORCH()}/actions/approve`, {
      scenario_id, entity_id, currency, decision:"APPROVE", action
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
      scenario_id, entity_id, currency, decision:"REJECT", action
    });
    qs("approvalResp").textContent = JSON.stringify(resp, null, 2);
  };

  qs("btnTour").onclick = tour;
}

/* ----- Init ----- */
(function init(){
  setCfgInputs();
  wireButtons();
  refreshPortfolio().catch(()=>{});
})();
