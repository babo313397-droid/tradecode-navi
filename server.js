/**
 * TradeCode Navi - UniPass(관세청) Open API 연동 백엔드 프록시
 * -------------------------------------------------------------
 * 목적: 프론트엔드(index.html)에 UniPass 인증키(crkyCn)를 절대 노출하지 않기 위해,
 *      이 서버가 대신 UniPass API를 호출하고 결과만 JSON으로 정리해서 내려준다.
 *
 * 사용 API (MYC_OpenAPI 연계가이드_v4.0 기준):
 *  - API018 HS 부호 조회   : https://unipass.customs.go.kr:38010/ext/rest/hsSgnQry/searchHsSgn
 *  - API030 관세율 기본 조회: https://unipass.customs.go.kr:38010/ext/rest/trrtQry/retrieveTrrt
 *
 * 실행 방법:
 *   cd server
 *   npm install
 *   cp .env.example .env   # .env에 UNIPASS_API_KEY=실제 인증키 입력 (이미 채워둔 .env가 있다면 확인)
 *   npm start
 *
 * 주의: .env 파일은 절대 git에 커밋하거나 외부에 공유하지 마세요. (.gitignore에 이미 포함됨)
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { searchHs, getTariff, navigateHsCode, checkCustomsRequirement } = require('./lib/unipass');
const { analyzeProduct } = require('./lib/ai');
const { freeTranslate } = require('./lib/freeTranslate');
const { createRateLimiter } = require('./lib/rateLimit');
const { listComments, createComment, updateComment, deleteComment, MAX_CONTENT_LEN, MAX_AUTHOR_LEN } = require('./lib/comments');
const { getExchangeRate } = require('./lib/exchangeRate');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20kb' })); // 댓글 등 POST/PUT/DELETE 본문(JSON) 파싱용
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 4000;
const UNIPASS_KEY = process.env.UNIPASS_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ''; // 선택: AI 상품명 분석 기능용

const MAX_QUERY_LENGTH = 100; // 상품명 입력 길이 제한 (남용/이상 입력 방지)
const analyzeProductLimiter = createRateLimiter({ windowMs: 60000, max: 10 }); // 분당 10회/IP
// 무료 번역은 키가 필요 없어 더 자주 쓰이므로 한도를 넉넉히(분당 20회/IP) 둔다.
const freeTranslateLimiter = createRateLimiter({ windowMs: 60000, max: 20 });
// 댓글 작성/수정/삭제는 도배 방지를 위해 분당 15회/IP로 제한 (조회는 제한 없음)
const commentWriteLimiter = createRateLimiter({ windowMs: 60000, max: 15 });
// 환율 조회도 키가 필요 없어 자주 호출될 수 있으므로 넉넉히(분당 20회/IP) 둔다.
const exchangeRateLimiter = createRateLimiter({ windowMs: 60000, max: 20 });

if (!UNIPASS_KEY) {
  console.warn('[경고] UNIPASS_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.');
}
if (!ANTHROPIC_KEY) {
  console.warn('[안내] ANTHROPIC_API_KEY 미설정 - AI 상품명 분석(선택 기능)은 비활성화 상태입니다.');
}

// GET /api/hs-search?q=가방&lang=ko   (API018 래핑)
// =========================================================
// 한국 관세청 CLIP HSK 10단위 후보 조회
// =========================================================

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16))
    );
}

function cleanHtmlCell(html) {
  const text = decodeHtmlEntities(
    String(html || '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );

  return text.replace(/\s+/g, ' ').trim();
}

function firstExactDigits(cell, len) {
  const m = String(cell || '').match(
    new RegExp('(?:^|\\D)(\\d{' + len + '})(?:\\D|$)')
  );
  return m ? m[1] : '';
}

function parseClipHskRows(html, prefix6) {
  const prefix = String(prefix6 || '').replace(/\D/g, '');

  if (!/^\d{6}$/.test(prefix)) return [];

  const p4 = prefix.slice(0, 4);
  const p2 = prefix.slice(4, 6);

  const rows =
    String(html || '').match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

  const found = new Map();

  for (const row of rows) {
    const rawCells = [
      ...row.matchAll(
        /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
      )
    ].map(m => m[1]);

    if (rawCells.length < 4) continue;

    const cells = rawCells.map(cleanHtmlCell);

    for (let i = 0; i < cells.length - 2; i++) {
      const a = firstExactDigits(cells[i], 4);
      const b = firstExactDigits(cells[i + 1], 2);
      const c = firstExactDigits(cells[i + 2], 4);

      if (
        a !== p4 ||
        b !== p2 ||
        !/^\d{4}$/.test(c)
      ) continue;

      const hs10Sgn = a + b + c;

      const korePrnm = cells[i + 3] || '';
      const englPrnm = cells[i + 4] || '';
      const baseRate = cells[i + 5] || '';

      if (!found.has(hs10Sgn)) {
        found.set(hs10Sgn, {
          hs10Sgn,
          korePrnm,
          englPrnm,
          baseRate,
          source: 'KCS CLIP'
        });
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => a.hs10Sgn.localeCompare(b.hs10Sgn)
  );
}

async function fetchClipHskChildren(prefix6) {
  const prefix = String(prefix6 || '').replace(/\D/g, '');

  if (!/^\d{6}$/.test(prefix)) {
    return {
      ok: false,
      error: 'prefix는 HS 6자리여야 합니다.',
      candidates: []
    };
  }

  const year = new Date().getFullYear();

  const url = new URL(
    'https://unipass.customs.go.kr/clip/hsinfosrch/openULS0201005Q.do'
  );

  url.searchParams.set('aplyYy', String(year));
  url.searchParams.set('cntyCd', 'KR');
  url.searchParams.set('cntyNm', '한국');
  url.searchParams.set('hstdYear', `${year}0101`);
  url.searchParams.set('sctYear', `${year}0101`);
  url.searchParams.set('searchVal', prefix);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 TradeCodeNavi/1.0',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `CLIP HTTP ${response.status}`,
        candidates: []
      };
    }

    const html = await response.text();

    const candidates =
      parseClipHskRows(html, prefix);

    return {
      ok: true,
      prefix,
      year,
      count: candidates.length,
      candidates
    };

  } catch (err) {
    return {
      ok: false,
      error: `CLIP 조회 실패: ${err.message}`,
      candidates: []
    };
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/hsk-children', async (req, res) => {
  const prefix =
    String(req.query.prefix || '').replace(/\D/g, '');

  if (!/^\d{6}$/.test(prefix)) {
    return res.status(400).json({
      ok: false,
      error: 'prefix 파라미터는 HS 6자리여야 합니다.',
      candidates: []
    });
  }

  const result =
    await fetchClipHskChildren(prefix);

  if (!result.ok) {
    return res.status(502).json(result);
  }

  res.json(result);
});
// =========================================================
// 관세청 CLIP 실제 세율표 조회
// HS 10자리 기준으로 A/C/FCN1 등 실제 세율 행을 읽어온다.
// =========================================================

function cleanClipRateCell(html) {
  const values = [];

  for (const m of String(html || '').matchAll(/\bvalue=["']([^"']*)["']/gi)) {
    const v = decodeHtmlEntities(m[1]).trim();
    if (v) values.push(v);
  }

  const text = cleanHtmlCell(html);
  if (text) values.push(text);

  return [...new Set(values)].join(' ').trim();
}

function extractPercent(text) {
  const s = String(text || '');

  const pct = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return parseFloat(pct[1]);

  const nums = s.match(/\d+(?:\.\d+)?/g) || [];
  for (const n of nums) {
    const v = parseFloat(n);
    if (Number.isFinite(v) && v >= 0 && v <= 100) return v;
  }

  return null;
}

function parseClipTariffRows(html) {
  const rows = String(html || '').match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  const found = [];

  for (const row of rows) {
    const rawCells = [
      ...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)
    ].map(m => m[1]);

    if (rawCells.length < 3) continue;

    const cells = rawCells.map(cleanClipRateCell);

    const code = String(cells[0] || '').trim();

    // A, C, FCN1, FEU1, FUS1 등 세율 구분기호
    if (!/^[A-Z][A-Z0-9]*\d*$/.test(code)) continue;

    const rate = extractPercent(cells[1]);
    if (rate === null) continue;

    const name = cells[2] || '';

    found.push({
      trrtTpcd: code,
      trrt: rate,
      trrtTpNm: name,
      source: 'KCS CLIP'
    });
  }

  return found;
}

async function fetchClipTariff(hs10) {
  const hs = String(hs10 || '').replace(/\D/g, '');

  if (!/^\d{10}$/.test(hs)) {
    return {
      ok: false,
      error: 'hs는 10자리여야 합니다.',
      rates: []
    };
  }

  const url = new URL(
    'https://unipass.customs.go.kr/clip/hsinfosrch/openULS0201007Q.do'
  );

  url.searchParams.set('opnMod', 'P');
  url.searchParams.set('cntyCd', 'KR');
  url.searchParams.set('searchVal', hs);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 TradeCodeNavi/1.0',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `CLIP HTTP ${response.status}`,
        rates: []
      };
    }

    const html = await response.text();
    const rates = parseClipTariffRows(html);

    return {
      ok: true,
      hs,
      count: rates.length,
      rates
    };

  } catch (err) {
    return {
      ok: false,
      error: `CLIP 세율 조회 실패: ${err.message}`,
      rates: []
    };
  } finally {
    clearTimeout(timer);
  }
}

app.get('/api/clip-tariff', async (req, res) => {
  const hs = String(req.query.hs || '').replace(/\D/g, '');

  if (!/^\d{10}$/.test(hs)) {
    return res.status(400).json({
      ok: false,
      error: 'hs 파라미터는 10자리여야 합니다.',
      rates: []
    });
  }

  const result = await fetchClipTariff(hs);

  if (!result.ok) {
    return res.status(502).json(result);
  }

  res.json(result);
});
app.get('/api/hs-search', async (req, res) => {
  
  const q = (req.query.q || '').trim();
  const lang = req.query.lang === 'en' ? 'en' : 'ko';
  if (!q) return res.status(400).json({ ok: false, error: 'q(검색어) 파라미터가 필요합니다.' });

  try {
    const result = await searchHs({ q, lang, apiKey: UNIPASS_KEY });
    if (!result.ok) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    res.status(504).json({ ok: false, error: `UniPass 호출 실패: ${err.message}` });
  }
});

// GET /api/tariff?hs=0712391030&code=FEU1(선택)   (API030 래핑)
// code(trrtTpcd) 생략 시 해당 HS부호의 모든 세율구분(기본/WTO/각 FTA)이 한번에
// 반환될 것으로 가이드 문서(항목구분: 옵션) 기준 추정됨 — 실사용 전 검증 필요.
app.get('/api/tariff', async (req, res) => {
  const hs = (req.query.hs || '').trim();
  const code = (req.query.code || '').trim();
  if (!/^\d{10}$/.test(hs)) {
    return res.status(400).json({ ok: false, error: 'hs 파라미터는 10자리 HS부호여야 합니다.' });
  }
  try {
    const result = await getTariff({ hs, code, apiKey: UNIPASS_KEY });
    if (!result.ok) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    res.status(504).json({ ok: false, error: `UniPass 호출 실패: ${err.message}` });
  }
});

// GET /api/analyze-product?q=반지   (선택 기능: AI 상품명 분석)
// ANTHROPIC_API_KEY가 없으면 ok:false를 반환하고, 프론트는 이 기능을 조용히 건너뛴다.
// 비용이 드는 호출이므로 IP당 분당 10회로 제한하고, 입력 길이도 제한한다.
app.get('/api/analyze-product', analyzeProductLimiter, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'q(상품명) 파라미터가 필요합니다.' });
  if (q.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({ ok: false, error: `상품명은 ${MAX_QUERY_LENGTH}자 이하로 입력해주세요.` });
  }
  try {
    const result = await analyzeProduct({ q, apiKey: ANTHROPIC_KEY });
    if (!result.ok) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    res.status(504).json({ ok: false, error: `AI 분석 실패: ${err.message}` });
  }
});

// GET /api/hs-navigate?heading=630790   (실험적: API043 HS CODE 내비게이션 조회)
// 6자리 HS 소호를 주면, 그 안에서 실제로 신고된 10자리 세번들을 건수 순위로 반환
// 시도한다. 이 서버가 있는 샌드박스에서는 unipass.customs.go.kr에 접속이 막혀
// 실제 동작을 검증하지 못했으므로, 실패해도 500 에러 대신 항상 candidates:[]와
// 함께 ok:false를 내려주어 프론트가 조용히 폴백할 수 있게 한다.
app.get('/api/hs-navigate', async (req, res) => {
  const heading = (req.query.heading || '').trim();
  if (!/^\d{6}$/.test(heading)) {
    return res.status(400).json({ ok: false, error: 'heading 파라미터는 6자리 숫자여야 합니다.', candidates: [] });
  }
  try {
    const result = await navigateHsCode({ heading6: heading, apiKey: UNIPASS_KEY });
    if (!result.ok) return res.status(502).json({ ...result, candidates: [] });
    res.json(result);
  } catch (err) {
    res.status(504).json({ ok: false, error: `UniPass 호출 실패: ${err.message}`, candidates: [] });
  }
});

// GET /api/customs-requirement?hs=3307902000&imexTp=2   (API029 래핑)
// HS 10단위 부호가 세관장확인대상(개별법상 별도 요건확인서류 제출 필요) 물품인지 조회한다.
// imexTp 생략 시 기본값 2(수입) - 이 프로젝트가 수입 통관 계산기이기 때문.
app.get('/api/customs-requirement', async (req, res) => {
  const hs = (req.query.hs || '').trim();
  const imexTp = (req.query.imexTp || '2').trim();
  if (!/^\d{10}$/.test(hs)) {
    return res.status(400).json({ ok: false, error: 'hs 파라미터는 10자리 HS부호여야 합니다.' });
  }
  try {
    const result = await checkCustomsRequirement({ hsSgn: hs, imexTp, apiKey: UNIPASS_KEY });
    if (!result.ok) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    res.status(504).json({ ok: false, error: `UniPass 호출 실패: ${err.message}` });
  }
});

// GET /api/free-translate?q=걸레   (키/가입 불필요 - AI 미설정 시에도 항상 동작하는 최후의 폴백)
// AI 분석(analyze-product)이 꺼져 있거나 실패했을 때, 최소한 "번역 결과 자체가 없어서
// 아무것도 못 보여주는" 상황만은 막기 위한 안전망. HS 챕터 추정 같은 건 하지 않는다.
app.get('/api/free-translate', freeTranslateLimiter, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'q(검색어) 파라미터가 필요합니다.' });
  if (q.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({ ok: false, error: `검색어는 ${MAX_QUERY_LENGTH}자 이하로 입력해주세요.` });
  }
  try {
    const result = await freeTranslate({ q });
    if (!result.ok) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    res.status(504).json({ ok: false, error: `번역 실패: ${err.message}` });
  }
});

// ---------------------------------------------------------------------
// 댓글/답글 (로그인 없이 닉네임+비밀번호로 본인 확인하는 간단 게시판형 댓글)
// 저장은 server/data/comments.json 파일에 한다 - 자세한 건 lib/comments.js 참고.
// ---------------------------------------------------------------------

// GET /api/comments - 전체 댓글/답글 목록 (평평한 배열, parentId로 트리 구성은 프론트에서)
app.get('/api/comments', (req, res) => {
  try {
    res.json({ ok: true, comments: listComments() });
  } catch (err) {
    res.status(500).json({ ok: false, error: `댓글 조회 실패: ${err.message}` });
  }
});

// POST /api/comments - 댓글 작성 (parentId를 주면 답글)
// body: { author, password, content, parentId? }
app.post('/api/comments', commentWriteLimiter, (req, res) => {
  const { author, password, content, parentId } = req.body || {};
  const result = createComment({ author, password, content, parentId: parentId || null });
  if (!result.ok) return res.status(400).json(result);
  res.status(201).json(result);
});

// PUT /api/comments/:id - 댓글 수정 (비밀번호 확인 필요)
// body: { password, content }
app.put('/api/comments/:id', commentWriteLimiter, (req, res) => {
  const { password, content } = req.body || {};
  const result = updateComment({ id: req.params.id, password, content });
  if (!result.ok) return res.status(result.error && result.error.includes('일치하지') ? 403 : 400).json(result);
  res.json(result);
});

// DELETE /api/comments/:id - 댓글 삭제 (비밀번호 확인 필요, 하위 답글도 함께 삭제)
// body: { password }
app.delete('/api/comments/:id', commentWriteLimiter, (req, res) => {
  const { password } = req.body || {};
  const result = deleteComment({ id: req.params.id, password });
  if (!result.ok) return res.status(result.error && result.error.includes('일치하지') ? 403 : 400).json(result);
  res.json(result);
});

// GET /api/exchange-rate?base=CNY&to=KRW   (키/가입 불필요 - 로켓배송 계산기의 환율 자동 입력용)
// 실패해도 500 에러 대신 ok:false를 내려주어, 프론트가 조용히 기존 기본값(직접 입력)으로 폴백할 수 있게 한다.
app.get('/api/exchange-rate', exchangeRateLimiter, async (req, res) => {
  const base = (req.query.base || 'CNY').trim();
  const to = (req.query.to || 'KRW').trim();
  try {
    const result = await getExchangeRate({ base, target: to });
    if (!result.ok) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    res.status(504).json({ ok: false, error: `환율 조회 실패: ${err.message}` });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, keyConfigured: !!UNIPASS_KEY, aiConfigured: !!ANTHROPIC_KEY });
});

app.get('/', (req, res) => {
  // =========================================================
// SEO용 개별 계산기 URL
// 기존 index.html 하나를 사용하되 URL별 title/description/canonical 변경
// =========================================================

const SEO_PAGES = {
  '/hs-code': {
    feature: 'calculator',
    title: 'HS코드 조회·FTA 관세율 계산기 | TradeCode Navi',
    description: '품명과 재질을 기준으로 HS코드, HSK 10자리, 기본관세율과 국가별 FTA 협정관세율을 확인해 보세요.'
  },

  '/coupang-margin': {
    feature: 'rocketmargin',
    title: '쿠팡 로켓배송 원가·마진률 계산기 | TradeCode Navi',
    description: '쿠팡 로켓배송 상품의 원가, 공급가, 판매가와 마진률을 간편하게 계산해 보세요.'
  },

  '/logistics-cost': {
    feature: 'logistics',
    title: '수입 물류비·CBM 계산기 | TradeCode Navi',
    description: '박스 규격과 수량, 신고금액, 관세율을 입력해 CBM과 예상 수입 물류비를 계산해 보세요.'
  }
};

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderSeoPage(req, res) {
  const config = SEO_PAGES[req.path];

  if (!config) {
    return res.status(404).send('Not Found');
  }

  const indexPath = path.join(__dirname, 'index.html');

  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) {
      console.error('index.html 읽기 실패:', err);
      return res.status(500).send('Server Error');
    }

    const canonical =
      `https://tool.dasaba.co.kr${req.path}`;

    html = html
      .replace(
        /<title>[\s\S]*?<\/title>/i,
        `<title>${config.title}</title>`
      )
      .replace(
        /<meta\s+name=["']description["'][^>]*>/i,
        `<meta name="description" content="${escapeAttr(config.description)}">`
      )
      .replace(
        /<link\s+rel=["']canonical["'][^>]*>/i,
        `<link rel="canonical" href="${canonical}">`
      )
      .replace(
        /<meta\s+property=["']og:title["'][^>]*>/i,
        `<meta property="og:title" content="${escapeAttr(config.title)}">`
      )
      .replace(
        /<meta\s+property=["']og:description["'][^>]*>/i,
        `<meta property="og:description" content="${escapeAttr(config.description)}">`
      )
      .replace(
        /<meta\s+property=["']og:url["'][^>]*>/i,
        `<meta property="og:url" content="${canonical}">`
      )
      .replace(
        '</head>',
        `<script>window.TRADECODE_INITIAL_FEATURE=${JSON.stringify(config.feature)};</script>\n</head>`
      );

    res.type('html').send(html);
  });
}

app.get('/hs-code', renderSeoPage);
app.get('/coupang-margin', renderSeoPage);
app.get('/logistics-cost', renderSeoPage);
  app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TradeCode Navi 백엔드 프록시 실행 중: http://localhost:${PORT}`);
  console.log(`인증키 설정 여부: ${UNIPASS_KEY ? 'O' : 'X (미설정)'}`);
});
