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
