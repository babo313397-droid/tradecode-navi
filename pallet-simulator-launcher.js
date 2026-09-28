(function(){
  'use strict';
  const ID='tc-pallet-simulator-launcher';
  if(document.getElementById(ID))return;

  const style=document.createElement('style');
  style.id=ID+'-style';
  style.textContent=`
    #${ID}{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:inline-flex;align-items:center;gap:8px;
      min-height:44px;padding:0 16px;border-radius:999px;background:#0b6b3a;color:#fff!important;text-decoration:none!important;
      font-family:Arial,'Noto Sans KR',sans-serif;font-size:13px;font-weight:900;letter-spacing:-.2px;
      box-shadow:0 8px 24px rgba(11,107,58,.28);border:1px solid rgba(255,255,255,.28);transition:.16s ease}
    #${ID}:hover{transform:translateY(-1px);background:#084f2c;box-shadow:0 10px 28px rgba(11,107,58,.34)}
    #${ID}:focus-visible{outline:3px solid #ffd54f;outline-offset:3px}
    #${ID} .tc-ps-icon{font-size:17px;line-height:1}
    #${ID}[aria-current="page"]{background:#123a28}
    @media(max-width:760px){#${ID}{right:10px;bottom:10px;min-height:40px;padding:0 12px;font-size:12px}}
    @media print{#${ID}{display:none!important}}
  `;
  document.head.appendChild(style);

  const a=document.createElement('a');
  a.id=ID;
  a.href='/coupang-pallet-simulator';
  a.innerHTML='<span class="tc-ps-icon">▦</span><span>쿠팡 팔레트 시뮬레이션</span>';
  a.title='쿠팡 팔레트 적재 시뮬레이션 열기';
  if(location.pathname.startsWith('/coupang-pallet-simulator'))a.setAttribute('aria-current','page');
  document.body.appendChild(a);
})();
