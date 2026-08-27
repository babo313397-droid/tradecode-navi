// 무료(가입/키 불필요) 한→영 번역 폴백.
// -----------------------------------------------------------------------
// 목적: ANTHROPIC_API_KEY가 없거나(과금 문제로 발급을 못한 경우 포함) AI 분석이
//       실패하더라도, "일치하는 품목을 찾지 못했습니다"처럼 아무 정보도 없는
//       빈 결과를 절대 보여주지 않기 위한 최후의 보루.
//
//       두 개의 무료(키/가입 불필요) 번역 소스를 순서대로 시도한다:
//       1) Google 번역 비공식 엔드포인트 - 품질이 좋고("네이버사전 수준"에 가장 가까움)
//          짧은 상품명 번역에서 특히 안정적이다. 공식 API가 아니라 예고 없이 막힐 수
//          있다는 단점이 있다.
//       2) MyMemory Translation API - 완전히 공개된 공식 무료 API. 1번이 막혔을 때의
//          보조 수단으로 유지한다.
//
// 주의: 품질이 AI 분석보다 낮고(단순 기계번역 수준), HS 챕터 추정 같은 건 못 한다.
//       그래서 이 결과는 항상 "참고용 단순 번역"이라고 명확히 표시하고, 가능하면
//       이 번역어로 UniPass 영문 검색(koenTp=2)을 한 번 더 시도해서 실제 공식
//       데이터와 연결되도록 한다.
//
// 진단용 로그: 두 소스가 모두 실패하면 서버 콘솔(터미널)에 이유를 남긴다.
// "자동 변환에 실패했습니다"가 뜰 때, 서버를 실행 중인 터미널 창에 어떤 에러가
// 찍히는지 보면 원인(네트워크 차단/타임아웃/응답 형식 문제 등)을 알 수 있다.

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function tryGoogle(q, timeoutMs) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ko&tl=en&dt=t&q=${encodeURIComponent(q)}`;
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`Google 비공식 엔드포인트 HTTP ${res.status}`);
  const json = await res.json();
  // 응답 형태: [ [ ["번역문장1","원문1",null,null,1], ["번역문장2","원문2",...] ], null, "ko", ... ]
  // 문장이 여러 개로 쪼개져 올 수 있어 모두 이어붙인다.
  const segments = Array.isArray(json) && Array.isArray(json[0]) ? json[0] : null;
  if (!segments) throw new Error('Google 응답 파싱 실패');
  const translated = segments.map(seg => (Array.isArray(seg) ? seg[0] : '')).join('').trim();
  if (!translated) throw new Error('Google 번역 결과 없음');
  return translated;
}

async function tryMyMemory(q, timeoutMs) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=ko|en`;
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
  const json = await res.json();
  const translated = json && json.responseData && json.responseData.translatedText;
  if (!translated) throw new Error('MyMemory 번역 결과 없음');
  // MyMemory는 실패해도 200을 주고 안내 문구(예: "MYMEMORY WARNING...")를 넣는 경우가 있어 걸러낸다.
  if (/MYMEMORY WARNING|INVALID|QUERY LENGTH LIMIT/i.test(translated)) {
    throw new Error('MyMemory 한도 초과 또는 오류 응답: ' + translated);
  }
  return translated;
}

async function freeTranslate({ q, timeoutMs }) {
  if (!q) return { ok: false, error: '입력이 없습니다.' };

  const errors = [];

  try {
    const translated = await tryGoogle(q, timeoutMs);
    return { ok: true, translatedText: translated, source: 'google' };
  } catch (err) {
    errors.push(`[Google] ${err.message}`);
  }

  try {
    const translated = await tryMyMemory(q, timeoutMs);
    return { ok: true, translatedText: translated, source: 'mymemory' };
  } catch (err) {
    errors.push(`[MyMemory] ${err.message}`);
  }

  const combined = errors.join(' / ');
  console.warn(`[freeTranslate] "${q}" 번역 실패 - 두 소스 모두 실패: ${combined}`);
  console.warn('[freeTranslate] 힌트: 이 서버가 외부 인터넷(translate.googleapis.com, api.mymemory.translated.net)에 접속 가능한지 확인하세요. 회사/공용 네트워크 방화벽이나 백신 프로그램이 막고 있을 수 있습니다.');
  return { ok: false, error: `번역 호출 실패: ${combined}` };
}

module.exports = { freeTranslate };
