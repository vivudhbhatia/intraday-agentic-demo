function v(id){ return document.getElementById(id).value.trim(); }
function setText(id, obj){ document.getElementById(id).textContent = JSON.stringify(obj, null, 2); }

function cfg(key, fallback){
  // Reads from ui/config.js: window.APP_CONFIG = {...}
  const val = window.APP_CONFIG && window.APP_CONFIG[key];
  return (val && String(val).trim()) ? String(val).trim() : (fallback || "");
}

async function post(url, body){
  const r = await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body ?? {})
  });
  if(!r.ok) throw new Error(await r.text());
  return await r.json();
}

async function get(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error(await r.text());
  return await r.json();
}

// Prefer config.js defaults; fall back to input boxes if you kept them in index.html
function simUrl(){ return cfg("SIM_URL", v("simUrl")); }
function riskUrl(){ return cfg("RISK_URL", v("riskUrl")); }
function orchUrl(){ return cfg("ORCH_URL", v("orchUrl")); }

document.getElementById("btnStart").onclick = async () => {
  try{
    const scenario = v("scenarioId");
    const seed = parseInt(v("seed") || "42", 10);
    const res = await post(`${simUrl()}/scenario/start`, {scenario_id: scenario, seed});
    setText("riskState", res);
  } catch(e){
    setText("riskState", {error: String(e)});
  }
};

document.getElementById("btnStep").onclick = async () => {
  try{
    const scenario = v("scenarioId");
    const res = await post(`${simUrl()}/scenario/step`, {scenario_id: scenario, minutes: 5});
    setText("riskState", res);
  } catch(e){
    setText("riskState", {error: String(e)});
  }
};

document.getElementById("btnReset").onclick = async () => {
  try{
    const scenario = v("scenarioId");
    const res = await post(`${simUrl()}/scenario/reset?scenario_id=${encodeURIComponent(scenario)}`, {});
    setText("riskState", res);
  } catch(e){
    setText("riskState", {error: String(e)});
  }
};

document.getElementById("btnRun").onclick = async () => {
  try{
    const scenario = v("scenarioId");
    const currency = v("currency") || "USD";

    // Show risk state
    const risk = await get(`${riskUrl()}/risk_state?scenario_id=${encodeURIComponent(scenario)}&entity_id=E1&currency=${encodeURIComponent(currency)}`);
    setText("riskState", risk);

    // Run agent cycle (send {} so Content-Length is set; avoids 411)
    const recs = await post(`${orchUrl()}/run_cycle?scenario_id=${encodeURIComponent(scenario)}&entity_id=E1&currency=${encodeURIComponent(currency)}`, {});
    setText("recs", recs);
  } catch(e){
    setText("recs", {error: String(e)});
  }
};
