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
app.use(express.json({ limit: '5mb' })); // 공용 라벨/상품목록/댓글 등 JSON 파싱용
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


// =====================================================================
// 쿠팡 입고 작업 공용 저장소 (인터넷 어디서나 같은 작업 공유)
// Front: /coupang-inbound-work.html
// API  : /api/coupang-shared/*
//
// 기본 저장 위치는 ./data/coupang-shared 입니다.
// 호스팅에서 영구 디스크를 별도로 제공하면 COUPANG_SHARED_DIR 환경변수로
// 해당 경로를 지정하면 재배포/재시작 후에도 데이터를 안전하게 유지할 수 있습니다.
// COUPANG_SHARED_TOKEN을 설정하면 작업 API에 공용 암호를 걸 수 있습니다.
// 비워두면 주소에 접속한 모든 사용자가 공용 작업을 읽고 수정할 수 있습니다.
// =====================================================================
const COUPANG_SHARED_DIR = process.env.COUPANG_SHARED_DIR || path.join(__dirname, 'data', 'coupang-shared');
const COUPANG_SHARED_TOKEN = String(process.env.COUPANG_SHARED_TOKEN || '').trim();
const COUPANG_STATE_PATH = path.join(COUPANG_SHARED_DIR, 'state.json');
const COUPANG_BLOBS = {
  source: {
    data: path.join(COUPANG_SHARED_DIR, 'source.xlsx.bin'),
    meta: path.join(COUPANG_SHARED_DIR, 'source.meta.json')
  },
  workbookSnapshot: {
    data: path.join(COUPANG_SHARED_DIR, 'workbookSnapshot.xlsx.bin'),
    meta: path.join(COUPANG_SHARED_DIR, 'workbookSnapshot.meta.json')
  }
};

function ensureCoupangSharedDir() {
  fs.mkdirSync(COUPANG_SHARED_DIR, { recursive: true });
}
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function writeAtomic(file, data) {
  ensureCoupangSharedDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function unlinkSafe(file) {
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function coupangAuth(req, res, next) {
  if (!COUPANG_SHARED_TOKEN) return next();
  const got = String(req.get('X-Coupang-Work-Token') || '');
  if (got !== COUPANG_SHARED_TOKEN) return res.status(401).json({ ok: false, error: '공용 작업 암호가 필요합니다.' });
  next();
}
function blobKeyOr404(req, res) {
  const key = req.params.key;
  const info = COUPANG_BLOBS[key];
  if (!info) { res.status(404).json({ ok: false, error: '지원하지 않는 파일 키입니다.' }); return null; }
  return { key, info };
}
function blobStatus(key) {
  const info = COUPANG_BLOBS[key];
  const meta = info ? readJsonSafe(info.meta) : null;
  if (!info || !meta || !fs.existsSync(info.data)) return null;
  return { updatedAt: Number(meta.updatedAt || 0), size: Number(meta.size || 0), name: meta.name || '' };
}
function stateStatus() {
  const row = readJsonSafe(COUPANG_STATE_PATH);
  return row ? { updatedAt: Number(row.updatedAt || 0) } : null;
}

app.get('/api/coupang-shared/status', coupangAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    state: stateStatus(),
    source: blobStatus('source'),
    workbookSnapshot: blobStatus('workbookSnapshot')
  });
});

app.get('/api/coupang-shared/state', coupangAuth, (req, res) => {
  const row = readJsonSafe(COUPANG_STATE_PATH);
  if (!row) return res.status(404).json({ ok: false, error: '저장된 작업 상태가 없습니다.' });
  res.set('Cache-Control', 'no-store');
  res.set('X-Updated-At', String(row.updatedAt || 0));
  res.json(row);
});

app.put('/api/coupang-shared/state', coupangAuth,
  express.text({ type: ['text/plain', 'application/json'], limit: '15mb' }),
  (req, res) => {
    try {
      const state = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const updatedAt = Date.now();
      writeAtomic(COUPANG_STATE_PATH, JSON.stringify({ ok: true, updatedAt, state }));
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, updatedAt });
    } catch (err) {
      res.status(400).json({ ok: false, error: `작업 상태 저장 실패: ${err.message}` });
    }
  }
);

app.delete('/api/coupang-shared/state', coupangAuth, (req, res) => {
  try { unlinkSafe(COUPANG_STATE_PATH); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/coupang-shared/blob/:key', coupangAuth, (req, res) => {
  const picked = blobKeyOr404(req, res); if (!picked) return;
  const { info } = picked;
  const meta = readJsonSafe(info.meta);
  if (!meta || !fs.existsSync(info.data)) return res.status(404).json({ ok: false, error: '저장된 파일이 없습니다.' });
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', meta.type || 'application/octet-stream');
  res.set('X-Updated-At', String(meta.updatedAt || 0));
  res.set('X-File-Name', String(meta.name || ''));
  res.set('X-File-Type', String(meta.type || ''));
  res.set('X-File-Mode', String(meta.mode || ''));
  res.set('X-Saved-At', String(meta.savedAt || meta.updatedAt || 0));
  res.sendFile(info.data);
});

app.put('/api/coupang-shared/blob/:key', coupangAuth,
  express.raw({ type: 'application/octet-stream', limit: '80mb' }),
  (req, res) => {
    try {
      const picked = blobKeyOr404(req, res); if (!picked) return;
      const { key, info } = picked;
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      if (!body.length) return res.status(400).json({ ok: false, error: '빈 파일은 저장할 수 없습니다.' });
      const updatedAt = Date.now();
      const meta = {
        updatedAt,
        size: body.length,
        name: String(req.get('X-File-Name') || ''),
        type: String(req.get('X-File-Type') || ''),
        mode: String(req.get('X-File-Mode') || ''),
        savedAt: Number(req.get('X-Saved-At') || updatedAt)
      };
      writeAtomic(info.data, body);
      writeAtomic(info.meta, JSON.stringify(meta));

      // 새 원본 선적 파일을 올리면 이전 작업 상태/스냅샷은 새 작업과 섞이지 않게 초기화한다.
      if (key === 'source') {
        unlinkSafe(COUPANG_STATE_PATH);
        unlinkSafe(COUPANG_BLOBS.workbookSnapshot.data);
        unlinkSafe(COUPANG_BLOBS.workbookSnapshot.meta);
      }
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, updatedAt, size: body.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: `공용 파일 저장 실패: ${err.message}` });
    }
  }
);

app.delete('/api/coupang-shared/blob/:key', coupangAuth, (req, res) => {
  try {
    const picked = blobKeyOr404(req, res); if (!picked) return;
    unlinkSafe(picked.info.data); unlinkSafe(picked.info.meta);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});


// =====================================================================
// v18: 여러 선적 작업을 동시에 보관하는 프로젝트형 공용 저장소
// 기존 단일 저장소는 자동으로 첫 프로젝트로 복사되어 마이그레이션됩니다.
// =====================================================================
const COUPANG_PROJECTS_PATH = path.join(COUPANG_SHARED_DIR, 'projects.json');
const COUPANG_PROJECTS_DIR = path.join(COUPANG_SHARED_DIR, 'projects');
function readProjectsV18(){
  const raw=readJsonSafe(COUPANG_PROJECTS_PATH);return raw&&Array.isArray(raw.projects)?raw:{version:18,projects:[]};
}
function saveProjectsV18(index){writeAtomic(COUPANG_PROJECTS_PATH,JSON.stringify({version:18,projects:index.projects||[]}));}
function safeProjectIdV18(id){id=String(id||'');return /^[A-Za-z0-9_-]{3,80}$/.test(id)?id:null;}
function newProjectIdV18(){return 'p_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);}
function projectPathsV18(id){
  const dir=path.join(COUPANG_PROJECTS_DIR,id);return {dir,state:path.join(dir,'state.json'),source:{data:path.join(dir,'source.xlsx.bin'),meta:path.join(dir,'source.meta.json')},workbookSnapshot:{data:path.join(dir,'workbookSnapshot.xlsx.bin'),meta:path.join(dir,'workbookSnapshot.meta.json')}};
}
function projectBlobStatusV18(paths,key){const info=paths[key],meta=info&&readJsonSafe(info.meta);if(!info||!meta||!fs.existsSync(info.data))return null;return {updatedAt:Number(meta.updatedAt||0),size:Number(meta.size||0),name:meta.name||''};}
function projectStateStatusV18(paths){const row=readJsonSafe(paths.state);return row?{updatedAt:Number(row.updatedAt||0)}:null;}
function touchProjectV18(id,patch={}){
  const idx=readProjectsV18(),p=idx.projects.find(x=>x.id===id);if(!p)return null;Object.assign(p,patch,{updatedAt:Date.now()});saveProjectsV18(idx);return p;
}
function copyIfExistsV18(src,dst){if(!fs.existsSync(src))return;fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);}
function migrateLegacyProjectV18(){
  ensureCoupangSharedDir();fs.mkdirSync(COUPANG_PROJECTS_DIR,{recursive:true});
  const idx=readProjectsV18();if(idx.projects.length)return idx;
  const hasLegacy=fs.existsSync(COUPANG_STATE_PATH)||fs.existsSync(COUPANG_BLOBS.source.data)||fs.existsSync(COUPANG_BLOBS.workbookSnapshot.data);if(!hasLegacy)return idx;
  const id=newProjectIdV18(),paths=projectPathsV18(id),sourceMeta=readJsonSafe(COUPANG_BLOBS.source.meta)||{};
  fs.mkdirSync(paths.dir,{recursive:true});
  copyIfExistsV18(COUPANG_STATE_PATH,paths.state);copyIfExistsV18(COUPANG_BLOBS.source.data,paths.source.data);copyIfExistsV18(COUPANG_BLOBS.source.meta,paths.source.meta);copyIfExistsV18(COUPANG_BLOBS.workbookSnapshot.data,paths.workbookSnapshot.data);copyIfExistsV18(COUPANG_BLOBS.workbookSnapshot.meta,paths.workbookSnapshot.meta);
  let name=String(sourceMeta.name||'기존 쿠팡 선적 작업').replace(/\.(xlsx|xlsm|xls)$/i,'').trim()||'기존 쿠팡 선적 작업';const now=Date.now();
  idx.projects.push({id,name,status:'active',createdAt:now,updatedAt:now,migratedFromLegacy:true});saveProjectsV18(idx);return idx;
}
function getProjectOr404V18(req,res){
  const id=safeProjectIdV18(req.params.projectId);if(!id){res.status(404).json({ok:false,error:'잘못된 작업 ID입니다.'});return null}
  const idx=migrateLegacyProjectV18(),project=idx.projects.find(x=>x.id===id);if(!project){res.status(404).json({ok:false,error:'선적 작업을 찾을 수 없습니다.'});return null}return {id,idx,project,paths:projectPathsV18(id)};
}

app.get('/api/coupang-shared/projects',coupangAuth,(req,res)=>{
  const idx=migrateLegacyProjectV18();res.set('Cache-Control','no-store');res.json({ok:true,projects:[...idx.projects].sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0))});
});
app.post('/api/coupang-shared/projects',coupangAuth,(req,res)=>{
  try{const idx=migrateLegacyProjectV18(),id=newProjectIdV18(),now=Date.now(),name=String(req.body?.name||'').trim().slice(0,120)||`새 선적 작업 ${new Date().toLocaleDateString('ko-KR')}`;const p={id,name,status:'active',createdAt:now,updatedAt:now};fs.mkdirSync(projectPathsV18(id).dir,{recursive:true});idx.projects.push(p);saveProjectsV18(idx);res.json({ok:true,project:p})}catch(err){res.status(500).json({ok:false,error:err.message})}
});
app.patch('/api/coupang-shared/projects/:projectId',coupangAuth,(req,res)=>{
  try{const found=getProjectOr404V18(req,res);if(!found)return;const {idx,project}=found;if(req.body?.name!==undefined){const n=String(req.body.name||'').trim().slice(0,120);if(n)project.name=n}if(req.body?.status!==undefined){const s=String(req.body.status);if(!['active','archived'].includes(s))return res.status(400).json({ok:false,error:'지원하지 않는 상태입니다.'});project.status=s}project.updatedAt=Date.now();saveProjectsV18(idx);res.json({ok:true,project})}catch(err){res.status(500).json({ok:false,error:err.message})}
});
app.delete('/api/coupang-shared/projects/:projectId',coupangAuth,(req,res)=>{
  try{const found=getProjectOr404V18(req,res);if(!found)return;const {id,idx,paths}=found;fs.rmSync(paths.dir,{recursive:true,force:true});idx.projects=idx.projects.filter(x=>x.id!==id);saveProjectsV18(idx);res.json({ok:true})}catch(err){res.status(500).json({ok:false,error:err.message})}
});

app.get('/api/coupang-shared/projects/:projectId/status',coupangAuth,(req,res)=>{const found=getProjectOr404V18(req,res);if(!found)return;const {paths}=found;res.set('Cache-Control','no-store');res.json({ok:true,state:projectStateStatusV18(paths),source:projectBlobStatusV18(paths,'source'),workbookSnapshot:projectBlobStatusV18(paths,'workbookSnapshot')})});
app.get('/api/coupang-shared/projects/:projectId/state',coupangAuth,(req,res)=>{const found=getProjectOr404V18(req,res);if(!found)return;const row=readJsonSafe(found.paths.state);if(!row)return res.status(404).json({ok:false,error:'저장된 작업 상태가 없습니다.'});res.set('Cache-Control','no-store');res.set('X-Updated-At',String(row.updatedAt||0));res.json(row)});
app.put('/api/coupang-shared/projects/:projectId/state',coupangAuth,express.text({type:['text/plain','application/json'],limit:'15mb'}),(req,res)=>{
  try{const found=getProjectOr404V18(req,res);if(!found)return;const state=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{}),updatedAt=Date.now();writeAtomic(found.paths.state,JSON.stringify({ok:true,updatedAt,state}));touchProjectV18(found.id);res.set('Cache-Control','no-store');res.json({ok:true,updatedAt})}catch(err){res.status(400).json({ok:false,error:`작업 상태 저장 실패: ${err.message}`})}
});
app.delete('/api/coupang-shared/projects/:projectId/state',coupangAuth,(req,res)=>{const found=getProjectOr404V18(req,res);if(!found)return;try{unlinkSafe(found.paths.state);touchProjectV18(found.id);res.json({ok:true})}catch(err){res.status(500).json({ok:false,error:err.message})}});

app.get('/api/coupang-shared/projects/:projectId/blob/:key',coupangAuth,(req,res)=>{
  const found=getProjectOr404V18(req,res);if(!found)return;const key=req.params.key;if(!['source','workbookSnapshot'].includes(key))return res.status(404).json({ok:false,error:'지원하지 않는 파일 키입니다.'});const info=found.paths[key],meta=readJsonSafe(info.meta);if(!meta||!fs.existsSync(info.data))return res.status(404).json({ok:false,error:'저장된 파일이 없습니다.'});res.set('Cache-Control','no-store');res.set('Content-Type',meta.type||'application/octet-stream');res.set('X-Updated-At',String(meta.updatedAt||0));res.set('X-File-Name',String(meta.name||''));res.set('X-File-Type',String(meta.type||''));res.set('X-File-Mode',String(meta.mode||''));res.set('X-Saved-At',String(meta.savedAt||meta.updatedAt||0));res.sendFile(info.data)
});
app.put('/api/coupang-shared/projects/:projectId/blob/:key',coupangAuth,express.raw({type:'application/octet-stream',limit:'80mb'}),(req,res)=>{
  try{const found=getProjectOr404V18(req,res);if(!found)return;const key=req.params.key;if(!['source','workbookSnapshot'].includes(key))return res.status(404).json({ok:false,error:'지원하지 않는 파일 키입니다.'});const info=found.paths[key],body=Buffer.isBuffer(req.body)?req.body:Buffer.from(req.body||'');if(!body.length)return res.status(400).json({ok:false,error:'빈 파일은 저장할 수 없습니다.'});const updatedAt=Date.now(),meta={updatedAt,size:body.length,name:String(req.get('X-File-Name')||''),type:String(req.get('X-File-Type')||''),mode:String(req.get('X-File-Mode')||''),savedAt:Number(req.get('X-Saved-At')||updatedAt)};writeAtomic(info.data,body);writeAtomic(info.meta,JSON.stringify(meta));if(key==='source'){unlinkSafe(found.paths.state);unlinkSafe(found.paths.workbookSnapshot.data);unlinkSafe(found.paths.workbookSnapshot.meta)}touchProjectV18(found.id);res.set('Cache-Control','no-store');res.json({ok:true,updatedAt,size:body.length})}catch(err){res.status(500).json({ok:false,error:`공용 파일 저장 실패: ${err.message}`})}
});
app.delete('/api/coupang-shared/projects/:projectId/blob/:key',coupangAuth,(req,res)=>{const found=getProjectOr404V18(req,res);if(!found)return;const key=req.params.key;if(!['source','workbookSnapshot'].includes(key))return res.status(404).json({ok:false,error:'지원하지 않는 파일 키입니다.'});try{unlinkSafe(found.paths[key].data);unlinkSafe(found.paths[key].meta);touchProjectV18(found.id);res.json({ok:true})}catch(err){res.status(500).json({ok:false,error:err.message})}});

// 확장자 없는 주소도 지원: https://tool.dasaba.co.kr/coupang-inbound-work
app.get('/coupang-inbound-work', (req, res) => {
  res.sendFile(path.join(__dirname, 'coupang-inbound-work.html'));
});


// =====================================================================
// 공용 바코드 라벨 보관함 + 공용 상품 기준목록
// barcode-label.html 이 사용하는 API. 서버 JSON 파일에 저장하여 모든 PC가 공유합니다.
// =====================================================================
const SHARED_LABEL_DIR = process.env.SHARED_LABEL_DIR || path.join(path.dirname(COUPANG_SHARED_DIR), 'shared-barcode');
const SHARED_LABELS_PATH = path.join(SHARED_LABEL_DIR, 'labels.json');
const PRODUCT_CATALOG_PATH = path.join(SHARED_LABEL_DIR, 'product-catalog.json');
const LABEL_EDIT_KEY = String(process.env.SHARED_LABEL_EDIT_KEY || process.env.LABEL_EDIT_KEY || '').trim();

function ensureSharedLabelDir() {
  fs.mkdirSync(SHARED_LABEL_DIR, { recursive: true });
}

// v30: 이전 공용 라벨 저장 파일 자동 탐색/복구
function looksLikeLabelArray(value) {
  const arr = Array.isArray(value) ? value : (Array.isArray(value?.labels) ? value.labels : (Array.isArray(value?.items) ? value.items : null));
  if (!arr || !arr.length) return null;
  const sample = arr.slice(0, 20);
  const hits = sample.filter(x => x && typeof x === 'object' && (x.barcode || x.productNumber || x.productName)).length;
  return hits ? arr : null;
}
function legacyLabelSearchRoots() {
  const roots = [
    __dirname,
    path.join(__dirname, 'data'),
    path.dirname(COUPANG_SHARED_DIR),
    COUPANG_SHARED_DIR,
    process.env.SHARED_LABEL_DIR || ''
  ].filter(Boolean);
  return [...new Set(roots.map(x => path.resolve(x)))];
}
function scanLegacyLabelFiles() {
  const current = path.resolve(SHARED_LABELS_PATH);
  const found = [];
  const seen = new Set();
  const walk = (dir, depth=0) => {
    if (depth > 3 || !dir || !fs.existsSync(dir)) return;
    let entries=[]; try { entries=fs.readdirSync(dir,{withFileTypes:true}); } catch { return; }
    for (const ent of entries) {
      const fp=path.join(dir,ent.name);
      if (ent.isDirectory()) {
        if (/node_modules|\.git|projects$/i.test(ent.name)) continue;
        walk(fp,depth+1); continue;
      }
      if (!ent.isFile() || !/\.json$/i.test(ent.name)) continue;
      if (!/(label|barcode|라벨)/i.test(ent.name) && !/(shared|data)/i.test(path.basename(dir))) continue;
      const abs=path.resolve(fp); if(abs===current || seen.has(abs)) continue; seen.add(abs);
      try {
        const st=fs.statSync(abs); if(st.size<=2 || st.size>15*1024*1024) continue;
        const parsed=JSON.parse(fs.readFileSync(abs,'utf8'));
        const arr=looksLikeLabelArray(parsed);
        if(arr) found.push({path:abs,count:arr.length,labels:arr});
      } catch {}
    }
  };
  for(const root of legacyLabelSearchRoots()) walk(root,0);
  return found;
}
function mergeLabelArrays(base, incoming) {
  const out=Array.isArray(base)?[...base]:[];
  for(const raw of (incoming||[])) {
    try { upsertSharedLabel(out, raw); } catch {}
  }
  return out;
}
function autoRecoverLegacyLabelsIfNeeded() {
  ensureSharedLabelDir();
  let current = readSharedArray(SHARED_LABELS_PATH);
  const found = scanLegacyLabelFiles();
  if (!current.length && found.length) {
    let merged=[];
    for(const f of found) merged=mergeLabelArrays(merged,f.labels);
    if(merged.length){ writeSharedArray(SHARED_LABELS_PATH,merged); current=merged; console.log(`[공용 라벨] 이전 저장파일에서 ${merged.length}개 자동 복구`); }
  }
  return {labels:current, found:found.map(x=>({path:x.path,count:x.count}))};
}

function readSharedArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8') || '[]');
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
  } catch (err) {
    console.error('[공용 라벨] 파일 읽기 실패:', filePath, err.message);
    return [];
  }
}
function writeSharedArray(filePath, arr) {
  ensureSharedLabelDir();
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}
function requireLabelEditKey(req, res, next) {
  if (!LABEL_EDIT_KEY) return next();
  const supplied = String(req.get('x-label-edit-key') || '').trim();
  if (supplied !== LABEL_EDIT_KEY) {
    return res.status(403).json({ ok: false, code: 'EDIT_KEY_REQUIRED', error: '공용 라벨 관리코드가 필요합니다.' });
  }
  next();
}
function cleanLabelPayload(raw = {}) {
  const text = (v, max = 1000) => String(v ?? '').slice(0, max);
  const num = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    id: text(raw.id, 100),
    productNumber: text(raw.productNumber, 120).trim(),
    barcode: text(raw.barcode, 160).trim(),
    productName: text(raw.productName, 1000),
    optionText: text(raw.optionText, 1000),
    material: text(raw.material, 1000),
    importer: text(raw.importer, 1000),
    address: text(raw.address, 1500),
    phone: text(raw.phone, 300),
    warning: text(raw.warning, 2000),
    age: text(raw.age, 500),
    country: text(raw.country, 500),
    labelWidth: num(raw.labelWidth, 50),
    labelHeight: num(raw.labelHeight, 60),
    titleFont: num(raw.titleFont, 18),
    bodyFont: num(raw.bodyFont, 14),
    barcodeHeight: num(raw.barcodeHeight, 16),
    barcodeTextFont: num(raw.barcodeTextFont, 12),
    madeInFont: num(raw.madeInFont, 8),
    updatedAt: text(raw.updatedAt, 100) || new Date().toISOString()
  };
}
function labelMatchIndex(labels, item) {
  if (item.id) {
    const i = labels.findIndex(x => String(x.id || '') === item.id);
    if (i >= 0) return i;
  }
  const bc = String(item.barcode || '').trim().toUpperCase();
  if (bc) {
    const i = labels.findIndex(x => String(x.barcode || '').trim().toUpperCase() === bc);
    if (i >= 0) return i;
  }
  const pn = String(item.productNumber || '').trim();
  if (pn) return labels.findIndex(x => String(x.productNumber || '').trim() === pn);
  return -1;
}
function upsertSharedLabel(labels, raw) {
  const item = cleanLabelPayload(raw);
  if (!item.barcode && !item.productNumber) throw new Error('바코드 또는 상품번호가 필요합니다.');
  const idx = labelMatchIndex(labels, item);
  if (idx >= 0) {
    item.id = labels[idx].id || item.id || `lbl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    labels[idx] = { ...labels[idx], ...item, updatedAt: new Date().toISOString() };
    return labels[idx];
  }
  item.id = item.id || `lbl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  item.createdAt = new Date().toISOString();
  item.updatedAt = new Date().toISOString();
  labels.push(item);
  return item;
}

app.get('/api/shared-labels', (req, res) => {
  const recovered = autoRecoverLegacyLabelsIfNeeded();
  const labels = recovered.labels.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, labels, count: labels.length, editKeyRequired: !!LABEL_EDIT_KEY, permanent: false, storage: 'server-json', legacySources: recovered.found.length });
});

app.get('/api/shared-labels-recovery-scan', (req,res)=>{
  try{
    const recovered=autoRecoverLegacyLabelsIfNeeded();
    res.set('Cache-Control','no-store');
    res.json({ok:true,count:recovered.labels.length,sources:recovered.found});
  }catch(err){res.status(500).json({ok:false,error:err.message})}
});

app.post('/api/shared-labels', requireLabelEditKey, (req, res) => {
  try {
    const labels = readSharedArray(SHARED_LABELS_PATH);
    const label = upsertSharedLabel(labels, req.body || {});
    writeSharedArray(SHARED_LABELS_PATH, labels);
    res.json({ ok: true, label, count: labels.length });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/shared-labels/:id', requireLabelEditKey, (req, res) => {
  try {
    const id = String(req.params.id || '');
    const labels = readSharedArray(SHARED_LABELS_PATH);
    const next = labels.filter(x => String(x.id || '') !== id);
    if (next.length === labels.length) return res.status(404).json({ ok: false, error: '삭제할 공용 라벨을 찾지 못했습니다.' });
    writeSharedArray(SHARED_LABELS_PATH, next);
    res.json({ ok: true, count: next.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/shared-labels-backup', (req, res) => {
  const labels = readSharedArray(SHARED_LABELS_PATH);
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), labels }, null, 2);
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="shared-labels-${ymd}.json"`);
  res.send(payload);
});

app.post('/api/shared-labels-restore', requireLabelEditKey, (req, res) => {
  try {
    const incoming = Array.isArray(req.body) ? req.body : req.body?.labels;
    if (!Array.isArray(incoming) || !incoming.length) return res.status(400).json({ ok: false, error: '복원할 라벨 데이터가 없습니다.' });
    const labels = readSharedArray(SHARED_LABELS_PATH);
    let restored = 0;
    for (const raw of incoming.slice(0, 20000)) {
      try { upsertSharedLabel(labels, raw); restored++; } catch (_) {}
    }
    writeSharedArray(SHARED_LABELS_PATH, labels);
    res.json({ ok: true, restored, count: labels.length });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// 바코드 자동매칭용 공용 상품 기준목록
function cleanCatalogItem(raw = {}) {
  return {
    productNumber: String(raw.productNumber ?? '').slice(0, 120).trim(),
    barcode: String(raw.barcode ?? '').slice(0, 160).trim().toUpperCase(),
    productName: String(raw.productName ?? '').slice(0, 1500),
    source: String(raw.source ?? '').slice(0, 500),
    updatedAt: new Date().toISOString()
  };
}
app.get('/api/product-catalog', (req, res) => {
  const barcode = String(req.query.barcode || '').trim().toUpperCase();
  if (!barcode) return res.status(400).json({ ok: false, error: 'barcode가 필요합니다.' });
  const items = readSharedArray(PRODUCT_CATALOG_PATH);
  const item = items.find(x => String(x.barcode || '').trim().toUpperCase() === barcode) || null;
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, item });
});
app.get('/api/product-catalog-status', (req, res) => {
  const items = readSharedArray(PRODUCT_CATALOG_PATH);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, count: items.length, permanent: false, storage: 'server-json' });
});
app.post('/api/product-catalog/import', requireLabelEditKey, (req, res) => {
  try {
    const incoming = req.body?.items;
    if (!Array.isArray(incoming)) return res.status(400).json({ ok: false, error: 'items 배열이 필요합니다.' });
    const items = readSharedArray(PRODUCT_CATALOG_PATH);
    const map = new Map(items.map(x => [String(x.barcode || '').trim().toUpperCase(), x]));
    let imported = 0;
    for (const raw of incoming.slice(0, 5000)) {
      const item = cleanCatalogItem({ ...raw, source: raw?.source || req.body?.source || '' });
      if (!item.barcode) continue;
      map.set(item.barcode, { ...(map.get(item.barcode) || {}), ...item });
      imported++;
    }
    const next = [...map.values()];
    writeSharedArray(PRODUCT_CATALOG_PATH, next);
    res.json({ ok: true, imported, count: next.length });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, keyConfigured: !!UNIPASS_KEY, aiConfigured: !!ANTHROPIC_KEY });
});

// /api 오타/미구현 주소가 HTML로 내려가 JSON 파싱 오류가 나지 않도록 항상 JSON 404 반환
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: `지원하지 않는 API입니다: ${req.method} ${req.originalUrl}` });
});


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
app.get('/barcode-label', (req, res) => {
  res.sendFile(path.join(__dirname, 'barcode-label.html'));
});
  app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TradeCode Navi 백엔드 프록시 실행 중: http://localhost:${PORT}`);
  console.log(`인증키 설정 여부: ${UNIPASS_KEY ? 'O' : 'X (미설정)'}`);
});
