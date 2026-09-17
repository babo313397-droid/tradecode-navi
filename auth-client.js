(function(){
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function ensurePurchaseOrderNav(){
  try{
    const sidebar=document.querySelector('nav.sidebar,.sidebar');
    if(!sidebar)return;
    const nodes=[...sidebar.querySelectorAll('a,button')];
    let link=nodes.find(el=>{
      const href=el.getAttribute('href')||'';
      const onclick=el.getAttribute('onclick')||'';
      return href.includes('/purchase-order.html')||onclick.includes('/purchase-order.html');
    });
    if(!link){
      link=document.createElement('a');
      link.className='nav-btn';
      link.href='/purchase-order.html';
      link.textContent='📝 발주서 작성';
      const inbound=nodes.find(el=>(el.textContent||'').includes('쿠팡 입고 작업'));
      if(inbound&&inbound.parentNode===sidebar)inbound.insertAdjacentElement('afterend',link);else sidebar.appendChild(link);
    }
    link.style.removeProperty('display');
    if(location.pathname==='/purchase-order.html'||location.pathname.startsWith('/purchase-order'))link.classList.add('active');
    else link.classList.remove('active');
  }catch(e){console.warn('purchase nav',e)}
}
async function init(){
  ensurePurchaseOrderNav();
  try{
    const r=await fetch('/api/auth/me',{cache:'no-store'}),j=await r.json();
    if(!j.authenticated){location.href='/login.html?next='+encodeURIComponent(location.pathname+location.search);return}
    const u=j.user;
    ensurePurchaseOrderNav();
    if(!document.getElementById('tradecodeAccountBar')){
      const bar=document.createElement('div');
      bar.id='tradecodeAccountBar';
      bar.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483000;background:#0b2e4f;color:#fff;border-radius:11px;padding:8px 10px;box-shadow:0 5px 18px #0003;font:700 12px -apple-system,BlinkMacSystemFont,Pretendard,Malgun Gothic,sans-serif;display:flex;gap:8px;align-items:center';
      bar.innerHTML='<span>👤 '+esc(u.displayName||u.username)+'</span>'+(u.role==='admin'?'<a href="/account-admin.html" style="color:#ffd66b;text-decoration:none">계정관리</a>':'')+'<button id="tcLogout" style="border:1px solid #ffffff55;background:#ffffff14;color:white;border-radius:7px;padding:4px 7px;cursor:pointer">로그아웃</button>';
      document.body.appendChild(bar);
      document.getElementById('tcLogout').onclick=async()=>{await fetch('/api/auth/logout',{method:'POST'});location.href='/login.html'};
    }
    window.TRADECODE_USER=u;
    window.dispatchEvent(new CustomEvent('tradecode-auth-ready',{detail:u}));
  }catch(e){console.warn('auth init',e)}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ensurePurchaseOrderNav,{once:true});
else ensurePurchaseOrderNav();
init();
})();


// ===== v82 deployment guard: all authenticated work screens =====
(function(){
  let baseBoot='',overlayOn=false,lockedAt=0,stableBoot='',stableCount=0,countTimer=null,pollTimer=null,keyBlocker=null,heartbeatFailCount=0;
  const WAIT_MS=30000;
  function ensureOverlay(){
    let el=document.getElementById('tcDeployGuardV82');if(el)return el;
    el=document.createElement('div');el.id='tcDeployGuardV82';el.style.cssText='display:none;position:fixed;inset:0;z-index:2147483647;background:rgba(7,26,42,.84);backdrop-filter:blur(2px);align-items:center;justify-content:center;padding:24px;pointer-events:auto';
    el.innerHTML='<div style="width:min(92vw,620px);background:#fff;border-radius:18px;box-shadow:0 22px 70px #0008;padding:34px 30px;text-align:center;font-family:-apple-system,BlinkMacSystemFont,Pretendard,Malgun Gothic,sans-serif"><div style="font-size:44px;margin-bottom:8px">🔄</div><div style="font-size:25px;font-weight:1000;color:#0b2e4f;margin-bottom:10px">업데이트 중 30초만 기다려 주세요</div><div id="tcDeployGuardCountdownV82" style="font-size:42px;font-weight:1000;color:#217346;margin:8px 0">30</div><div style="font-size:14px;font-weight:800;color:#566979;line-height:1.7">작업 데이터 보호를 위해 모든 작업 입력을 잠시 차단했습니다.<br>서버 업데이트가 안정되면 자동으로 화면을 다시 연결합니다.</div></div>';
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
  function tick(){
    if(!overlayOn)return;const left=Math.max(0,Math.ceil((WAIT_MS-(Date.now()-lockedAt))/1000));const n=document.getElementById('tcDeployGuardCountdownV82');if(n)n.textContent=String(left);
    if(!countTimer)countTimer=setInterval(()=>{if(!overlayOn){clearInterval(countTimer);countTimer=null;return}const remain=Math.max(0,Math.ceil((WAIT_MS-(Date.now()-lockedAt))/1000));const t=document.getElementById('tcDeployGuardCountdownV82');if(t)t.textContent=String(remain);if(remain<=0&&stableCount>=2){location.reload()}},500);
  }
  async function heartbeat(){
    const c=new AbortController(),tm=setTimeout(()=>c.abort(),2500);
    try{
      const r=await fetch('/api/system/deploy-heartbeat?ts='+Date.now(),{cache:'no-store',signal:c.signal,headers:{'Cache-Control':'no-cache'}});if(!r.ok)throw new Error('heartbeat '+r.status);const j=await r.json();const boot=String(j.bootId||'');if(!boot)throw new Error('no boot id');
      heartbeatFailCount=0;
      if(!baseBoot){baseBoot=boot;return}
      // v85: 전체화면 잠금은 '실제로 서버 세대가 바뀐 것이 성공 응답으로 확인된 경우'에만 켭니다.
      // 단순 네트워크 지연/일시적인 heartbeat 실패는 배포로 오인하지 않습니다.
      if(boot!==baseBoot)activate('server-changed',boot);
      if(overlayOn){if(!stableBoot||stableBoot===boot){stableBoot=boot;stableCount++}else{stableBoot=boot;stableCount=1}if(Date.now()-lockedAt>=WAIT_MS&&stableCount>=2)location.reload()}
    }catch(e){heartbeatFailCount++;stableCount=0;console.warn('[v85 deploy heartbeat temporary failure]',heartbeatFailCount,e?.message||e)}
    finally{clearTimeout(tm)}
  }
  function start(){ensureOverlay();heartbeat();pollTimer=setInterval(heartbeat,2000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)heartbeat()})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  window.__TC_DEPLOY_GUARD_V82__={activate,heartbeat};
})();
// v85: heartbeat 실패 자체로는 업데이트 잠금을 띄우지 않음. 서버 bootId 변경 확인시에만 30초 잠금.
// ===== /v82 deployment guard =====
