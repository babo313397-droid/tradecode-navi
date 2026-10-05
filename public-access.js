(function(){
  'use strict';
  const RESTRICTED=['/order-barcode','/shipment-list-builder','/detail-maker','/coupang-inbound-work','/purchase-order','/account-admin'];
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
    const map=[['발주 바코드','/order-barcode.html'],['선적 리스트','/shipment-list-builder.html'],['상세페이지','/detail-maker'],['쿠팡 입고 작업','/coupang-inbound-work.html'],['발주서 작성','/purchase-order.html'],['계정관리','/account-admin.html']];
    const hit=map.find(([name])=>t.includes(name));return hit?hit[1]:'';
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
    if(/공용 라벨 저장|공용 라벨 불러오기|공용 라벨 보기|공용 라벨 삭제|기존 라벨 공용|공용 라벨 백업|백업 복원|저장소 상태|목록 새로고침|지금 저장/.test(txt))return true;
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
    guard();const st=await check();accountBar();
    const p=new URLSearchParams(location.search);if(!st.authenticated&&p.get('authChoice')==='1'){show(p.get('next')||'/');}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
