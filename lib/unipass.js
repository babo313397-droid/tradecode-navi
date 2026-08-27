// UniPass(관세청) Open API 호출 + 파싱 로직.
// server.js 와 테스트 코드가 동일한 로직을 공유하도록 별도 모듈로 분리했다.
const { extractTag, extractBlocks } = require('./xml');

const DEFAULT_BASE = 'https://unipass.customs.go.kr:38010/ext/rest';
const DEFAULT_TIMEOUT_MS = 10000;

async function callUnipass(baseUrl, serviceName, operationName, crkyCn, params, timeoutMs) {
  const url = new URL(`${baseUrl}/${serviceName}/${operationName}`);
  url.searchParams.set('crkyCn', crkyCn || '');
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    const text = await res.text();
    return { httpOk: res.ok, status: res.status, body: text, requestUrl: url.toString() };
  } finally {
    clearTimeout(t);
  }
}

// API018 HS 부호 조회
async function searchHs({ q, lang, baseUrl, apiKey, timeoutMs }) {
  const isHsDigits = /^\d{10}$/.test(q);
  const params = isHsDigits
    ? { hsSgn: q, koenTp: lang === 'en' ? '2' : '1' }
    : { prnm: q, koenTp: lang === 'en' ? '2' : '1' };

  const { httpOk, status, body, requestUrl } = await callUnipass(
    baseUrl || DEFAULT_BASE, 'hsSgnQry', 'searchHsSgn', apiKey, params, timeoutMs
  );
  if (!httpOk) return { ok: false, error: `UniPass HTTP ${status}`, requestUrl };

  const ntceInfo = extractTag(body, 'ntceInfo') || '';
  const tCnt = parseInt(extractTag(body, 'tCnt') || '0', 10);
  const blocks = extractBlocks(body, 'hsSgnSrchRsltVo');
  const items = blocks.map((b) => ({
    hsSgn: extractTag(b, 'hsSgn') || '',
    korePrnm: extractTag(b, 'korePrnm') || '',
    englPrnm: extractTag(b, 'englPrnm') || '',
    txrt: extractTag(b, 'txrt') || '',
    txtpSgn: extractTag(b, 'txtpSgn') || '',
    qtyUt: extractTag(b, 'qtyUt') || '',
    wghtUt: extractTag(b, 'wghtUt') || ''
  }));
  return { ok: true, tCnt, ntceInfo, count: items.length, items, requestUrl };
}

// API030 관세율 기본 조회
async function getTariff({ hs, code, baseUrl, apiKey, timeoutMs }) {
  const { httpOk, status, body, requestUrl } = await callUnipass(
    baseUrl || DEFAULT_BASE, 'trrtQry', 'retrieveTrrt', apiKey, { hsSgn: hs, trrtTpcd: code || undefined }, timeoutMs
  );
  if (!httpOk) return { ok: false, error: `UniPass HTTP ${status}`, requestUrl };

  const ntceInfo = extractTag(body, 'ntceInfo') || '';
  const tCnt = parseInt(extractTag(body, 'tCnt') || '0', 10);
  const blocks = extractBlocks(body, 'TrrtQryRsltVo');
  const rates = blocks.map((b) => ({
    hsSgn: extractTag(b, 'hsSgn') || '',
    trrtTpcd: extractTag(b, 'trrtTpcd') || '',
    trrtTpNm: extractTag(b, 'trrtTpNm') || '',
    trrt: extractTag(b, 'trrt') || '',
    aplyStrtDt: extractTag(b, 'aplyStrtDt') || '',
    aplyEndDt: extractTag(b, 'aplyEndDt') || '',
    basePrc: extractTag(b, 'basePrc') || '',
    prutXamt: extractTag(b, 'prutXamt') || ''
  }));
  return { ok: true, tCnt, ntceInfo, count: rates.length, rates, requestUrl };
}

// API043 HS CODE 내비게이션 조회 (cmtrStatsQry/retrieveCmtrStats)
// -----------------------------------------------------------------------
// 가이드 문서(MYC_OpenAPI 연계가이드_v4.0, API043)에 따르면 이 API는 "무역통계의
// HS10 단위부호로 신고한 내역을 건수별로 순위를 집계"해서 돌려준다. 응답에는
// hs10Sgn(실제 신고된 10자리 HS부호), prlstNm(그 부호의 실제 품목명), acrsTcntRnk
// (실적 건수 순위)가 들어있다 — 즉 "샘플 사전의 -0000 placeholder" 대신, 실제로
// 신고에 쓰인 진짜 마지막 4자리(HSK 세번)와 그 설명을 보여줄 수 있는 유일한 공식
// 경로다.
//
// 가이드의 예제 요청이 hsSgn=01*******0 처럼 '*'가 섞인 값을 쓰고 있어, 앞자리
// (HS류/호)만 고정하고 나머지를 '*'로 채우면 그 앞자리에 속하는 실제 신고 코드들을
// 건수 순위로 받아올 수 있는 것으로 추정된다. 다만 이 문서에는 '*' 사용법에 대한
// 별도 설명 문장이 없고, 이 서버가 실행되는 샌드박스 환경에서는 실제
// unipass.customs.go.kr 서버에 접속이 차단되어 있어 이 동작을 직접 검증하지
// 못했다. 그래서 이 함수는 "실험적(unverified)" 기능으로 분리해두었고, 호출
// 실패/빈 결과 시에도 에러를 던지지 않고 항상 ok:false 또는 candidates:[]를
// 돌려주어 나머지 기능에 영향을 주지 않도록 만들었다. 실제 서버에서 이 기능을
// 써보고 결과(성공/빈 배열/에러 메시지)를 알려주면 그에 맞춰 패턴을 조정할 수 있다.
async function navigateHsCode({ heading6, baseUrl, apiKey, timeoutMs }) {
  const digits = String(heading6 || '').replace(/\D/g, '');
  if (digits.length !== 6) {
    return { ok: false, error: 'heading6는 6자리 숫자(HS 소호)여야 합니다.' };
  }
  // 앞 6자리(HS 6단위)는 고정하고, 뒤 4자리(HSK 세번)는 '*'로 채워 실제 신고된
  // 세번들을 건수 순위로 조회 시도. 예: "630790" -> "630790****"
  const pattern = `${digits}****`;

  const { httpOk, status, body, requestUrl } = await callUnipass(
    baseUrl || DEFAULT_BASE, 'cmtrStatsQry', 'retrieveCmtrStats', apiKey, { hsSgn: pattern }, timeoutMs
  );
  if (!httpOk) return { ok: false, error: `UniPass HTTP ${status}`, requestUrl };

  const ntceInfo = extractTag(body, 'ntceInfo') || '';
  const tCnt = parseInt(extractTag(body, 'tCnt') || '0', 10);
  const blocks = extractBlocks(body, 'cmtrStatsQryRsltVo');
  const candidates = blocks.map((b) => ({
    hs10Sgn: extractTag(b, 'hs10Sgn') || '',
    prlstNm: extractTag(b, 'prlstNm') || '',
    acrsTcntRnk: parseInt(extractTag(b, 'acrsTcntRnk') || '0', 10),
    prlstLnCnt: parseInt(extractTag(b, 'prlstLnCnt') || '0', 10)
  })).sort((a, b) => a.acrsTcntRnk - b.acrsTcntRnk);

  return { ok: true, tCnt, ntceInfo, count: candidates.length, candidates, requestUrl, pattern };
}

// API029 세관장확인대상 물품 조회 (ccctLworCdQry/retrieveCcctLworCd)
// -----------------------------------------------------------------------
// HS 10단위 부호가 특정 개별법(예: 화장품법, 전기용품 및 생활용품 안전관리법 등)에
// 따른 "세관장확인대상"인지 - 즉 통관 시 관세청 신고 외에 별도의 요건확인서류
// (예: 표준통관예정보고서) 제출이 필요한지를 조회한다. 가이드 문서 예제 응답 기준
// tCnt가 0이면 "조회된 정보가 없습니다" - 이는 해당 세번에 걸린 개별법 요건이
// 없다는 뜻으로 해석한다(요건 없음 ≠ API 실패).
// imexTp: 1=수출, 2=수입 (이 프로젝트는 수입 통관 계산기이므로 기본값 2를 쓴다)
async function checkCustomsRequirement({ hsSgn, imexTp, baseUrl, apiKey, timeoutMs }) {
  const digits = String(hsSgn || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(digits)) {
    return { ok: false, error: 'hsSgn은 10자리 숫자(HS 10단위 부호)여야 합니다.' };
  }
  const { httpOk, status, body, requestUrl } = await callUnipass(
    baseUrl || DEFAULT_BASE, 'ccctLworCdQry', 'retrieveCcctLworCd', apiKey,
    { hsSgn: digits, imexTp: imexTp || '2' }, timeoutMs
  );
  if (!httpOk) return { ok: false, error: `UniPass HTTP ${status}`, requestUrl };

  const ntceInfo = extractTag(body, 'ntceInfo') || '';
  const tCnt = parseInt(extractTag(body, 'tCnt') || '0', 10);
  const blocks = extractBlocks(body, 'CcctLworCdQryRsltVo');
  const requirements = blocks.map((b) => ({
    hsSgn: extractTag(b, 'hsSgn') || '',
    lworNm: extractTag(b, 'dcerCfrmLworNm') || '',       // 관련법령명 (예: 화장품법)
    docNm: extractTag(b, 'reqCfrmIstmNm') || '',          // 요건확인서류명 (예: 표준통관예정보고서(화장품))
    ittNm: extractTag(b, 'reqApreIttNm') || '',           // 요건승인기관명 (예: 한국의약품수출입협회)
    aplyStrtDt: extractTag(b, 'aplyStrtDt') || '',
    aplyEndDt: extractTag(b, 'aplyEndDt') || ''
  }));
  return { ok: true, tCnt, ntceInfo, count: requirements.length, requirements, requestUrl };
}

module.exports = { searchHs, getTariff, navigateHsCode, checkCustomsRequirement, callUnipass, DEFAULT_BASE };
