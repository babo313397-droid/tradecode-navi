// 아주 가벼운 in-memory 슬라이딩 윈도우 rate limiter.
// AI 분석 엔드포인트처럼 실제 비용이 드는 호출을 남용/무한 반복 요청으로부터 보호하기 위함.
// 외부 패키지(redis, express-rate-limit 등) 없이 단일 서버 프로세스 안에서만 동작한다.
// (여러 대의 서버로 수평 확장할 경우에는 공유 저장소 기반 limiter로 교체해야 함)
function createRateLimiter({ windowMs = 60000, max = 10 } = {}) {
  const hits = new Map(); // key -> timestamp[]

  return function rateLimitMiddleware(req, res, next) {
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(ts => now - ts < windowMs);
    arr.push(now);
    hits.set(key, arr);

    if (arr.length > max) {
      const retryAfterSec = Math.ceil(windowMs / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        ok: false,
        error: `요청이 너무 많습니다. ${retryAfterSec}초 후 다시 시도해주세요. (최대 ${max}회/${Math.round(windowMs / 1000)}초)`
      });
    }
    next();
  };
}

module.exports = { createRateLimiter };
