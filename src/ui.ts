export const html = `<!DOCTYPE html>
<html lang="et">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TAK25 Branch Bank</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:1rem;max-width:900px;margin:0 auto}
h1{color:#38bdf8;margin-bottom:.5rem;font-size:1.5rem}
h2{color:#94a3b8;font-size:1rem;margin:1.5rem 0 .5rem;border-bottom:1px solid #334155;padding-bottom:.25rem}
.info{background:#1e293b;padding:.75rem;border-radius:8px;margin-bottom:1rem;font-size:.85rem}
.info span{color:#38bdf8}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media(max-width:600px){.grid{grid-template-columns:1fr}}
.card{background:#1e293b;border-radius:8px;padding:1rem}
label{display:block;font-size:.8rem;color:#94a3b8;margin-bottom:.25rem}
input,select{width:100%;padding:.5rem;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#e2e8f0;margin-bottom:.5rem;font-size:.9rem}
button{background:#2563eb;color:#fff;border:none;padding:.5rem 1rem;border-radius:4px;cursor:pointer;font-size:.9rem;width:100%}
button:hover{background:#1d4ed8}
button:disabled{opacity:.5;cursor:not-allowed}
.result{background:#0f172a;border:1px solid #334155;border-radius:4px;padding:.5rem;margin-top:.5rem;font-size:.8rem;white-space:pre-wrap;max-height:200px;overflow-y:auto;display:none}
.result.show{display:block}
.accounts-list{margin-top:.5rem}
.acc{background:#0f172a;border:1px solid #334155;border-radius:4px;padding:.5rem;margin-bottom:.25rem;font-size:.85rem;display:flex;justify-content:space-between}
.acc .bal{color:#4ade80;font-weight:bold}
.acc .cur{color:#94a3b8}
.err{color:#f87171}
.ok{color:#4ade80}
.tabs{display:flex;gap:.5rem;margin-bottom:1rem}
.tab{padding:.5rem 1rem;background:#1e293b;border:none;color:#94a3b8;border-radius:4px 4px 0 0;cursor:pointer;font-size:.85rem}
.tab.active{background:#2563eb;color:#fff}
.section{display:none}
.section.active{display:block}
.transfer-status{font-size:.85rem;margin-top:.25rem}
</style>
</head>
<body>
<h1>TAK25 Branch Bank</h1>
<div class="info" id="bankInfo">Loading...</div>

<div class="tabs">
<button class="tab active" onclick="showTab('auth',this)">Sisselogimine</button>
<button class="tab" onclick="showTab('accounts',this)">Kontod</button>
<button class="tab" onclick="showTab('transfer',this)">Ülekanne</button>
<button class="tab" onclick="showTab('lookup',this)">Konto otsing</button>
</div>

<div id="auth" class="section active">
<div class="grid">
<div class="card">
<h2>Registreerimine</h2>
<label>Täisnimi</label>
<input id="regName" placeholder="Nimi">
<label>Email (valikuline)</label>
<input id="regEmail" placeholder="email@example.com">
<button onclick="register()">Registreeri</button>
<div class="result" id="regResult"></div>
</div>
<div class="card">
<h2>Sisselogimine</h2>
<label>User ID</label>
<input id="loginUserId" placeholder="user-...">
<label>API Key</label>
<input id="loginApiKey" placeholder="API key">
<button onclick="login()">Logi sisse</button>
<div class="result" id="loginResult"></div>
<div id="loggedIn" style="display:none;margin-top:.5rem">
<span class="ok">Sisse logitud</span>
</div>
</div>
</div>
</div>

<div id="accounts" class="section">
<div class="grid">
<div class="card">
<h2>Loo konto</h2>
<label>Valuuta</label>
<select id="newCurrency">
<option>EUR</option><option>USD</option><option>GBP</option><option>SEK</option>
</select>
<button onclick="createAccount()">Loo konto</button>
<div class="result" id="createResult"></div>
</div>
<div class="card">
<h2>Deposit</h2>
<label>Konto number</label>
<input id="depAccount" placeholder="BRA.....">
<label>Summa</label>
<input id="depAmount" placeholder="100.00">
<button onclick="deposit()">Lisa raha</button>
<div class="result" id="depResult"></div>
</div>
</div>
<h2>Minu kontod</h2>
<button onclick="loadAccounts()" style="width:auto;margin-bottom:.5rem">Värskenda</button>
<div id="accountsList" class="accounts-list"></div>
</div>

<div id="transfer" class="section">
<div class="card">
<h2>Ülekanne</h2>
<label>Lähtekonto</label>
<input id="srcAccount" placeholder="BRA.....">
<label>Sihtkonto</label>
<input id="dstAccount" placeholder="BRA..... või GFT.....">
<label>Summa</label>
<input id="txAmount" placeholder="50.00">
<button onclick="doTransfer()">Saada ülekanne</button>
<div class="result" id="txResult"></div>
</div>
</div>

<div id="lookup" class="section">
<div class="grid">
<div class="card">
<h2>Konto otsing</h2>
<label>Konto number</label>
<input id="lookupNum" placeholder="BRA..... või GFT.....">
<button onclick="lookupAccount()">Otsi</button>
<div class="result" id="lookupResult"></div>
</div>
<div class="card">
<h2>Kõik kontod (meie pank)</h2>
<button onclick="loadAllAccounts()">Laadi</button>
<div id="allAccountsList" class="accounts-list"></div>
</div>
</div>
</div>

<script>
const BASE = window.location.origin + '/api/v1';
let token = '';
let userId = '';

async function api(path, opts = {}) {
  const headers = {'Content-Type':'application/json',...(opts.headers||{})};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, {...opts, headers});
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {raw: text}; }
  return {status: res.status, data, headers: res.headers};
}

function show(id, text, isErr) {
  const el = document.getElementById(id);
  el.textContent = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  el.className = 'result show' + (isErr ? ' err' : '');
}

function showTab(name, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(name).classList.add('active');
  if (el) el.classList.add('active');
  else document.querySelector('.tab[onclick*="'+name+'"]')?.classList.add('active');
}

async function loadBankInfo() {
  try {
    const res = await fetch(window.location.origin + '/health');
    const data = await res.json();
    document.getElementById('bankInfo').innerHTML =
      'Bank: <span>' + (data.bankId||'?') + '</span> | Prefiks: <span>' + (data.bankPrefix||'?') + '</span> | Aadress: <span>' + (data.address||'?') + '</span>';
  } catch {}
}

async function register() {
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  if (!name) return show('regResult','Sisesta nimi',true);
  const body = {fullName: name};
  if (email) body.email = email;
  const {status, data, headers} = await api('/users', {method:'POST', body: JSON.stringify(body)});
  const apiKey = headers.get('x-api-key');
  if (status === 201) {
    document.getElementById('loginUserId').value = data.userId;
    document.getElementById('loginApiKey').value = apiKey || '';
    show('regResult', 'Registreeritud!\\nUser ID: ' + data.userId + '\\nAPI Key: ' + (apiKey||'vaata headereid'));
  } else {
    show('regResult', data, true);
  }
}

async function login() {
  const uid = document.getElementById('loginUserId').value.trim();
  const key = document.getElementById('loginApiKey').value.trim();
  if (!uid || !key) return show('loginResult','Täida mõlemad väljad',true);
  const {status, data} = await api('/auth/tokens', {method:'POST', body: JSON.stringify({userId:uid, apiKey:key})});
  if (status === 200) {
    token = data.accessToken;
    userId = uid;
    document.getElementById('loggedIn').style.display = 'block';
    show('loginResult', 'Token saadud, kehtib ' + data.expiresIn + 's');
    loadAccounts();
    showTab('accounts');
  } else {
    show('loginResult', data, true);
  }
}

async function createAccount() {
  if (!token) return show('createResult','Logi kõigepealt sisse',true);
  const cur = document.getElementById('newCurrency').value;
  const {status, data} = await api('/users/'+userId+'/accounts', {method:'POST', body: JSON.stringify({currency:cur})});
  if (status === 201) {
    show('createResult', 'Konto loodud: ' + data.accountNumber + ' (' + data.currency + ')');
    loadAccounts();
  } else {
    show('createResult', data, true);
  }
}

async function deposit() {
  if (!token) return show('depResult','Logi kõigepealt sisse',true);
  const acc = document.getElementById('depAccount').value.trim();
  const amt = document.getElementById('depAmount').value.trim();
  if (!acc || !amt) return show('depResult','Täida mõlemad väljad',true);
  const {status, data} = await api('/accounts/'+acc+'/deposit', {method:'POST', body: JSON.stringify({amount:amt})});
  if (status === 200) {
    show('depResult', 'Uus saldo: ' + data.balance);
    loadAccounts();
  } else {
    show('depResult', data, true);
  }
}

async function loadAccounts() {
  if (!token) return;
  const {data} = await api('/users/'+userId+'/accounts');
  const list = document.getElementById('accountsList');
  if (!data.accounts || !data.accounts.length) {
    list.innerHTML = '<div style="color:#94a3b8;font-size:.85rem">Kontosid pole</div>';
    return;
  }
  list.innerHTML = data.accounts.map(a =>
    '<div class="acc"><div>' + a.accountNumber + ' <span class="cur">' + a.currency + '</span></div><div class="bal">' + a.balance + '</div></div>'
  ).join('');
  // Auto-fill source account
  if (data.accounts.length > 0) {
    document.getElementById('srcAccount').value = data.accounts[0].accountNumber;
    document.getElementById('depAccount').value = data.accounts[0].accountNumber;
  }
}

async function doTransfer() {
  if (!token) return show('txResult','Logi kõigepealt sisse',true);
  const src = document.getElementById('srcAccount').value.trim();
  const dst = document.getElementById('dstAccount').value.trim();
  const amt = document.getElementById('txAmount').value.trim();
  if (!src || !dst || !amt) return show('txResult','Täida kõik väljad',true);
  const transferId = 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random()*16).toString(16));
  const {status, data} = await api('/transfers', {method:'POST', body: JSON.stringify({transferId, sourceAccount:src, destinationAccount:dst, amount:amt})});
  if (status === 201) {
    let msg = 'Ülekanne: ' + data.status + '\\nID: ' + data.transferId;
    if (data.convertedAmount) msg += '\\nKonverteeritud: ' + data.convertedAmount + ' (kurss: ' + data.exchangeRate + ')';
    show('txResult', msg);
    loadAccounts();
  } else {
    show('txResult', data, true);
  }
}

async function lookupAccount() {
  const num = document.getElementById('lookupNum').value.trim();
  if (!num) return show('lookupResult','Sisesta konto number',true);
  const {status, data} = await api('/accounts/'+num);
  if (status === 200) {
    show('lookupResult', 'Omanik: ' + data.ownerName + '\\nValuuta: ' + data.currency);
  } else {
    show('lookupResult', data, true);
  }
}

async function loadAllAccounts() {
  const {data} = await api('/accounts');
  const list = document.getElementById('allAccountsList');
  if (!data.accounts || !data.accounts.length) {
    list.innerHTML = '<div style="color:#94a3b8;font-size:.85rem">Kontosid pole</div>';
    return;
  }
  list.innerHTML = data.accounts.map(a =>
    '<div class="acc"><div>' + a.accountNumber + ' <span class="cur">' + a.currency + '</span> - ' + a.ownerName + '</div><div class="bal">' + a.balance + '</div></div>'
  ).join('');
}

loadBankInfo();
</script>
</body>
</html>`;
