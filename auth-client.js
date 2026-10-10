(function(){
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
const TC_PUBLIC_PATHS_V144=new Set(['/', '/index.html','/barcode-label','/barcode-label.html','/coupang-pallet-simulator','/coupang-pallet-simulator.html']);
const TC_RESTRICTED_PREFIXES_V144=['/order-barcode','/shipment-list-builder','/detail-maker','/coupang-inbound-work','/purchase-order','/truck-shipment','/account-admin'];
let tcAuthStateV144={checked:false,authenticated:false,user:null};
let tcAuthPromiseV144=null;
let tcPendingTargetV144='';
function currentPathV144(){return location.pathname||'/'}
function isPublicPathV144(path=currentPathV144()){return TC_PUBLIC_PATHS_V144.has(path)}
function isRestrictedTargetV144(url){
  try{
    const u=new URL(url,location.origin);
    if(u.origin!==location.origin)return false;
    const p=u.pathname||'/';
    return TC_RESTRICTED_PREFIXES_V144.some(x=>p===x||p.startsWith(x+'/')||p.startsWith(x+'.html')||p.startsWith(x));
  }catch(_){return false}
}
function targetFromElementV144(el){
  if(!el)return '';
  const href=el.getAttribute&&el.getAttribute('href');
  if(href&&href!=='#'&&!href.toLowerCase().startsWith('javascript:'))return href;
  const onclick=el.getAttribute&&String(el.getAttribute('onclick')||'');
  const m=onclick.match(/(?:location(?:\.href)?|window\.location(?:\.href)?)\s*=\s*['"]([^'"]+)['"]/i)||onclick.match(/(?:location\.assign|location\.replace)\(\s*['"]([^'"]+)['"]\s*\)/i);
  if(m)return m[1];
  const txt=(el.textContent||'').trim();
  const map=[
    ['발주 바코드','/order-barcode.html'],['선적 리스트','/shipment-list-builder.html'],['상세페이지','/detail-maker'],
    ['쿠팡 입고 작업','/coupang-inbound-work.html'],['발주서 작성','/purchase-order.html'],['트럭쉽먼트','/truck-shipment.html'],['계정관리','/account-admin.html']
  ];
  const hit=map.find(([name])=>txt.includes(name));
  return hit?hit[1]:'';
}
function ensurePurchaseOrderNav(){
  try{
    const sidebar=document.querySelector('nav.sidebar,.sidebar');if(!sidebar)return;
    const nodes=[...sidebar.querySelectorAll('a,button')];
    let link=nodes.find(el=>{const href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'';return href.includes('/purchase-order.html')||onclick.includes('/purchase-order.html')});
    if(!link){link=document.createElement('a');link.className='nav-btn';link.href='/purchase-order.html';link.textContent='📝 발주서 작성';const inbound=nodes.find(el=>(el.textContent||'').includes('쿠팡 입고 작업'));if(inbound&&inbound.parentNode===sidebar)inbound.insertAdjacentElement('afterend',link);else sidebar.appendChild(link)}
    link.style.removeProperty('display');if(location.pathname.startsWith('/purchase-order'))link.classList.add('active');else link.classList.remove('active');
  }catch(e){console.warn('purchase nav',e)}
}
function ensureTruckShipmentNav(){
  try{
    const sidebar=document.querySelector('nav.sidebar,.sidebar');if(!sidebar)return;
    const nodes=[...sidebar.querySelectorAll('a,button')];
    let link=nodes.find(el=>{const href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'';return href.includes('/truck-shipment')||onclick.includes('/truck-shipment')||(el.textContent||'').includes('트럭쉽먼트')});
    if(!link){link=document.createElement('a');link.className='nav-btn';link.href='/truck-shipment.html';link.textContent='🚛 트럭쉽먼트 자동입력'}
    const fresh=[...sidebar.querySelectorAll('a,button')];
    const purchase=fresh.find(el=>{const href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'';return href.includes('/purchase-order')||onclick.includes('/purchase-order')||(el.textContent||'').includes('발주서 작성')});
    if(purchase&&purchase.parentNode===sidebar&&purchase.nextElementSibling!==link)purchase.insertAdjacentElement('afterend',link);else if(!link.isConnected)sidebar.appendChild(link);
    link.style.removeProperty('display');if(location.pathname.startsWith('/truck-shipment'))link.classList.add('active');else link.classList.remove('active');
  }catch(e){console.warn('truck shipment nav',e)}
}
function ensurePalletSimulatorNav(){
  try{
    const sidebar=document.querySelector('nav.sidebar,.sidebar');if(!sidebar)return;
    const nodes=[...sidebar.querySelectorAll('a,button')];
    let link=nodes.find(el=>{const href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'';return href.includes('/coupang-pallet-simulator')||onclick.includes('/coupang-pallet-simulator')});
    const logistics=nodes.find(el=>{const href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'';return href.includes('/logistics-cost')||onclick.includes("showFeature('logistics')")||(el.textContent||'').includes('물류비 계산기')});
    if(!link){link=document.createElement('a');link.className='nav-btn';link.href='/coupang-pallet-simulator';link.textContent='📦 쿠팡 팔레트 시뮬레이션'}
    if(logistics&&logistics.parentNode===sidebar&&logistics.nextElementSibling!==link)logistics.insertAdjacentElement('afterend',link);else if(!link.isConnected)sidebar.appendChild(link);
    link.style.removeProperty('display');if(location.pathname.startsWith('/coupang-pallet-simulator'))link.classList.add('active');else link.classList.remove('active');
  }catch(e){console.warn('pallet simulator nav',e)}
}
function ensureLoginRequiredDivider(){
  try{
    const sidebar=document.querySelector('nav.sidebar,.sidebar');if(!sidebar)return;
    let divider=document.getElementById('tcLoginRequiredDivider')||[...sidebar.querySelectorAll('.nav-section-label,div')].find(el=>(el.textContent||'').includes('아래 메뉴는 로그인 후 사용'));
    if(!divider){divider=document.createElement('div');divider.className='nav-section-label';divider.textContent='🔒 아래 메뉴는 로그인 후 사용';divider.style.cssText='margin-top:10px;color:#f6cf74;line-height:1.35;'}
    divider.id='tcLoginRequiredDivider';
    const nodes=[...sidebar.querySelectorAll('a,button')];
    const barcode=nodes.find(el=>{const href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'';return href.includes('/barcode-label')||onclick.includes('/barcode-label')||(el.textContent||'').includes('바코드 라벨 생성기')});
    if(barcode&&barcode.parentNode===sidebar&&barcode.nextElementSibling!==divider)barcode.insertAdjacentElement('afterend',divider);else if(!divider.isConnected)sidebar.appendChild(divider);
  }catch(e){console.warn('login divider nav',e)}
}
function ensureAccessChoiceModalV144(){
  let ov=document.getElementById('tcAccessChoiceV144');if(ov)return ov;
  ov=document.createElement('div');ov.id='tcAccessChoiceV144';ov.setAttribute('role','dialog');ov.setAttribute('aria-modal','true');ov.setAttribute('aria-labelledby','tcAccessChoiceTitleV144');
  ov.style.cssText='display:none;position:fixed;inset:0;z-index:2147483600;background:rgba(7,26,42,.58);align-items:center;justify-content:center;padding:20px;font-family:-apple-system,BlinkMacSystemFont,Pretendard,Malgun Gothic,sans-serif';
  ov.innerHTML='<div style="width:min(92vw,430px);background:#fff;border-radius:16px;box-shadow:0 20px 60px #0006;padding:26px 24px;text-align:center"><div style="font-size:36px;margin-bottom:8px">🔐</div><div id="tcAccessChoiceTitleV144" style="font-size:21px;font-weight:1000;color:#102a43;margin-bottom:8px">로그인이 필요한 작업입니다</div><div style="font-size:13px;line-height:1.7;color:#52687a;margin-bottom:20px">이 기능은 회원가입 후 관리자 승인을 받거나,<br>기존 계정으로 로그인하면 사용할 수 있습니다.<br><b>어떻게 진행하시겠습니까?</b></div><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button type="button" id="tcAccessLoginV144" style="border:0;border-radius:10px;background:#0b2e4f;color:#fff;padding:11px 18px;font-weight:900;cursor:pointer">로그인</button><button type="button" id="tcAccessSignupV144" style="border:0;border-radius:10px;background:#217346;color:#fff;padding:11px 18px;font-weight:900;cursor:pointer">회원가입</button><button type="button" id="tcAccessCancelV144" style="border:1px solid #cbd7e2;border-radius:10px;background:#fff;color:#425466;padding:11px 18px;font-weight:900;cursor:pointer">취소</button></div></div>';
  document.body.appendChild(ov);
  const close=()=>{ov.style.display='none';tcPendingTargetV144=''};
  document.getElementById('tcAccessCancelV144').onclick=close;
  document.getElementById('tcAccessLoginV144').onclick=()=>{const next=tcPendingTargetV144||'/';location.href='/login.html?next='+encodeURIComponent(new URL(next,location.origin).pathname+new URL(next,location.origin).search)};
  document.getElementById('tcAccessSignupV144').onclick=()=>{const next=tcPendingTargetV144||'/';location.href='/login.html?mode=signup&next='+encodeURIComponent(new URL(next,location.origin).pathname+new URL(next,location.origin).search)};
  ov.addEventListener('click',e=>{if(e.target===ov)close()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&ov.style.display==='flex')close()});
  return ov;
}
function showAccessChoiceV144(target){
  tcPendingTargetV144=target||'/';const ov=ensureAccessChoiceModalV144();ov.style.display='flex';setTimeout(()=>document.getElementById('tcAccessLoginV144')?.focus(),0);
}
window.tradecodeShowLoginChoice=showAccessChoiceV144;
async function checkAuthV144(force=false){
  if(tcAuthStateV144.checked&&!force)return tcAuthStateV144;
  if(tcAuthPromiseV144&&!force)return tcAuthPromiseV144;
  tcAuthPromiseV144=(async()=>{
    try{const r=await fetch('/api/auth/me',{cache:'no-store'}),j=await r.json();tcAuthStateV144={checked:true,authenticated:!!j.authenticated,user:j.user||null}}
    catch(_){tcAuthStateV144={checked:true,authenticated:false,user:null}}
    window.TRADECODE_AUTH=tcAuthStateV144;tcAuthPromiseV144=null;return tcAuthStateV144;
  })();
  return tcAuthPromiseV144;
}
function installRestrictedNavGuardV144(){
  if(document.documentElement.dataset.tcRestrictedGuardV144==='1')return;document.documentElement.dataset.tcRestrictedGuardV144='1';
  document.addEventListener('click',e=>{
    const el=e.target&&e.target.closest?e.target.closest('a,button'):null;if(!el)return;
    if(el.closest('#tcAccessChoiceV144'))return;
    const target=targetFromElementV144(el);if(!target||!isRestrictedTargetV144(target))return;
    if(tcAuthStateV144.checked&&tcAuthStateV144.authenticated)return;
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
    if(tcAuthStateV144.checked){showAccessChoiceV144(target);return}
    checkAuthV144().then(st=>{if(st.authenticated)location.href=target;else showAccessChoiceV144(target)});
  },true);
}
async function init(){
  ensurePurchaseOrderNav();ensureTruckShipmentNav();ensurePalletSimulatorNav();ensureLoginRequiredDivider();installRestrictedNavGuardV144();
  try{
    const st=await checkAuthV144();const j={authenticated:st.authenticated,user:st.user};
    if(!j.authenticated){
      window.TRADECODE_USER=null;
      if(!isPublicPathV144())location.href='/login.html?next='+encodeURIComponent(location.pathname+location.search);
      return;
    }
    const u=j.user;ensurePurchaseOrderNav();ensureTruckShipmentNav();ensurePalletSimulatorNav();ensureLoginRequiredDivider();
    if(!document.getElementById('tradecodeAccountBar')){
      const bar=document.createElement('div');bar.id='tradecodeAccountBar';bar.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483000;background:#0b2e4f;color:#fff;border-radius:11px;padding:8px 10px;box-shadow:0 5px 18px #0003;font:700 12px -apple-system,BlinkMacSystemFont,Pretendard,Malgun Gothic,sans-serif;display:flex;gap:8px;align-items:center';
      bar.innerHTML='<span>👤 '+esc(u.displayName||u.username)+'</span>'+(u.role==='admin'?'<a href="/account-admin.html" style="color:#ffd66b;text-decoration:none">계정관리</a>':'')+'<button id="tcLogout" style="border:1px solid #ffffff55;background:#ffffff14;color:white;border-radius:7px;padding:4px 7px;cursor:pointer">로그아웃</button>';
      document.body.appendChild(bar);document.getElementById('tcLogout').onclick=async()=>{await fetch('/api/auth/logout',{method:'POST'});location.href='/'};
    }
    window.TRADECODE_USER=u;window.dispatchEvent(new CustomEvent('tradecode-auth-ready',{detail:u}));
  }catch(e){console.warn('auth init',e)}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{ensurePurchaseOrderNav();ensureTruckShipmentNav();ensurePalletSimulatorNav();ensureLoginRequiredDivider();installRestrictedNavGuardV144()},{once:true});
else {ensurePurchaseOrderNav();ensureTruckShipmentNav();ensurePalletSimulatorNav();ensureLoginRequiredDivider();installRestrictedNavGuardV144();}
init();
})();

// ===== v97 deployment guard: lock from Render deploy start =====
(function(){
  let baseBoot='',overlayOn=false,lockedAt=0,stableBoot='',stableCount=0,countTimer=null,pollTimer=null,keyBlocker=null,heartbeatFailCount=0,lastDeploying=false;
  const WAIT_MS=10000;
  function ensureOverlay(){
    let el=document.getElementById('tcDeployGuardV82');if(el)return el;
    el=document.createElement('div');el.id='tcDeployGuardV82';el.style.cssText='display:none;position:fixed;inset:0;z-index:2147483647;background:rgba(7,26,42,.84);backdrop-filter:blur(2px);align-items:center;justify-content:center;padding:24px;pointer-events:auto';
    el.innerHTML='<div style="width:min(92vw,620px);background:#fff;border-radius:18px;box-shadow:0 22px 70px #0008;padding:34px 30px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,Pretendard,Malgun Gothic,sans-serif"><div style="font-size:44px;margin-bottom:8px">🔄</div><div style="font-size:25px;font-weight:1000;color:#0b2e4f;margin-bottom:10px">업데이트 중 10초만 기다려 주세요</div><div id="tcDeployGuardCountdownV82" style="font-size:42px;font-weight:1000;color:#217346;margin:8px 0">10</div><div id="tcDeployGuardSubV97" style="font-size:14px;font-weight:800;color:#566979;line-height:1.7">작업 데이터 보호를 위해 모든 작업 입력을 잠시 차단했습니다.<br>서버 업데이트가 안정되면 자동으로 화면을 다시 연결합니다.</div></div>';
    document.body.appendChild(el);return el;
  }
  function blockKeys(on){
    if(on&&!keyBlocker){keyBlocker=e=>{if(e.key==='F5'||(e.ctrlKey&&String(e.key).toLowerCase()==='r'))return;e.preventDefault();e.stopImmediatePropagation()};window.addEventListener('keydown',keyBlocker,true);window.addEventListener('keypress',keyBlocker,true);window.addEventListener('keyup',keyBlocker,true)}
    if(!on&&keyBlocker){window.removeEventListener('keydown',keyBlocker,true);window.removeEventListener('keypress',keyBlocker,true);window.removeEventListener('keyup',keyBlocker,true);keyBlocker=null}
  }
  function activate(reason,boot){
    if(!overlayOn){overlayOn=true;lockedAt=Date.now();stableBoot=boot||'';stableCount=0;const el=ensureOverlay();el.style.display='flex';blockKeys(true)}
    if(boot&&boot!==stableBoot){stableBoot=boot;stableCount=0}
    tick();
  }
  function updateCountdown(){
    if(!overlayOn)return;
    const left=Math.max(0,Math.ceil((WAIT_MS-(Date.now()-lockedAt))/1000));
    const n=document.getElementById('tcDeployGuardCountdownV82');if(n)n.textContent=left>0?String(left):'✓';
    const sub=document.getElementById('tcDeployGuardSubV97');
    if(sub&&left<=0&&lastDeploying)sub.innerHTML='10초 보호 시간이 지났습니다.<br>서버 배포가 아직 진행 중이라 작업 잠금을 계속 유지합니다.';
  }
  function tick(){
    if(!overlayOn)return;updateCountdown();
    if(!countTimer)countTimer=setInterval(()=>{if(!overlayOn){clearInterval(countTimer);countTimer=null;return}updateCountdown();if(Date.now()-lockedAt>=WAIT_MS&&!lastDeploying&&stableCount>=2)location.reload()},500);
  }
  async function heartbeat(){
    const c=new AbortController(),tm=setTimeout(()=>c.abort(),4500);
    try{
      const r=await fetch('/api/system/deploy-heartbeat?ts='+Date.now(),{cache:'no-store',signal:c.signal,headers:{'Cache-Control':'no-cache'}});if(!r.ok)throw new Error('heartbeat '+r.status);const j=await r.json();const boot=String(j.bootId||'');if(!boot)throw new Error('no boot id');
      heartbeatFailCount=0;lastDeploying=!!j.deploying;
      if(!baseBoot)baseBoot=boot;
      // v97: Render가 deploy를 created/build/pre-deploy/update 단계로 올리는 즉시 잠급니다.
      if(j.deploying)activate('render-deploy-start',boot);
      // Render API 감지가 설정되지 않았거나 놓친 경우에도 기존 bootId 변경 보호를 유지합니다.
      if(boot!==baseBoot)activate('server-changed',boot);
      if(overlayOn){
        if(j.deploying){stableCount=0}
        else if(!stableBoot||stableBoot===boot){stableBoot=boot;stableCount++}
        else{stableBoot=boot;stableCount=1}
        if(Date.now()-lockedAt>=WAIT_MS&&!j.deploying&&stableCount>=2)location.reload();
      }
    }catch(e){heartbeatFailCount++;stableCount=0;console.warn('[v97 deploy heartbeat temporary failure]',heartbeatFailCount,e?.message||e)}
    finally{clearTimeout(tm)}
  }
  function start(){ensureOverlay();heartbeat();pollTimer=setInterval(heartbeat,2000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)heartbeat()})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  window.__TC_DEPLOY_GUARD_V82__={activate,heartbeat};
})();
// v97: Render API 자동감지가 설정되면 '배포 완료 후'가 아니라 '배포 시작 직후' 잠금. 최소 대기시간 10초.
// ===== /v97 deployment guard =====
