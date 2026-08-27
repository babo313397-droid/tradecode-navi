// 선택 기능(ANTHROPIC_API_KEY 설정 시 활성화): "반지", "스테인리스 기계 부품", "실리콘 빨대"처럼
// 대략적인 한글 상품명을 입력해도, 국제 무역/HS코드 검색에 바로 쓸 수 있는 영문 무역품명과
// 검색 키워드, 재질/용도 추정, HS 챕터 후보, 그리고 "반지"처럼 그 자체만으로는 AI도 HS코드를
// 하나로 단정할 수 없는 경우 재질/용도를 좁히기 위한 선택형(버튼) 질문까지 함께 만들어주는
// "AI 상품명 분석" 기능. 단순 번역기가 아니라 HS 분류를 돕기 위한 구조화된 분석 결과를 반환한다.
// 키가 없으면 이 기능은 비활성화되고, 프론트는 조용히 원래 입력어만으로 검색한다.
async function analyzeProduct({ q, apiKey, model, timeoutMs }) {
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY 미설정 (선택 기능)' };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || 8000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        messages: [{
          role: 'user',
          content:
            '너는 한국 관세청 HS코드 분류를 돕는 무역 상품명 분석기야. 아래 한국어 상품명은 ' +
            '구어체·줄임말·비전문가 표현이거나, "반지"처럼 그 자체만으로는 재질/용도가 정해지지 ' +
            '않아 HS 챕터가 하나로 단정되지 않는 경우일 수 있어. 이걸 단순히 번역하지 말고, ' +
            'HS코드 검색과 분류에 실제로 도움이 되도록 분석해줘.\n\n' +
            '반드시 아래 JSON 형식으로만 답하고 다른 텍스트는 절대 포함하지 마. 값을 모르면 ' +
            '빈 문자열이나 빈 배열로 두고, 절대 지어내지 마.\n' +
            '{\n' +
            '  "normalizedKoreanName": "정리된 한글 상품명",\n' +
            '  "englishTradeName": "국제 무역에서 쓰는 영문 상품명(trade name)",\n' +
            '  "searchKeywords": ["HS코드 검색에 적합한 영문 키워드 3~5개"],\n' +
            '  "material": "입력만으로 추정 가능한 재질 (모르면 빈 문자열)",\n' +
            '  "purpose": "추정 용도/사용처 (모르면 빈 문자열)",\n' +
            '  "hsChapterCandidates": [{"chapter":"2자리 챕터번호","label":"챕터 설명과 선택 이유"}],\n' +
            '  "clarifyingQuestions": [\n' +
            '    {"question":"사용자에게 물어볼 질문", "options":["짧은 선택지1","선택지2","선택지3","기타"]}\n' +
            '  ]\n' +
            '}\n\n' +
            '주의사항:\n' +
            '1. 정보가 부족해서 HS 챕터를 하나로 단정할 수 없으면(예: "반지"는 재질이 금속인지 ' +
            '   플라스틱인지에 따라 HS 71류/74류/39류 등으로 완전히 달라짐), hsChapterCandidates에 ' +
            '   재질/용도별로 가능성 있는 후보를 여러 개 넣어.\n' +
            '2. 그리고 그 후보를 좁히기 위해 꼭 필요한 질문을 clarifyingQuestions에 1~3개 만들어. ' +
            '   각 질문은 사용자가 타이핑하지 않고 클릭만으로 답할 수 있도록, 실제 분류에 영향을 ' +
            '   주는 짧은 선택지(2~5개)로 구성하고, 마지막 선택지는 항상 "기타"로 끝나야 해.\n' +
            '   예시: {"question":"재질이 무엇인가요?","options":["금","은","도금 금속","플라스틱","기타"]}\n' +
            '3. 입력만으로 이미 HS 챕터가 충분히 명확하면(예: "실리콘 빨대") hsChapterCandidates에 ' +
            '   후보 1개만 넣고 clarifyingQuestions는 빈 배열로 둬.\n\n' +
            `상품명: ${q}`
        }]
      }),
      signal: controller.signal
    });
    const json = await res.json();
    if (!res.ok) {
      return { ok: false, error: (json && json.error && json.error.message) || `HTTP ${res.status}` };
    }
    const text = (json.content && json.content[0] && json.content[0].text) || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, error: 'AI 응답 파싱 실패' };
    const parsed = JSON.parse(match[0]);

    const hsChapterCandidates = Array.isArray(parsed.hsChapterCandidates)
      ? parsed.hsChapterCandidates
          .filter(c => c && c.chapter)
          .slice(0, 5)
          .map(c => ({ chapter: String(c.chapter), label: c.label || '' }))
      : [];

    const clarifyingQuestions = Array.isArray(parsed.clarifyingQuestions)
      ? parsed.clarifyingQuestions
          .filter(q2 => q2 && q2.question)
          .slice(0, 3)
          .map(q2 => {
            let options = Array.isArray(q2.options) ? q2.options.filter(Boolean).slice(0, 6) : [];
            // 모델이 "기타"를 빼먹었을 수 있으니 서버에서 항상 보정해 넣는다.
            if (!options.some(o => o.trim() === '기타')) options.push('기타');
            return { question: String(q2.question), options };
          })
      : [];

    return {
      ok: true,
      normalizedKoreanName: parsed.normalizedKoreanName || q,
      englishTradeName: parsed.englishTradeName || '',
      searchKeywords: Array.isArray(parsed.searchKeywords) ? parsed.searchKeywords.filter(Boolean).slice(0, 5) : [],
      material: parsed.material || '',
      purpose: parsed.purpose || '',
      hsChapterCandidates,
      clarifyingQuestions
    };
  } catch (err) {
    return { ok: false, error: `AI 호출 실패: ${err.message}` };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { analyzeProduct };
