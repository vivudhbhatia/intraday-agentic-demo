function v(id){ return document.getElementById(id).value.trim(); }
function setText(id, obj){ document.getElementById(id).textContent = JSON.stringify(obj, null, 2); }

async function post(url, body){
  const r = await fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)});
  if(!r.ok) throw new Error(await r.text());
  return await r.json();
}
async function get(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error(await r.text());
  return await r.json();
}

document.getElementById("btnStart").onclick = async () => {
  const scenario = v("scenarioId");
  const seed = parseInt(v("seed") || "42", 10);
  const sim = v("simUrl");
  const res = await post(`${sim}/scenario/start`, {scenario_id: scenario, seed});
  setText("riskState", res);
};

document.getElementById("btnStep").onclick = async () => {
  const scenario = v("scenarioId");
  const sim = v("simUrl");
  const res = await post(`${sim}/scenario/step`, {scenario_id: scenario, minutes: 5});
  setText("riskState", res);
};

document.getElementById("btnReset").onclick = async () => {
  const scenario = v("scenarioId");
  const sim = v("simUrl");
  const res = await post(`${sim}/scenario/reset?scenario_id=${encodeURIComponent(scenario)}`, {});
  setText("riskState", res);
};

document.getElementById("btnRun").onclick = async () => {
  const scenario = v("scenarioId");
  const currency = v("currency");
  const riskUrl = v("riskUrl");
  const orch = v("orchUrl");

  const risk = await get(`${riskUrl}/risk_state?scenario_id=${encodeURIComponent(scenario)}&entity_id=E1&currency=${encodeURIComponent(currency)}`);
  setText("riskState", risk);

  const recs = await post(`${orch}/run_cycle?scenario_id=${encodeURIComponent(scenario)}&entity_id=E1&currency=${encodeURIComponent(currency)}`, {});
  setText("recs", recs);
};
