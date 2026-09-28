(function(){
  'use strict';
  const ID='tc-pallet-simulator-launcher';
  if(document.getElementById(ID))return;

  const style=document.createElement('style');
  style.id=ID+'-style';
  style.textContent=`
    #${ID}.tc-ps-nav{display:flex!important;align-items:center;gap:8px;width:100%;text-decoration:none!important}
    #${ID}.tc-ps-nav[aria-current="page"]{background:#dcae24!important;color:#102a1e!important;border-color:#dcae24!important}
    #${ID}.tc-ps-float{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:inline-flex;align-items:center;gap:8px;
      min-height:44px;padding:0 16px;border-radius:999px;background:#0b6b3a;color:#fff!important;text-decoration:none!important;
      font-family:Arial,'Noto Sans KR',sans-serif;font-size:13px;font-weight:900;letter-spacing:-.2px;
      box-shadow:0 8px 24px rgba(11,107,58,.28);border:1px solid rgba(255,255,255,.28)}
    #${ID}.tc-ps-float:hover{background:#084f2c}
    #${ID} .tc-ps-icon{font-size:15px;line-height:1}
    @media(max-width:760px){#${ID}.tc-ps-float{right:10px;bottom:10px;min-height:40px;padding:0 12px;font-size:12px}}
    @media print{#${ID}{display:none!important}}
  `;
  document.head.appendChild(style);

  const a=document.createElement('a');
  a.id=ID;
  a.href='/coupang-pallet-simulator';
  a.innerHTML='<span class="tc-ps-icon">▦</span><span>쿠팡 팔레트 시뮬레이션</span>';
  a.title='쿠팡 팔레트 적재 시뮬레이션 열기';
  if(location.pathname.startsWith('/coupang-pallet-simulator'))a.setAttribute('aria-current','page');

  function isPurchaseOrderLink(el){
    if(!el||el.tagName!=='A')return false;
    try{const u=new URL(el.href,location.href);return u.pathname==='/purchase-order'||u.pathname==='/purchase-order.html'}catch(_){return /purchase-order(?:\.html)?(?:[?#]|$)/.test(el.getAttribute('href')||'')}
  }
  function installInSidebar(){
    const side=document.querySelector('.sidebar, nav.sidebar');
    if(!side)return false;
    const links=[...side.querySelectorAll('a')];
    const po=links.find(isPurchaseOrderLink);
    if(!po)return false;
    a.className=(po.className?po.className+' ':'')+'tc-ps-nav';
    a.classList.remove('active');
    if(location.pathname.startsWith('/coupang-pallet-simulator'))a.classList.add('active');
    po.insertAdjacentElement('afterend',a);
    return true;
  }
  function installFallback(){
    if(a.isConnected)return;
    a.className='tc-ps-float';
    document.body.appendChild(a);
  }

  if(!installInSidebar()){
    const mo=new MutationObserver(()=>{if(installInSidebar())mo.disconnect()});
    mo.observe(document.documentElement,{childList:true,subtree:true});
    setTimeout(()=>{if(!a.isConnected){mo.disconnect();installFallback()}},1800);
  }
})();
