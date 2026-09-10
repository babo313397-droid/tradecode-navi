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
const crypto = require('crypto');
const cors = require('cors');
const { searchHs, getTariff, navigateHsCode, checkCustomsRequirement } = require('./lib/unipass');
const { analyzeProduct } = require('./lib/ai');
const { freeTranslate } = require('./lib/freeTranslate');
const { createRateLimiter } = require('./lib/rateLimit');
const { listComments, createComment, updateComment, deleteComment, MAX_CONTENT_LEN, MAX_AUTHOR_LEN } = require('./lib/comments');
const { getExchangeRate } = require('./lib/exchangeRate');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' })); // 댓글 등 POST/PUT/DELETE 본문(JSON) 파싱용
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 4000;
const UNIPASS_KEY = process.env.UNIPASS_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ''; // 기존 AI 상품명 분석 기능 호환용
const OPENAI_KEY = process.env.OPENAI_API_KEY || ''; // 쿠팡 상세페이지 AI 초안용
const SHARED_LABEL_EDIT_KEY = String(process.env.SHARED_LABEL_EDIT_KEY || '').trim();
const SHARED_LABEL_FILE = path.join(__dirname, 'data', 'shared-labels.json');
const PRODUCT_CATALOG_SEED_FILE = path.join(__dirname, 'barcode-product-catalog.json');

// 공용 라벨 영구 저장소 (Supabase)
// 2026 기준 신규 프로젝트는 SUPABASE_SECRET_KEY(sb_secret_...) 사용 권장.
// 기존 service_role 키도 폴백으로 지원한다.
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SECRET_KEY = String(
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''
).trim();
const SHARED_LABEL_STORAGE = (SUPABASE_URL && SUPABASE_SECRET_KEY) ? 'supabase' : 'local';

const MAX_QUERY_LENGTH = 100; // 상품명 입력 길이 제한 (남용/이상 입력 방지)
const analyzeProductLimiter = createRateLimiter({ windowMs: 60000, max: 10 });
const detailDraftLimiter = createRateLimiter({ windowMs: 60000, max: 5 }); // 분당 10회/IP
// 무료 번역은 키가 필요 없어 더 자주 쓰이므로 한도를 넉넉히(분당 20회/IP) 둔다.
const freeTranslateLimiter = createRateLimiter({ windowMs: 60000, max: 20 });
// 댓글 작성/수정/삭제는 도배 방지를 위해 분당 15회/IP로 제한 (조회는 제한 없음)
const commentWriteLimiter = createRateLimiter({ windowMs: 60000, max: 15 });
// 환율 조회도 키가 필요 없어 자주 호출될 수 있으므로 넉넉히(분당 20회/IP) 둔다.
const exchangeRateLimiter = createRateLimiter({ windowMs: 60000, max: 20 });
const sharedLabelWriteLimiter = createRateLimiter({ windowMs: 60000, max: 60 });

if (!UNIPASS_KEY) {
  console.warn('[경고] UNIPASS_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.');
}
if (!ANTHROPIC_KEY) {
  console.warn('[안내] ANTHROPIC_API_KEY 미설정 - 기존 AI 상품명 분석(선택 기능)은 비활성화 상태입니다.');
}
if (!OPENAI_KEY) {
  console.warn('[안내] OPENAI_API_KEY 미설정 - 쿠팡 상세페이지 AI 초안 기능은 비활성화 상태입니다.');
}


// POST /api/detail-draft
// OpenAI Responses API를 사용해 1688 PDF 텍스트를 쿠팡 상세페이지 "편집 가능한 초안"으로 구조화한다.
// 기존 바코드/Supabase 저장소와는 완전히 독립된 기능이다.
app.post('/api/detail-draft', detailDraftLimiter, async (req, res) => {
  if (!OPENAI_KEY) {
    return res.status(503).json({
      ok: false,
      error: 'OPENAI_API_KEY가 설정되어 있지 않아 AI 초안 기능을 사용할 수 없습니다.'
    });
  }

  const manual = req.body?.manual && typeof req.body.manual === 'object'
    ? req.body.manual
    : {};
  const pages = Array.isArray(req.body?.pages) ? req.body.pages.slice(0, 40) : [];

  if (!pages.length) {
    return res.status(400).json({ ok: false, error: '분석할 PDF 페이지 텍스트가 없습니다.' });
  }

  const safeText = pages.map(p => ({
    page: Number(p.page) || 0,
    use: p.use !== false,
    role: String(p.role || '').slice(0, 50),
    text: String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 7000)
  }));

  const sourceChars = safeText.reduce((sum, p) => sum + p.text.length, 0);
  if (sourceChars > 90000) {
    return res.status(400).json({
      ok: false,
      error: '원본 텍스트가 너무 많습니다. PDF를 나누거나 사용할 페이지만 남겨 다시 시도해 주세요.'
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const prompt = [
      '너는 한국 온라인 판매용 상세페이지 편집 초안을 만드는 상품정보 편집자다.',
      '입력은 중국 1688/알리바바 상품 페이지에서 추출한 텍스트와 사용자가 직접 입력한 판매 정보다.',
      '',
      '목표:',
      '1) 1688 가격, 리뷰, 판매자/점포 정보, 배송, 쿠폰, 추천상품, 플랫폼 약관/푸터, 주문 UI 등 판매 상세페이지에 불필요한 페이지는 제외 후보로 분류한다.',
      '2) 제품 기능/사용방법/제품컷/사이즈/재질/색상/구성 정보 페이지는 사용 후보로 분류한다.',
      '3) 중국어 문구를 자연스러운 한국어 판매 문구 초안으로 바꾸되, 과장/효능/인증/성능을 지어내지 않는다.',
      '4) 같은 정보가 원본 안에서 서로 다르면 임의로 하나를 확정하지 말고 conflicts에 모두 제시한다.',
      '5) 제품명과 옵션명/옵션값은 사용자가 최종 결정하므로 manual에 값이 있으면 그대로 존중한다.',
      '6) 담배, 술, 의약품, 어린이제품 등 카테고리 제한 여부를 "판매 가능"이라고 단정하지 않는다.',
      '7) 원문에 없는 KC, 특허, 인증, 방수등급, 식품용, 안전성, 효능 등은 절대 추가하지 않는다.',
      '',
      '반드시 JSON 하나만 출력하고 코드블록/설명문은 쓰지 마라.',
      JSON.stringify({
        pageDecisions:[{page:1,use:false,role:'제외',reason:'짧은 이유'}],
        productFacts:{material:'',size:'',composition:'',colors:[]},
        conflicts:[{field:'사이즈',values:['값1','값2'],message:'원본 정보가 서로 다름'}],
        sections:[
          {
            type:'대표',
            sourcePage:3,
            use:true,
            showImage:true,
            title:'한국어 제목',
            body:'사용자가 수정 가능한 한국어 설명',
            original:'참고한 중국어 원문 일부'
          }
        ]
      }, null, 2),
      '',
      '섹션 작성 규칙:',
      '- 총 4~9개 정도로 압축한다.',
      '- type은 대표/특징/사용방법/상품정보/디테일/옵션/주의사항 중 하나.',
      '- sourcePage는 실제 참고 페이지 번호. 없으면 0.',
      '- original은 참고한 원문 중 핵심 문구만 짧게.',
      '- body는 쿠팡 상세페이지에서 바로 수정해 쓸 수 있는 짧고 명확한 한국어.',
      '- 상품명 자체는 sections에서 새로 만들어내지 말고 manual.productName을 존중한다.',
      '',
      '사용자 직접 입력값:',
      JSON.stringify(manual),
      '',
      '페이지별 원본 텍스트:',
      JSON.stringify(safeText)
    ].join('\n');

    const aiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-5.6-luna',
        input: prompt,
        max_output_tokens: 4200,
        reasoning: { effort: 'low' }
      }),
      signal: controller.signal
    });

    const json = await aiRes.json();

    if (!aiRes.ok) {
      const apiMessage =
        json?.error?.message ||
        json?.message ||
        `OpenAI HTTP ${aiRes.status}`;
      return res.status(502).json({
        ok: false,
        error: `OpenAI API 오류: ${apiMessage}`
      });
    }

    // Responses API의 output[] 안 output_text 항목들을 합친다.
    const text = (json?.output || [])
      .flatMap(item => Array.isArray(item?.content) ? item.content : [])
      .filter(part => part?.type === 'output_text' && typeof part?.text === 'string')
      .map(part => part.text)
      .join('\n')
      .trim();

    if (!text) {
      return res.status(502).json({
        ok: false,
        error: 'OpenAI 응답에서 상세페이지 초안 텍스트를 찾지 못했습니다.'
      });
    }

    // 모델이 혹시 앞뒤 설명을 붙여도 JSON 부분만 안전하게 파싱
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(502).json({
        ok: false,
        error: 'OpenAI 응답에서 JSON 초안을 찾지 못했습니다.'
      });
    }

    const parsed = JSON.parse(match[0]);

    const allowedTypes = new Set(['대표','특징','사용방법','상품정보','디테일','옵션','주의사항']);
    const pageDecisions = Array.isArray(parsed.pageDecisions)
      ? parsed.pageDecisions.slice(0, 40).map(x => ({
          page: Number(x?.page) || 0,
          use: x?.use !== false,
          role: String(x?.role || '특징').slice(0, 30),
          reason: String(x?.reason || '').slice(0, 300)
        }))
      : [];

    const sections = Array.isArray(parsed.sections)
      ? parsed.sections.slice(0, 12).map(x => ({
          type: allowedTypes.has(String(x?.type)) ? String(x.type) : '특징',
          sourcePage: Number(x?.sourcePage) || 0,
          use: x?.use !== false,
          showImage: x?.showImage !== false,
          title: String(x?.title || '').slice(0, 200),
          body: String(x?.body || '').slice(0, 1200),
          original: String(x?.original || '').slice(0, 800)
        }))
      : [];

    const conflicts = Array.isArray(parsed.conflicts)
      ? parsed.conflicts.slice(0, 10).map(x => ({
          field: String(x?.field || '').slice(0, 100),
          values: Array.isArray(x?.values)
            ? x.values.slice(0, 6).map(v => String(v).slice(0, 200))
            : [],
          message: String(x?.message || '').slice(0, 400)
        }))
      : [];

    const f = parsed.productFacts && typeof parsed.productFacts === 'object'
      ? parsed.productFacts
      : {};

    res.json({
      ok: true,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      pageDecisions,
      productFacts: {
        material: String(f.material || '').slice(0, 300),
        size: String(f.size || '').slice(0, 300),
        composition: String(f.composition || '').slice(0, 300),
        colors: Array.isArray(f.colors)
          ? f.colors.slice(0, 20).map(v => String(v).slice(0, 100))
          : []
      },
      conflicts,
      sections
    });

  } catch (err) {
    const msg = err?.name === 'AbortError'
      ? 'OpenAI 분석 시간이 초과되었습니다. 사용할 페이지를 줄여 다시 시도해 주세요.'
      : `상세페이지 OpenAI 초안 생성 실패: ${err.message}`;

    res.status(504).json({ ok: false, error: msg });
  } finally {
    clearTimeout(timeout);
  }
});

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


// =========================================================
// 공용 바코드 라벨 보관함
// - SUPABASE_URL + SUPABASE_SECRET_KEY가 있으면 Supabase 영구 저장
// - 환경변수가 없으면 기존 data/shared-labels.json 임시 저장으로 폴백
// - 프론트 API 주소는 동일하므로 화면 코드는 그대로 사용 가능
// =========================================================

function ensureSharedLabelFile() {
  const dir = path.dirname(SHARED_LABEL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(SHARED_LABEL_FILE)) {
    fs.writeFileSync(SHARED_LABEL_FILE, '[]', 'utf8');
  }
}

function readLocalSharedLabels() {
  ensureSharedLabelFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(SHARED_LABEL_FILE, 'utf8') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('공용 라벨 로컬 파일 읽기 실패:', err);
    return [];
  }
}

function writeLocalSharedLabels(labels) {
  ensureSharedLabelFile();
  const temp = `${SHARED_LABEL_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(labels, null, 2), 'utf8');
  fs.renameSync(temp, SHARED_LABEL_FILE);
}

function cleanSharedText(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanSharedNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeSharedLabel(input, existing = null) {
  const now = new Date().toISOString();
  const barcode = cleanSharedText(input.barcode, 80).toUpperCase();
  const productNumber = cleanSharedText(input.productNumber, 80);

  return {
    id: existing?.id || cleanSharedText(input.id, 120) || crypto.randomUUID(),
    productNumber,
    barcode,
    productName: cleanSharedText(input.productName, 500),
    optionText: cleanSharedText(input.optionText, 1000),
    material: cleanSharedText(input.material, 500),
    importer: cleanSharedText(input.importer, 500),
    address: cleanSharedText(input.address, 1000),
    phone: cleanSharedText(input.phone, 100),
    warning: cleanSharedText(input.warning, 1500),
    age: cleanSharedText(input.age, 200),
    country: cleanSharedText(input.country, 200),
    labelWidth: cleanSharedNumber(input.labelWidth, 20, 210, 50),
    labelHeight: cleanSharedNumber(input.labelHeight, 20, 297, 60),
    titleFont: cleanSharedNumber(input.titleFont, 5, 28, 18),
    bodyFont: cleanSharedNumber(input.bodyFont, 4, 22, 14),
    barcodeHeight: cleanSharedNumber(input.barcodeHeight, 5, 30, 16),
    barcodeTextFont: cleanSharedNumber(input.barcodeTextFont, 4, 22, 12),
    madeInFont: cleanSharedNumber(input.madeInFont, 3, 18, 8),
    createdAt: existing?.createdAt || cleanSharedText(input.createdAt, 80) || now,
    updatedAt: now
  };
}

function labelToDbRow(label) {
  return {
    id: label.id,
    product_number: label.productNumber || '',
    barcode: label.barcode || '',
    product_name: label.productName || '',
    option_text: label.optionText || '',
    material: label.material || '',
    importer: label.importer || '',
    address: label.address || '',
    phone: label.phone || '',
    warning: label.warning || '',
    age: label.age || '',
    country: label.country || '',
    label_width: Number(label.labelWidth) || 50,
    label_height: Number(label.labelHeight) || 60,
    title_font: Number(label.titleFont) || 18,
    body_font: Number(label.bodyFont) || 14,
    barcode_height: Number(label.barcodeHeight) || 16,
    barcode_text_font: Number(label.barcodeTextFont) || 12,
    made_in_font: Number(label.madeInFont) || 8,
    created_at: label.createdAt || new Date().toISOString(),
    updated_at: label.updatedAt || new Date().toISOString()
  };
}

function dbRowToLabel(row) {
  return {
    id: row.id,
    productNumber: row.product_number || '',
    barcode: row.barcode || '',
    productName: row.product_name || '',
    optionText: row.option_text || '',
    material: row.material || '',
    importer: row.importer || '',
    address: row.address || '',
    phone: row.phone || '',
    warning: row.warning || '',
    age: row.age || '',
    country: row.country || '',
    labelWidth: Number(row.label_width) || 50,
    labelHeight: Number(row.label_height) || 60,
    titleFont: Number(row.title_font) || 18,
    bodyFont: Number(row.body_font) || 14,
    barcodeHeight: Number(row.barcode_height) || 16,
    barcodeTextFont: Number(row.barcode_text_font) || 12,
    madeInFont: Number(row.made_in_font) || 8,
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || ''
  };
}

async function supabaseRest(resource, options = {}) {
  if (SHARED_LABEL_STORAGE !== 'supabase') {
    throw new Error('Supabase 환경변수가 설정되지 않았습니다.');
  }

  const url = `${SUPABASE_URL}/rest/v1/${resource}`;
  const headers = {
    apikey: SUPABASE_SECRET_KEY,
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(15000)
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = text; }
  }

  if (!response.ok) {
    const detail = typeof data === 'object'
      ? (data?.message || data?.details || JSON.stringify(data))
      : String(data || '');
    throw new Error(`Supabase ${response.status}: ${detail}`);
  }

  return data;
}

async function readSharedLabels() {
  if (SHARED_LABEL_STORAGE === 'supabase') {
    const rows = await supabaseRest(
      'shared_labels?select=*&order=updated_at.desc'
    );
    return Array.isArray(rows) ? rows.map(dbRowToLabel) : [];
  }

  return readLocalSharedLabels().sort(
    (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  );
}

async function findExistingSharedLabel(input, labels = null) {
  const list = labels || await readSharedLabels();
  const id = cleanSharedText(input.id, 120);
  const barcode = cleanSharedText(input.barcode, 80).toUpperCase();
  const productNumber = cleanSharedText(input.productNumber, 80);

  if (id) {
    const found = list.find(x => String(x.id) === id);
    if (found) return found;
  }
  if (barcode) {
    const found = list.find(
      x => String(x.barcode || '').trim().toUpperCase() === barcode
    );
    if (found) return found;
  }
  if (productNumber) {
    const found = list.find(
      x => String(x.productNumber || '').trim() === productNumber
    );
    if (found) return found;
  }
  return null;
}

async function saveSharedLabel(input) {
  const all = await readSharedLabels();
  const existing = await findExistingSharedLabel(input, all);
  const saved = sanitizeSharedLabel(input, existing);

  if (SHARED_LABEL_STORAGE === 'supabase') {
    const row = labelToDbRow(saved);

    if (existing?.id) {
      const rows = await supabaseRest(
        `shared_labels?id=eq.${encodeURIComponent(existing.id)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row)
        }
      );
      return Array.isArray(rows) && rows[0] ? dbRowToLabel(rows[0]) : saved;
    }

    const rows = await supabaseRest(
      'shared_labels',
      {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row)
      }
    );
    return Array.isArray(rows) && rows[0] ? dbRowToLabel(rows[0]) : saved;
  }

  const idx = all.findIndex(x => x.id === existing?.id);
  if (idx >= 0) all[idx] = saved;
  else all.push(saved);
  writeLocalSharedLabels(all);
  return saved;
}

async function deleteSharedLabel(id) {
  const cleanId = cleanSharedText(id, 120);
  if (!cleanId) return false;

  if (SHARED_LABEL_STORAGE === 'supabase') {
    const rows = await supabaseRest(
      `shared_labels?id=eq.${encodeURIComponent(cleanId)}`,
      {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' }
      }
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  const labels = readLocalSharedLabels();
  const next = labels.filter(x => String(x.id) !== cleanId);
  if (next.length === labels.length) return false;
  writeLocalSharedLabels(next);
  return true;
}

function checkSharedLabelEditKey(req, res, next) {
  if (!SHARED_LABEL_EDIT_KEY) return next();
  const key = String(req.get('x-label-edit-key') || '');
  if (key !== SHARED_LABEL_EDIT_KEY) {
    return res.status(403).json({
      ok: false,
      code: 'EDIT_KEY_REQUIRED',
      error: '공용 라벨 관리코드가 필요합니다.'
    });
  }
  next();
}

// 저장소 상태 확인
app.get('/api/shared-labels-status', async (req, res) => {
  try {
    const labels = await readSharedLabels();
    res.json({
      ok: true,
      storage: SHARED_LABEL_STORAGE,
      permanent: SHARED_LABEL_STORAGE === 'supabase',
      count: labels.length,
      editKeyRequired: !!SHARED_LABEL_EDIT_KEY
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      storage: SHARED_LABEL_STORAGE,
      permanent: false,
      error: err.message
    });
  }
});

// 전체 공용 라벨 목록
app.get('/api/shared-labels', async (req, res) => {
  try {
    const labels = await readSharedLabels();
    res.json({
      ok: true,
      labels,
      storage: SHARED_LABEL_STORAGE,
      permanent: SHARED_LABEL_STORAGE === 'supabase',
      editKeyRequired: !!SHARED_LABEL_EDIT_KEY
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: `공용 라벨 조회 실패: ${err.message}` });
  }
});

// 공용 라벨 저장/수정
app.post(
  '/api/shared-labels',
  sharedLabelWriteLimiter,
  checkSharedLabelEditKey,
  async (req, res) => {
    try {
      const input = req.body || {};
      const barcode = cleanSharedText(input.barcode, 80).toUpperCase();
      const productNumber = cleanSharedText(input.productNumber, 80);

      if (!barcode && !productNumber) {
        return res.status(400).json({
          ok: false,
          error: '바코드 번호 또는 상품번호가 필요합니다.'
        });
      }

      const before = await findExistingSharedLabel(input);
      const saved = await saveSharedLabel(input);
      const labels = await readSharedLabels();

      res.status(before ? 200 : 201).json({
        ok: true,
        label: saved,
        count: labels.length,
        storage: SHARED_LABEL_STORAGE
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: `공용 라벨 저장 실패: ${err.message}` });
    }
  }
);

// 공용 라벨 삭제
app.delete(
  '/api/shared-labels/:id',
  sharedLabelWriteLimiter,
  checkSharedLabelEditKey,
  async (req, res) => {
    try {
      const deleted = await deleteSharedLabel(req.params.id);

      if (!deleted) {
        return res.status(404).json({
          ok: false,
          error: '삭제할 라벨을 찾지 못했습니다.'
        });
      }

      const labels = await readSharedLabels();
      res.json({ ok: true, count: labels.length, storage: SHARED_LABEL_STORAGE });
    } catch (err) {
      res.status(500).json({ ok: false, error: `공용 라벨 삭제 실패: ${err.message}` });
    }
  }
);

// 공용 라벨 JSON 백업 다운로드
app.get('/api/shared-labels-backup', async (req, res) => {
  try {
    const labels = await readSharedLabels();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="tradecode-shared-labels-${stamp}.json"`
    );
    res.type('application/json').send(JSON.stringify(labels, null, 2));
  } catch (err) {
    res.status(500).json({ ok: false, error: `공용 라벨 백업 실패: ${err.message}` });
  }
});

// 공용 라벨 JSON 백업 복원
app.post(
  '/api/shared-labels-restore',
  sharedLabelWriteLimiter,
  checkSharedLabelEditKey,
  async (req, res) => {
    try {
      const labels = Array.isArray(req.body)
        ? req.body
        : (Array.isArray(req.body?.labels) ? req.body.labels : []);

      if (!labels.length) {
        return res.status(400).json({
          ok: false,
          error: '복원할 라벨 백업 데이터가 없습니다.'
        });
      }

      if (labels.length > 3000) {
        return res.status(400).json({
          ok: false,
          error: '한 번에 복원할 수 있는 라벨은 최대 3,000개입니다.'
        });
      }

      let savedCount = 0;
      for (const item of labels) {
        if (!item || (!item.barcode && !item.productNumber)) continue;
        await saveSharedLabel(item);
        savedCount++;
      }

      const all = await readSharedLabels();
      res.json({
        ok: true,
        restored: savedCount,
        count: all.length,
        storage: SHARED_LABEL_STORAGE
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: `공용 라벨 백업 복원 실패: ${err.message}`
      });
    }
  }
);

// 구 Render 임시 JSON에 데이터가 있고 Supabase가 비어 있는 경우 자동 1회 이전.
// 같은 인스턴스에서 전환할 때 데이터 유실을 줄이기 위한 안전장치다.
async function migrateLocalSharedLabelsToSupabase() {
  if (SHARED_LABEL_STORAGE !== 'supabase') return;

  try {
    const local = readLocalSharedLabels();
    if (!local.length) return;

    const remote = await readSharedLabels();
    let migrated = 0;

    for (const item of local) {
      const existing = await findExistingSharedLabel(item, remote);
      if (existing) continue;
      await saveSharedLabel(item);
      remote.push(item);
      migrated++;
    }

    if (migrated) {
      console.log(`[공용 라벨] 로컬 JSON → Supabase 자동 이전: ${migrated}개`);
    }
  } catch (err) {
    console.error('[공용 라벨] Supabase 자동 이전 실패:', err.message);
  }
}



// =========================================================
// 공용 상품 기준목록 (바코드 ↔ 상품번호/SKU ↔ 상품명)
// Supabase product_catalog 테이블에 영구 저장한다.
// =========================================================

function sanitizeCatalogItem(input, defaultSource = '') {
  return {
    barcode: cleanSharedText(input?.barcode, 80).toUpperCase(),
    product_number: cleanSharedText(input?.productNumber ?? input?.product_number, 80),
    product_name: cleanSharedText(input?.productName ?? input?.product_name, 800),
    source: cleanSharedText(input?.source || defaultSource, 300),
    updated_at: new Date().toISOString()
  };
}

async function getProductCatalogCount() {
  if (SHARED_LABEL_STORAGE !== 'supabase') {
    try {
      const parsed = JSON.parse(fs.readFileSync(PRODUCT_CATALOG_SEED_FILE, 'utf8'));
      return Array.isArray(parsed?.items) ? parsed.items.length : 0;
    } catch {
      return 0;
    }
  }

  // Supabase/PostgREST는 한 번의 조회에서 기본 최대 1,000행만 반환할 수 있으므로
  // 1,000개씩 페이지를 넘겨 실제 전체 개수를 계산한다.
  const pageSize = 1000;
  let offset = 0;
  let total = 0;

  while (true) {
    const rows = await supabaseRest(
      `product_catalog?select=barcode&limit=${pageSize}&offset=${offset}`
    );
    const count = Array.isArray(rows) ? rows.length : 0;
    total += count;

    if (count < pageSize) break;
    offset += pageSize;

    // 비정상 무한 루프 방지
    if (offset > 100000) {
      throw new Error('상품 기준목록 개수 계산 한도를 초과했습니다.');
    }
  }

  return total;
}

async function findProductCatalogByBarcode(barcode) {
  const cleanBarcode = cleanSharedText(barcode, 80).toUpperCase();
  if (!cleanBarcode) return null;

  if (SHARED_LABEL_STORAGE === 'supabase') {
    const rows = await supabaseRest(
      `product_catalog?barcode=eq.${encodeURIComponent(cleanBarcode)}&select=barcode,product_number,product_name,source,updated_at&limit=1`
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    return {
      barcode: row.barcode || '',
      productNumber: row.product_number || '',
      productName: row.product_name || '',
      source: row.source || '',
      updatedAt: row.updated_at || ''
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(PRODUCT_CATALOG_SEED_FILE, 'utf8'));
    const item = (parsed?.items || []).find(
      x => String(x.barcode || '').trim().toUpperCase() === cleanBarcode
    );
    return item || null;
  } catch {
    return null;
  }
}

async function upsertProductCatalogItems(items, source = '') {
  const map = new Map();
  for (const item of items || []) {
    const row = sanitizeCatalogItem(item, source);
    if (!row.barcode) continue;
    map.set(row.barcode, row);
  }
  const rows = [...map.values()];
  if (!rows.length) return 0;

  if (SHARED_LABEL_STORAGE !== 'supabase') {
    throw new Error('상품 기준목록 업데이트에는 Supabase 영구 저장 연결이 필요합니다.');
  }

  const batchSize = 500;
  let imported = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    await supabaseRest('product_catalog?on_conflict=barcode', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk)
    });
    imported += chunk.length;
  }
  return imported;
}

app.get('/api/product-catalog', async (req, res) => {
  try {
    const barcode = cleanSharedText(req.query.barcode, 80).toUpperCase();
    if (!barcode) {
      return res.status(400).json({ ok: false, error: 'barcode 값이 필요합니다.' });
    }
    const item = await findProductCatalogByBarcode(barcode);
    res.json({ ok: true, item, permanent: SHARED_LABEL_STORAGE === 'supabase' });
  } catch (err) {
    res.status(500).json({ ok: false, error: `상품 기준목록 조회 실패: ${err.message}` });
  }
});

app.get('/api/product-catalog-status', async (req, res) => {
  try {
    const count = await getProductCatalogCount();
    res.json({
      ok: true,
      count,
      storage: SHARED_LABEL_STORAGE,
      permanent: SHARED_LABEL_STORAGE === 'supabase'
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: `상품 기준목록 상태 조회 실패: ${err.message}` });
  }
});

app.post(
  '/api/product-catalog/import',
  sharedLabelWriteLimiter,
  checkSharedLabelEditKey,
  async (req, res) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!items.length) {
        return res.status(400).json({ ok: false, error: '업데이트할 상품목록이 없습니다.' });
      }
      if (items.length > 1000) {
        return res.status(400).json({ ok: false, error: '한 번에 최대 1,000개까지 업데이트할 수 있습니다.' });
      }
      const source = cleanSharedText(req.body?.source, 300);
      const imported = await upsertProductCatalogItems(items, source);
      res.json({ ok: true, imported, permanent: SHARED_LABEL_STORAGE === 'supabase' });
    } catch (err) {
      res.status(500).json({ ok: false, error: `상품 기준목록 업데이트 실패: ${err.message}` });
    }
  }
);

// GitHub에 포함된 현재 기준 JSON을 Supabase가 비어 있을 때 최초 1회 자동 적재한다.
async function seedProductCatalogToSupabase() {
  if (SHARED_LABEL_STORAGE !== 'supabase') return;
  try {
    if (!fs.existsSync(PRODUCT_CATALOG_SEED_FILE)) return;

    const parsed = JSON.parse(fs.readFileSync(PRODUCT_CATALOG_SEED_FILE, 'utf8'));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    if (!items.length) return;

    // 일부 배치만 들어간 상태에서도 자동으로 복구할 수 있도록
    // 현재 실제 개수와 기준 JSON 개수를 비교한다.
    const currentCount = await getProductCatalogCount();
    if (currentCount >= items.length) {
      console.log(`[상품 기준목록] 이미 적재 완료: ${currentCount}개`);
      return;
    }

    console.log(
      `[상품 기준목록] 부족분 확인: 현재 ${currentCount}개 / 기준 ${items.length}개 → 전체 upsert 재동기화`
    );

    const imported = await upsertProductCatalogItems(
      items,
      cleanSharedText(parsed?.source || 'barcode-product-catalog.json', 300)
    );

    const finalCount = await getProductCatalogCount();
    console.log(
      `[상품 기준목록] Supabase 동기화 완료: 처리 ${imported}개 / 최종 ${finalCount}개`
    );
  } catch (err) {
    console.error('[상품 기준목록] 초기/재동기화 실패:', err.message);
  }
}


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
  res.json({
    ok: true,
    keyConfigured: !!UNIPASS_KEY,
    aiConfigured: !!ANTHROPIC_KEY,
    detailAiProvider: 'openai',
    detailAiConfigured: !!OPENAI_KEY
  });
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
app.get('/detail-maker', (req, res) => {
  res.sendFile(path.join(__dirname, 'coupang-detail-maker.html'));
});

app.get('/barcode-label', (req, res) => {
  res.sendFile(path.join(__dirname, 'barcode-label.html'));
});
  app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TradeCode Navi 백엔드 프록시 실행 중: http://localhost:${PORT}`);
  console.log(`인증키 설정 여부: ${UNIPASS_KEY ? 'O' : 'X (미설정)'}`);
  console.log(`공용 라벨 저장소: ${SHARED_LABEL_STORAGE === 'supabase' ? 'Supabase 영구 저장' : '로컬 임시 저장'}`);
  if (SHARED_LABEL_STORAGE === 'supabase') {
    migrateLocalSharedLabelsToSupabase();
    seedProductCatalogToSupabase();
  }
});
