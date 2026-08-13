/* ============================================================================
   ELECTION CENTER — URNA ELEITORAL RPG
   Projeto independente do site de apuração.

   CONFIGURAÇÃO:
   1) Crie um NOVO projeto Firebase.
   2) Cole o firebaseConfig abaixo.
   3) Ative Authentication > Email/Password e crie UMA conta de admin.
   4) Coloque o e-mail dessa conta em ADMIN_EMAIL e o UID em ADMIN_UID.
   5) Publique database.rules.json no Realtime Database, substituindo ADMIN_UID_AQUI.
   ============================================================================ */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAPfsNMvBurQR3zWqQq21uNMKWb0FRJg1k",
  authDomain: "ballotbox-641e4.firebaseapp.com",
  databaseURL: "https://ballotbox-641e4-default-rtdb.firebaseio.com",
  projectId: "ballotbox-641e4",
  storageBucket: "ballotbox-641e4.firebasestorage.app",
  messagingSenderId: "376974694128",
  appId: "1:376974694128:web:7325698bffb777fa8e1435",
  measurementId: "G-VYJW7EFG4Y"
};

const ADMIN_EMAIL = "khailanabdala15@gmail.com";
const ADMIN_UID = "0s0BWZQW6cXy3OFQJbQGY59CW4J3";

const STATES = [
  ["AL","Alabama"],["AK","Alasca"],["AZ","Arizona"],["AR","Arkansas"],["CA","Califórnia"],
  ["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],["DC","Distrito de Columbia"],["FL","Flórida"],
  ["GA","Geórgia"],["HI","Havaí"],["ID","Idaho"],["IL","Illinois"],["IN","Indiana"],["IA","Iowa"],
  ["KS","Kansas"],["KY","Kentucky"],["LA","Luisiana"],["ME","Maine"],["MD","Maryland"],["MA","Massachusetts"],
  ["MI","Michigan"],["MN","Minnesota"],["MS","Mississippi"],["MO","Missouri"],["MT","Montana"],["NE","Nebraska"],
  ["NV","Nevada"],["NH","New Hampshire"],["NJ","Nova Jersey"],["NM","Novo México"],["NY","Nova York"],
  ["NC","Carolina do Norte"],["ND","Dakota do Norte"],["OH","Ohio"],["OK","Oklahoma"],["OR","Oregon"],
  ["PA","Pensilvânia"],["RI","Rhode Island"],["SC","Carolina do Sul"],["SD","Dakota do Sul"],["TN","Tennessee"],
  ["TX","Texas"],["UT","Utah"],["VT","Vermont"],["VA","Virgínia"],["WA","Washington"],
  ["WV","Virgínia Ocidental"],["WI","Wisconsin"],["WY","Wyoming"]
].map(([a,n])=>({a,n}));
const STATE_BY_ABBR = Object.fromEntries(STATES.map(s=>[s.a,s]));

let db = null;
let auth = null;
let firebaseReady = true;
let publicElections = {};
let currentElection = null;
let publicListener = null;

let voter = null;
let ballotSteps = [];
let ballotStepIndex = 0;
let selections = { president:null, governor:null, congress:[] };
let lastReceipt = null;

let adminUser = null;
let editingElection = null;
let editingElectionId = null;
let editorStateAbbr = "FL";
let adminBallotsCache = {};
let resultsElectionId = null;
let auditElectionId = null;

const $ = id => document.getElementById(id);
const clone = obj => JSON.parse(JSON.stringify(obj));
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
const nowIso = () => new Date().toISOString();
const stateName = abbr => STATE_BY_ABBR[abbr]?.n || abbr || "—";
const asObject = value => (value && typeof value === "object") ? value : {};
const candidateList = map => Object.values(asObject(map)).sort((a,b)=>(a.order||0)-(b.order||0) || String(a.name||"").localeCompare(String(b.name||"")));
const validBallots = ballots => Object.values(asObject(ballots)).filter(b=>b && b.status !== "invalid");

function makeId(prefix="id"){
  const rnd = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9]/g,"").slice(0,14);
  return `${prefix}-${rnd}`.toLowerCase();
}
function makeCandidate(name="Novo candidato", party="IND", color="#64748B"){
  return { id:makeId("cand"), name, party, color, photo:"", order:Date.now() };
}
function defaultElection(){
  const year = new Date().getFullYear();
  return {
    id:makeId("election"), year, name:`Eleição Geral de ${year}`, description:"",
    status:"draft", createdAt:nowIso(), updatedAt:nowIso(),
    president:{ candidates:{} }, states:{}
  };
}
function ensureStateConfig(election, abbr){
  election.states = election.states || {};
  if(!election.states[abbr]){
    election.states[abbr] = {
      enabled:false,
      governor:{candidates:{}},
      congress:{seats:1,candidates:{}}
    };
  }
  election.states[abbr].governor ||= {candidates:{}};
  election.states[abbr].governor.candidates ||= {};
  election.states[abbr].congress ||= {seats:1,candidates:{}};
  election.states[abbr].congress.candidates ||= {};
  election.states[abbr].congress.seats = Math.max(1, parseInt(election.states[abbr].congress.seats,10)||1);
  return election.states[abbr];
}
function normalizeDiscord(raw){
  let value = String(raw||"").trim();
  if(value.startsWith("@")) value = value.slice(1);
  return value.toLowerCase().replace(/\s+/g,"");
}
async function discordKey(norm){
  const bytes = new TextEncoder().encode(norm);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
function candidateInitials(name){
  return String(name||"?").split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase();
}
function avatarHtml(c, cls="candidate-avatar"){
  if(c.photo) return `<img class="${cls}" src="${escapeHtml(c.photo)}" alt="${escapeHtml(c.name)}" onerror="this.outerHTML='<div class=&quot;${cls}&quot; style=&quot;background:${escapeHtml(c.color||'#64748B')}&quot;>${escapeHtml(candidateInitials(c.name))}</div>'">`;
  return `<div class="${cls}" style="background:${escapeHtml(c.color||'#64748B')}">${escapeHtml(candidateInitials(c.name))}</div>`;
}
function showToast(message){
  const t = $("toast"); t.textContent = message; t.hidden = false;
  clearTimeout(t._timer); t._timer=setTimeout(()=>t.hidden=true,2400);
}
function fmtDate(ts){
  if(!ts) return "—";
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if(Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"});
}
function setScreen(id){
  ["screenClosed","screenHome","screenIdentity","screenBallot","screenReview","screenReceipt"].forEach(x=>$(x).hidden=x!==id);
  window.scrollTo({top:0,behavior:"smooth"});
}
function setAdminVisible(visible){
  $("publicApp").hidden=visible;
  $("adminApp").hidden=!visible;
  $("adminToggle").classList.toggle("on",visible);
  $("adminToggle").textContent=visible?"Painel administrativo":"Entrar como admin";
}
function isConfigured(){
  return FIREBASE_CONFIG.apiKey &&
         FIREBASE_CONFIG.apiKey !== "COLE_AQUI" &&
         FIREBASE_CONFIG.databaseURL &&
         FIREBASE_CONFIG.databaseURL !== "COLE_AQUI";
}

/* ============================== FIREBASE =================================== */
function initFirebase(){
  if(!isConfigured()){
    $("configWarning").hidden=false;
    firebaseReady=false;
    renderClosed("O sistema ainda não foi conectado ao Firebase. Configure o projeto antes de abrir a votação.");
    return;
  }
  try{
    firebase.initializeApp(FIREBASE_CONFIG);
    db=firebase.database(); auth=firebase.auth(); firebaseReady=true;
    auth.onAuthStateChanged(async user=>{
      if(user && user.uid===ADMIN_UID){
        adminUser=user;
        $("adminSessionLabel").textContent=`Administrador autenticado · ${user.email || user.uid}`;
      }else{
        if(user && user.uid!==ADMIN_UID) await auth.signOut().catch(()=>{});
        adminUser=null;
        if(!$("adminApp").hidden) setAdminVisible(false);
      }
    });
    listenPublicElections();
  }catch(err){
    console.error(err); $("configWarning").hidden=false;
    renderClosed("Falha ao conectar ao Firebase. Verifique a configuração do projeto.");
  }
}
function listenPublicElections(){
  if(!firebaseReady) return;
  if(publicListener) db.ref("public/elections").off("value",publicListener);
  publicListener = snap=>{
    publicElections = snap.val() || {};
    chooseLatestOpenElection();
    if(adminUser) renderAdminElectionCards();
  };
  db.ref("public/elections").on("value",publicListener,err=>{
    console.error(err); renderClosed("Não foi possível carregar as eleições.");
  });
}
function chooseLatestOpenElection(){
  const open = Object.values(publicElections).filter(e=>e && e.status==="open");
  open.sort((a,b)=>(Number(b.year)||0)-(Number(a.year)||0) || String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
  const next = open[0] || null;
  if(currentElection?.id && next?.id===currentElection.id){ currentElection=next; renderHeaderElection(); return; }
  currentElection=next;
  resetVoterSession(false);
  renderHeaderElection();
  if(currentElection) renderHome(); else renderClosed("Não há nenhuma eleição aberta neste momento.");
}
function renderHeaderElection(){
  $("headerElectionLabel").textContent=currentElection?`${currentElection.name} · ${currentElection.year}`:"Nenhuma votação aberta";
}

/* ============================== PUBLIC APP ================================= */
function renderClosed(message){
  $("closedMessage").textContent=message;
  setScreen("screenClosed");
  renderHeaderElection();
}
function renderHome(){
  if(!currentElection){renderClosed("Não há nenhuma eleição aberta neste momento.");return;}
  $("homeElectionName").textContent=currentElection.name || "Eleição";
  $("homeElectionYear").textContent=currentElection.year || "—";
  $("homeElectionDescription").textContent=currentElection.description || "A votação está aberta. Inicie para registrar seu voto.";
  const enabled=Object.values(asObject(currentElection.states)).filter(s=>s?.enabled).length;
  $("homeStateCount").textContent=enabled;
  setScreen("screenHome");
}
function resetVoterSession(goHome=true){
  voter=null; ballotSteps=[]; ballotStepIndex=0; selections={president:null,governor:null,congress:[]}; lastReceipt=null;
  $("identityForm")?.reset();
  if(goHome){ if(currentElection) renderHome(); else renderClosed("Não há nenhuma eleição aberta neste momento."); }
}
function openIdentity(){
  if(!currentElection || currentElection.status!=="open"){renderClosed("A votação foi encerrada.");return;}
  const enabledStates=STATES.filter(s=>currentElection.states?.[s.a]?.enabled);
  if(!enabledStates.length){showToast("Nenhum estado foi habilitado nesta eleição.");return;}
  $("stateInput").innerHTML=`<option value="">Selecione...</option>`+enabledStates.map(s=>`<option value="${s.a}">${escapeHtml(s.n)} (${s.a})</option>`).join("");
  setScreen("screenIdentity");
}
function buildBallotSteps(){
  const st=currentElection.states?.[voter.state] || {};
  const steps=[];
  const pres=candidateList(currentElection.president?.candidates);
  if(pres.length) steps.push({key:"president",title:"Presidência",subtitle:"Disputa nacional",mode:"single",candidates:pres});
  const gov=candidateList(st.governor?.candidates);
  if(gov.length) steps.push({key:"governor",title:`Governador de ${stateName(voter.state)}`,subtitle:"Disputa estadual",mode:"single",candidates:gov});
  const con=candidateList(st.congress?.candidates);
  if(con.length){
    const seats=Math.min(con.length,Math.max(1,parseInt(st.congress?.seats,10)||1));
    steps.push({key:"congress",title:`Congressista · ${stateName(voter.state)}`,subtitle:`${seats} ${seats===1?'assento em disputa':'assentos em disputa'}`,mode:"multi",limit:seats,candidates:con});
  }
  ballotSteps=steps; ballotStepIndex=0;
}
function renderBallot(){
  if(!currentElection || !voter) return renderHome();
  if(!ballotSteps.length) buildBallotSteps();
  if(!ballotSteps.length){showToast("Esta eleição não possui candidatos configurados.");return renderHome();}
  const step=ballotSteps[ballotStepIndex];
  $("ballotElectionTitle").textContent=`${currentElection.name} · ${currentElection.year}`;
  $("ballotVoterLine").textContent=`${voter.firstName} ${voter.lastName} · @${voter.discordNorm} · ${stateName(voter.state)}`;
  $("ballotStepLabel").textContent=`Etapa ${ballotStepIndex+1} de ${ballotSteps.length}`;
  $("ballotProgress").style.width=`${((ballotStepIndex+1)/ballotSteps.length)*100}%`;
  const selected=step.mode==="multi"?selections[step.key]:(selections[step.key]?[selections[step.key]]:[]);
  $("ballotRaceCard").innerHTML=`
    <div class="race-banner"><div class="race-type">${escapeHtml(step.subtitle)}</div><h3>${escapeHtml(step.title)}</h3>
    <p>${step.mode==="multi"?`Selecione até ${step.limit} candidato(s).`:'Selecione um candidato.'}</p></div>
    <div class="candidate-grid">${step.candidates.map((c,i)=>`
      <label class="candidate-option ${selected.includes(c.id)?'selected':''}" data-candidate-id="${c.id}" style="--candidate-color:${escapeHtml(c.color||'#64748B')}">
        <input type="${step.mode==='multi'?'checkbox':'radio'}" name="raceChoice" value="${c.id}" ${selected.includes(c.id)?'checked':''}>
        <span class="candidate-stripe"></span>
        <span class="candidate-number">${String(i+1).padStart(2,'0')}</span>
        ${avatarHtml(c)}
        <div class="candidate-copy"><div class="candidate-name">${escapeHtml(c.name)}</div><div class="candidate-party">${escapeHtml(c.party||'Sem partido')}</div><div class="candidate-action-label">${selected.includes(c.id)?'SELECIONADO':'SELECIONAR CANDIDATO'}</div></div>
        <div class="candidate-check">✓</div>
      </label>`).join("")}</div>
    ${step.mode==='multi'?`<div class="candidate-limit" id="candidateLimitText">Selecionados: ${selected.length} de ${step.limit}</div>`:''}`;
  document.querySelectorAll(".candidate-option").forEach(label=>label.addEventListener("click",ev=>{
    ev.preventDefault(); selectCandidate(step,label.dataset.candidateId);
  }));
  $("ballotBackBtn").textContent=ballotStepIndex===0?"Voltar à identificação":"Voltar";
  $("ballotNextBtn").textContent=ballotStepIndex===ballotSteps.length-1?"Revisar voto":"Continuar";
  setScreen("screenBallot");
}
function selectCandidate(step,candidateId){
  if(step.mode==="single") selections[step.key]=candidateId;
  else{
    let arr=Array.isArray(selections[step.key])?[...selections[step.key]]:[];
    if(arr.includes(candidateId)) arr=arr.filter(id=>id!==candidateId);
    else if(arr.length<step.limit) arr.push(candidateId);
    else {showToast(`Você pode escolher no máximo ${step.limit} candidato(s).`);return;}
    selections[step.key]=arr;
  }
  renderBallot();
}
function currentStepHasSelection(){
  const step=ballotSteps[ballotStepIndex];
  if(!step) return false;
  return step.mode==="multi" ? Array.isArray(selections[step.key]) && selections[step.key].length>0 : !!selections[step.key];
}
function candidateFor(raceKey,id,state=voter?.state,election=currentElection){
  if(!id||!election) return null;
  let map={};
  if(raceKey==="president") map=election.president?.candidates;
  else if(raceKey==="governor") map=election.states?.[state]?.governor?.candidates;
  else map=election.states?.[state]?.congress?.candidates;
  return asObject(map)[id] || null;
}
function renderReview(){
  $("reviewIdentity").innerHTML=`<span><b>Eleitor:</b> ${escapeHtml(voter.firstName)} ${escapeHtml(voter.lastName)}</span><span><b>Discord:</b> @${escapeHtml(voter.discordNorm)}</span><span><b>Estado:</b> ${escapeHtml(stateName(voter.state))}</span>`;
  const rows=[];
  if(selections.president){const c=candidateFor("president",selections.president); rows.push(reviewRow("Presidente",c));}
  if(selections.governor){const c=candidateFor("governor",selections.governor); rows.push(reviewRow("Governador",c));}
  if(selections.congress?.length){const cs=selections.congress.map(id=>candidateFor("congress",id)).filter(Boolean); rows.push(reviewRowMulti("Congressista(s)",cs));}
  $("reviewChoices").innerHTML=rows.join("");
  $("confirmVoteCheck").checked=false; $("submitVoteBtn").disabled=true; $("submitError").hidden=true;
  setScreen("screenReview");
}
function reviewRow(label,c){
  if(!c) return `<div class="review-row"><div class="review-race">${label}</div><div class="review-choice">—</div></div>`;
  return `<div class="review-row" style="border-left-color:${escapeHtml(c.color||'#0A1930')}"><div class="review-race">${label}</div><div class="review-choice">${escapeHtml(c.name)}<small>${escapeHtml(c.party||'Sem partido')}</small></div></div>`;
}
function reviewRowMulti(label,cs){
  return `<div class="review-row"><div class="review-race">${label}</div><div class="review-choice">${cs.map(c=>`${escapeHtml(c.name)} <small style="display:inline">(${escapeHtml(c.party||'Sem partido')})</small>`).join("<br>")}</div></div>`;
}
async function submitVote(){
  if(!firebaseReady){showSubmitError("Firebase não está configurado. O voto não foi enviado.");return;}
  if(!currentElection || currentElection.status!=="open"){showSubmitError("A votação foi encerrada antes da confirmação. Nenhum voto foi registrado.");return;}
  $("submitVoteBtn").disabled=true; $("submitVoteBtn").textContent="COMPUTANDO...";
  const norm=normalizeDiscord(voter.discordNorm);
  const key=await discordKey(norm);
  const voteId=makeId("ballot");
  const receiptCode=`BALLOT-${Math.random().toString(36).slice(2,10).toUpperCase()}`;
  const congressMap={}; (selections.congress||[]).forEach(id=>congressMap[id]=true);
  const ballot={
    voteId, receiptCode, submittedAt:firebase.database.ServerValue.TIMESTAMP, status:"valid",
    voter:{firstName:voter.firstName,lastName:voter.lastName,discord:voter.discordOriginal,discordNorm:norm,state:voter.state},
    choices:{president:selections.president}
  };
  if(selections.governor) ballot.choices.governor=selections.governor;
  if(Object.keys(congressMap).length) ballot.choices.congress=congressMap;
  try{
    await db.ref(`private/elections/${currentElection.id}/ballots/${key}`).set(ballot);
    lastReceipt={...clone(ballot),submittedAt:Date.now()};
    renderReceipt();
  }catch(err){
    console.error(err);
    showSubmitError("O voto não foi aceito. As causas mais comuns são: este @Discord já votou nesta eleição ou a votação foi encerrada. Se acreditar que é um erro, procure a administração.");
  }finally{
    $("submitVoteBtn").textContent="CONFIRMAR E COMPUTAR VOTO";
  }
}
function showSubmitError(msg){$("submitError").textContent=msg;$("submitError").hidden=false;$("submitVoteBtn").disabled=!$("confirmVoteCheck").checked;}
function renderReceipt(){
  const r=lastReceipt; if(!r) return;
  $("receiptMeta").innerHTML=`
    <div>Eleição<b>${escapeHtml(currentElection.name)} · ${escapeHtml(currentElection.year)}</b></div>
    <div>Código do boletim<b>${escapeHtml(r.receiptCode)}</b></div>
    <div>Eleitor<b>${escapeHtml(voter.firstName)} ${escapeHtml(voter.lastName)} · @${escapeHtml(voter.discordNorm)}</b></div>
    <div>Estado<b>${escapeHtml(stateName(voter.state))}</b></div>
    <div>Registrado em<b>${escapeHtml(fmtDate(r.submittedAt))}</b></div>
    <div>ID interno<b>${escapeHtml(r.voteId)}</b></div>`;
  const rows=[];
  const p=candidateFor("president",selections.president); if(p) rows.push(reviewRow("Presidente",p));
  const g=candidateFor("governor",selections.governor); if(g) rows.push(reviewRow("Governador",g));
  const cs=(selections.congress||[]).map(id=>candidateFor("congress",id)).filter(Boolean); if(cs.length) rows.push(reviewRowMulti("Congressista(s)",cs));
  $("receiptChoices").innerHTML=rows.join("");
  setScreen("screenReceipt");
}

/* ============================== ADMIN AUTH ================================= */
function openAdminLogin(){
  if(!firebaseReady){showToast("Configure o Firebase antes de entrar como admin.");return;}
  if(adminUser){setAdminVisible(true);renderAdmin();return;}
  $("adminLoginError").hidden=true;$("adminPasswordInput").value="";$("adminLoginModal").hidden=false;setTimeout(()=>$("adminPasswordInput").focus(),50);
}
async function adminLogin(password){
  $("adminLoginError").hidden=true;
  try{
    const cred=await auth.signInWithEmailAndPassword(ADMIN_EMAIL,password);
    if(cred.user.uid!==ADMIN_UID){await auth.signOut();throw new Error("Conta sem permissão administrativa.");}
    adminUser=cred.user;$("adminLoginModal").hidden=true;setAdminVisible(true);renderAdmin();showToast("Modo administrador ativado.");
  }catch(err){console.error(err);$("adminLoginError").textContent="Senha incorreta ou configuração administrativa inválida.";$("adminLoginError").hidden=false;}
}
async function adminLogout(){
  await auth?.signOut().catch(()=>{});adminUser=null;editingElection=null;editingElectionId=null;setAdminVisible(false);chooseLatestOpenElection();showToast("Sessão administrativa encerrada.");
}
function renderAdmin(){
  renderAdminElectionCards(); populateAdminElectionSelectors(); switchAdminTab("elections");
}
function switchAdminTab(tab){
  document.querySelectorAll(".admin-tab").forEach(b=>b.classList.toggle("active",b.dataset.adminTab===tab));
  document.querySelectorAll(".admin-tab-page").forEach(p=>p.hidden=p.id!==`adminTab-${tab}`);
  if(tab==="elections")renderAdminElectionCards();
  if(tab==="editor")renderEditor();
  if(tab==="results")loadResults(resultsElectionId||newestElectionId());
  if(tab==="audit")loadAudit(auditElectionId||newestElectionId());
}
function electionList(){return Object.values(publicElections).filter(Boolean).sort((a,b)=>(Number(b.year)||0)-(Number(a.year)||0)||String(b.createdAt||"").localeCompare(String(a.createdAt||"")));}
function newestElectionId(){return electionList()[0]?.id||null;}
function statusLabel(status){return status==="open"?"ABERTA":status==="closed"?"FECHADA":"RASCUNHO";}
function enabledStateCount(e){return Object.values(asObject(e.states)).filter(s=>s?.enabled).length;}
function renderAdminElectionCards(){
  const host=$("electionCards"); if(!host)return;
  const list=electionList();
  if(!list.length){host.innerHTML=`<div class="empty-state">Nenhuma eleição cadastrada.</div>`;return;}
  host.innerHTML=list.map(e=>`<article class="election-admin-card ${escapeHtml(e.status||'draft')}">
    <div class="eac-top"><div><div class="eac-year">${escapeHtml(e.year)}</div><div class="eac-name">${escapeHtml(e.name)}</div></div><span class="status-badge ${escapeHtml(e.status||'draft')}">${statusLabel(e.status)}</span></div>
    <div class="eac-meta">${enabledStateCount(e)} estados habilitados · criada em ${escapeHtml(fmtDate(e.createdAt))}</div>
    <div class="eac-actions">
      <button class="secondary-btn small" data-action="edit" data-id="${e.id}">Editar</button>
      ${e.status==="open"?`<button class="secondary-btn small" data-action="close" data-id="${e.id}">Fechar</button>`:`<button class="primary-btn small" data-action="open" data-id="${e.id}">Abrir</button>`}
      <button class="secondary-btn small" data-action="results" data-id="${e.id}">Resultados</button>
      <button class="secondary-btn small danger-mini" data-action="delete" data-id="${e.id}">Apagar</button>
    </div></article>`).join("");
  host.querySelectorAll("button[data-action]").forEach(btn=>btn.onclick=()=>handleElectionAction(btn.dataset.action,btn.dataset.id));
}
async function handleElectionAction(action,id){
  const e=publicElections[id]; if(!e)return;
  if(action==="edit"){openEditor(id);return;}
  if(action==="results"){resultsElectionId=id;switchAdminTab("results");return;}
  if(action==="open"||action==="close"){
    const next=action==="open"?"open":"closed";
    try{await db.ref(`public/elections/${id}`).update({status:next,updatedAt:nowIso()});showToast(next==="open"?"Urna aberta.":"Urna fechada.");}
    catch(err){console.error(err);showToast("Falha ao alterar status.");}
    return;
  }
  if(action==="delete"){
    const conf=window.prompt(`Esta ação apaga a urna ${e.year} E todos os votos armazenados nela. Para confirmar, digite EXCLUIR ${e.year}:`);
    if(conf!==`EXCLUIR ${e.year}`){showToast("Exclusão cancelada.");return;}
    try{
      await db.ref(`public/elections/${id}`).remove(); await db.ref(`private/elections/${id}`).remove();
      if(editingElectionId===id){editingElection=null;editingElectionId=null;}
      delete adminBallotsCache[id]; showToast("Urna apagada definitivamente.");
    }catch(err){console.error(err);showToast("Falha ao apagar urna.");}
  }
}
function createElection(){
  editingElection=defaultElection();editingElectionId=editingElection.id;editorStateAbbr="FL";renderEditor();switchAdminTab("editor");
}
function openEditor(id){
  const e=publicElections[id];if(!e)return;editingElection=clone(e);editingElectionId=id;editorStateAbbr=Object.keys(asObject(e.states)).find(a=>e.states[a]?.enabled)||"FL";switchAdminTab("editor");
}

/* ============================== ADMIN EDITOR =============================== */
function renderEditor(){
  if(!editingElection){$("editorEmptyState").hidden=false;$("editorWorkspace").hidden=true;return;}
  $("editorEmptyState").hidden=true;$("editorWorkspace").hidden=false;
  $("editorYear").value=editingElection.year||"";$("editorName").value=editingElection.name||"";$("editorDescription").value=editingElection.description||"";
  $("editorStatusBadge").textContent=statusLabel(editingElection.status);$("editorStatusBadge").className=`status-badge ${editingElection.status||'draft'}`;
  $("editorElectionSummary").innerHTML=`<b>${escapeHtml(editingElection.name)}</b><br>${escapeHtml(editingElection.year)} · ${statusLabel(editingElection.status)}<br>${enabledStateCount(editingElection)} estados habilitados`;
  renderCandidateEditor("presidentCandidateEditor",editingElection.president?.candidates||{},"president");
  renderEditorStateList();renderStateEditor();
}
function syncGeneralEditor(){
  if(!editingElection)return;
  editingElection.year=parseInt($("editorYear").value,10)||editingElection.year;
  editingElection.name=$("editorName").value.trim()||`Eleição ${editingElection.year}`;
  editingElection.description=$("editorDescription").value.trim();
  editingElection.updatedAt=nowIso();
}
function renderEditorStateList(){
  const q=$("stateSearchInput").value.trim().toLowerCase();
  const list=STATES.filter(s=>!q||s.n.toLowerCase().includes(q)||s.a.toLowerCase().includes(q));
  $("editorStateList").innerHTML=list.map(s=>{const enabled=!!editingElection.states?.[s.a]?.enabled;return `<button class="state-config-item ${s.a===editorStateAbbr?'active':''} ${enabled?'enabled':''}" data-state="${s.a}">${escapeHtml(s.n)} <small>${s.a}</small></button>`}).join("");
  $("editorStateList").querySelectorAll("button").forEach(b=>b.onclick=()=>{syncStateEditor();editorStateAbbr=b.dataset.state;renderStateEditor();renderEditorStateList();});
}
function renderStateEditor(){
  if(!editingElection)return;
  const cfg=ensureStateConfig(editingElection,editorStateAbbr);
  $("stateEditorTitle").textContent=`${stateName(editorStateAbbr)} (${editorStateAbbr})`;
  $("stateEnabledToggle").checked=!!cfg.enabled;$("stateEditorBody").hidden=!cfg.enabled;
  $("congressSeatsInput").value=cfg.congress.seats||1;
  renderCandidateEditor("governorCandidateEditor",cfg.governor.candidates,"governor");
  renderCandidateEditor("congressCandidateEditor",cfg.congress.candidates,"congress");
}
function syncStateEditor(){
  if(!editingElection)return;
  const cfg=ensureStateConfig(editingElection,editorStateAbbr);
  cfg.enabled=$("stateEnabledToggle").checked;
  cfg.congress.seats=Math.max(1,Math.min(20,parseInt($("congressSeatsInput").value,10)||1));
}
function renderCandidateEditor(hostId,map,raceKey){
  const host=$(hostId);const list=candidateList(map);
  if(!list.length){host.innerHTML=`<div class="empty-state" style="padding:18px 5px">Nenhum candidato cadastrado.</div>`;return;}
  host.innerHTML=list.map(c=>`<div class="candidate-edit-row" data-candidate="${c.id}" data-race="${raceKey}">
    <input type="text" data-field="name" value="${escapeHtml(c.name)}" placeholder="Nome">
    <input type="text" data-field="party" value="${escapeHtml(c.party||'')}" placeholder="Partido">
    <input type="color" data-field="color" value="${escapeHtml(c.color||'#64748B')}" title="Cor">
    <input type="text" data-field="photo" value="${escapeHtml(c.photo||'')}" placeholder="URL da foto (opcional)">
    <button class="candidate-delete" title="Excluir">×</button></div>`).join("");
  host.querySelectorAll(".candidate-edit-row").forEach(row=>{
    row.querySelectorAll("input").forEach(inp=>inp.addEventListener("input",()=>updateCandidateFromRow(row)));
    row.querySelector(".candidate-delete").onclick=()=>deleteCandidate(row.dataset.race,row.dataset.candidate);
  });
}
function candidateMapForRace(race){
  if(race==="president"){editingElection.president ||= {candidates:{}}; editingElection.president.candidates ||= {}; return editingElection.president.candidates;}
  const cfg=ensureStateConfig(editingElection,editorStateAbbr); return race==="governor"?cfg.governor.candidates:cfg.congress.candidates;
}
function updateCandidateFromRow(row){
  const map=candidateMapForRace(row.dataset.race),c=map[row.dataset.candidate];if(!c)return;
  row.querySelectorAll("input").forEach(inp=>c[inp.dataset.field]=inp.value);
}
function addCandidate(race){
  const map=candidateMapForRace(race);const c=makeCandidate();map[c.id]=c;
  if(race==="president")renderCandidateEditor("presidentCandidateEditor",map,race);
  else renderStateEditor();
}
function deleteCandidate(race,id){
  const map=candidateMapForRace(race);delete map[id];
  if(race==="president")renderCandidateEditor("presidentCandidateEditor",map,race);else renderStateEditor();
}
async function saveElection(){
  if(!adminUser||!editingElection)return;
  syncGeneralEditor();syncStateEditor();
  if(!candidateList(editingElection.president?.candidates).length){showToast("Cadastre pelo menos um candidato à Presidência.");return;}
  if(!enabledStateCount(editingElection)){showToast("Habilite pelo menos um estado.");return;}
  editingElection.updatedAt=nowIso(); editingElection.id=editingElectionId;
  try{await db.ref(`public/elections/${editingElectionId}`).set(editingElection);showToast("Eleição salva.");populateAdminElectionSelectors();renderEditor();}
  catch(err){console.error(err);showToast("Falha ao salvar eleição.");}
}

/* ============================== RESULTS ==================================== */
function populateAdminElectionSelectors(){
  const list=electionList();const html=list.map(e=>`<option value="${e.id}">${escapeHtml(e.year)} — ${escapeHtml(e.name)}</option>`).join("");
  [$("resultsElectionSelect"),$("auditElectionSelect")].forEach(sel=>{if(!sel)return;const prev=sel.value;sel.innerHTML=html;if(list.some(e=>e.id===prev))sel.value=prev;});
}
async function getAdminBallots(id,force=false){
  if(!id||!adminUser)return{};
  if(adminBallotsCache[id]&&!force)return adminBallotsCache[id];
  try{const snap=await db.ref(`private/elections/${id}/ballots`).once("value");adminBallotsCache[id]=snap.val()||{};return adminBallotsCache[id];}
  catch(err){console.error(err);showToast("Não foi possível carregar os votos.");return{};}
}
async function loadResults(id){
  if(!id){renderEmptyResults();return;}resultsElectionId=id;populateAdminElectionSelectors();$("resultsElectionSelect").value=id;
  const election=publicElections[id];if(!election)return renderEmptyResults();
  const ballots=await getAdminBallots(id,true);renderResults(election,ballots);
}
function renderEmptyResults(){
  $("resultsSummaryCards").innerHTML=`<div class="empty-state">Nenhuma eleição disponível.</div>`;$("nationalPresidentResults").innerHTML="";$("nationalCongressResults").innerHTML="";$("stateResults").innerHTML="";
}
function renderResults(election,ballotsObj){
  const all=Object.values(asObject(ballotsObj)).filter(Boolean);const ballots=validBallots(ballotsObj);const statesWithVotes=new Set(ballots.map(b=>b.voter?.state).filter(Boolean));
  $("resultsSummaryCards").innerHTML=`
    <div class="summary-card"><span>Eleitores válidos</span><b>${ballots.length}</b></div>
    <div class="summary-card"><span>Estados com votos</span><b>${statesWithVotes.size}</b></div>
    <div class="summary-card"><span>Votos invalidados</span><b>${all.length-ballots.length}</b></div>
    <div class="summary-card"><span>Último voto</span><b style="font-size:15px">${escapeHtml(fmtDate(Math.max(0,...all.map(b=>Number(b.submittedAt)||0))))}</b></div>`;
  const presCandidates=candidateList(election.president?.candidates);const presCounts=countSingle(ballots,"president",presCandidates.map(c=>c.id));
  $("nationalPresidentResults").innerHTML=resultRows(presCandidates,presCounts);
  const partyCounts={};let congressVotes=0;
  ballots.forEach(b=>Object.keys(asObject(b.choices?.congress)).forEach(cid=>{const c=candidateForElection(election,b.voter?.state,"congress",cid);const p=c?.party||"Outros";partyCounts[p]=(partyCounts[p]||0)+1;congressVotes++;}));
  const partyCandidates=Object.entries(partyCounts).map(([party,votes],i)=>({id:party,name:party,party:"Agregado nacional",color:partyColor(party,i),votes}));
  $("nationalCongressResults").innerHTML=partyCandidates.length?resultRows(partyCandidates,Object.fromEntries(partyCandidates.map(x=>[x.id,x.votes])),congressVotes):`<div class="empty-state" style="padding:18px">Nenhum voto para congressista.</div>`;
  const enabled=STATES.filter(s=>election.states?.[s.a]?.enabled);$("resultsStateSelect").innerHTML=enabled.map(s=>`<option value="${s.a}">${escapeHtml(s.n)} (${s.a})</option>`).join("");
  if(enabled.length){if(!enabled.some(s=>s.a===$("resultsStateSelect").value))$("resultsStateSelect").value=enabled[0].a;renderStateResults(election,ballots,$("resultsStateSelect").value);}else $("stateResults").innerHTML=`<div class="empty-state">Nenhum estado habilitado.</div>`;
}
function countSingle(ballots,key,candidateIds){const counts=Object.fromEntries(candidateIds.map(id=>[id,0]));ballots.forEach(b=>{const id=b.choices?.[key];if(id&&counts[id]!==undefined)counts[id]++;});return counts;}
function resultRows(candidates,counts,totalOverride=null){
  const total=totalOverride??Object.values(counts).reduce((a,b)=>a+b,0);
  if(!candidates.length)return`<div class="empty-state" style="padding:18px">Nenhum candidato configurado.</div>`;
  return [...candidates].sort((a,b)=>(counts[b.id]||0)-(counts[a.id]||0)).map((c,i)=>{const v=counts[c.id]||0,p=total?100*v/total:0;return `<div class="result-row ${i===0&&v>0?'leader':''}"><div class="result-rank">${String(i+1).padStart(2,'0')}</div><div class="result-name">${escapeHtml(c.name)}<small>${escapeHtml(c.party||'')}</small></div><div class="result-bar-track"><div class="result-bar" style="width:${p}%;background:${escapeHtml(c.color||'#64748B')}"></div></div><div class="result-votes">${v.toLocaleString('pt-BR')} votos</div><div class="result-pct">${p.toFixed(1)}%</div></div>`}).join("");
}
function candidateForElection(election,state,race,id){
  if(!id)return null;let map=race==="president"?election.president?.candidates:race==="governor"?election.states?.[state]?.governor?.candidates:election.states?.[state]?.congress?.candidates;return asObject(map)[id]||null;
}
function partyColor(party,i){
  const p=String(party).toLowerCase();if(p.includes("rep"))return"#DC2626";if(p.includes("dem"))return"#2563EB";const colors=["#7C3AED","#D97706","#15803D","#475569","#0891B2"];return colors[i%colors.length];
}
function renderStateResults(election,ballots,abbr){
  const stateBallots=ballots.filter(b=>b.voter?.state===abbr);const cfg=election.states?.[abbr]||{};
  const parts=[];
  const pc=candidateList(election.president?.candidates);parts.push(`<h5>Presidente</h5>${resultRows(pc,countSingle(stateBallots,"president",pc.map(c=>c.id)))}`);
  const gc=candidateList(cfg.governor?.candidates);if(gc.length)parts.push(`<h5>Governador</h5>${resultRows(gc,countSingle(stateBallots,"governor",gc.map(c=>c.id)))}`);
  const cc=candidateList(cfg.congress?.candidates);if(cc.length){const counts=Object.fromEntries(cc.map(c=>[c.id,0]));let total=0;stateBallots.forEach(b=>Object.keys(asObject(b.choices?.congress)).forEach(id=>{if(counts[id]!==undefined){counts[id]++;total++;}}));parts.push(`<h5>Congressista(s) · ${cfg.congress?.seats||1} assento(s)</h5>${resultRows(cc,counts,total)}`);}
  $("stateResults").innerHTML=`<div class="state-result-block"><div class="state-result-head">${escapeHtml(stateName(abbr))} · ${stateBallots.length} eleitor(es)</div><div class="state-result-body">${parts.join("")}</div></div>`;
}

/* ============================== AUDIT ====================================== */
async function loadAudit(id){
  if(!id){$("auditTableBody").innerHTML="";return;}auditElectionId=id;populateAdminElectionSelectors();$("auditElectionSelect").value=id;
  const ballots=await getAdminBallots(id,true);renderAudit(publicElections[id],ballots);
}
function renderAudit(election,ballotsObj){
  if(!election)return;
  const q=$("auditSearchInput").value.trim().toLowerCase();
  const entries=Object.entries(asObject(ballotsObj)).map(([key,b])=>({key,...b})).filter(b=>{
    const hay=`${b.voter?.firstName||''} ${b.voter?.lastName||''} ${b.voter?.discordNorm||''} ${b.voter?.state||''} ${stateName(b.voter?.state)}`.toLowerCase();return!q||hay.includes(q);
  }).sort((a,b)=>(Number(b.submittedAt)||0)-(Number(a.submittedAt)||0));
  $("auditCountLabel").textContent=`${entries.length} registro(s)`;
  $("auditTableBody").innerHTML=entries.map(b=>{
    const p=candidateForElection(election,b.voter?.state,"president",b.choices?.president)?.name||"—";
    const g=candidateForElection(election,b.voter?.state,"governor",b.choices?.governor)?.name||"—";
    const cs=Object.keys(asObject(b.choices?.congress)).map(id=>candidateForElection(election,b.voter?.state,"congress",id)?.name||`[${id}]`).join(", ")||"—";
    const invalid=b.status==="invalid";
    return `<tr class="${invalid?'invalid':''}"><td><b>${escapeHtml(b.voter?.firstName)} ${escapeHtml(b.voter?.lastName)}</b><br><small>${escapeHtml(b.receiptCode||b.voteId||'')}</small></td><td>@${escapeHtml(b.voter?.discordNorm)}</td><td>${escapeHtml(stateName(b.voter?.state))}</td><td>${escapeHtml(p)}</td><td>${escapeHtml(g)}</td><td>${escapeHtml(cs)}</td><td>${escapeHtml(fmtDate(b.submittedAt))}</td><td><span class="audit-status ${invalid?'invalid':''}">${invalid?'Invalidado':'Válido'}</span>${invalid&&b.invalidReason?`<br><small>${escapeHtml(b.invalidReason)}</small>`:''}</td><td><button class="row-action" data-audit-key="${b.key}" data-invalid="${invalid?'1':'0'}">${invalid?'Restaurar':'Invalidar'}</button></td></tr>`;
  }).join("");
  $("auditTableBody").querySelectorAll("button[data-audit-key]").forEach(btn=>btn.onclick=()=>toggleBallotValidity(election.id,btn.dataset.auditKey,btn.dataset.invalid==="1"));
}
async function toggleBallotValidity(electionId,key,isInvalid){
  const path=`private/elections/${electionId}/ballots/${key}`;
  try{
    if(isInvalid){await db.ref(path).update({status:"valid",invalidReason:null,invalidatedAt:null});}
    else{const reason=window.prompt("Motivo da invalidação (fica registrado na auditoria):");if(reason===null)return;await db.ref(path).update({status:"invalid",invalidReason:reason.trim()||"Invalidado pelo administrador",invalidatedAt:firebase.database.ServerValue.TIMESTAMP});}
    await loadAudit(electionId);if(resultsElectionId===electionId)delete adminBallotsCache[electionId];showToast(isInvalid?"Voto restaurado.":"Voto invalidado.");
  }catch(err){console.error(err);showToast("Falha ao alterar o voto.");}
}
async function exportAuditCsv(){
  const id=auditElectionId;if(!id)return;const election=publicElections[id],ballots=await getAdminBallots(id,true);
  const rows=[["vote_id","receipt_code","status","nome","sobrenome","discord","estado","presidente","governador","congressistas","data_hora","motivo_invalidacao"]];
  Object.values(asObject(ballots)).forEach(b=>{
    const st=b.voter?.state;const p=candidateForElection(election,st,"president",b.choices?.president)?.name||"";const g=candidateForElection(election,st,"governor",b.choices?.governor)?.name||"";const cs=Object.keys(asObject(b.choices?.congress)).map(cid=>candidateForElection(election,st,"congress",cid)?.name||cid).join(" | ");
    rows.push([b.voteId,b.receiptCode,b.status||"valid",b.voter?.firstName,b.voter?.lastName,b.voter?.discordNorm,st,p,g,cs,fmtDate(b.submittedAt),b.invalidReason||""]);
  });
  const csv=rows.map(r=>r.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob=new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`auditoria-${election.year}-${election.id}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),500);
}

/* ============================== EVENTS ===================================== */
$("startVotingBtn").onclick=openIdentity;
document.querySelectorAll('[data-action="back-home"]').forEach(b=>b.onclick=()=>renderHome());
$("identityForm").onsubmit=e=>{
  e.preventDefault();if(!currentElection)return;
  const first=$("firstNameInput").value.trim(),last=$("lastNameInput").value.trim(),raw=$("discordInput").value.trim(),norm=normalizeDiscord(raw),state=$("stateInput").value;
  if(!first||!last||!norm||!state){showToast("Preencha todos os campos.");return;}
  if(norm.length<2||norm.length>64){showToast("Informe um @Discord válido.");return;}
  if(!currentElection.states?.[state]?.enabled){showToast("Esse estado não está habilitado nesta eleição.");return;}
  voter={firstName:first,lastName:last,discordOriginal:raw,discordNorm:norm,state};selections={president:null,governor:null,congress:[]};buildBallotSteps();renderBallot();
};
$("ballotBackBtn").onclick=()=>{if(ballotStepIndex===0)setScreen("screenIdentity");else{ballotStepIndex--;renderBallot();}};
$("ballotNextBtn").onclick=()=>{if(!currentStepHasSelection()){showToast("Selecione pelo menos uma opção para continuar.");return;}if(ballotStepIndex<ballotSteps.length-1){ballotStepIndex++;renderBallot();}else renderReview();};
$("editBallotBtn").onclick=()=>{ballotStepIndex=0;renderBallot();};
$("confirmVoteCheck").onchange=()=>$("submitVoteBtn").disabled=!$("confirmVoteCheck").checked;
$("submitVoteBtn").onclick=submitVote;$("printReceiptBtn").onclick=()=>window.print();$("finishReceiptBtn").onclick=()=>resetVoterSession(true);

$("adminToggle").onclick=()=>{if(!$("adminApp").hidden){setAdminVisible(false);chooseLatestOpenElection();}else openAdminLogin();};
$("adminLoginClose").onclick=()=>$("adminLoginModal").hidden=true;$("adminLoginModal").addEventListener("click",e=>{if(e.target===$("adminLoginModal"))$("adminLoginModal").hidden=true;});
$("adminLoginForm").onsubmit=e=>{e.preventDefault();adminLogin($("adminPasswordInput").value);};$("adminLogoutBtn").onclick=adminLogout;
document.querySelectorAll(".admin-tab").forEach(b=>b.onclick=()=>switchAdminTab(b.dataset.adminTab));
$("createElectionBtn").onclick=createElection;$("addPresidentCandidateBtn").onclick=()=>addCandidate("president");$("addGovernorCandidateBtn").onclick=()=>addCandidate("governor");$("addCongressCandidateBtn").onclick=()=>addCandidate("congress");
$("stateSearchInput").oninput=renderEditorStateList;$("stateEnabledToggle").onchange=()=>{syncStateEditor();renderStateEditor();renderEditorStateList();};$("congressSeatsInput").onchange=syncStateEditor;
$("saveElectionBtn").onclick=saveElection;["editorYear","editorName","editorDescription"].forEach(id=>$(id).addEventListener("input",syncGeneralEditor));
$("resultsElectionSelect").onchange=()=>loadResults($("resultsElectionSelect").value);$("resultsStateSelect").onchange=async()=>{const e=publicElections[resultsElectionId],b=validBallots(await getAdminBallots(resultsElectionId));renderStateResults(e,b,$("resultsStateSelect").value);};
$("auditElectionSelect").onchange=()=>loadAudit($("auditElectionSelect").value);$("auditSearchInput").oninput=async()=>renderAudit(publicElections[auditElectionId],await getAdminBallots(auditElectionId));$("exportCsvBtn").onclick=exportAuditCsv;

initFirebase();
