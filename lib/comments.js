// 댓글/답글(대댓글) 저장소.
// -----------------------------------------------------------------------
// 별도 로그인/회원가입 없이 쓰는 "게시판형" 댓글이라, 옛날 한국 게시판/방명록처럼
// 닉네임 + 짧은 비밀번호로 본인 확인을 한다(수정/삭제 시 비밀번호 일치 여부만
// 확인). 이건 진짜 보안 인증이 아니라 "아무나 남의 댓글을 실수로/장난으로 못
// 지우게 막는" 정도의 가벼운 장치이니, 실제 회원 시스템이 필요하면 별도로
// 구축해야 한다.
//
// 저장 방식: server/data/comments.json 파일 하나에 배열로 저장한다. 매 요청마다
// 파일을 통째로 읽고 쓰는 아주 단순한 방식이라 트래픽이 많은 실서비스에는 안
// 맞지만, 데모/저트래픽 사이트에는 충분하고 별도 DB 설치가 필요 없다는 장점이 있다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DATA_FILE = path.join(DEFAULT_DATA_DIR, 'comments.json');

// 테스트에서 실제 운영 데이터 파일(server/data/comments.json)을 건드리지 않도록,
// COMMENTS_DATA_FILE 환경변수가 있으면 그 경로를 대신 쓴다.
function getDataFile() {
  return process.env.COMMENTS_DATA_FILE || DEFAULT_DATA_FILE;
}

const MAX_AUTHOR_LEN = 20;
const MAX_PASSWORD_LEN = 30;
const MIN_PASSWORD_LEN = 4;
const MAX_CONTENT_LEN = 500;

function ensureStore() {
  const file = getDataFile();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');
}

function readAll() {
  ensureStore();
  try {
    const raw = fs.readFileSync(getDataFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // 파일이 깨졌거나 비어있는 경우, 기존 댓글을 날리는 대신 빈 배열로 안전하게 시작
    return [];
  }
}

function writeAll(list) {
  ensureStore();
  fs.writeFileSync(getDataFile(), JSON.stringify(list, null, 2), 'utf8');
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

function toPublic(c) {
  return {
    id: c.id,
    parentId: c.parentId || null,
    author: c.author,
    content: c.content,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt || null
  };
}

function validateInputs({ author, password, content }) {
  const a = (author || '').trim();
  const p = String(password || '');
  const c = (content || '').trim();
  if (!a) return '닉네임을 입력해주세요.';
  if (a.length > MAX_AUTHOR_LEN) return `닉네임은 ${MAX_AUTHOR_LEN}자 이하로 입력해주세요.`;
  if (p.length < MIN_PASSWORD_LEN) return `비밀번호는 ${MIN_PASSWORD_LEN}자 이상 입력해주세요.`;
  if (p.length > MAX_PASSWORD_LEN) return `비밀번호는 ${MAX_PASSWORD_LEN}자 이하로 입력해주세요.`;
  if (!c) return '댓글 내용을 입력해주세요.';
  if (c.length > MAX_CONTENT_LEN) return `댓글은 ${MAX_CONTENT_LEN}자 이하로 입력해주세요.`;
  return null;
}

// 목록 조회: 비밀번호 해시는 절대 프론트로 내려주지 않는다.
function listComments() {
  return readAll().map(toPublic).sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt));
}

function createComment({ author, password, content, parentId }) {
  const err = validateInputs({ author, password, content });
  if (err) return { ok: false, error: err };

  const all = readAll();
  if (parentId) {
    const parentExists = all.some(c => c.id === parentId);
    if (!parentExists) return { ok: false, error: '답글을 달려는 원본 댓글을 찾을 수 없습니다(이미 삭제되었을 수 있어요).' };
  }

  const now = new Date().toISOString();
  const comment = {
    id: crypto.randomUUID(),
    parentId: parentId || null,
    author: author.trim(),
    passwordHash: hashPassword(password),
    content: content.trim(),
    createdAt: now,
    updatedAt: null
  };
  all.push(comment);
  writeAll(all);
  return { ok: true, comment: toPublic(comment) };
}

function updateComment({ id, password, content }) {
  const c = (content || '').trim();
  if (!c) return { ok: false, error: '댓글 내용을 입력해주세요.' };
  if (c.length > MAX_CONTENT_LEN) return { ok: false, error: `댓글은 ${MAX_CONTENT_LEN}자 이하로 입력해주세요.` };

  const all = readAll();
  const idx = all.findIndex(x => x.id === id);
  if (idx === -1) return { ok: false, error: '댓글을 찾을 수 없습니다(이미 삭제되었을 수 있어요).' };
  if (all[idx].passwordHash !== hashPassword(password)) {
    return { ok: false, error: '비밀번호가 일치하지 않습니다.' };
  }
  all[idx].content = c;
  all[idx].updatedAt = new Date().toISOString();
  writeAll(all);
  return { ok: true, comment: toPublic(all[idx]) };
}

// 삭제: 본문만 지우는 게 아니라, 그 댓글에 달린 답글(및 답글의 답글...)까지
// 전부 함께 지운다 - 부모 없는 답글이 화면에 붕 떠서 남는 것을 막기 위함.
function deleteComment({ id, password }) {
  const all = readAll();
  const target = all.find(x => x.id === id);
  if (!target) return { ok: false, error: '댓글을 찾을 수 없습니다(이미 삭제되었을 수 있어요).' };
  if (target.passwordHash !== hashPassword(password)) {
    return { ok: false, error: '비밀번호가 일치하지 않습니다.' };
  }

  const toDelete = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    all.forEach(c => {
      if (c.parentId && toDelete.has(c.parentId) && !toDelete.has(c.id)) {
        toDelete.add(c.id);
        changed = true;
      }
    });
  }

  const remaining = all.filter(c => !toDelete.has(c.id));
  writeAll(remaining);
  return { ok: true, deletedIds: Array.from(toDelete) };
}

module.exports = { listComments, createComment, updateComment, deleteComment, MAX_CONTENT_LEN, MAX_AUTHOR_LEN };
