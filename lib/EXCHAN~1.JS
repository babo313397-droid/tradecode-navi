// 실시간(참고용) 환율 조회 - 키/가입 불필요한 공개 API 2곳을 순서대로 시도한다.
// -----------------------------------------------------------------------
// 목적: "로켓배송 원가&마진률 계산" 화면의 환율 입력칸을 사용자가 매번 직접
//       네이버 등에서 찾아 입력하지 않아도, 화면을 열 때 자동으로 채워주기 위함.
//
// 주의(중요): 사용자가 원한 건 정확히는 "네이버 환율"이었지만, 네이버는 공식
// 공개 API를 제공하지 않는다(내부용 비공식 엔드포인트를 가져다 쓰는 방법도 있지만,
// 예고 없이 막히거나 구조가 바뀔 수 있어 이 프로젝트의 다른 기능들과 신뢰성 기준이
// 맞지 않는다고 판단했다). 대신 은행/기관들이 흔히 참조하는 공개 환율 API 2곳을
// 순서대로 시도한다:
//  1) Frankfurter.app - 유럽중앙은행(ECB) 환율 기반의 안정적인 무료 API
//  2) open.er-api.com - 위 API가 실패했을 때의 보조 수단
// 두 값 모두 "네이버 환율"과 완전히 동일하진 않을 수 있어(환전 수수료·스프레드
// 차이), 프론트에서는 이 값을 "참고용 실시간 환율"이라고 표시하고 사용자가 직접
// +/-나 값 수정으로 조정할 수 있게 해둔다.
//
// 실패 시 ok:false만 반환하고 에러를 던지지 않는다 - 프론트는 이 경우 조용히
// 기존 기본값(직접 입력)으로 폴백한다.

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

async function tryFrankfurter(base, target, timeoutMs) {
  const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(target)}`;
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);
  const json = await res.json();
  const rate = json && json.rates && json.rates[target];
  if (!rate || typeof rate !== 'number') throw new Error('Frankfurter 응답 파싱 실패');
  return rate;
}

async function tryOpenErApi(base, target, timeoutMs) {
  const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`;
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`open.er-api.com HTTP ${res.status}`);
  const json = await res.json();
  const rate = json && json.rates && json.rates[target];
  if (!rate || typeof rate !== 'number') throw new Error('open.er-api.com 응답 파싱 실패');
  return rate;
}

// base: 기준 통화(예: 'CNY'), target: 환산 대상 통화(예: 'KRW')
async function getExchangeRate({ base, target, timeoutMs }) {
  const b = (base || 'CNY').toUpperCase();
  const t = (target || 'KRW').toUpperCase();
  const errors = [];

  try {
    const rate = await tryFrankfurter(b, t, timeoutMs);
    return { ok: true, rate, source: 'frankfurter.app', base: b, target: t };
  } catch (err) {
    errors.push(`[Frankfurter] ${err.message}`);
  }

  try {
    const rate = await tryOpenErApi(b, t, timeoutMs);
    return { ok: true, rate, source: 'open.er-api.com', base: b, target: t };
  } catch (err) {
    errors.push(`[open.er-api.com] ${err.message}`);
  }

  const combined = errors.join(' / ');
  console.warn(`[exchangeRate] ${b}->${t} 환율 조회 실패 - 두 소스 모두 실패: ${combined}`);
  return { ok: false, error: `환율 조회 실패: ${combined}` };
}

module.exports = { getExchangeRate };
