const ORCH = window.APP_CONFIG.ORCH_URL;
const RISK = window.APP_CONFIG.RISK_URL;
const SIM  = window.APP_CONFIG.SIM_URL;

let chart;

function qs(id){ return document.getElementById(id); }

function money(n){ return "$" + Number(n).toLocaleString(); }

function status(r){
  if(!r.minutes_to_breach) return ["SAFE","status-safe","badge-safe"];
  if(r.minutes_to_breach < 30) return ["IMMINENT","status-breach","badge-breach"];
  return ["EARLY WARNING","status-warn","badge-warn"];
}

function drawChart(r){
  const ctx = qs("chart");

  const labels = r.forecast.map(f=>f.t.slice(11,16));
  const data = r.forecast.map(f=>f.balance);

  if(chart) chart.destroy();

  chart = new Chart(ctx,{
    type:"line",
    data:{
      labels,
      datasets:[{
        label:"Balance",
        data,
        borderColor:"#2563eb",
        tension:0.2
      },{
        label:"Buffer",
        data:labels.map(()=>r.early_warning_buffer),
        borderColor:"#dc2626",
        borderDash:[5,5]
      }]
    },
    options:{plugins:{legend:{display:true}}}
  });
}

function renderStatus(r){
  const [txt,cls,bg] = status(r);

  qs("statusBox").innerHTML = `
    <div class="${cls}">
      <span class="badge ${bg}">${txt}</span>
      Balance ${money(r.current_balance)} |
      Buffer left ${money(r.buffer_remaining)} |
      ${r.minutes_to_breach? r.minutes_to_breach+" min to breach": "No breach"}
    </div>
  `;
}

function renderDrivers(r){
  qs("drivers").textContent =
    r.drivers
      .slice(0,5)
      .map(d=>`${d.direction} ${money(d.amount)} ${d.rail}`)
      .join("\n");
}

function renderRecs(r){
  if(!r.ranked_actions?.length){
    qs("recPanel").innerHTML =
      "<div>No action required</div><div>"+r.explanation+"</div>";
    return;
  }

  qs("recPanel").innerHTML =
    "<ul class='actions'>" +
    r.ranked_actions
      .map(a=>`<li><b>${a.action}</b> – ${a.rationale}</li>`)
      .join("") +
    "</ul>";
}

async function get(url){
  const r = await fetch(url);
  if(!r.ok) throw await r.text();
  return r.json();
}

async function post(url,b={}){
  const r = await fetch(url,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(b)
  });
  if(!r.ok) throw await r.text();
  return r.json();
}

async function assess(){
  const sc = qs("scenarioId").value;
  const c  = qs("currency").value;

  const risk = await get(
    `${RISK}/risk_state?scenario_id=${sc}&entity_id=E1&currency=${c}`
  );

  renderStatus(risk);
  drawChart(risk);
  renderDrivers(risk);

  const rec = await post(
    `${ORCH}/run_cycle?scenario_id=${sc}&entity_id=E1&currency=${c}`,{}
  );

  renderRecs(rec);
}

qs("btnStart").onclick = async()=>{
  await post(`${SIM}/scenario/start`,
    {scenario_id:qs("scenarioId").value, seed:42});
  await assess();
};

qs("btnStep").onclick = async()=>{
  await post(`${SIM}/scenario/step`,
    {scenario_id:qs("scenarioId").value, minutes:5});
  await assess();
};

qs("btnRun").onclick = assess;
