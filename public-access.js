(function(){
  'use strict';
  const RESTRICTED=['/order-barcode','/shipment-list-builder','/coupang-inbound-work','/purchase-order','/truck-shipment','/pallet-load-list','/outbound-box-numbering','/account-admin'];
  let auth={checked:false,authenticated:false,user:null};
  let authPromise=null;
  let pending='';
  function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function isRestricted(url){
    try{const u=new URL(url,location.origin);if(u.origin!==location.origin)return false;const p=u.pathname||'/';return RESTRICTED.some(x=>p===x||p.startsWith(x+'.')||p.startsWith(x+'/'));}catch(_){return false}
  }
  function targetOf(el){
    if(!el)return '';
    const href=el.getAttribute&&el.getAttribute('href');
    if(href&&href!=='#'&&!/^javascript:/i.test(href))return href;
    const onclick=String(el.getAttribute&&el.getAttribute('onclick')||'');
    const m=onclick.match(/(?:location(?:\.href)?|window\.location(?:\.href)?)\s*=\s*['"]([^'"]+)['"]/i)||onclick.match(/(?:location\.assign|location\.replace)\(\s*['"]([^'"]+)['"]\s*\)/i);
    if(m)return m[1];
    const t=(el.textContent||'').trim();
    const map=[['발주 바코드','/order-barcode.html'],['선적 리스트','/shipment-list-builder.html'],['상세페이지','/detail-maker'],['쿠팡 입고 작업','/coupang-inbound-work.html'],['발주서 작성','/purchase-order.html'],['트럭쉽먼트','/truck-shipment.html'],['밀크런 팔레트 적재리스트','/pallet-load-list.html'],['출고박스 자동넘버링','/outbound-box-numbering.html'],['계정관리','/account-admin.html']];
    const hit=map.find(([name])=>t.includes(name));return hit?hit[1]:'';
  }
  function ensureTruckShipmentNav(){
    try{
      const sidebar=document.querySelector('nav.sidebar,.sidebar');if(!sidebar)return;
      const nodes=[...sidebar.querySelectorAll('a,button')];
      let link=nodes.find(el=>{const href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'';return href.includes('/truck-shipment')||onclick.includes('/truck-shipment')||(el.textContent||'').includes('트럭쉽먼트')});
      if(!link){link=document.createElement('a');link.className='nav-btn';link.href='/truck-shipment.html';link.textContent='🚛 트럭쉽먼트 자동입력';}
      const fresh=[...sidebar.querySelectorAll('a,button')];
      const purchase=fresh.find(el=>{const href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'';return href.includes('/purchase-order')||onclick.includes('/purchase-order')||(el.textContent||'').includes('발주서 작성')});
      if(purchase&&purchase.parentNode===sidebar&&purchase.nextElementSibling!==link)purchase.insertAdjacentElement('afterend',link);else if(!link.isConnected)sidebar.appendChild(link);
      if(location.pathname.startsWith('/truck-shipment'))link.classList.add('active');else link.classList.remove('active');
    }catch(e){console.warn('truck shipment public nav',e)}
  }
  function ensurePalletLoadListNav(){
    try{
      const sidebar=document.querySelector('nav.sidebar,.sidebar');if(!sidebar)return;
      const nodes=[...sidebar.querySelectorAll('a,button')];
      let link=nodes.find(el=>{const href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'';return href.includes('/pallet-load-list')||onclick.includes('/pallet-load-list')||(el.textContent||'').includes('밀크런 팔레트 적재리스트')});
      if(!link){link=document.createElement('a');link.className='nav-btn';link.href='/pallet-load-list.html';link.textContent='📄 밀크런 팔레트 적재리스트 자동입력';}
      const fresh=[...sidebar.querySelectorAll('a,button')];
      const truck=fresh.find(el=>{const href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'';return href.includes('/truck-shipment')||onclick.includes('/truck-shipment')||(el.textContent||'').includes('트럭쉽먼트')});
      if(truck&&truck.parentNode===sidebar&&truck.nextElementSibling!==link)truck.insertAdjacentElement('afterend',link);else if(!link.isConnected)sidebar.appendChild(link);
      if(location.pathname.startsWith('/pallet-load-list'))link.classList.add('active');else link.classList.remove('active');
    }catch(e){console.warn('pallet load list public nav',e)}
  }

  function ensureOutboundBoxNumberingNav(){
    try{
      const sidebar=document.querySelector('nav.sidebar,.sidebar');if(!sidebar)return;
      const nodes=[...sidebar.querySelectorAll('a,button')];
      let link=nodes.find(el=>{const href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'';return href.includes('/outbound-box-numbering')||onclick.includes('/outbound-box-numbering')||(el.textContent||'').includes('출고박스 자동넘버링')});
      if(!link){link=document.createElement('a');link.className='nav-btn';link.href='/outbound-box-numbering.html';link.textContent='🔢 출고박스 자동넘버링';}
      const fresh=[...sidebar.querySelectorAll('a,button')];
      const pallet=fresh.find(el=>{const href=el.getAttribute('href')||'',onclick=el.getAttribute('onclick')||'';return href.includes('/pallet-load-list')||onclick.includes('/pallet-load-list')||(el.textContent||'').includes('밀크런 팔레트 적재리스트')});
      if(pallet&&pallet.parentNode===sidebar&&pallet.nextElementSibling!==link)pallet.insertAdjacentElement('afterend',link);else if(!link.isConnected)sidebar.appendChild(link);
      if(location.pathname.startsWith('/outbound-box-numbering'))link.classList.add('active');else link.classList.remove('active');
    }catch(e){console.warn('outbound box numbering public nav',e)}
  }
  async function check(force=false){
    if(auth.checked&&!force)return auth;
    if(authPromise&&!force)return authPromise;
    authPromise=(async()=>{try{const r=await fetch('/api/auth/me',{cache:'no-store'}),j=await r.json();auth={checked:true,authenticated:!!j.authenticated,user:j.user||null};}catch(_){auth={checked:true,authenticated:false,user:null};}authPromise=null;window.TRADECODE_PUBLIC_AUTH=auth;return auth;})();
    return authPromise;
  }
  function cleanChoiceQuery(){
    try{const u=new URL(location.href);u.searchParams.delete('authChoice');u.searchParams.delete('next');history.replaceState(history.state,'',u.pathname+(u.search?'?'+u.searchParams.toString():'')+u.hash);}catch(_){}
  }
  function modal(){
    let ov=document.getElementById('tcPublicAccessChoice');if(ov)return ov;
    ov=document.createElement('div');ov.id='tcPublicAccessChoice';ov.style.cssText='display:none;position:fixed;inset:0;z-index:2147483600;background:rgba(7,26,42,.58);align-items:center;justify-content:center;padding:20px;font-family:-apple-system,BlinkMacSystemFont,Pretendard,Malgun Gothic,sans-serif';
    ov.innerHTML='<div style="width:min(92vw,430px);background:#fff;border-radius:16px;box-shadow:0 20px 60px #0006;padding:26px 24px;text-align:center"><div style="font-size:36px;margin-bottom:8px">🔐</div><div style="font-size:21px;font-weight:1000;color:#102a43;margin-bottom:8px">로그인이 필요한 작업입니다</div><div style="font-size:13px;line-height:1.7;color:#52687a;margin-bottom:20px">이 기능은 회원가입 후 관리자 승인을 받거나,<br>기존 계정으로 로그인하면 사용할 수 있습니다.<br><b>어떻게 진행하시겠습니까?</b></div><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button type="button" id="tcPublicLogin" style="border:0;border-radius:10px;background:#0b2e4f;color:#fff;padding:11px 18px;font-weight:900;cursor:pointer">로그인</button><button type="button" id="tcPublicSignup" style="border:0;border-radius:10px;background:#217346;color:#fff;padding:11px 18px;font-weight:900;cursor:pointer">회원가입</button><button type="button" id="tcPublicCancel" style="border:1px solid #cbd7e2;border-radius:10px;background:#fff;color:#425466;padding:11px 18px;font-weight:900;cursor:pointer">취소</button></div></div>';
    document.body.appendChild(ov);
    const close=()=>{ov.style.display='none';pending='';cleanChoiceQuery();};
    document.getElementById('tcPublicCancel').onclick=close;
    document.getElementById('tcPublicLogin').onclick=()=>{const n=pending||'/';location.href='/login.html?next='+encodeURIComponent(new URL(n,location.origin).pathname+new URL(n,location.origin).search);};
    document.getElementById('tcPublicSignup').onclick=()=>{const n=pending||'/';location.href='/login.html?mode=signup&next='+encodeURIComponent(new URL(n,location.origin).pathname+new URL(n,location.origin).search);};
    ov.addEventListener('click',e=>{if(e.target===ov)close();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&ov.style.display==='flex')close();});
    return ov;
  }
  function show(target){pending=target||'/';modal().style.display='flex';setTimeout(()=>document.getElementById('tcPublicLogin')?.focus(),0);}
  window.tradecodeShowLoginChoice=show;
  function accountBar(){
    if(!auth.authenticated||!auth.user||document.getElementById('tradecodePublicAccountBar'))return;
    const u=auth.user,b=document.createElement('div');b.id='tradecodePublicAccountBar';b.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483000;background:#0b2e4f;color:#fff;border-radius:11px;padding:8px 10px;box-shadow:0 5px 18px #0003;font:700 12px -apple-system,BlinkMacSystemFont,Pretendard,Malgun Gothic,sans-serif;display:flex;gap:8px;align-items:center';
    b.innerHTML='<span>👤 '+esc(u.displayName||u.username)+'</span>'+(u.role==='admin'?'<a href="/account-admin.html" style="color:#ffd66b;text-decoration:none">계정관리</a>':'')+'<button type="button" id="tcPublicLogout" style="border:1px solid #ffffff55;background:#ffffff14;color:#fff;border-radius:7px;padding:4px 7px;cursor:pointer">로그아웃</button>';
    document.body.appendChild(b);document.getElementById('tcPublicLogout').onclick=async()=>{await fetch('/api/auth/logout',{method:'POST'});location.href='/';};
  }
  function isBarcodeProtectedAction(el){
    const p=location.pathname||'';
    if(!(p==='/barcode-label'||p==='/barcode-label.html'))return false;
    const txt=(el?.textContent||'').replace(/\s+/g,' ').trim();
    // v147: 비로그인은 공용 라벨을 조회/불러오기/목록 새로고침까지 할 수 있고,
    // 저장·삭제·이관·백업/복원·서버 작업저장 같은 변경 동작만 로그인 필요.
    if(/공용 라벨 저장|공용 라벨 삭제|기존 라벨 공용|공용 라벨 백업|백업 복원|저장소 상태|지금 저장/.test(txt))return true;
    const href=String(el?.getAttribute?.('href')||'');
    return /\/api\/shared-labels(?:-|\/|$)|\/api\/shared-workspace\/barcode-label/.test(href);
  }
  function guard(){
    document.addEventListener('click',e=>{
      const el=e.target&&e.target.closest?e.target.closest('a,button'):null;if(!el||el.closest('#tcPublicAccessChoice'))return;
      const barcodeProtected=isBarcodeProtectedAction(el);
      const target=targetOf(el);
      const restrictedNav=!!(target&&isRestricted(target));
      if(!barcodeProtected&&!restrictedNav)return;
      if(auth.checked&&auth.authenticated)return;
      e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
      const next=restrictedNav?target:location.pathname+location.search;
      if(auth.checked){show(next);return;}
      check().then(st=>{if(st.authenticated){if(restrictedNav)location.href=target;else el.click();}else show(next);});
    },true);
  }
  async function init(){
    ensureTruckShipmentNav();ensurePalletLoadListNav();ensureOutboundBoxNumberingNav();guard();const st=await check();accountBar();
    const p=new URLSearchParams(location.search);if(!st.authenticated&&p.get('authChoice')==='1'){show(p.get('next')||'/');}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();


// ===== v151 unified sidebar: same menu/style on every TradeCode page =====
(function(){
  'use strict';
  if(window.__TC_UNIFIED_SIDEBAR_V151__)return;
  window.__TC_UNIFIED_SIDEBAR_V151__=true;

  const ITEMS=[
    {key:'calculator',icon:'📊',label:'TradeCode Navi 관세율 계산',href:'/'},
    {key:'rocket',icon:'🚀',label:'로켓배송 원가&마진률 계산',href:'/coupang-margin'},
    {key:'logistics',icon:'🚚',label:'물류비 계산기',href:'/logistics-cost'},
    {key:'simulator',icon:'📦',label:'쿠팡 팔레트 시뮬레이션',href:'/coupang-pallet-simulator.html'},
    {key:'barcode',icon:'🏷️',label:'바코드 라벨 생성기',href:'/barcode-label.html'},
    {divider:true,label:'🔒 아래 메뉴는 로그인 후 사용'},
    {key:'orderbarcode',icon:'📦',label:'발주 바코드 출력',href:'/order-barcode.html'},
    {key:'shipmentlist',icon:'📋',label:'선적 리스트 작성',href:'/shipment-list-builder.html'},
    {key:'detail',icon:'✨',label:'쿠팡 상세페이지 자동 제작',href:'#',comingSoon:true},
    {key:'inbound',icon:'📦',label:'쿠팡 입고 작업',href:'/coupang-inbound-work.html'},
    {key:'purchase',icon:'📝',label:'발주서 작성',href:'/purchase-order.html'},
    {key:'truck',icon:'🚛',label:'트럭쉽먼트 자동입력',href:'/truck-shipment.html'},
    {key:'palletlist',icon:'📄',label:'밀크런 팔레트 적재리스트 자동입력',href:'/pallet-load-list.html'},
    {key:'outbound',icon:'🔢',label:'출고박스 자동넘버링',href:'/outbound-box-numbering.html'}
  ];

  function style(){
    if(document.getElementById('tcUnifiedSidebarStyleV151'))return;
    const el=document.createElement('style');el.id='tcUnifiedSidebarStyleV151';
    el.textContent=`
      .tc-unified-sidebar{width:270px!important;min-width:270px!important;height:100vh!important;position:sticky!important;top:0!important;overflow-y:auto!important;overflow-x:hidden!important;background:#102744!important;color:#fff!important;padding:10px 8px 18px!important;box-sizing:border-box!important;font-family:Pretendard,"Malgun Gothic","Apple SD Gothic Neo",Arial,sans-serif!important;display:block!important;align-self:flex-start!important}
      .tc-unified-sidebar *{box-sizing:border-box!important}
      .tc-unified-sidebar .tc-nav-brand{display:flex!important;align-items:center!important;gap:10px!important;padding:0 2px 13px!important;margin:0!important;color:#fff!important}
      .tc-unified-sidebar .tc-nav-logo{width:40px!important;height:40px!important;min-width:40px!important;border-radius:10px!important;background:#d7ad3f!important;color:#102744!important;display:flex!important;align-items:center!important;justify-content:center!important;font-size:18px!important;font-weight:1000!important;line-height:1!important}
      .tc-unified-sidebar .tc-nav-brand-title{font-size:19px!important;line-height:1.13!important;font-weight:900!important;letter-spacing:-.2px!important;color:#fff!important}
      .tc-unified-sidebar .tc-nav-brand-sub{display:block!important;margin-top:4px!important;font-size:12px!important;line-height:1.2!important;font-weight:500!important;color:#b9c8da!important}
      .tc-unified-sidebar .tc-nav-section{font-size:12px!important;line-height:1.3!important;color:#9eb0c5!important;padding:8px 4px 5px!important;margin:0!important;font-weight:700!important}
      .tc-unified-sidebar .tc-nav-login-divider{color:#ffd463!important;font-weight:900!important;padding-top:9px!important}
      .tc-unified-sidebar .tc-nav-link{display:flex!important;width:100%!important;min-height:56px!important;align-items:center!important;justify-content:flex-start!important;gap:8px!important;margin:6px 0!important;padding:12px 12px!important;border:1px solid #3a4d68!important;border-radius:12px!important;background:#1b2f4b!important;color:#f7f9fc!important;text-decoration:none!important;text-align:left!important;font-size:16px!important;line-height:1.35!important;font-weight:800!important;letter-spacing:-.15px!important;cursor:pointer!important;white-space:normal!important;word-break:keep-all!important;box-shadow:none!important;font-family:Pretendard,"Malgun Gothic","Apple SD Gothic Neo",Arial,sans-serif!important}
      .tc-unified-sidebar .tc-nav-link:hover{background:#223956!important;border-color:#51647c!important;color:#fff!important}
      .tc-unified-sidebar .tc-nav-link.active{background:#d6ad3f!important;border-color:#d6ad3f!important;color:#102744!important}
      .tc-unified-sidebar .tc-nav-icon{flex:0 0 auto!important;font-size:15px!important;line-height:1!important}
      .tc-unified-sidebar .tc-nav-text{display:block!important;min-width:0!important}
      @media(max-width:820px){.tc-unified-sidebar{width:100%!important;min-width:100%!important;height:auto!important;position:relative!important;padding:10px!important}.tc-unified-sidebar .tc-nav-link{min-height:50px!important}}
    `;
    document.head.appendChild(el);
  }
  function activeKey(){
    const p=(location.pathname||'/').toLowerCase();
    if(p==='/coupang-margin')return 'rocket';
    if(p==='/logistics-cost')return 'logistics';
    if(p.includes('coupang-pallet-simulator'))return 'simulator';
    if(p.includes('barcode-label'))return 'barcode';
    if(p.includes('order-barcode'))return 'orderbarcode';
    if(p.includes('shipment-list-builder'))return 'shipmentlist';
    if(p.includes('coupang-inbound-work'))return 'inbound';
    if(p.includes('purchase-order'))return 'purchase';
    if(p.includes('truck-shipment'))return 'truck';
    if(p.includes('pallet-load-list'))return 'palletlist';
    if(p.includes('outbound-box-numbering'))return 'outbound';
    if(p==='/'||p==='/index.html'||p==='/hs-code')return 'calculator';
    return '';
  }
  function findSidebar(){
    const candidates=[...document.querySelectorAll('nav.sidebar,aside.sidebar,.sidebar,aside.side,nav.side')];
    return candidates.find(x=>/TradeCode|관세율|물류비|바코드|발주|입고|트럭쉽먼트/.test(x.textContent||''))||candidates[0]||null;
  }
  function html(){
    const active=activeKey();
    const rows=ITEMS.map(it=>{
      if(it.divider)return `<div class="tc-nav-section tc-nav-login-divider">${it.label}</div>`;
      const cls='tc-nav-link'+(active===it.key?' active':'');
      if(it.comingSoon)return `<a class="${cls}" href="#" data-tc-coming-soon="1"><span class="tc-nav-icon">${it.icon}</span><span class="tc-nav-text">${it.label}</span></a>`;
      return `<a class="${cls}" href="${it.href}"><span class="tc-nav-icon">${it.icon}</span><span class="tc-nav-text">${it.label}</span></a>`;
    }).join('');
    return `<div class="tc-nav-brand"><div class="tc-nav-logo">TC</div><div><div class="tc-nav-brand-title">TradeCode Navi</div><span class="tc-nav-brand-sub">기능 목록</span></div></div><div class="tc-nav-section">도구</div>${rows}`;
  }
  function apply(){
    style();
    const side=findSidebar();if(!side)return false;
    side.classList.add('tc-unified-sidebar');
    if(side.dataset.tcUnifiedSidebarV151!=='1'){
      side.innerHTML=html();side.dataset.tcUnifiedSidebarV151='1';
    }else{
      side.querySelectorAll('.tc-nav-link').forEach(x=>x.classList.remove('active'));
      const key=activeKey();const item=ITEMS.find(x=>x.key===key);if(item){const a=[...side.querySelectorAll('.tc-nav-link')].find(x=>(x.getAttribute('href')||'')===item.href);if(a)a.classList.add('active')}
    }
    return true;
  }
  function comingSoonGuard(e){
    const el=e.target&&e.target.closest?e.target.closest('[data-tc-coming-soon="1"]'):null;
    if(!el)return;
    e.preventDefault();e.stopPropagation();
    alert('준비중입니다.');
  }
  document.addEventListener('click',comingSoonGuard,false);
  function boot(){apply();setTimeout(apply,80);setTimeout(apply,350);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
// ===== /v151 unified sidebar =====
