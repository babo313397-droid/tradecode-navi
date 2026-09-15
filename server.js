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
const os = require('os');
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
app.use(express.json({ limit: '5mb' })); // 댓글 + 공용 라벨 JSON 파싱용
// v48: 정적 파일 제공은 로그인 보호 미들웨어 등록 뒤에 시작합니다.
// app.use(express.static(path.join(__dirname))); // moved below


// =====================================================================
// v60: Render Persistent Disk canonical storage
// - /var/data 가 마운트되어 있으면 모든 운영 데이터의 정본은 /var/data/tradecode 입니다.
// - 코드 배포 폴더와 데이터 저장소를 완전히 분리합니다.
// - 기존 v48~v59 위치는 복구/마이그레이션 후보로만 읽고, 새 저장은 canonical 아래에만 합니다.
// =====================================================================
const V60_DEFAULT_DISK_ROOT = '/var/data';
// v61: 운영 데이터는 Render Persistent Disk 한 곳만 사용합니다.
// 임시 파일시스템으로 폴백하지 않습니다. 디스크가 없으면 서버가 시작되지 않아
// 계정을 잘못된 임시 경로에 만드는 사고를 원천 차단합니다.
const TRADECODE_PERSIST_ROOT_V60 = path.resolve('/var/data/tradecode');
const V60_COUPANG_ROOT = path.join(TRADECODE_PERSIST_ROOT_V60,'coupang-shared');
const V60_AUTH_ROOT = path.join(TRADECODE_PERSIST_ROOT_V60,'auth');
const V60_USERS_ROOT = path.join(TRADECODE_PERSIST_ROOT_V60,'users');
const V60_SNAPSHOT_ROOT = path.join(TRADECODE_PERSIST_ROOT_V60,'pre-v60-snapshot');
let V61_DISK_DEVICE_OK=false;
function ensureV60PersistentRoot(){
  if(!fs.existsSync(V60_DEFAULT_DISK_ROOT)){
    throw new Error('Render 영구 디스크 /var/data 가 없습니다. 임시 저장소에는 계정을 만들지 않습니다.');
  }
  const rootDev=fs.statSync('/').dev;
  const diskDev=fs.statSync(V60_DEFAULT_DISK_ROOT).dev;
  if(rootDev===diskDev){
    throw new Error('/var/data 가 별도 Persistent Disk로 마운트되지 않았습니다. 임시 저장을 차단합니다.');
  }
  V61_DISK_DEVICE_OK=true;
  fs.mkdirSync(TRADECODE_PERSIST_ROOT_V60,{recursive:true});
  const probe=path.join(TRADECODE_PERSIST_ROOT_V60,'.write-test-'+process.pid);
  const fd=fs.openSync(probe,'w',0o600);
  try{fs.writeFileSync(fd,String(Date.now()));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  fs.unlinkSync(probe);
}
let V60_PERSIST_WRITABLE=false;
try{
  ensureV60PersistentRoot();
  V60_PERSIST_WRITABLE=true;
}catch(e){
  console.error('[v61 storage] 영구 저장소 검증 실패:',e.message);
  throw e;
}
function copyMissingTreeV60(src,dst){
  try{
    if(!src||!fs.existsSync(src))return false;
    const st=fs.statSync(src);
    if(st.isDirectory()){
      fs.mkdirSync(dst,{recursive:true});let changed=false;
      for(const ent of fs.readdirSync(src,{withFileTypes:true})){
        changed=copyMissingTreeV60(path.join(src,ent.name),path.join(dst,ent.name))||changed;
      }
      return changed;
    }
    if(!fs.existsSync(dst)){fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);return true}
  }catch(e){console.warn('[v60 migration] copy skip:',src,e.message)}
  return false;
}
function legacySnapshotCandidatesV60(){
  const rows=[];const add=v=>{try{if(v){const r=path.resolve(v);if(!rows.includes(r))rows.push(r)}}catch(_){}};
  add(path.join(os.homedir()||'/opt/render','.tradecode-navi'));
  add(path.join(__dirname,'data'));add(path.join(process.cwd(),'data'));
  add(path.join(V60_SNAPSHOT_ROOT,'home-tradecode'));
  add(path.join(V60_SNAPSHOT_ROOT,'project-data'));
  return rows;
}
function migrateSimplePersistentDataV60(){
  let changed=false;
  for(const base of legacySnapshotCandidatesV60()){
    // 직원 개인 작업
    changed=copyMissingTreeV60(path.join(base,'users'),V60_USERS_ROOT)||changed;
    // 과거 ~/.tradecode-navi 는 users가 바로 하위에 존재합니다.
    if(path.basename(base)==='.tradecode-navi')changed=copyMissingTreeV60(path.join(base,'users'),V60_USERS_ROOT)||changed;
    // 서버 data 폴더 안의 공용 라벨
    changed=copyMissingTreeV60(path.join(base,'shared-barcode'),path.join(TRADECODE_PERSIST_ROOT_V60,'shared-barcode'))||changed;
    // 쿠팡 저장소 전체를 비파괴 복사합니다. 이미 영구 디스크에 있는 파일은 덮어쓰지 않습니다.
    changed=copyMissingTreeV60(path.join(base,'coupang-shared'),V60_COUPANG_ROOT)||changed;
  }
  if(changed)console.log('[v60 migration] 기존 보조 데이터를 영구 디스크로 비파괴 복사했습니다.');
}
migrateSimplePersistentDataV60();

// =====================================================================
// v50: 계정별 로그인 + 사용자별 작업공간 (직원 데이터 완전 분리)
// - 기존 데이터는 삭제/이동하지 않습니다.
// - 최초 생성 관리자(legacyOwner=true)는 기존 저장소를 그대로 사용합니다.
// - 이후 계정은 data/users/<userId>/ 아래에 분리 저장합니다.
// =====================================================================
// v54: 로그인 계정과 쿠팡 작업 데이터의 영구 저장 루트를 서버 시작 전에 하나로 확정합니다.
// 핵심: server.js가 새 배포 폴더로 교체되어도 기존 프로젝트/계정이 있는 저장소를 먼저 찾아 사용합니다.
function readJsonLooseV54(file,fallback=null){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch(_){return fallback}}
function projectCountAtRootEarlyV54(root){
  try{
    if(!root)return 0;
    const idx=readJsonLooseV54(path.join(root,'projects.json'),null);
    const idxCount=(idx&&Array.isArray(idx.projects))?idx.projects.length:0;
    const pdir=path.join(root,'projects');let dirCount=0;
    if(fs.existsSync(pdir))dirCount=fs.readdirSync(pdir,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^[A-Za-z0-9_-]{3,80}$/.test(e.name)).length;
    const legacy=(fs.existsSync(path.join(root,'state.json'))||fs.existsSync(path.join(root,'source.xlsx.bin')))?1:0;
    return Math.max(idxCount,dirCount,legacy);
  }catch(_){return 0}
}
function authCountAtRootV54(root){
  try{const x=readJsonLooseV54(path.join(root,'_auth','users.json'),null);return x&&Array.isArray(x.users)?x.users.length:0}catch(_){return 0}
}
function persistentRootCandidatesV54(){
  const arr=[];const add=v=>{try{if(v){const r=path.resolve(v);if(!arr.includes(r))arr.push(r)}}catch(_){}};
  add(V60_COUPANG_ROOT);
  add(process.env.TRADECODE_DATA_ROOT);
  add(process.env.COUPANG_SHARED_DIR);
  add(path.join(__dirname,'data','coupang-shared'));
  add(path.join(process.cwd(),'data','coupang-shared'));
  add(path.join(__dirname,'..','data','coupang-shared'));
  add(path.join(process.cwd(),'server','data','coupang-shared'));
  add(path.join(os.homedir()||'/opt/render','.tradecode-navi','coupang-shared'));
  add(path.join(V60_SNAPSHOT_ROOT,'project-data','coupang-shared'));
  add(path.join(V60_SNAPSHOT_ROOT,'home-tradecode','coupang-shared'));
  for(const parent of [...new Set([path.dirname(__dirname),process.cwd(),path.dirname(process.cwd())].map(x=>path.resolve(x)))]){
    try{
      for(const e of fs.readdirSync(parent,{withFileTypes:true}).slice(0,250)){
        if(!e.isDirectory())continue;
        add(path.join(parent,e.name,'data','coupang-shared'));
        add(path.join(parent,e.name,'server','data','coupang-shared'));
      }
    }catch(_){}
  }
  // 이전 버전이 기록해 둔 저장 위치 힌트가 있으면 후보에 추가합니다.
  for(const root of [...arr]){
    try{const h=readJsonLooseV54(path.join(root,'_auth','coupang-storage-location.json'),null);if(h?.selectedRoot)add(h.selectedRoot)}catch(_){}
  }
  return arr;
}
const PERSISTENT_ROOT_CANDIDATES_V54=persistentRootCandidatesV54();
function discoverPersistentCoupangRootV54(){
  const explicit=process.env.TRADECODE_DATA_ROOT||process.env.COUPANG_SHARED_DIR||'';
  let best=explicit?path.resolve(explicit):path.resolve(path.join(__dirname,'data','coupang-shared'));
  let bestProjects=projectCountAtRootEarlyV54(best),bestAuth=authCountAtRootV54(best);
  for(const c of PERSISTENT_ROOT_CANDIDATES_V54){
    const p=projectCountAtRootEarlyV54(c),a=authCountAtRootV54(c);
    // 쿠팡 프로젝트 수를 최우선, 동률이면 계정 수가 많은 저장소를 선택합니다.
    if(p>bestProjects || (p===bestProjects && a>bestAuth)){best=c;bestProjects=p;bestAuth=a}
  }
  console.log(`[v54 storage] 영구 저장 루트: ${best} / 쿠팡 ${bestProjects}개 / 계정 ${bestAuth}개`);
  return best;
}
const PERSISTENT_COUPANG_ROOT_V54=V60_COUPANG_ROOT;
console.log(`[v60 storage] 쿠팡 영구 정본: ${PERSISTENT_COUPANG_ROOT_V54}`);
// =====================================================================
// v59: 로그인/직원 계정 영구 저장소
// - 계정 DB를 배포 코드 폴더(__dirname) 밖, OS 사용자 홈의 고정 폴더에 저장합니다.
// - 환경변수 TRADECODE_PERSIST_DIR 또는 TRADECODE_AUTH_DIR가 있으면 그것을 최우선 사용합니다.
// - v48~v58에서 흩어진 users.json / .prev / _backups를 모두 검색하여 사용자명 기준으로 병합 복구합니다.
// - 정본 + 서버폴더 백업 + 쿠팡 저장소 백업의 3중 미러를 유지합니다.
// - 기존 작업 데이터가 발견되는 서버에서는 계정 DB가 일시적으로 안 보여도 "첫 관리자 만들기"를 금지합니다.
// =====================================================================
function uniquePathListV56(rows){const out=[];for(const v of rows){try{if(!v)continue;const r=path.resolve(v);if(!out.includes(r))out.push(r)}catch(_){}}return out}
function readJsonFileV48(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch(_){return fallback}}
function atomicJsonV48(file,obj){fs.mkdirSync(path.dirname(file),{recursive:true});const t=`${file}.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(t,JSON.stringify(obj,null,2),'utf8');fs.renameSync(t,file)}
function dirHasEntriesV59(dir){
  try{return fs.existsSync(dir)&&fs.readdirSync(dir).length>0}catch(_){return false}
}

const TRADECODE_PERSIST_HOME_V59 = TRADECODE_PERSIST_ROOT_V60;
const AUTH_DIR_V48 = V60_AUTH_ROOT;
const USERS_FILE_V48=path.join(AUTH_DIR_V48,'users.json');
const SECRET_FILE_V48=path.join(AUTH_DIR_V48,'session-secret.txt');
const AUTH_INIT_FLAG_V59=path.join(AUTH_DIR_V48,'initialized.flag');
const SYSTEM_INIT_FLAG_V59=path.join(TRADECODE_PERSIST_HOME_V59,'installed.flag');
const SESSION_COOKIE_V48='tradecode_session';
const AUTH_BACKUP_DIR_V54=path.join(AUTH_DIR_V48,'_backups');
const USER_DATA_BASE_V59=V60_USERS_ROOT;
const AUTH_COUPANG_ROOT_V52=PERSISTENT_COUPANG_ROOT_V54;
fs.mkdirSync(AUTH_DIR_V48,{recursive:true});
fs.mkdirSync(USER_DATA_BASE_V59,{recursive:true});

function scanAuthDirsNearbyV59(){
  const dirs=[];const add=v=>{try{if(v)dirs.push(path.resolve(v))}catch(_){}};
  add(AUTH_DIR_V48);
  add(path.join(TRADECODE_PERSIST_HOME_V59,'auth'));
  add(path.join(os.homedir()||'/opt/render','.tradecode-navi','auth'));
  add(path.join(V60_SNAPSHOT_ROOT,'home-tradecode','auth'));
  add(path.join(V60_SNAPSHOT_ROOT,'project-data','auth'));
  add(path.join(V60_SNAPSHOT_ROOT,'project-data','coupang-shared','_auth'));
  add(path.join(V60_SNAPSHOT_ROOT,'tradecode-auth-backup'));
  add(path.join(__dirname,'tradecode-auth-backup'));
  add(path.join(__dirname,'data','auth'));
  add(path.join(__dirname,'data','coupang-shared','_auth'));
  add(path.join(__dirname,'auth'));
  add(path.join(process.cwd(),'tradecode-auth-backup'));
  add(path.join(process.cwd(),'data','auth'));
  add(path.join(process.cwd(),'data','coupang-shared','_auth'));
  add(path.join(process.cwd(),'auth'));
  if(process.env.TRADECODE_AUTH_DIR)add(process.env.TRADECODE_AUTH_DIR);
  for(const r of PERSISTENT_ROOT_CANDIDATES_V54||[]){
    add(path.join(r,'_auth'));add(path.join(path.dirname(r),'auth'));
  }
  add(path.join(PERSISTENT_COUPANG_ROOT_V54,'_auth'));
  add(path.join(path.dirname(PERSISTENT_COUPANG_ROOT_V54),'auth'));
  const parents=uniquePathListV56([__dirname,path.dirname(__dirname),process.cwd(),path.dirname(process.cwd())]);
  for(const parent of parents){
    try{
      for(const e of fs.readdirSync(parent,{withFileTypes:true}).slice(0,500)){
        if(!e.isDirectory()||['node_modules','.git'].includes(e.name))continue;
        const base=path.join(parent,e.name);
        add(path.join(base,'tradecode-auth-backup'));
        add(path.join(base,'data','auth'));
        add(path.join(base,'data','coupang-shared','_auth'));
        add(path.join(base,'server','data','auth'));
        add(path.join(base,'server','data','coupang-shared','_auth'));
      }
    }catch(_){}
  }
  return uniquePathListV56(dirs);
}
const AUTH_LEGACY_DIRS_V52=scanAuthDirsNearbyV59();

function authFileInfoV59(file,authDir,kind='users'){
  const x=readJsonFileV48(file,null);let mtime=0;try{mtime=fs.statSync(file).mtimeMs}catch(_){}
  const valid=!!(x&&Array.isArray(x.users));
  return {file,authDir,kind,data:valid?x:null,count:valid?x.users.length:0,mtime,valid};
}
function authDbCandidatesV59(){
  const rows=[];
  for(const dir of scanAuthDirsNearbyV59()){
    rows.push(authFileInfoV59(path.join(dir,'users.json'),dir,'users'));
    rows.push(authFileInfoV59(path.join(dir,'users.json.prev'),dir,'prev'));
    try{
      const b=path.join(dir,'_backups');
      if(fs.existsSync(b)){
        for(const n of fs.readdirSync(b).filter(n=>/^users-.*\.json$/i.test(n)).sort().slice(-120)){
          rows.push(authFileInfoV59(path.join(b,n),dir,'backup'));
        }
      }
    }catch(_){}
  }
  const uniq=new Map();
  for(const r of rows.filter(x=>x.valid)){
    const k=path.resolve(r.file);
    const old=uniq.get(k);
    if(!old||r.mtime>old.mtime)uniq.set(k,r);
  }
  return [...uniq.values()];
}
function bestAuthDbV56(){
  return authDbCandidatesV59().filter(x=>x.count>0).sort((a,b)=>b.count-a.count||b.mtime-a.mtime)[0]||null;
}
function authUserKeyV59(u){
  const name=String(u?.username||'').trim().toLowerCase();
  return name||String(u?.id||'').trim();
}
function mergedAuthDbV59(){
  const rows=authDbCandidatesV59().filter(x=>x.count>0).sort((a,b)=>a.mtime-b.mtime);
  const map=new Map();
  for(const row of rows){
    for(const raw of row.data.users||[]){
      const key=authUserKeyV59(raw);if(!key)continue;
      const old=map.get(key);
      if(!old){map.set(key,{user:{...raw},mtime:row.mtime});continue}
      const latest=row.mtime>=old.mtime?{...old.user,...raw}:{...raw,...old.user};
      latest.legacyOwner=!!(old.user.legacyOwner||raw.legacyOwner);
      if(old.user.role==='admin'||raw.role==='admin'||latest.legacyOwner)latest.role='admin';
      if(latest.legacyOwner){latest.approved=true;latest.disabled=false}
      else if(old.user.approved===true||raw.approved===true)latest.approved=true;
      map.set(key,{user:latest,mtime:Math.max(old.mtime,row.mtime)});
    }
  }
  return {version:59,users:[...map.values()].map(x=>x.user)};
}
function authInitFlagExistsV59(){
  try{if(fs.existsSync(SYSTEM_INIT_FLAG_V59)||fs.existsSync(AUTH_INIT_FLAG_V59))return true}catch(_){}
  for(const dir of scanAuthDirsNearbyV59()){
    try{if(fs.existsSync(path.join(dir,'initialized.flag')))return true}catch(_){}
  }
  return false;
}
function operationalDataExistsV59(){
  try{
    for(const root of PERSISTENT_ROOT_CANDIDATES_V54||[]){
      if(projectCountAtRootEarlyV54(root)>0)return true;
      if(dirHasEntriesV59(path.join(root,'_shared-workspaces')))return true;
      if(dirHasEntriesV59(path.join(root,'projects')))return true;
      const label=path.join(path.dirname(root),'shared-barcode','labels.json');
      try{const x=readJsonFileV48(label,[]);if(Array.isArray(x)&&x.length)return true}catch(_){}
      const users=path.join(path.dirname(root),'users','v50-private');
      if(dirHasEntriesV59(users))return true;
    }
    if(dirHasEntriesV59(path.join(__dirname,'data','users')))return true;
    if(dirHasEntriesV59(path.join(process.cwd(),'data','users')))return true;
  }catch(_){}
  return false;
}
function authHistoryExistsV56(){
  return mergedAuthDbV59().users.length>0 || authInitFlagExistsV59() || operationalDataExistsV59();
}
function writeAuthInitFlagV59(){
  try{
    fs.mkdirSync(AUTH_DIR_V48,{recursive:true});
    fs.mkdirSync(TRADECODE_PERSIST_HOME_V59,{recursive:true});
    const body=`initialized=${new Date().toISOString()}\n`;
    fs.writeFileSync(AUTH_INIT_FLAG_V59,body,'utf8');
    fs.writeFileSync(SYSTEM_INIT_FLAG_V59,body,'utf8');
  }catch(e){console.warn('[v59 auth] 초기화 표식 저장 실패:',e.message)}
}
function backupAuthUsersV54(){
  try{
    if(!fs.existsSync(USERS_FILE_V48))return;
    fs.mkdirSync(AUTH_BACKUP_DIR_V54,{recursive:true});
    fs.copyFileSync(USERS_FILE_V48,USERS_FILE_V48+'.prev');
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    fs.copyFileSync(USERS_FILE_V48,path.join(AUTH_BACKUP_DIR_V54,`users-${stamp}.json`));
    const rows=fs.readdirSync(AUTH_BACKUP_DIR_V54).filter(x=>/^users-.*\.json$/.test(x)).sort();
    while(rows.length>120){const x=rows.shift();try{fs.unlinkSync(path.join(AUTH_BACKUP_DIR_V54,x))}catch(_){}}
  }catch(e){console.warn('[v59 auth] 계정 백업 실패:',e.message)}
}
function copyTreeNewerV59(src,dst){
  try{
    if(!fs.existsSync(src))return false;
    const st=fs.statSync(src);
    if(st.isDirectory()){
      fs.mkdirSync(dst,{recursive:true});let changed=false;
      for(const e of fs.readdirSync(src,{withFileTypes:true})){
        if(['node_modules','.git'].includes(e.name))continue;
        changed=copyTreeNewerV59(path.join(src,e.name),path.join(dst,e.name))||changed;
      }
      return changed;
    }
    let copy=!fs.existsSync(dst);
    if(!copy){try{copy=fs.statSync(src).mtimeMs>fs.statSync(dst).mtimeMs+1000}catch(_){copy=true}}
    if(copy){fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);return true}
  }catch(_){}
  return false;
}
function legacyUserDataRootsV59(){
  const rows=[];const add=v=>{try{if(v)rows.push(path.resolve(v))}catch(_){}};
  for(const root of PERSISTENT_ROOT_CANDIDATES_V54||[])add(path.join(path.dirname(root),'users','v50-private'));
  add(path.join(__dirname,'data','users','v50-private'));
  add(path.join(process.cwd(),'data','users','v50-private'));
  const parents=uniquePathListV56([__dirname,path.dirname(__dirname),process.cwd(),path.dirname(process.cwd())]);
  for(const parent of parents){
    try{
      for(const e of fs.readdirSync(parent,{withFileTypes:true}).slice(0,400)){
        if(!e.isDirectory()||['node_modules','.git'].includes(e.name))continue;
        add(path.join(parent,e.name,'data','users','v50-private'));
        add(path.join(parent,e.name,'server','data','users','v50-private'));
      }
    }catch(_){}
  }
  return uniquePathListV56(rows);
}
function migratePrivateUserDataV59(){
  const dstBase=path.join(USER_DATA_BASE_V59,'v50-private');fs.mkdirSync(dstBase,{recursive:true});
  for(const srcBase of legacyUserDataRootsV59()){
    if(path.resolve(srcBase)===path.resolve(dstBase)||!fs.existsSync(srcBase))continue;
    try{
      for(const e of fs.readdirSync(srcBase,{withFileTypes:true})){
        if(!e.isDirectory())continue;
        copyTreeNewerV59(path.join(srcBase,e.name),path.join(dstBase,e.name));
      }
    }catch(_){}
  }
}
function recoverAuthFilesV52(){
  try{
    fs.mkdirSync(AUTH_DIR_V48,{recursive:true});
    const canonical=authFileInfoV59(USERS_FILE_V48,AUTH_DIR_V48,'users');
    const alreadyInitialized=fs.existsSync(AUTH_INIT_FLAG_V59);

    // v61 핵심: 한 번 영구 디스크에 계정을 만들고 initialized.flag가 생기면
    // 이후 재시작/배포에서는 다른 경로를 다시 병합하거나 갈아타지 않습니다.
    // /var/data/tradecode/auth/users.json 만 유일한 정본입니다.
    if(!alreadyInitialized && (!canonical.valid || canonical.count===0)){
      const merged=mergedAuthDbV59();
      if(merged.users.length){
        atomicJsonV48(USERS_FILE_V48,{version:61,users:merged.users});
        writeAuthInitFlagV59();
        console.log(`[v61 auth] 최초 1회 기존 계정 이관: ${merged.users.length}개 -> ${USERS_FILE_V48}`);
      }
    }else if(canonical.count>0 && !alreadyInitialized){
      writeAuthInitFlagV59();
    }

    // 이미 초기화된 영구 저장소에서 users.json이 사라지거나 손상되면
    // 새 관리자 생성으로 덮어쓰지 않고 오류 상태로 남깁니다.
    if(fs.existsSync(AUTH_INIT_FLAG_V59)){
      const now=authFileInfoV59(USERS_FILE_V48,AUTH_DIR_V48,'users');
      if(!now.valid){
        console.error('[v61 auth] 영구 users.json 손상/누락 감지. 새 관리자 생성은 차단됩니다.');
      }
    }

    if(!fs.existsSync(SECRET_FILE_V48)){
      const dirs=scanAuthDirsNearbyV59();
      for(const dir of dirs){
        const f=path.join(dir,'session-secret.txt');
        if(path.resolve(f)===path.resolve(SECRET_FILE_V48))continue;
        try{if(fs.existsSync(f)&&fs.readFileSync(f,'utf8').trim()){fs.copyFileSync(f,SECRET_FILE_V48);break}}catch(_){}
      }
    }
    migratePrivateUserDataV59();
    try{atomicJsonV48(path.join(AUTH_DIR_V48,'storage-location.json'),{
      version:61,canonical:true,persistentHome:TRADECODE_PERSIST_HOME_V59,authDir:AUTH_DIR_V48,
      usersFile:USERS_FILE_V48,userDataBase:USER_DATA_BASE_V59,coupangRoot:PERSISTENT_COUPANG_ROOT_V54,checkedAt:Date.now()
    })}catch(_){}
  }catch(e){console.warn('[v61 auth] 영구 계정 저장소 확인 실패:',e.message)}
}
function mirrorAuthFilesV56(){
  const mirrors=uniquePathListV56([
    path.join(__dirname,'tradecode-auth-backup'),
    path.join(__dirname,'data','auth'),
    path.join(PERSISTENT_COUPANG_ROOT_V54,'_auth')
  ]);
  for(const dir of mirrors){
    try{
      if(path.resolve(dir)===path.resolve(AUTH_DIR_V48))continue;
      fs.mkdirSync(dir,{recursive:true});
      if(fs.existsSync(USERS_FILE_V48))fs.copyFileSync(USERS_FILE_V48,path.join(dir,'users.json'));
      if(fs.existsSync(SECRET_FILE_V48))fs.copyFileSync(SECRET_FILE_V48,path.join(dir,'session-secret.txt'));
      if(fs.existsSync(AUTH_INIT_FLAG_V59))fs.copyFileSync(AUTH_INIT_FLAG_V59,path.join(dir,'initialized.flag'));
    }catch(e){console.warn('[v59 auth] 인증 미러 저장 실패:',dir,e.message)}
  }
}
recoverAuthFilesV52();
function usersV48(){
  let x=readJsonFileV48(USERS_FILE_V48,{version:59,users:[]});
  if(!x||!Array.isArray(x.users)||x.users.length===0){
    recoverAuthFilesV52();
    x=readJsonFileV48(USERS_FILE_V48,{version:59,users:[]});
  }
  return x&&Array.isArray(x.users)?x:{version:59,users:[]}
}
function saveUsersV48(x){
  if(!V60_PERSIST_WRITABLE || !V61_DISK_DEVICE_OK)throw new Error('영구 디스크가 연결되지 않아 계정 저장을 중단했습니다.');
  const users=Array.isArray(x?.users)?x.users:[];
  backupAuthUsersV54();
  atomicJsonV48(USERS_FILE_V48,{version:61,updatedAt:Date.now(),users});
  const check=readJsonFileV48(USERS_FILE_V48,null);
  if(!check||!Array.isArray(check.users)||check.users.length!==users.length){
    throw new Error('영구 디스크 계정 저장 검증에 실패했습니다.');
  }
  if(users.length)writeAuthInitFlagV59();
  mirrorAuthFilesV56();
}
function secretV48(){
  try{const x=fs.readFileSync(SECRET_FILE_V48,'utf8').trim();if(x)return x}catch(_){}
  const x=crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(path.dirname(SECRET_FILE_V48),{recursive:true});
  fs.writeFileSync(SECRET_FILE_V48,x,{mode:0o600});
  return x
}
const AUTH_SECRET_V48=String(process.env.TRADECODE_AUTH_SECRET||'').trim()||secretV48();
try{mirrorAuthFilesV56()}catch(_){}
console.log(`[v61 auth] 영구 인증 저장소 고정: ${AUTH_DIR_V48} / 계정 ${usersV48().users.length}개`);

function normUserV48(v){return String(v||'').trim().toLowerCase().replace(/[^a-z0-9._-]/g,'').slice(0,60)}
function hashPwV48(pw,salt=crypto.randomBytes(16).toString('hex')){const hash=crypto.scryptSync(String(pw),salt,64).toString('hex');return{salt,hash}}
function verifyPwV48(pw,u){try{const h=crypto.scryptSync(String(pw),u.salt,64);return crypto.timingSafeEqual(h,Buffer.from(u.passwordHash,'hex'))}catch(_){return false}}
function b64uV48(x){return Buffer.from(x).toString('base64url')}
function signSessionV48(u){const payload=b64uV48(JSON.stringify({uid:u.id,exp:Date.now()+1000*60*60*24*14}));const sig=crypto.createHmac('sha256',AUTH_SECRET_V48).update(payload).digest('base64url');return payload+'.'+sig}
function parseCookiesV48(req){const out={};String(req.headers.cookie||'').split(';').forEach(p=>{const i=p.indexOf('=');if(i>0)out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())});return out}
function authUserV48(req){try{const tok=parseCookiesV48(req)[SESSION_COOKIE_V48]||'';const [payload,sig]=tok.split('.');if(!payload||!sig)return null;const expected=crypto.createHmac('sha256',AUTH_SECRET_V48).update(payload).digest('base64url');if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;const d=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));if(Number(d.exp||0)<Date.now())return null;const u=usersV48().users.find(x=>x.id===d.uid&&!x.disabled&&(x.legacyOwner||x.approved!==false));return u||null}catch(_){return null}}
function identityCookiesV50(req,u,maxAge=60*60*24*14){const secure=String(req.headers['x-forwarded-proto']||req.protocol||'').includes('https'),sec=secure?'; Secure':'';return [`tradecode_uid=${encodeURIComponent(u?.id||'')}; Path=/; SameSite=Lax; Max-Age=${maxAge}${sec}`,`tradecode_legacy=${u?.legacyOwner?'1':'0'}; Path=/; SameSite=Lax; Max-Age=${maxAge}${sec}`]}
function setSessionV48(req,res,u){const secure=String(req.headers['x-forwarded-proto']||req.protocol||'').includes('https');res.setHeader('Set-Cookie',[`${SESSION_COOKIE_V48}=${encodeURIComponent(signSessionV48(u))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*14}${secure?'; Secure':''}`,...identityCookiesV50(req,u)])}
function clearSessionV48(req,res){const secure=String(req.headers['x-forwarded-proto']||req.protocol||'').includes('https'),sec=secure?'; Secure':'';res.setHeader('Set-Cookie',[`${SESSION_COOKIE_V48}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${sec}`,`tradecode_uid=; Path=/; SameSite=Lax; Max-Age=0${sec}`,`tradecode_legacy=; Path=/; SameSite=Lax; Max-Age=0${sec}`])}
function publicUserV48(u){return{id:u.id,username:u.username,displayName:u.displayName||u.username,role:u.role||'user',legacyOwner:!!u.legacyOwner,approved:!!u.legacyOwner||u.approved!==false,approvalPending:!u.legacyOwner&&u.approved===false}}
function requireLoginApiV48(req,res,next){const u=authUserV48(req);if(!u)return res.status(401).json({ok:false,code:'LOGIN_REQUIRED',error:'로그인이 필요합니다.'});req.authUser=u;next()}
function requireLoginPageV48(req,res,next){const u=authUserV48(req);if(!u)return res.redirect('/login.html?next='+encodeURIComponent(req.originalUrl||'/'));req.authUser=u;for(const c of identityCookiesV50(req,u))res.append('Set-Cookie',c);next()}
function isAdminV48(req){return req.authUser&&req.authUser.role==='admin'}
function userDataRootV48(req){const u=req.authUser;if(!u)throw new Error('login required');if(u.legacyOwner)return null;return path.join(USER_DATA_BASE_V59,'v50-private',u.id)}
function ensureUserRootV48(req){const r=userDataRootV48(req);if(r)fs.mkdirSync(r,{recursive:true});return r}

app.get('/api/auth/me',(req,res)=>{recoverAuthFilesV52();const u=authUserV48(req),db=usersV48(),initialized=fs.existsSync(AUTH_INIT_FLAG_V59),storageError=initialized&&db.users.length===0;res.set('Cache-Control','no-store');res.json({ok:true,authenticated:!!u,user:u?publicUserV48(u):null,needsBootstrap:db.users.length===0&&!initialized&&!storageError,recoveryRequired:false,storageError,storageErrorMessage:storageError?'영구 계정 DB가 비어 있거나 손상되었습니다. 새 관리자 생성은 차단됩니다.':'',authVersion:61,persistent:true,persistentRoot:TRADECODE_PERSIST_ROOT_V60})});
app.get('/api/auth/storage-status',(req,res)=>{recoverAuthFilesV52();const db=usersV48();res.set('Cache-Control','no-store');res.json({ok:true,version:61,userCount:db.users.length,initialized:fs.existsSync(AUTH_INIT_FLAG_V59),persistent:true,persistentWritable:V60_PERSIST_WRITABLE,diskDeviceOk:V61_DISK_DEVICE_OK,persistentRoot:TRADECODE_PERSIST_ROOT_V60,canonicalAuthDir:AUTH_DIR_V48,usersFile:USERS_FILE_V48,userDataBase:USER_DATA_BASE_V59})});
app.get('/api/storage/v60-status',(req,res)=>{recoverAuthFilesV52();let projects=0;try{projects=(mergeAllCoupangRootsV57().projects||[]).length}catch(_){};res.set('Cache-Control','no-store');res.json({ok:true,version:61,persistentRoot:TRADECODE_PERSIST_ROOT_V60,persistentWritable:V60_PERSIST_WRITABLE,authDir:AUTH_DIR_V48,userDataBase:USER_DATA_BASE_V59,coupangRoot:PERSISTENT_COUPANG_ROOT_V54,userCount:usersV48().users.length,projectCount:projects,snapshotRoot:V60_SNAPSHOT_ROOT,snapshotExists:dirHasEntriesV59(V60_SNAPSHOT_ROOT)})});
app.get('/api/storage/v61-status',(req,res)=>{recoverAuthFilesV52();let projects=0;try{projects=(mergeAllCoupangRootsV57().projects||[]).length}catch(_){};res.set('Cache-Control','no-store');res.json({ok:true,version:61,persistentRoot:TRADECODE_PERSIST_ROOT_V60,persistentWritable:V60_PERSIST_WRITABLE,diskDeviceOk:V61_DISK_DEVICE_OK,authDir:AUTH_DIR_V48,usersFile:USERS_FILE_V48,userDataBase:USER_DATA_BASE_V59,coupangRoot:PERSISTENT_COUPANG_ROOT_V54,userCount:usersV48().users.length,projectCount:projects,initialized:fs.existsSync(AUTH_INIT_FLAG_V59)})});
app.get('/api/auth/safety-status',(req,res)=>{const u=authUserV48(req);if(!u)return res.status(401).json({ok:false,error:'로그인이 필요합니다.'});if(u.role!=='admin')return res.status(403).json({ok:false,error:'관리자만 확인할 수 있습니다.'});const db=usersV48();res.set('Cache-Control','no-store');res.json({ok:true,version:60,persistentHome:TRADECODE_PERSIST_HOME_V59,persistentRoot:PERSISTENT_COUPANG_ROOT_V54,authDir:AUTH_DIR_V48,userCount:db.users.length,usersFileExists:fs.existsSync(USERS_FILE_V48),prevBackupExists:fs.existsSync(USERS_FILE_V48+'.prev'),backupDir:AUTH_BACKUP_DIR_V54,userDataBase:USER_DATA_BASE_V59})});
app.post('/api/auth/bootstrap',(req,res)=>{try{recoverAuthFilesV52();const db=usersV48();if(!V60_PERSIST_WRITABLE||!V61_DISK_DEVICE_OK)return res.status(503).json({ok:false,error:'Render 영구 디스크가 확인되지 않아 계정 생성을 차단했습니다.'});if(db.users.length||fs.existsSync(AUTH_INIT_FLAG_V59))return res.status(409).json({ok:false,error:'영구 저장소는 이미 초기화되었습니다. 첫 관리자 계정을 다시 만들 수 없습니다.'});const username=normUserV48(req.body?.username),displayName=String(req.body?.displayName||username).trim().slice(0,80),pw=String(req.body?.password||'');if(username.length<3)return res.status(400).json({ok:false,error:'아이디는 3자 이상이어야 합니다.'});if(pw.length<8)return res.status(400).json({ok:false,error:'비밀번호는 8자 이상이어야 합니다.'});const hp=hashPwV48(pw),u={id:'u_'+crypto.randomBytes(8).toString('hex'),username,displayName,role:'admin',legacyOwner:true,approved:true,approvedAt:Date.now(),disabled:false,salt:hp.salt,passwordHash:hp.hash,createdAt:Date.now()};db.users.push(u);saveUsersV48(db);setSessionV48(req,res,u);res.json({ok:true,user:publicUserV48(u),legacyDataAssigned:true,persistent:true})}catch(e){res.status(500).json({ok:false,error:e.message})}});
app.post('/api/auth/login',(req,res)=>{const username=normUserV48(req.body?.username),pw=String(req.body?.password||'');const u=usersV48().users.find(x=>x.username===username&&!x.disabled);if(!u||!verifyPwV48(pw,u))return res.status(401).json({ok:false,error:'아이디 또는 비밀번호가 올바르지 않습니다.'});if(!u.legacyOwner&&u.approved===false)return res.status(403).json({ok:false,code:'APPROVAL_REQUIRED',error:'관리자 승인 대기 중인 계정입니다. 관리자에게 승인을 요청해 주세요.'});setSessionV48(req,res,u);res.json({ok:true,user:publicUserV48(u)})});
app.post('/api/auth/logout',(req,res)=>{clearSessionV48(req,res);res.json({ok:true})});
app.get('/api/auth/users',requireLoginApiV48,(req,res)=>{if(!isAdminV48(req))return res.status(403).json({ok:false,error:'관리자만 사용할 수 있습니다.'});res.json({ok:true,users:usersV48().users.map(publicUserV48)})});
app.post('/api/auth/users',requireLoginApiV48,(req,res)=>{if(!isAdminV48(req))return res.status(403).json({ok:false,error:'관리자만 사용할 수 있습니다.'});try{const db=usersV48(),username=normUserV48(req.body?.username),pw=String(req.body?.password||''),displayName=String(req.body?.displayName||username).trim().slice(0,80);if(username.length<3||pw.length<8)return res.status(400).json({ok:false,error:'아이디 3자 이상, 비밀번호 8자 이상이 필요합니다.'});if(db.users.some(x=>x.username===username))return res.status(409).json({ok:false,error:'이미 사용 중인 아이디입니다.'});const hp=hashPwV48(pw),u={id:'u_'+crypto.randomBytes(8).toString('hex'),username,displayName,role:req.body?.role==='admin'?'admin':'user',legacyOwner:false,approved:false,approvedAt:0,disabled:false,salt:hp.salt,passwordHash:hp.hash,createdAt:Date.now()};db.users.push(u);saveUsersV48(db);res.json({ok:true,user:publicUserV48(u),approvalRequired:true})}catch(e){res.status(500).json({ok:false,error:e.message})}});
app.patch('/api/auth/users/:id',requireLoginApiV48,(req,res)=>{if(!isAdminV48(req))return res.status(403).json({ok:false,error:'관리자만 사용할 수 있습니다.'});const db=usersV48(),u=db.users.find(x=>x.id===req.params.id);if(!u)return res.status(404).json({ok:false,error:'계정을 찾지 못했습니다.'});if(req.body?.displayName!==undefined)u.displayName=String(req.body.displayName||u.username).slice(0,80);if(req.body?.disabled!==undefined&&!u.legacyOwner)u.disabled=!!req.body.disabled;if(req.body?.role!==undefined&&!u.legacyOwner)u.role=req.body.role==='admin'?'admin':'user';if(req.body?.approved!==undefined&&!u.legacyOwner){u.approved=!!req.body.approved;u.approvedAt=u.approved?Date.now():0}if(req.body?.password){const pw=String(req.body.password);if(pw.length<8)return res.status(400).json({ok:false,error:'비밀번호는 8자 이상이어야 합니다.'});const hp=hashPwV48(pw);u.salt=hp.salt;u.passwordHash=hp.hash}saveUsersV48(db);res.json({ok:true,user:publicUserV48(u)})});

const PROTECTED_PAGE_PREFIXES_V48=['/barcode-label','/order-barcode','/shipment-list-builder','/coupang-inbound-work','/purchase-order','/detail-maker','/account-admin'];
app.use((req,res,next)=>{if(PROTECTED_PAGE_PREFIXES_V48.some(p=>req.path===p||req.path.startsWith(p+'.')||req.path.startsWith(p+'/')))return requireLoginPageV48(req,res,next);next()});
const PRIVATE_API_PREFIXES_V48=['/api/shared-labels','/api/shared-workspace','/api/shipment-list-vault','/api/coupang-shared'];
app.use((req,res,next)=>{if(PRIVATE_API_PREFIXES_V48.some(p=>req.path===p||req.path.startsWith(p+'/')))return requireLoginApiV48(req,res,next);next()});

// v50: 직원 계정 쿠팡 API는 레거시 공용 라우트보다 먼저 개인 저장소에서 처리합니다.
// 최초 관리자(legacyOwner)는 next()로 기존 저장소를 그대로 사용합니다.
// 계정별 쿠팡 선적 프로젝트. 최초 관리자는 기존 프로젝트 저장소를 그대로 사용합니다.
app.use('/api/coupang-shared',(req,res,next)=>{
  if(!req.authUser||req.authUser.legacyOwner)return next();
  const root=userJsonV48(req,'coupang-shared');fs.mkdirSync(root,{recursive:true});const idxFile=path.join(root,'projects.json'),pRoot=path.join(root,'projects');
  const readIdx=()=>{const x=readJsonFileV48(idxFile,{projects:[]});return x&&Array.isArray(x.projects)?x:{projects:[]}};const saveIdx=x=>atomicJsonV48(idxFile,{version:48,projects:x.projects||[]});const newId=()=>`p_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;const pp=id=>{const dir=path.join(pRoot,id);return{dir,state:path.join(dir,'state.json'),source:{data:path.join(dir,'source.xlsx.bin'),meta:path.join(dir,'source.meta.json')},workbookSnapshot:{data:path.join(dir,'workbookSnapshot.xlsx.bin'),meta:path.join(dir,'workbookSnapshot.meta.json')}}};
  const touch=id=>{const idx=readIdx(),p=idx.projects.find(x=>x.id===id);if(p){p.updatedAt=Date.now();saveIdx(idx)}return p};
  if(req.path==='/projects'&&req.method==='GET'){const idx=readIdx();return res.json({ok:true,projects:[...idx.projects].sort((a,b)=>b.updatedAt-a.updatedAt)})}
  if(req.path==='/projects'&&req.method==='POST'){const idx=readIdx(),id=newId(),now=Date.now(),p={id,name:String(req.body?.name||'새 선적 작업').slice(0,120),status:'active',createdAt:now,updatedAt:now};fs.mkdirSync(pp(id).dir,{recursive:true});idx.projects.push(p);saveIdx(idx);return res.json({ok:true,project:p})}
  const m=req.path.match(/^\/projects\/([A-Za-z0-9_-]+)(?:\/(status|state|blob\/source|blob\/workbookSnapshot))?$/);if(!m)return next();const id=m[1],part=m[2]||'',idx=readIdx(),proj=idx.projects.find(x=>x.id===id);if(!proj)return res.status(404).json({ok:false,error:'선적 작업을 찾을 수 없습니다.'});const paths=pp(id);
  if(!part){if(req.method==='PATCH'){if(req.body?.name!==undefined)proj.name=String(req.body.name||proj.name).slice(0,120);if(req.body?.status!==undefined)proj.status=req.body.status==='archived'?'archived':'active';proj.updatedAt=Date.now();saveIdx(idx);return res.json({ok:true,project:proj})}if(req.method==='DELETE'){fs.rmSync(paths.dir,{recursive:true,force:true});idx.projects=idx.projects.filter(x=>x.id!==id);saveIdx(idx);return res.json({ok:true})}}
  if(part==='status'&&req.method==='GET'){const st=readJsonFileV48(paths.state,null),bs=k=>{const meta=readJsonFileV48(paths[k].meta,null);return meta&&fs.existsSync(paths[k].data)?{updatedAt:Number(meta.updatedAt||0),size:Number(meta.size||0),name:meta.name||''}:null};return res.json({ok:true,state:st?{updatedAt:Number(st.updatedAt||0)}:null,source:bs('source'),workbookSnapshot:bs('workbookSnapshot')})}
  if(part==='state'){
    if(req.method==='GET'){const st=readJsonFileV48(paths.state,null);if(!st)return res.status(404).json({ok:false,error:'저장 상태가 없습니다.'});res.set('X-Updated-At',String(st.updatedAt||0));return res.json(st)}
    if(req.method==='DELETE'){fs.rmSync(paths.state,{force:true});touch(id);return res.json({ok:true})}
    if(req.method==='PUT')return rawBodyV48(req).then(buf=>{let state={};try{state=JSON.parse(buf.toString('utf8')||'{}')}catch(_){state=req.body||{}}const updatedAt=Date.now();atomicJsonV48(paths.state,{ok:true,updatedAt,state});touch(id);res.json({ok:true,updatedAt})}).catch(e=>res.status(400).json({ok:false,error:e.message}));
  }
  if(part.startsWith('blob/')){const key=part.split('/')[1],info=paths[key];if(!info)return res.status(404).json({ok:false,error:'파일 키 오류'});if(req.method==='GET'){const meta=readJsonFileV48(info.meta,null);if(!meta||!fs.existsSync(info.data))return res.status(404).json({ok:false,error:'저장된 파일이 없습니다.'});res.set('Content-Type',meta.type||'application/octet-stream');res.set('X-Updated-At',String(meta.updatedAt||0));res.set('X-File-Name',meta.name||'');res.set('X-File-Type',meta.type||'');res.set('X-File-Mode',meta.mode||'');res.set('X-Saved-At',String(meta.savedAt||meta.updatedAt||0));return res.sendFile(info.data)}if(req.method==='DELETE'){fs.rmSync(info.data,{force:true});fs.rmSync(info.meta,{force:true});touch(id);return res.json({ok:true})}if(req.method==='PUT')return rawBodyV48(req).then(buf=>{if(!buf.length)return res.status(400).json({ok:false,error:'빈 파일입니다.'});fs.mkdirSync(paths.dir,{recursive:true});const updatedAt=Date.now(),meta={updatedAt,size:buf.length,name:String(req.get('X-File-Name')||''),type:String(req.get('X-File-Type')||''),mode:String(req.get('X-File-Mode')||''),savedAt:Number(req.get('X-Saved-At')||updatedAt)};fs.writeFileSync(info.data,buf);atomicJsonV48(info.meta,meta);if(key==='source'){fs.rmSync(paths.state,{force:true});fs.rmSync(paths.workbookSnapshot.data,{force:true});fs.rmSync(paths.workbookSnapshot.meta,{force:true})}touch(id);res.json({ok:true,updatedAt,size:buf.length})}).catch(e=>res.status(500).json({ok:false,error:e.message}));}
  next();
});


// 상세페이지 자동 제작 화면도 기존 파일을 교체하지 않고 로그인 보호 + 계정 표시 스크립트만 삽입합니다.
app.get('/detail-maker',(req,res,next)=>{const candidates=[path.join(__dirname,'detail-maker.html'),path.join(__dirname,'detail-maker','index.html')];const f=candidates.find(x=>fs.existsSync(x));if(!f)return next();let html=fs.readFileSync(f,'utf8');if(!html.includes('/auth-client.js'))html=html.replace(/<\/body>/i,'<script src="/auth-client.js"></script><script src="/detail-auth-workspace.js"></script></body>');res.type('html').send(html)});

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
// v53 safety: 쿠팡 저장 루트가 업데이트 때 빈 경로로 바뀌어 보이지 않도록
// 주변의 기존 coupang-shared 저장소를 검사하고, 실제 프로젝트가 가장 많이 남아 있는 경로를 우선 사용합니다.
// COUPANG_SHARED_DIR 환경변수가 기존 데이터를 가진 경로라면 그 경로가 그대로 선택됩니다.
function projectCountAtRootV53(root){
  try{
    if(!root)return 0;
    const idx=readJsonFileV48(path.join(root,'projects.json'),null);
    const idxCount=(idx&&Array.isArray(idx.projects))?idx.projects.length:0;
    const pdir=path.join(root,'projects');let dirCount=0;
    if(fs.existsSync(pdir)){
      dirCount=fs.readdirSync(pdir,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^[A-Za-z0-9_-]{3,80}$/.test(e.name)).length;
    }
    const legacy=(fs.existsSync(path.join(root,'state.json'))||fs.existsSync(path.join(root,'source.xlsx.bin')))?1:0;
    return Math.max(idxCount,dirCount,legacy);
  }catch(_){return 0}
}
function discoverCoupangSharedDirV53(){
  // v54부터 인증보다 늦게 별도 경로를 고르지 않습니다. 서버 시작 초기에 확정한 영구 루트를 그대로 사용합니다.
  return PERSISTENT_COUPANG_ROOT_V54;
}
const COUPANG_SHARED_DIR = PERSISTENT_COUPANG_ROOT_V54;
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
  if (req.authUser) return next();
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
      backupFileV46(COUPANG_STATE_PATH);
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
const COUPANG_PROJECTS_PREV_V53 = path.join(COUPANG_SHARED_DIR,'projects.json.prev');
const COUPANG_PROJECTS_SAFE_V53 = path.join(COUPANG_SHARED_DIR,'projects.json.safe');
const COUPANG_PROJECTS_BACKUP_DIR_V53 = path.join(COUPANG_SHARED_DIR,'_project-index-backups');
const COUPANG_PROJECTS_TRASH_V53 = path.join(COUPANG_SHARED_DIR,'_project-trash');
function safeProjectIdV18(id){id=String(id||'');return /^[A-Za-z0-9_-]{3,80}$/.test(id)?id:null;}
function validProjectIndexV53(x){return x&&Array.isArray(x.projects)?x:null}
function listProjectDirsV53(){
  try{
    if(!fs.existsSync(COUPANG_PROJECTS_DIR))return [];
    return fs.readdirSync(COUPANG_PROJECTS_DIR,{withFileTypes:true}).filter(e=>e.isDirectory()&&safeProjectIdV18(e.name)).map(e=>e.name).sort();
  }catch(_){return []}
}
function decodeFileNameV53(v){try{return decodeURIComponent(String(v||''))}catch(_){return String(v||'')}}
function deriveProjectV53(id,prior={}){
  const paths=projectPathsV18(id),sourceMeta=readJsonSafe(paths.source.meta)||{},stateRow=readJsonSafe(paths.state)||{},snapMeta=readJsonSafe(paths.workbookSnapshot.meta)||{};
  let fileName=decodeFileNameV53(sourceMeta.name||'');
  let name=String(prior.name||'').trim();
  if(!name&&fileName)name=fileName.replace(/\.(xlsx|xlsm|xls)$/i,'').trim();
  const st=stateRow&&typeof stateRow==='object'?(stateRow.state||stateRow):{};
  if(!name)name=String(st.projectName||st.sourceFileName||st.fileName||'').replace(/\.(xlsx|xlsm|xls)$/i,'').trim();
  if(!name)name=`복구된 선적 작업 ${id}`;
  const times=[];
  for(const v of [prior.updatedAt,stateRow.updatedAt,sourceMeta.updatedAt,snapMeta.updatedAt,sourceMeta.savedAt,snapMeta.savedAt]){const n=Number(v||0);if(n)times.push(n)}
  try{for(const f of [paths.dir,paths.state,paths.source.data,paths.workbookSnapshot.data])if(fs.existsSync(f))times.push(fs.statSync(f).mtimeMs)}catch(_){}
  const updatedAt=times.length?Math.max(...times):Date.now();
  let createdAt=Number(prior.createdAt||0);if(!createdAt){try{createdAt=fs.statSync(paths.dir).birthtimeMs||fs.statSync(paths.dir).ctimeMs}catch(_){createdAt=updatedAt}}
  return {id,name,status:prior.status==='archived'?'archived':'active',createdAt:Number(createdAt||updatedAt),updatedAt:Number(updatedAt),recovered:!prior.id||!!prior.recovered};
}
function backupProjectsIndexV53(){
  try{
    const current=validProjectIndexV53(readJsonSafe(COUPANG_PROJECTS_PATH));
    if(!current||!current.projects.length)return;
    fs.mkdirSync(COUPANG_PROJECTS_BACKUP_DIR_V53,{recursive:true});
    fs.copyFileSync(COUPANG_PROJECTS_PATH,COUPANG_PROJECTS_PREV_V53);
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    fs.copyFileSync(COUPANG_PROJECTS_PATH,path.join(COUPANG_PROJECTS_BACKUP_DIR_V53,`projects-${stamp}.json`));
    const files=fs.readdirSync(COUPANG_PROJECTS_BACKUP_DIR_V53).filter(x=>/^projects-.*\.json$/.test(x)).sort();
    while(files.length>30){const old=files.shift();try{fs.rmSync(path.join(COUPANG_PROJECTS_BACKUP_DIR_V53,old),{force:true})}catch(_){}}
  }catch(e){console.warn('[v53 coupang safety] 프로젝트 인덱스 백업 실패:',e.message)}
}
function saveProjectsV18(index){
  const projects=Array.isArray(index?.projects)?index.projects:[];
  backupProjectsIndexV53();
  writeAtomic(COUPANG_PROJECTS_PATH,JSON.stringify({version:53,projects}));
  // 마지막 정상 비어있지 않은 인덱스를 별도 안전본으로 보관합니다.
  if(projects.length){try{writeAtomic(COUPANG_PROJECTS_SAFE_V53,JSON.stringify({version:53,projects}))}catch(_){}}
  try{if(typeof saveProjectRegistryV57==='function')saveProjectRegistryV57(projects)}catch(_){}
}
function recoverProjectsIndexV53(){
  ensureCoupangSharedDir();fs.mkdirSync(COUPANG_PROJECTS_DIR,{recursive:true});
  const current=validProjectIndexV53(readJsonSafe(COUPANG_PROJECTS_PATH))||{version:53,projects:[]};
  const prev=validProjectIndexV53(readJsonSafe(COUPANG_PROJECTS_PREV_V53))||{projects:[]};
  const safe=validProjectIndexV53(readJsonSafe(COUPANG_PROJECTS_SAFE_V53))||{projects:[]};
  const dirs=listProjectDirsV53();
  if(!dirs.length)return current;
  const oldMap=new Map();
  for(const src of [safe.projects,prev.projects,current.projects])for(const p of src||[]){if(p&&safeProjectIdV18(p.id))oldMap.set(p.id,{...(oldMap.get(p.id)||{}),...p})}
  const rebuilt=[];
  for(const id of dirs)rebuilt.push(deriveProjectV53(id,oldMap.get(id)||{}));
  // 인덱스에만 있고 실제 폴더가 없는 항목은 빈 유령 작업으로 만들지 않습니다.
  const changed=current.projects.length!==rebuilt.length || rebuilt.some((p,i)=>current.projects[i]?.id!==p.id || current.projects[i]?.name!==p.name || current.projects[i]?.status!==p.status);
  if(changed){
    console.warn(`[v53 coupang safety] 프로젝트 인덱스 자동 복구: ${current.projects.length}개 -> ${rebuilt.length}개 (실제 프로젝트 폴더 기준)`);
    try{saveProjectsV18({projects:rebuilt})}catch(e){console.warn('[v53 coupang safety] 복구 인덱스 저장 실패:',e.message)}
  }
  return {version:53,projects:rebuilt};
}
function readProjectsV18(){
  try{
    if(typeof mergeAllCoupangRootsV57==='function')return mergeAllCoupangRootsV57();
  }catch(e){console.warn('[v57 coupang safety] 전체 저장소 병합 실패, 현재 저장소로 폴백:',e.message)}
  return recoverProjectsIndexV53();
}
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
try{const _v53=recoverProjectsIndexV53();console.log(`[v53 coupang safety] 저장경로: ${COUPANG_SHARED_DIR} / 프로젝트 ${_v53.projects.length}개 확인`)}catch(e){console.warn('[v53 coupang safety] 시작 점검 실패:',e.message)}

function getProjectOr404V18(req,res){
  const id=safeProjectIdV18(req.params.projectId);if(!id){res.status(404).json({ok:false,error:'잘못된 작업 ID입니다.'});return null}
  const idx=migrateLegacyProjectV18(),project=idx.projects.find(x=>x.id===id);if(!project){res.status(404).json({ok:false,error:'선적 작업을 찾을 수 없습니다.'});return null}return {id,idx,project,paths:projectPathsV18(id)};
}


// =====================================================================
// v55: 쿠팡 프로젝트 '빈 목록' 방어 + 다른 저장루트 자동 구조복구
// - 현재 저장소가 비어 있어도 주변의 기존 저장소에 프로젝트 폴더가 남아 있으면 복사 복구합니다.
// - 기존 파일은 덮어쓰지 않고, 현재 저장소에 없는 프로젝트 폴더만 복사합니다.
// - 프로젝트 0개 응답에는 safety 메타데이터를 붙여 프론트가 화면을 지우지 않게 합니다.
// =====================================================================
function copyDirMissingV55(src,dst){
  try{
    if(!fs.existsSync(src))return false;
    fs.mkdirSync(dst,{recursive:true});
    let copied=false;
    for(const ent of fs.readdirSync(src,{withFileTypes:true})){
      const s=path.join(src,ent.name),d=path.join(dst,ent.name);
      if(ent.isDirectory())copied=copyDirMissingV55(s,d)||copied;
      else if(ent.isFile()&&!fs.existsSync(d)){fs.copyFileSync(s,d);copied=true}
    }
    return copied;
  }catch(e){console.warn('[v55 coupang safety] 폴더 복사 실패:',src,e.message);return false}
}
function nearbyCoupangRootsV55(){
  const found=[];const add=v=>{try{if(v){const r=path.resolve(v);if(!found.includes(r))found.push(r)}}catch(_){}};
  for(const r of (typeof PERSISTENT_ROOT_CANDIDATES_V54!=='undefined'?PERSISTENT_ROOT_CANDIDATES_V54:[]))add(r);
  add(COUPANG_SHARED_DIR);
  const starts=[__dirname,path.dirname(__dirname),process.cwd(),path.dirname(process.cwd())];
  const seen=new Set();
  function walk(dir,depth){
    try{
      dir=path.resolve(dir);if(seen.has(dir)||depth<0)return;seen.add(dir);
      const direct=path.join(dir,'data','coupang-shared');if(fs.existsSync(direct))add(direct);
      const direct2=path.join(dir,'server','data','coupang-shared');if(fs.existsSync(direct2))add(direct2);
      if(depth===0)return;
      const ents=fs.readdirSync(dir,{withFileTypes:true}).slice(0,220);
      for(const e of ents){
        if(!e.isDirectory()||['node_modules','.git','tmp','temp','logs'].includes(e.name.toLowerCase()))continue;
        const p=path.join(dir,e.name);
        if(e.name==='coupang-shared'&&path.basename(path.dirname(p))==='data')add(p);
        else walk(p,depth-1);
      }
    }catch(_){}
  }
  for(const s of starts)walk(s,2);
  return found;
}
function rootProjectScoreV55(root){
  try{
    const idx=validProjectIndexV53(readJsonSafe(path.join(root,'projects.json')))||{projects:[]};
    const pdir=path.join(root,'projects');
    const dirs=fs.existsSync(pdir)?fs.readdirSync(pdir,{withFileTypes:true}).filter(e=>e.isDirectory()&&safeProjectIdV18(e.name)).length:0;
    return {root,indexCount:idx.projects.length,dirCount:dirs,score:Math.max(idx.projects.length,dirs)};
  }catch(_){return {root,indexCount:0,dirCount:0,score:0}}
}
function recoverCoupangFromAlternateRootsV55(){
  let idx=recoverProjectsIndexV53();
  if(idx.projects.length||listProjectDirsV53().length)return {idx,recovered:false,sourceRoot:COUPANG_SHARED_DIR};
  const candidates=nearbyCoupangRootsV55().filter(r=>path.resolve(r)!==path.resolve(COUPANG_SHARED_DIR)).map(rootProjectScoreV55).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  const best=candidates[0];
  if(!best)return {idx,recovered:false,sourceRoot:''};
  console.warn(`[v55 coupang safety] 현재 저장소가 비어 있어 기존 저장소 복구 시도: ${best.root} (${best.score}개) -> ${COUPANG_SHARED_DIR}`);
  fs.mkdirSync(COUPANG_PROJECTS_DIR,{recursive:true});
  const srcProjects=path.join(best.root,'projects');
  if(fs.existsSync(srcProjects)){
    for(const ent of fs.readdirSync(srcProjects,{withFileTypes:true})){
      if(!ent.isDirectory()||!safeProjectIdV18(ent.name))continue;
      const src=path.join(srcProjects,ent.name),dst=path.join(COUPANG_PROJECTS_DIR,ent.name);
      if(!fs.existsSync(dst))copyDirMissingV55(src,dst);
    }
  }
  // 인덱스/안전본은 참고용으로만 보관하고 실제 목록은 프로젝트 폴더에서 다시 생성합니다.
  try{
    const altIdx=path.join(best.root,'projects.json');
    if(fs.existsSync(altIdx))fs.copyFileSync(altIdx,path.join(COUPANG_SHARED_DIR,'projects.v55-recovered-source.json'));
  }catch(_){}
  idx=recoverProjectsIndexV53();
  return {idx,recovered:idx.projects.length>0,sourceRoot:best.root};
}


// =====================================================================
// v57: 모든 과거 쿠팡 저장루트 병합 + 프로젝트 이름/폴더 영구 복구
// 문제: 한 저장루트에 일부 프로젝트만 남아 있으면 v55는 "비어 있지 않다"고 판단해
//      다른 루트의 최신 프로젝트를 가져오지 않았습니다.
// 해결: 서버 시작/목록 조회/저장 전마다 발견 가능한 모든 루트의 프로젝트를 ID 기준으로
//      합치고, 현재 루트에 없는 프로젝트 폴더를 복사합니다. 같은 ID가 여러 루트에 있으면
//      더 최신 파일만 안전백업 후 가져옵니다. 어떤 원본도 삭제하지 않습니다.
// =====================================================================
const V57_PROJECT_REGISTRY_FILE=path.join(AUTH_DIR_V48,'coupang-project-registry.json');
const V57_PROJECT_REGISTRY_PREV=V57_PROJECT_REGISTRY_FILE+'.prev';
function readProjectRegistryV57(){
  const x=validProjectIndexV53(readJsonSafe(V57_PROJECT_REGISTRY_FILE))||validProjectIndexV53(readJsonSafe(V57_PROJECT_REGISTRY_PREV));
  return x&&Array.isArray(x.projects)?x:{version:57,projects:[]};
}
function saveProjectRegistryV57(projects){
  try{
    fs.mkdirSync(path.dirname(V57_PROJECT_REGISTRY_FILE),{recursive:true});
    if(fs.existsSync(V57_PROJECT_REGISTRY_FILE))try{fs.copyFileSync(V57_PROJECT_REGISTRY_FILE,V57_PROJECT_REGISTRY_PREV)}catch(_){}
    const payload={version:57,updatedAt:Date.now(),projects:(projects||[]).map(p=>({id:p.id,name:p.name||'',status:p.status==='archived'?'archived':'active',createdAt:Number(p.createdAt||0),updatedAt:Number(p.updatedAt||0)}))};
    atomicJsonV48(V57_PROJECT_REGISTRY_FILE,payload);
    try{const mirror=path.join(COUPANG_SHARED_DIR,'_auth','coupang-project-registry.json');atomicJsonV48(mirror,payload)}catch(_){}
  }catch(e){console.warn('[v57 coupang safety] 프로젝트 이름 레지스트리 저장 실패:',e.message)}
}
function v57ProjectIndexAtRoot(root){
  const rows=[];
  for(const f of ['projects.json','projects.json.safe','projects.json.prev']){
    const x=validProjectIndexV53(readJsonSafe(path.join(root,f)));
    if(x&&Array.isArray(x.projects))rows.push(...x.projects);
  }
  try{
    const b=path.join(root,'_project-index-backups');
    if(fs.existsSync(b)){
      const names=fs.readdirSync(b).filter(n=>/^projects-.*\.json$/i.test(n)).sort().slice(-30);
      for(const n of names){const x=validProjectIndexV53(readJsonSafe(path.join(b,n)));if(x?.projects)rows.push(...x.projects)}
    }
  }catch(_){}
  const map=new Map();
  for(const raw of rows){
    if(!raw||!safeProjectIdV18(raw.id))continue;
    const prev=map.get(raw.id);
    const nu={...raw,id:String(raw.id),name:String(raw.name||'').trim(),status:raw.status==='archived'?'archived':'active',createdAt:Number(raw.createdAt||0),updatedAt:Number(raw.updatedAt||0)};
    if(!prev || Number(nu.updatedAt||0)>=Number(prev.updatedAt||0))map.set(nu.id,{...(prev||{}),...nu});
  }
  return map;
}
function v57ProjectDirsAtRoot(root){
  try{
    const d=path.join(root,'projects');if(!fs.existsSync(d))return [];
    return fs.readdirSync(d,{withFileTypes:true}).filter(e=>e.isDirectory()&&safeProjectIdV18(e.name)).map(e=>e.name);
  }catch(_){return []}
}
function v57FileStamp(file){
  try{
    let updated=0,size=0;const st=fs.statSync(file);size=st.size;updated=st.mtimeMs;
    if(/\.json$/i.test(file)){
      const x=readJsonSafe(file);const n=Number(x?.updatedAt||x?.savedAt||x?.state?.savedAt||0);if(n)updated=Math.max(updated,n);
    }
    return {exists:true,updated,size};
  }catch(_){return {exists:false,updated:0,size:0}}
}
function v57CopyNewerFile(src,dst){
  const a=v57FileStamp(src),b=v57FileStamp(dst);if(!a.exists||!a.size)return false;
  if(b.exists && a.updated<=b.updated+1500)return false;
  fs.mkdirSync(path.dirname(dst),{recursive:true});
  if(b.exists){
    try{fs.copyFileSync(dst,dst+'.v57-prev')}catch(_){}
  }
  fs.copyFileSync(src,dst);return true;
}
function v57MergeProjectDir(srcRoot,dstRoot,id){
  const src=path.join(srcRoot,'projects',id),dst=path.join(dstRoot,'projects',id);if(!fs.existsSync(src))return false;
  fs.mkdirSync(dst,{recursive:true});let changed=false;
  for(const rel of ['state.json','source.xlsx.bin','source.meta.json','workbookSnapshot.xlsx.bin','workbookSnapshot.meta.json']){
    try{changed=v57CopyNewerFile(path.join(src,rel),path.join(dst,rel))||changed}catch(_){}
  }
  // 미래 버전에서 추가된 파일도 현재 폴더에 없다면 보존용으로 복사합니다.
  try{
    for(const ent of fs.readdirSync(src,{withFileTypes:true})){
      if(!ent.isFile())continue;const d=path.join(dst,ent.name);if(!fs.existsSync(d)){fs.copyFileSync(path.join(src,ent.name),d);changed=true}
    }
  }catch(_){}
  return changed;
}
function v57AllCoupangRoots(){
  const roots=[];const add=v=>{try{if(v){const r=path.resolve(v);if(!roots.includes(r))roots.push(r)}}catch(_){}};
  for(const r of nearbyCoupangRootsV55())add(r);add(COUPANG_SHARED_DIR);
  // 이전 버전이 기록해 둔 선택경로/병합경로 힌트도 계속 따라갑니다.
  for(let round=0;round<3;round++){
    for(const root of [...roots]){
      for(const f of [path.join(root,'coupang-storage-location.json'),path.join(root,'_auth','coupang-storage-location.json'),path.join(root,'_auth','storage-location.json')]){
        try{
          const x=readJsonSafe(f);if(!x)continue;
          add(x.selectedRoot);add(x.coupangRoot);add(x.storageRoot);
          for(const row of x.sourceRoots||[])add(typeof row==='string'?row:row?.root);
        }catch(_){}
      }
    }
  }
  return roots;
}
function v57DeletedProjectIds(){
  const ids=new Set();
  try{
    if(fs.existsSync(COUPANG_PROJECTS_TRASH_V53)){
      for(const e of fs.readdirSync(COUPANG_PROJECTS_TRASH_V53,{withFileTypes:true})){
        if(!e.isDirectory())continue;const m=e.name.match(/^([A-Za-z0-9_-]{3,80})_\d+$/);if(m)ids.add(m[1]);
      }
    }
  }catch(_){}
  return [...ids];
}
function mergeAllCoupangRootsV57(){
  ensureCoupangSharedDir();fs.mkdirSync(COUPANG_PROJECTS_DIR,{recursive:true});
  const roots=v57AllCoupangRoots();if(!roots.includes(COUPANG_SHARED_DIR))roots.unshift(COUPANG_SHARED_DIR);
  const deleted=new Set(v57DeletedProjectIds());
  const meta=new Map();const sources=[];
  const registry=readProjectRegistryV57();
  for(const p of registry.projects||[]){if(p&&safeProjectIdV18(p.id)&&!deleted.has(p.id))meta.set(p.id,p)}
  for(const root of roots){
    const idx=v57ProjectIndexAtRoot(root),dirs=v57ProjectDirsAtRoot(root);if(!idx.size&&!dirs.length)continue;
    sources.push({root,indexCount:idx.size,dirCount:dirs.length});
    for(const [id,p] of idx){if(deleted.has(id))continue;const old=meta.get(id);if(!old||Number(p.updatedAt||0)>=Number(old.updatedAt||0))meta.set(id,p)}
    for(const id of dirs){
      if(deleted.has(id))continue;
      try{v57MergeProjectDir(root,COUPANG_SHARED_DIR,id)}catch(e){console.warn('[v57 coupang safety] 프로젝트 병합 실패',id,root,e.message)}
      if(!meta.has(id))meta.set(id,{id,name:'',status:'active',createdAt:0,updatedAt:0});
    }
  }
  // 현재 저장소의 실제 폴더를 기준으로 최종 목록을 만들되, 모든 과거 인덱스의 이름/상태를 보존합니다.
  const currentDirs=listProjectDirsV53();const rows=[];
  for(const id of currentDirs){if(deleted.has(id))continue;rows.push(deriveProjectV53(id,meta.get(id)||{}))}
  rows.sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0));
  const current=validProjectIndexV53(readJsonSafe(COUPANG_PROJECTS_PATH))||{projects:[]};
  const sig=a=>(a||[]).map(x=>`${x.id}|${x.name}|${x.status}|${Number(x.updatedAt||0)}`).sort().join('\n');
  if(sig(current.projects)!==sig(rows)){
    console.warn(`[v57 coupang safety] 전체 저장소 병합: ${current.projects.length}개 -> ${rows.length}개 / 저장소 ${sources.length}곳`);
    saveProjectsV18({version:57,projects:rows});
  }else{
    saveProjectRegistryV57(rows);
  }
  try{writeAtomic(path.join(COUPANG_SHARED_DIR,'coupang-storage-location.json'),JSON.stringify({version:60,selectedRoot:COUPANG_SHARED_DIR,projectCount:rows.length,sourceRoots:sources,checkedAt:Date.now()}))}catch(_){}
  return {version:57,projects:rows,_v57:{sourceRoots:sources,deletedIds:[...deleted]}};
}
function v57ProjectAudit(){
  const roots=v57AllCoupangRoots();if(!roots.includes(COUPANG_SHARED_DIR))roots.unshift(COUPANG_SHARED_DIR);
  return roots.map(root=>{
    const idx=v57ProjectIndexAtRoot(root),dirs=v57ProjectDirsAtRoot(root);const names=[];
    for(const [id,p] of idx)names.push({id,name:p.name||'',updatedAt:Number(p.updatedAt||0)});
    for(const id of dirs)if(!idx.has(id))names.push({id,name:'(폴더만 발견)',updatedAt:0});
    return {root,indexCount:idx.size,dirCount:dirs.length,projects:names.sort((a,b)=>b.updatedAt-a.updatedAt)};
  }).filter(x=>x.indexCount||x.dirCount);
}
try{const _v57=mergeAllCoupangRootsV57();console.log(`[v57 coupang safety] 전체 저장소 병합 완료: ${_v57.projects.length}개`)}catch(e){console.warn('[v57 coupang safety] 시작 병합 실패:',e.message)}

app.get('/api/coupang-shared/project-audit',coupangAuth,(req,res)=>{
  if(!req.authUser||!req.authUser.legacyOwner||req.authUser.role!=='admin')return res.status(403).json({ok:false,error:'기존 관리자 계정만 확인할 수 있습니다.'});
  const idx=mergeAllCoupangRootsV57();res.set('Cache-Control','no-store');res.json({ok:true,version:57,storageRoot:COUPANG_SHARED_DIR,mergedCount:idx.projects.length,deletedIds:v57DeletedProjectIds(),stores:v57ProjectAudit()});
});

app.get('/api/coupang-shared/safety-status',coupangAuth,(req,res)=>{
  if(!req.authUser||req.authUser.role!=='admin')return res.status(403).json({ok:false,error:'관리자만 확인할 수 있습니다.'});
  const idx=recoverProjectsIndexV53();
  res.set('Cache-Control','no-store');
  const alt=nearbyCoupangRootsV55().map(rootProjectScoreV55).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,10);res.json({ok:true,version:55,storageRoot:COUPANG_SHARED_DIR,indexCount:idx.projects.length,projectFolderCount:listProjectDirsV53().length,indexExists:fs.existsSync(COUPANG_PROJECTS_PATH),prevBackupExists:fs.existsSync(COUPANG_PROJECTS_PREV_V53),safeBackupExists:fs.existsSync(COUPANG_PROJECTS_SAFE_V53),candidateStores:alt});
});

app.get('/api/coupang-shared/projects',coupangAuth,(req,res)=>{
  const idx=mergeAllCoupangRootsV57();
  const rows=[...(idx.projects||[])].sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0));
  res.set('Cache-Control','no-store');
  res.json({ok:true,projects:rows,safety:{version:57,empty:rows.length===0,storageRoot:COUPANG_SHARED_DIR,projectFolderCount:listProjectDirsV53().length,mergedAcrossRoots:true,sourceRoots:idx._v57?.sourceRoots||[],deletedProjectIds:idx._v57?.deletedIds||[]}});
});
app.post('/api/coupang-shared/projects',coupangAuth,(req,res)=>{
  try{const idx=migrateLegacyProjectV18(),id=newProjectIdV18(),now=Date.now(),name=String(req.body?.name||'').trim().slice(0,120)||`새 선적 작업 ${new Date().toLocaleDateString('ko-KR')}`;const p={id,name,status:'active',createdAt:now,updatedAt:now};fs.mkdirSync(projectPathsV18(id).dir,{recursive:true});idx.projects.push(p);saveProjectsV18(idx);res.json({ok:true,project:p})}catch(err){res.status(500).json({ok:false,error:err.message})}
});
app.patch('/api/coupang-shared/projects/:projectId',coupangAuth,(req,res)=>{
  try{const found=getProjectOr404V18(req,res);if(!found)return;const {idx,project}=found;if(req.body?.name!==undefined){const n=String(req.body.name||'').trim().slice(0,120);if(n)project.name=n}if(req.body?.status!==undefined){const s=String(req.body.status);if(!['active','archived'].includes(s))return res.status(400).json({ok:false,error:'지원하지 않는 상태입니다.'});project.status=s}project.updatedAt=Date.now();saveProjectsV18(idx);res.json({ok:true,project})}catch(err){res.status(500).json({ok:false,error:err.message})}
});
app.delete('/api/coupang-shared/projects/:projectId',coupangAuth,(req,res)=>{
  try{
    const found=getProjectOr404V18(req,res);if(!found)return;const {id,idx,paths}=found;
    // v53: 삭제 버튼을 눌러도 프로젝트 폴더는 즉시 영구삭제하지 않고 휴지통으로 이동합니다.
    if(fs.existsSync(paths.dir)){
      fs.mkdirSync(COUPANG_PROJECTS_TRASH_V53,{recursive:true});
      const target=path.join(COUPANG_PROJECTS_TRASH_V53,`${id}_${Date.now()}`);
      try{fs.renameSync(paths.dir,target)}catch(e){fs.cpSync(paths.dir,target,{recursive:true});fs.rmSync(paths.dir,{recursive:true,force:true})}
    }
    idx.projects=idx.projects.filter(x=>x.id!==id);saveProjectsV18(idx);res.json({ok:true,safetyTrash:true})
  }catch(err){res.status(500).json({ok:false,error:err.message})}
});

app.get('/api/coupang-shared/projects/:projectId/status',coupangAuth,(req,res)=>{const found=getProjectOr404V18(req,res);if(!found)return;const {paths}=found;res.set('Cache-Control','no-store');res.json({ok:true,state:projectStateStatusV18(paths),source:projectBlobStatusV18(paths,'source'),workbookSnapshot:projectBlobStatusV18(paths,'workbookSnapshot')})});
app.get('/api/coupang-shared/projects/:projectId/state',coupangAuth,(req,res)=>{const found=getProjectOr404V18(req,res);if(!found)return;const row=readJsonSafe(found.paths.state);if(!row)return res.status(404).json({ok:false,error:'저장된 작업 상태가 없습니다.'});res.set('Cache-Control','no-store');res.set('X-Updated-At',String(row.updatedAt||0));res.json(row)});
app.put('/api/coupang-shared/projects/:projectId/state',coupangAuth,express.text({type:['text/plain','application/json'],limit:'15mb'}),(req,res)=>{
  try{const found=getProjectOr404V18(req,res);if(!found)return;const state=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{}),updatedAt=Date.now();backupFileV46(found.paths.state);writeAtomic(found.paths.state,JSON.stringify({ok:true,updatedAt,state}));touchProjectV18(found.id);res.set('Cache-Control','no-store');res.json({ok:true,updatedAt})}catch(err){res.status(400).json({ok:false,error:`작업 상태 저장 실패: ${err.message}`})}
});
app.delete('/api/coupang-shared/projects/:projectId/state',coupangAuth,(req,res)=>{const found=getProjectOr404V18(req,res);if(!found)return;try{unlinkSafe(found.paths.state);touchProjectV18(found.id);res.json({ok:true})}catch(err){res.status(500).json({ok:false,error:err.message})}});

app.get('/api/coupang-shared/projects/:projectId/blob/:key',coupangAuth,(req,res)=>{
  const found=getProjectOr404V18(req,res);if(!found)return;const key=req.params.key;if(!['source','workbookSnapshot'].includes(key))return res.status(404).json({ok:false,error:'지원하지 않는 파일 키입니다.'});const info=found.paths[key],meta=readJsonSafe(info.meta);if(!meta||!fs.existsSync(info.data))return res.status(404).json({ok:false,error:'저장된 파일이 없습니다.'});res.set('Cache-Control','no-store');res.set('Content-Type',meta.type||'application/octet-stream');res.set('X-Updated-At',String(meta.updatedAt||0));res.set('X-File-Name',String(meta.name||''));res.set('X-File-Type',String(meta.type||''));res.set('X-File-Mode',String(meta.mode||''));res.set('X-Saved-At',String(meta.savedAt||meta.updatedAt||0));res.sendFile(info.data)
});
app.put('/api/coupang-shared/projects/:projectId/blob/:key',coupangAuth,express.raw({type:'application/octet-stream',limit:'80mb'}),(req,res)=>{
  try{const found=getProjectOr404V18(req,res);if(!found)return;const key=req.params.key;if(!['source','workbookSnapshot'].includes(key))return res.status(404).json({ok:false,error:'지원하지 않는 파일 키입니다.'});const info=found.paths[key],body=Buffer.isBuffer(req.body)?req.body:Buffer.from(req.body||'');if(!body.length)return res.status(400).json({ok:false,error:'빈 파일은 저장할 수 없습니다.'});const updatedAt=Date.now(),meta={updatedAt,size:body.length,name:String(req.get('X-File-Name')||''),type:String(req.get('X-File-Type')||''),mode:String(req.get('X-File-Mode')||''),savedAt:Number(req.get('X-Saved-At')||updatedAt)};backupFileV46(info.data);backupFileV46(info.meta);writeAtomic(info.data,body);writeAtomic(info.meta,JSON.stringify(meta));if(key==='source'){backupFileV46(found.paths.state);backupFileV46(found.paths.workbookSnapshot.data);backupFileV46(found.paths.workbookSnapshot.meta);unlinkSafe(found.paths.state);unlinkSafe(found.paths.workbookSnapshot.data);unlinkSafe(found.paths.workbookSnapshot.meta)}touchProjectV18(found.id);res.set('Cache-Control','no-store');res.json({ok:true,updatedAt,size:body.length})}catch(err){res.status(500).json({ok:false,error:`공용 파일 저장 실패: ${err.message}`})}
});
app.delete('/api/coupang-shared/projects/:projectId/blob/:key',coupangAuth,(req,res)=>{const found=getProjectOr404V18(req,res);if(!found)return;const key=req.params.key;if(!['source','workbookSnapshot'].includes(key))return res.status(404).json({ok:false,error:'지원하지 않는 파일 키입니다.'});try{unlinkSafe(found.paths[key].data);unlinkSafe(found.paths[key].meta);touchProjectV18(found.id);res.json({ok:true})}catch(err){res.status(500).json({ok:false,error:err.message})}});

// 확장자 없는 주소도 지원: https://tool.dasaba.co.kr/coupang-inbound-work
app.get('/coupang-inbound-work', (req, res) => {
  res.sendFile(path.join(__dirname, 'coupang-inbound-work.html'));
});




// =====================================================================
// v48: 비-기존계정 API 분리 저장소 인터셉터
// 최초 관리자(legacyOwner)는 기존 API/파일을 그대로 통과시킵니다.
// =====================================================================
function userJsonV48(req,...parts){const root=ensureUserRootV48(req);return path.join(root,...parts)}
function sendJsonFileV48(res,file){const row=readJsonFileV48(file,null);res.set('Cache-Control','no-store');if(!row)return res.status(404).json({ok:false,error:'저장된 작업이 없습니다.'});res.json(row)}
async function rawBodyV48(req){if(Buffer.isBuffer(req.body))return req.body;if(typeof req.body==='string')return Buffer.from(req.body);if(req.body&&typeof req.body==='object'&&Object.keys(req.body).length)return Buffer.from(JSON.stringify(req.body));return await new Promise((resolve,reject)=>{const a=[];req.on('data',c=>a.push(c));req.on('end',()=>resolve(Buffer.concat(a)));req.on('error',reject)})}

// 계정별 현재 작업 상태. detail-maker는 최초 관리자도 이 저장소를 사용합니다.
app.use('/api/shared-workspace/:key',(req,res,next)=>{
  const key=String(req.params.key||'');
  if(!req.authUser)return next();
  if(req.authUser.legacyOwner && key!=='detail-maker')return next();
  if(!['barcode-label','order-barcode','detail-maker'].includes(key))return next();
  const base=req.authUser.legacyOwner?path.join(__dirname,'data','users',req.authUser.id):ensureUserRootV48(req);const file=path.join(base,'workspaces',key+'.json');
  if(req.method==='GET')return sendJsonFileV48(res,file);
  if(req.method==='DELETE'){try{fs.rmSync(file,{force:true});return res.json({ok:true})}catch(e){return res.status(500).json({ok:false,error:e.message})}}
  if(req.method==='PUT'||req.method==='POST'){try{const state=req.body?.state??req.body;if(!state||typeof state!=='object')return res.status(400).json({ok:false,error:'저장할 작업 상태가 없습니다.'});const updatedAt=Date.now();atomicJsonV48(file,{ok:true,key,updatedAt,state});return res.json({ok:true,key,updatedAt})}catch(e){return res.status(400).json({ok:false,error:e.message})}}
  next();
});

// 계정별 바코드 라벨. 최초 관리자는 기존 Supabase/라벨 파일을 그대로 사용합니다.
app.use('/api/shared-labels',(req,res,next)=>{
  if(!req.authUser||req.authUser.legacyOwner)return next();
  const file=userJsonV48(req,'shared-barcode','labels.json');
  const read=()=>{const x=readJsonFileV48(file,[]);return Array.isArray(x)?x:[]};
  const write=x=>atomicJsonV48(file,x);
  if(req.path==='/status'&&req.method==='GET'){const a=read();return res.json({ok:true,count:a.length,storage:'account-private',permanent:true,supabaseConfigured:false})}
  if(req.path==='/backup'&&req.method==='GET'){const a=read();res.set('Content-Disposition','attachment; filename="my-labels.json"');return res.json({exportedAt:new Date().toISOString(),labels:a})}
  if(req.path==='/restore'&&req.method==='POST'){const incoming=Array.isArray(req.body)?req.body:req.body?.labels;if(!Array.isArray(incoming))return res.status(400).json({ok:false,error:'라벨 데이터가 없습니다.'});const a=read();for(const raw of incoming){try{upsertLocalLabelV32(a,raw)}catch(_){}}write(a);return res.json({ok:true,restored:incoming.length,count:a.length,storage:'account-private',permanent:true})}
  if((req.path==='/'||req.path==='')&&req.method==='GET'){const a=read();return res.json({ok:true,labels:a,count:a.length,editKeyRequired:false,permanent:true,storage:'account-private'})}
  if((req.path==='/'||req.path==='')&&req.method==='POST'){try{const a=read(),label=upsertLocalLabelV32(a,req.body||{});write(a);return res.json({ok:true,label,count:a.length,storage:'account-private',permanent:true})}catch(e){return res.status(400).json({ok:false,error:e.message})}}
  if(req.method==='DELETE'&&/^\/[A-Za-z0-9_-]+/.test(req.path)){const id=decodeURIComponent(req.path.slice(1)),a=read(),b=a.filter(x=>String(x.id||'')!==id);if(a.length===b.length)return res.status(404).json({ok:false,error:'라벨을 찾지 못했습니다.'});write(b);return res.json({ok:true,count:b.length})}
  next();
});


// shared-labels-status / backup / restore는 하이픈형 별도 경로라 추가로 분리합니다.
app.use('/api/shared-labels-status',(req,res,next)=>{if(!req.authUser||req.authUser.legacyOwner)return next();const file=userJsonV48(req,'shared-barcode','labels.json'),a=readJsonFileV48(file,[]);res.json({ok:true,count:Array.isArray(a)?a.length:0,storage:'account-private',permanent:true,supabaseConfigured:false,localSources:[]})});
app.use('/api/shared-labels-backup',(req,res,next)=>{if(!req.authUser||req.authUser.legacyOwner)return next();const file=userJsonV48(req,'shared-barcode','labels.json'),a=readJsonFileV48(file,[]);res.set('Content-Disposition','attachment; filename="my-labels.json"');res.json({exportedAt:new Date().toISOString(),labels:Array.isArray(a)?a:[]})});
app.use('/api/shared-labels-restore',(req,res,next)=>{if(!req.authUser||req.authUser.legacyOwner)return next();if(req.method!=='POST')return next();const file=userJsonV48(req,'shared-barcode','labels.json'),a0=readJsonFileV48(file,[]),a=Array.isArray(a0)?a0:[],incoming=Array.isArray(req.body)?req.body:req.body?.labels;if(!Array.isArray(incoming))return res.status(400).json({ok:false,error:'라벨 데이터가 없습니다.'});for(const raw of incoming){try{upsertLocalLabelV32(a,raw)}catch(_){}}atomicJsonV48(file,a);res.json({ok:true,restored:incoming.length,count:a.length,storage:'account-private',permanent:true})});

// 계정별 선적 리스트 보관함. 최초 관리자는 기존 보관함을 그대로 사용합니다.
app.use('/api/shipment-list-vault',(req,res,next)=>{
  if(!req.authUser||req.authUser.legacyOwner)return next();
  const root=userJsonV48(req,'shipment-list-vault'),indexFile=path.join(root,'index.json');
  const readIdx=()=>{const x=readJsonFileV48(indexFile,{drafts:[]});return x&&Array.isArray(x.drafts)?x:{drafts:[]}};const saveIdx=x=>atomicJsonV48(indexFile,{version:48,drafts:x.drafts||[]});
  const m=req.path.match(/^\/([^/]+)(?:\/(blob))?$/);if((req.path==='/'||req.path==='')&&req.method==='GET'){const x=readIdx();return res.json({ok:true,drafts:[...x.drafts].sort((a,b)=>Number(b.savedAt||0)-Number(a.savedAt||0))})}if(!m)return next();
  const id=String(m[1]||'').replace(/[^A-Za-z0-9_-]/g,'');if(!id)return res.status(404).json({ok:false,error:'잘못된 ID입니다.'});const dir=path.join(root,'drafts',id),metaFile=path.join(dir,'meta.json'),blobFile=path.join(dir,'source.xlsx.bin');
  if(m[2]==='blob'){
    if(req.method==='GET'){const meta=readJsonFileV48(metaFile,{});if(!fs.existsSync(blobFile))return res.status(404).json({ok:false,error:'원본 엑셀이 없습니다.'});res.set('Content-Type',meta.fileType||'application/octet-stream');res.set('X-File-Name',encodeURIComponent(meta.fileName||'선적리스트.xlsx'));return res.sendFile(blobFile)}
    if(req.method==='PUT')return rawBodyV48(req).then(buf=>{if(!buf.length)return res.status(400).json({ok:false,error:'빈 파일입니다.'});fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(blobFile,buf);const idx=readIdx(),row=idx.drafts.find(x=>x.id===id);if(row)row.blobSize=buf.length;saveIdx(idx);res.json({ok:true,size:buf.length,updatedAt:Date.now()})}).catch(e=>res.status(500).json({ok:false,error:e.message}));
  }
  if(req.method==='GET'){const meta=readJsonFileV48(metaFile,null);if(!meta)return res.status(404).json({ok:false,error:'보관본을 찾지 못했습니다.'});return res.json({ok:true,draft:meta})}
  if(req.method==='PUT'){const now=Date.now(),meta={...(req.body||{}),id,savedAt:Number(req.body?.savedAt||now),createdAt:Number(req.body?.createdAt||now)};atomicJsonV48(metaFile,meta);const idx=readIdx(),summary={id,name:meta.name,fileName:meta.fileName,fileType:meta.fileType,confirmed:!!meta.confirmed,createdAt:meta.createdAt,savedAt:meta.savedAt,transferredAt:Number(meta.transferredAt||0),transferredProjectId:meta.transferredProjectId||'',transferredProjectName:meta.transferredProjectName||'',inputNamesV41:meta.inputNamesV41||[],blobSize:fs.existsSync(blobFile)?fs.statSync(blobFile).size:0};const at=idx.drafts.findIndex(x=>x.id===id);if(at>=0)idx.drafts[at]=summary;else idx.drafts.push(summary);saveIdx(idx);return res.json({ok:true,draft:summary,updatedAt:now})}
  if(req.method==='DELETE'){fs.rmSync(dir,{recursive:true,force:true});const idx=readIdx();idx.drafts=idx.drafts.filter(x=>x.id!==id);saveIdx(idx);return res.json({ok:true})}
  next();
});

// 계정별 쿠팡 선적 프로젝트. 최초 관리자는 기존 프로젝트 저장소를 그대로 사용합니다.
app.use('/api/coupang-shared',(req,res,next)=>{
  if(!req.authUser||req.authUser.legacyOwner)return next();
  const root=userJsonV48(req,'coupang-shared');fs.mkdirSync(root,{recursive:true});const idxFile=path.join(root,'projects.json'),pRoot=path.join(root,'projects');
  const readIdx=()=>{const x=readJsonFileV48(idxFile,{projects:[]});return x&&Array.isArray(x.projects)?x:{projects:[]}};const saveIdx=x=>atomicJsonV48(idxFile,{version:48,projects:x.projects||[]});const newId=()=>`p_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;const pp=id=>{const dir=path.join(pRoot,id);return{dir,state:path.join(dir,'state.json'),source:{data:path.join(dir,'source.xlsx.bin'),meta:path.join(dir,'source.meta.json')},workbookSnapshot:{data:path.join(dir,'workbookSnapshot.xlsx.bin'),meta:path.join(dir,'workbookSnapshot.meta.json')}}};
  const touch=id=>{const idx=readIdx(),p=idx.projects.find(x=>x.id===id);if(p){p.updatedAt=Date.now();saveIdx(idx)}return p};
  if(req.path==='/projects'&&req.method==='GET'){const idx=readIdx();return res.json({ok:true,projects:[...idx.projects].sort((a,b)=>b.updatedAt-a.updatedAt)})}
  if(req.path==='/projects'&&req.method==='POST'){const idx=readIdx(),id=newId(),now=Date.now(),p={id,name:String(req.body?.name||'새 선적 작업').slice(0,120),status:'active',createdAt:now,updatedAt:now};fs.mkdirSync(pp(id).dir,{recursive:true});idx.projects.push(p);saveIdx(idx);return res.json({ok:true,project:p})}
  const m=req.path.match(/^\/projects\/([A-Za-z0-9_-]+)(?:\/(status|state|blob\/source|blob\/workbookSnapshot))?$/);if(!m)return next();const id=m[1],part=m[2]||'',idx=readIdx(),proj=idx.projects.find(x=>x.id===id);if(!proj)return res.status(404).json({ok:false,error:'선적 작업을 찾을 수 없습니다.'});const paths=pp(id);
  if(!part){if(req.method==='PATCH'){if(req.body?.name!==undefined)proj.name=String(req.body.name||proj.name).slice(0,120);if(req.body?.status!==undefined)proj.status=req.body.status==='archived'?'archived':'active';proj.updatedAt=Date.now();saveIdx(idx);return res.json({ok:true,project:proj})}if(req.method==='DELETE'){fs.rmSync(paths.dir,{recursive:true,force:true});idx.projects=idx.projects.filter(x=>x.id!==id);saveIdx(idx);return res.json({ok:true})}}
  if(part==='status'&&req.method==='GET'){const st=readJsonFileV48(paths.state,null),bs=k=>{const meta=readJsonFileV48(paths[k].meta,null);return meta&&fs.existsSync(paths[k].data)?{updatedAt:Number(meta.updatedAt||0),size:Number(meta.size||0),name:meta.name||''}:null};return res.json({ok:true,state:st?{updatedAt:Number(st.updatedAt||0)}:null,source:bs('source'),workbookSnapshot:bs('workbookSnapshot')})}
  if(part==='state'){
    if(req.method==='GET'){const st=readJsonFileV48(paths.state,null);if(!st)return res.status(404).json({ok:false,error:'저장 상태가 없습니다.'});res.set('X-Updated-At',String(st.updatedAt||0));return res.json(st)}
    if(req.method==='DELETE'){fs.rmSync(paths.state,{force:true});touch(id);return res.json({ok:true})}
    if(req.method==='PUT')return rawBodyV48(req).then(buf=>{let state={};try{state=JSON.parse(buf.toString('utf8')||'{}')}catch(_){state=req.body||{}}const updatedAt=Date.now();atomicJsonV48(paths.state,{ok:true,updatedAt,state});touch(id);res.json({ok:true,updatedAt})}).catch(e=>res.status(400).json({ok:false,error:e.message}));
  }
  if(part.startsWith('blob/')){const key=part.split('/')[1],info=paths[key];if(!info)return res.status(404).json({ok:false,error:'파일 키 오류'});if(req.method==='GET'){const meta=readJsonFileV48(info.meta,null);if(!meta||!fs.existsSync(info.data))return res.status(404).json({ok:false,error:'저장된 파일이 없습니다.'});res.set('Content-Type',meta.type||'application/octet-stream');res.set('X-Updated-At',String(meta.updatedAt||0));res.set('X-File-Name',meta.name||'');res.set('X-File-Type',meta.type||'');res.set('X-File-Mode',meta.mode||'');res.set('X-Saved-At',String(meta.savedAt||meta.updatedAt||0));return res.sendFile(info.data)}if(req.method==='DELETE'){fs.rmSync(info.data,{force:true});fs.rmSync(info.meta,{force:true});touch(id);return res.json({ok:true})}if(req.method==='PUT')return rawBodyV48(req).then(buf=>{if(!buf.length)return res.status(400).json({ok:false,error:'빈 파일입니다.'});fs.mkdirSync(paths.dir,{recursive:true});const updatedAt=Date.now(),meta={updatedAt,size:buf.length,name:String(req.get('X-File-Name')||''),type:String(req.get('X-File-Type')||''),mode:String(req.get('X-File-Mode')||''),savedAt:Number(req.get('X-Saved-At')||updatedAt)};fs.writeFileSync(info.data,buf);atomicJsonV48(info.meta,meta);if(key==='source'){fs.rmSync(paths.state,{force:true});fs.rmSync(paths.workbookSnapshot.data,{force:true});fs.rmSync(paths.workbookSnapshot.meta,{force:true})}touch(id);res.json({ok:true,updatedAt,size:buf.length})}).catch(e=>res.status(500).json({ok:false,error:e.message}));}
  next();
});

// =====================================================================
// v32 공용 바코드 라벨 보관함 - 안전 복원
// - 쿠팡 선적 작업 API/저장경로는 위 코드를 그대로 사용합니다.
// - 상품 기준목록(product catalog)은 라벨 복구에 절대 섞지 않습니다.
// - Supabase public.shared_labels가 있으면 우선 사용합니다.
// - Supabase가 비어 있거나 미설정이면, '라벨 전용 파일명'의 기존 저장소만 확인합니다.
// =====================================================================
const SHARED_LABEL_DIR = path.join(TRADECODE_PERSIST_ROOT_V60, 'shared-barcode');
const SHARED_LABELS_PATH = process.env.SHARED_LABELS_PATH || path.join(SHARED_LABEL_DIR, 'labels.json');
const PRODUCT_CATALOG_PATH = path.join(SHARED_LABEL_DIR, 'product-catalog.json');
const LABEL_EDIT_KEY = String(process.env.SHARED_LABEL_EDIT_KEY || process.env.LABEL_EDIT_KEY || '').trim();
const SUPABASE_URL = String(
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_PROJECT_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL || ''
).replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_KEY || ''
).trim();
const SUPABASE_LABELS_ENABLED = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

function ensureSharedLabelDirV32(filePath=SHARED_LABELS_PATH){
  fs.mkdirSync(path.dirname(filePath),{recursive:true});
}
function rawArrayV32(filePath){
  try{
    if(!filePath || !fs.existsSync(filePath)) return [];
    const parsed=JSON.parse(fs.readFileSync(filePath,'utf8')||'[]');
    return Array.isArray(parsed)?parsed:(Array.isArray(parsed?.labels)?parsed.labels:(Array.isArray(parsed?.items)?parsed.items:[]));
  }catch(err){ console.warn('[공용 라벨] 파일 읽기 실패:',filePath,err.message); return []; }
}
function looksLikeActualSavedLabelV32(x){
  if(!x || typeof x!=='object') return false;
  if(!String(x.barcode||'').trim() && !String(x.productNumber||x.product_number||'').trim()) return false;
  const labelOnlyKeys=['optionText','option_text','material','importer','address','phone','warning','age','country','labelWidth','label_width','labelHeight','label_height','titleFont','title_font','bodyFont','body_font','barcodeHeight','barcode_height','barcodeTextFont','barcode_text_font','madeInFont','made_in_font'];
  return labelOnlyKeys.some(k => Object.prototype.hasOwnProperty.call(x,k));
}
function cleanLabelV32(raw={}){
  const text=(v,max=2000)=>String(v??'').slice(0,max);
  const num=(v,f)=>{const n=Number(v);return Number.isFinite(n)?n:f};
  return {
    id:text(raw.id,100),
    productNumber:text(raw.productNumber ?? raw.product_number,120).trim(),
    barcode:text(raw.barcode,160).trim(),
    productName:text(raw.productName ?? raw.product_name,1000),
    optionText:text(raw.optionText ?? raw.option_text,1000),
    material:text(raw.material,1000), importer:text(raw.importer,1000), address:text(raw.address,1500), phone:text(raw.phone,300), warning:text(raw.warning,2000),
    age:text(raw.age,500), country:text(raw.country,500),
    labelWidth:num(raw.labelWidth ?? raw.label_width,50), labelHeight:num(raw.labelHeight ?? raw.label_height,60),
    titleFont:num(raw.titleFont ?? raw.title_font,18), bodyFont:num(raw.bodyFont ?? raw.body_font,14), barcodeHeight:num(raw.barcodeHeight ?? raw.barcode_height,16),
    barcodeTextFont:num(raw.barcodeTextFont ?? raw.barcode_text_font,12), madeInFont:num(raw.madeInFont ?? raw.made_in_font,8),
    createdAt:text(raw.createdAt ?? raw.created_at,100), updatedAt:text(raw.updatedAt ?? raw.updated_at,100)
  };
}
function readActualLabelFileV32(filePath){
  return rawArrayV32(filePath).filter(looksLikeActualSavedLabelV32).map(cleanLabelV32);
}
function writeLabelFileV32(filePath,arr){
  ensureSharedLabelDirV32(filePath);
  const tmp=`${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp,JSON.stringify(arr,null,2),'utf8');
  fs.renameSync(tmp,filePath);
}
function requireLabelEditKeyV32(req,res,next){
  if(req.authUser) return next();
  if(!LABEL_EDIT_KEY) return next();
  const supplied=String(req.get('x-label-edit-key')||'').trim();
  if(supplied!==LABEL_EDIT_KEY) return res.status(403).json({ok:false,code:'EDIT_KEY_REQUIRED',error:'공용 라벨 관리코드가 필요합니다.'});
  next();
}
function labelIdentityV32(x){
  const bc=String(x.barcode||'').trim().toUpperCase();
  if(bc) return `B:${bc}`;
  const pn=String(x.productNumber||'').trim();
  return pn?`P:${pn}`:'';
}
function mergeLabelsV32(groups){
  const map=new Map();
  for(const arr of groups){
    for(const raw of (Array.isArray(arr)?arr:[])){
      const x=cleanLabelV32(raw), key=labelIdentityV32(x);
      if(!key) continue;
      const old=map.get(key);
      if(!old || String(x.updatedAt||'') >= String(old.updatedAt||'')) map.set(key,x);
    }
  }
  return [...map.values()].sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
}
function upsertLocalLabelV32(labels,raw){
  const item=cleanLabelV32(raw); if(!item.barcode&&!item.productNumber) throw new Error('바코드 또는 상품번호가 필요합니다.');
  let idx=-1;
  if(item.id) idx=labels.findIndex(x=>String(x.id||'')===item.id);
  if(idx<0&&item.barcode) idx=labels.findIndex(x=>String(x.barcode||'').trim().toUpperCase()===item.barcode.toUpperCase());
  if(idx<0&&item.productNumber) idx=labels.findIndex(x=>String(x.productNumber||'').trim()===item.productNumber);
  const now=new Date().toISOString();
  if(idx>=0){ item.id=labels[idx].id||item.id||`lbl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`; labels[idx]={...labels[idx],...item,updatedAt:now}; return labels[idx]; }
  item.id=item.id||`lbl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`; item.createdAt=item.createdAt||now; item.updatedAt=now; labels.push(item); return item;
}
function localLabelCandidatesV32(){
  const c=[
    process.env.SHARED_LABELS_PATH || '',
    SHARED_LABELS_PATH,
    path.join(__dirname,'data','shared-barcode','labels.json'),
    path.join(__dirname,'shared-barcode','labels.json'),
    path.join(__dirname,'data','shared-labels.json'),
    path.join(__dirname,'shared-labels.json'),
    path.join(path.dirname(COUPANG_SHARED_DIR),'shared-barcode','labels.json'),
    path.join(path.dirname(COUPANG_SHARED_DIR),'shared-labels.json'),
    path.join(COUPANG_SHARED_DIR,'shared-barcode','labels.json')
  ].filter(Boolean).map(p=>path.resolve(p));
  return [...new Set(c)];
}
function localLabelSourcesV32(){
  return localLabelCandidatesV32().map((filePath,i)=>({filePath,labels:readActualLabelFileV32(filePath),index:i})).filter(x=>x.labels.length>0);
}
function bestLocalLabelStoreV32(){
  const sources=localLabelSourcesV32().sort((a,b)=>b.labels.length-a.labels.length || a.index-b.index);
  if(sources.length) return sources[0];
  return {filePath:path.resolve(SHARED_LABELS_PATH),labels:[],index:999};
}

function toDbLabelV32(x){
  const c=cleanLabelV32(x); return {
    product_number:c.productNumber, barcode:c.barcode, product_name:c.productName, option_text:c.optionText,
    material:c.material, importer:c.importer, address:c.address, phone:c.phone, warning:c.warning, age:c.age, country:c.country,
    label_width:c.labelWidth, label_height:c.labelHeight, title_font:c.titleFont, body_font:c.bodyFont,
    barcode_height:c.barcodeHeight, barcode_text_font:c.barcodeTextFont, made_in_font:c.madeInFont,
    updated_at:new Date().toISOString()
  };
}
function fromDbLabelV32(r={}){ return cleanLabelV32(r); }
async function supabaseV32(pathname,opts={}){
  const headers={apikey:SUPABASE_SERVICE_KEY,Authorization:`Bearer ${SUPABASE_SERVICE_KEY}`,'Content-Type':'application/json',...(opts.headers||{})};
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`,{...opts,headers});
  const text=await r.text(); let data=null; try{data=text?JSON.parse(text):null}catch(_){data=text}
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${typeof data==='string'?data:(data?.message||JSON.stringify(data))}`);
  return {data,status:r.status};
}
async function listSupabaseLabelsV32(){
  const {data}=await supabaseV32('shared_labels?select=*&order=updated_at.desc&limit=20000',{method:'GET'});
  return (Array.isArray(data)?data:[]).map(fromDbLabelV32);
}
async function findSupabaseLabelV32(item){
  if(item.id && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(item.id)){
    const {data}=await supabaseV32(`shared_labels?select=*&id=eq.${encodeURIComponent(item.id)}&limit=1`,{method:'GET'}); if(data?.[0])return data[0];
  }
  if(item.barcode){ const {data}=await supabaseV32(`shared_labels?select=*&barcode=eq.${encodeURIComponent(item.barcode)}&limit=1`,{method:'GET'}); if(data?.[0])return data[0]; }
  if(item.productNumber){ const {data}=await supabaseV32(`shared_labels?select=*&product_number=eq.${encodeURIComponent(item.productNumber)}&limit=1`,{method:'GET'}); if(data?.[0])return data[0]; }
  return null;
}
async function upsertSupabaseLabelV32(raw){
  const item=cleanLabelV32(raw); if(!item.barcode&&!item.productNumber)throw new Error('바코드 또는 상품번호가 필요합니다.');
  const existing=await findSupabaseLabelV32(item), row=toDbLabelV32(item);
  if(existing?.id){
    const {data}=await supabaseV32(`shared_labels?id=eq.${encodeURIComponent(existing.id)}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(row)});
    return fromDbLabelV32(data?.[0]||{...existing,...row});
  }
  const {data}=await supabaseV32('shared_labels',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(row)});
  return fromDbLabelV32(data?.[0]||row);
}

async function resolveSharedLabelsV32(){
  let supabaseError='';
  if(SUPABASE_LABELS_ENABLED){
    try{
      const labels=await listSupabaseLabelsV32();
      if(labels.length) return {labels,storage:'supabase',permanent:true,supabaseConfigured:true,supabaseError:'',localFallback:false};
    }catch(err){ supabaseError=err.message; console.warn('[공용 라벨] Supabase 조회 실패, 기존 라벨 파일 확인:',err.message); }
  }
  const sources=localLabelSourcesV32();
  const labels=mergeLabelsV32(sources.map(s=>s.labels));
  return {labels,storage:labels.length?'existing-label-file':'empty',permanent:false,supabaseConfigured:SUPABASE_LABELS_ENABLED,supabaseError,localFallback:labels.length>0};
}

app.get('/api/shared-labels',async(req,res)=>{
  try{
    const result=await resolveSharedLabelsV32();
    res.set('Cache-Control','no-store');
    res.json({ok:true,labels:result.labels,count:result.labels.length,editKeyRequired:!!LABEL_EDIT_KEY,permanent:result.permanent,storage:result.storage,supabaseConfigured:result.supabaseConfigured,localFallback:result.localFallback});
  }catch(err){console.error('[공용 라벨] 조회 실패',err);res.status(500).json({ok:false,error:err.message})}
});

app.get('/api/shared-labels-status',async(req,res)=>{
  try{
    let supabaseCount=null,supabaseError='';
    if(SUPABASE_LABELS_ENABLED){try{supabaseCount=(await listSupabaseLabelsV32()).length}catch(err){supabaseError=err.message}}
    const sources=localLabelCandidatesV32().map((p,i)=>({name:`라벨저장소${i+1}`,exists:fs.existsSync(p),count:readActualLabelFileV32(p).length})).filter(x=>x.exists||x.count);
    const resolved=await resolveSharedLabelsV32();
    res.set('Cache-Control','no-store');
    res.json({ok:true,count:resolved.labels.length,storage:resolved.storage,permanent:resolved.permanent,supabaseConfigured:SUPABASE_LABELS_ENABLED,supabaseCount,supabaseError,localSources:sources});
  }catch(err){res.status(500).json({ok:false,error:err.message})}
});

app.post('/api/shared-labels',requireLabelEditKeyV32,async(req,res)=>{
  try{
    let label,count,storage,permanent=false;
    if(SUPABASE_LABELS_ENABLED){
      try{ label=await upsertSupabaseLabelV32(req.body||{}); count=(await listSupabaseLabelsV32()).length; storage='supabase'; permanent=true; return res.json({ok:true,label,count,storage,permanent}); }
      catch(err){ console.warn('[공용 라벨] Supabase 저장 실패, 기존 라벨 파일에 저장:',err.message); }
    }
    const store=bestLocalLabelStoreV32(), labels=store.labels.slice(); label=upsertLocalLabelV32(labels,req.body||{}); writeLabelFileV32(store.filePath,labels); count=labels.length; storage='existing-label-file';
    res.json({ok:true,label,count,storage,permanent});
  }catch(err){res.status(400).json({ok:false,error:err.message})}
});

app.delete('/api/shared-labels/:id',requireLabelEditKeyV32,async(req,res)=>{
  try{
    const id=String(req.params.id||'');
    if(SUPABASE_LABELS_ENABLED){
      try{
        const current=await listSupabaseLabelsV32();
        if(current.length){await supabaseV32(`shared_labels?id=eq.${encodeURIComponent(id)}`,{method:'DELETE',headers:{Prefer:'return=minimal'}});return res.json({ok:true,count:(await listSupabaseLabelsV32()).length,storage:'supabase'})}
      }catch(err){console.warn('[공용 라벨] Supabase 삭제 경로 사용 불가:',err.message)}
    }
    let removed=false,total=0;
    for(const src of localLabelSourcesV32()){
      const next=src.labels.filter(x=>String(x.id||'')!==id);
      if(next.length<src.labels.length){writeLabelFileV32(src.filePath,next);removed=true}
      total+=next.length;
    }
    if(!removed)return res.status(404).json({ok:false,error:'삭제할 공용 라벨을 찾지 못했습니다.'});
    res.json({ok:true,count:total,storage:'existing-label-file'});
  }catch(err){res.status(500).json({ok:false,error:err.message})}
});

app.get('/api/shared-labels-backup',async(req,res)=>{
  try{
    const result=await resolveSharedLabelsV32();
    const payload=JSON.stringify({exportedAt:new Date().toISOString(),storage:result.storage,labels:result.labels},null,2),ymd=new Date().toISOString().slice(0,10).replace(/-/g,'');
    res.set('Content-Type','application/json; charset=utf-8');res.set('Content-Disposition',`attachment; filename="shared-labels-${ymd}.json"`);res.send(payload);
  }catch(err){res.status(500).json({ok:false,error:err.message})}
});

app.post('/api/shared-labels-restore',requireLabelEditKeyV32,async(req,res)=>{
  try{
    const incoming=Array.isArray(req.body)?req.body:req.body?.labels;
    if(!Array.isArray(incoming)||!incoming.length)return res.status(400).json({ok:false,error:'복원할 라벨 데이터가 없습니다.'});
    const valid=incoming.filter(looksLikeActualSavedLabelV32); if(!valid.length)return res.status(400).json({ok:false,error:'실제 라벨 저장 데이터가 없습니다. 상품 기준정보는 라벨로 복원하지 않습니다.'});
    let restored=0;
    if(SUPABASE_LABELS_ENABLED){
      try{for(const raw of valid.slice(0,20000)){try{await upsertSupabaseLabelV32(raw);restored++}catch(e){console.warn('[라벨 복원]',e.message)}}return res.json({ok:true,restored,count:(await listSupabaseLabelsV32()).length,permanent:true,storage:'supabase'})}catch(err){console.warn('[공용 라벨] Supabase 복원 실패, 로컬 라벨 저장소 사용:',err.message)}
    }
    const store=bestLocalLabelStoreV32(),labels=store.labels.slice();for(const raw of valid.slice(0,20000)){try{upsertLocalLabelV32(labels,raw);restored++}catch(_){}}writeLabelFileV32(store.filePath,labels);res.json({ok:true,restored,count:labels.length,permanent:false,storage:'existing-label-file'});
  }catch(err){res.status(400).json({ok:false,error:err.message})}
});

// 상품 기준목록은 라벨과 완전히 분리합니다. 라벨 복구에는 사용하지 않습니다.
function readCatalogV32(){
  try{if(!fs.existsSync(PRODUCT_CATALOG_PATH))return[];const p=JSON.parse(fs.readFileSync(PRODUCT_CATALOG_PATH,'utf8')||'[]');return Array.isArray(p)?p:(Array.isArray(p?.items)?p.items:[])}catch(_){return[]}
}
function writeCatalogV32(arr){ensureSharedLabelDirV32(PRODUCT_CATALOG_PATH);const t=`${PRODUCT_CATALOG_PATH}.tmp-${process.pid}-${Date.now()}`;fs.writeFileSync(t,JSON.stringify(arr,null,2),'utf8');fs.renameSync(t,PRODUCT_CATALOG_PATH)}
app.get('/api/product-catalog',(req,res)=>{const barcode=String(req.query.barcode||'').trim().toUpperCase();if(!barcode)return res.status(400).json({ok:false,error:'barcode가 필요합니다.'});const items=readCatalogV32();const item=items.find(x=>String(x.barcode||'').trim().toUpperCase()===barcode)||null;res.set('Cache-Control','no-store');res.json({ok:true,item})});
app.get('/api/product-catalog-status',(req,res)=>{const items=readCatalogV32();res.set('Cache-Control','no-store');res.json({ok:true,count:items.length,permanent:false,storage:'server-json'})});
app.post('/api/product-catalog/import',requireLabelEditKeyV32,(req,res)=>{try{const incoming=req.body?.items;if(!Array.isArray(incoming))return res.status(400).json({ok:false,error:'items 배열이 필요합니다.'});const items=readCatalogV32(),map=new Map(items.map(x=>[String(x.barcode||'').trim().toUpperCase(),x]));let imported=0;for(const raw of incoming.slice(0,5000)){const barcode=String(raw?.barcode||'').trim().toUpperCase();if(!barcode)continue;map.set(barcode,{...(map.get(barcode)||{}),productNumber:String(raw?.productNumber||''),barcode,productName:String(raw?.productName||''),source:String(raw?.source||req.body?.source||''),updatedAt:new Date().toISOString()});imported++}const next=[...map.values()];writeCatalogV32(next);res.json({ok:true,imported,count:next.length})}catch(err){res.status(400).json({ok:false,error:err.message})}});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, keyConfigured: !!UNIPASS_KEY, aiConfigured: !!ANTHROPIC_KEY });
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


// =====================================================================
// v46: 모든 주요 작업 화면의 공용 서버 작업상태 저장소
// - 바코드 라벨 현재 작성중 상태
// - 발주 바코드 출력 현재 작업상태
// - 선적 리스트 작성 보관함(복수 작업 + 원본 엑셀)
// 쿠팡 입고 작업은 기존 /api/coupang-shared 프로젝트 저장소를 그대로 사용합니다.
// 저장 위치는 COUPANG_SHARED_DIR 내부라 기존 공용 선적작업과 같은 영구 디스크를 사용합니다.
// =====================================================================
const SHARED_WORKSPACE_DIR_V46 = path.join(COUPANG_SHARED_DIR, '_shared-workspaces');
const WORKSPACE_KEYS_V46 = new Set(['barcode-label','order-barcode']);
function ensureDirV46(dir){ fs.mkdirSync(dir,{recursive:true}); }
function safeWorkspaceKeyV46(v){ v=String(v||''); return WORKSPACE_KEYS_V46.has(v)?v:null; }
function backupFileV46(file){try{if(fs.existsSync(file))fs.copyFileSync(file,file+'.prev')}catch(_){}}
function writeAtomicV46(file,data){
  ensureDirV46(path.dirname(file));
  try{ if(fs.existsSync(file)) fs.copyFileSync(file,file+'.prev'); }catch(_){}
  const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp,data);
  fs.renameSync(tmp,file);
}
function workspaceFileV46(key){ return path.join(SHARED_WORKSPACE_DIR_V46,`${key}.json`); }
function readWorkspaceV46(key){ return readJsonSafe(workspaceFileV46(key)); }

app.get('/api/shared-workspace/:key',coupangAuth,(req,res)=>{
  const key=safeWorkspaceKeyV46(req.params.key);if(!key)return res.status(404).json({ok:false,error:'지원하지 않는 작업 저장소입니다.'});
  const row=readWorkspaceV46(key);res.set('Cache-Control','no-store');
  if(!row)return res.status(404).json({ok:false,error:'저장된 작업이 없습니다.'});
  res.json(row);
});
function saveWorkspaceHandlerV46(req,res){
  const key=safeWorkspaceKeyV46(req.params.key);if(!key)return res.status(404).json({ok:false,error:'지원하지 않는 작업 저장소입니다.'});
  try{
    const state=(req.body&&typeof req.body==='object')?req.body?.state:req.body;
    if(!state||typeof state!=='object')return res.status(400).json({ok:false,error:'저장할 작업 상태가 없습니다.'});
    const updatedAt=Date.now();const row={ok:true,key,updatedAt,state};
    writeAtomicV46(workspaceFileV46(key),JSON.stringify(row));
    res.set('Cache-Control','no-store');res.json({ok:true,key,updatedAt});
  }catch(err){res.status(400).json({ok:false,error:`공용 작업 저장 실패: ${err.message}`})}
}
app.put('/api/shared-workspace/:key',coupangAuth,saveWorkspaceHandlerV46);
app.post('/api/shared-workspace/:key',coupangAuth,saveWorkspaceHandlerV46);
app.delete('/api/shared-workspace/:key',coupangAuth,(req,res)=>{
  const key=safeWorkspaceKeyV46(req.params.key);if(!key)return res.status(404).json({ok:false,error:'지원하지 않는 작업 저장소입니다.'});
  try{unlinkSafe(workspaceFileV46(key));res.json({ok:true})}catch(err){res.status(500).json({ok:false,error:err.message})}
});

// 선적 리스트 작성 공용 보관함
const SHIPMENT_VAULT_DIR_V46=path.join(SHARED_WORKSPACE_DIR_V46,'shipment-list-vault');
const SHIPMENT_VAULT_INDEX_V46=path.join(SHIPMENT_VAULT_DIR_V46,'index.json');
function safeShipmentDraftIdV46(v){v=String(v||'');return /^[A-Za-z0-9_-]{3,100}$/.test(v)?v:null}
function shipmentDraftPathsV46(id){const dir=path.join(SHIPMENT_VAULT_DIR_V46,'drafts',id);return{dir,meta:path.join(dir,'meta.json'),blob:path.join(dir,'source.xlsx.bin')}}
function readShipmentIndexV46(){const x=readJsonSafe(SHIPMENT_VAULT_INDEX_V46);return x&&Array.isArray(x.drafts)?x:{version:46,drafts:[]}}
function saveShipmentIndexV46(x){writeAtomicV46(SHIPMENT_VAULT_INDEX_V46,JSON.stringify({version:46,drafts:x.drafts||[]}))}
function cleanShipmentMetaV46(raw={},id=''){
  const now=Date.now();const ct=(raw.centerTypes&&typeof raw.centerTypes==='object')?raw.centerTypes:{};
  const centerTypes={};for(const [k,v] of Object.entries(ct).slice(0,1000))centerTypes[String(k).slice(0,300)]=String(v).slice(0,30);
  return {
    id, name:String(raw.name||'선적 리스트').slice(0,180), fileName:String(raw.fileName||'선적리스트.xlsx').slice(0,260),
    fileType:String(raw.fileType||'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').slice(0,160),
    centerTypes, confirmed:!!raw.confirmed, createdAt:Number(raw.createdAt||now), savedAt:Number(raw.savedAt||now),
    transferredAt:Number(raw.transferredAt||0), transferredProjectId:String(raw.transferredProjectId||'').slice(0,120),
    transferredProjectName:String(raw.transferredProjectName||'').slice(0,180),
    inputNamesV41:Array.isArray(raw.inputNamesV41)?raw.inputNamesV41.slice(0,50).map(x=>String(x).slice(0,260)):[]
  };
}
function upsertShipmentIndexV46(meta,blobSize){
  const idx=readShipmentIndexV46();let row=idx.drafts.find(x=>x.id===meta.id);
  const summary={id:meta.id,name:meta.name,fileName:meta.fileName,fileType:meta.fileType,confirmed:meta.confirmed,createdAt:meta.createdAt,savedAt:meta.savedAt,transferredAt:meta.transferredAt,transferredProjectId:meta.transferredProjectId,transferredProjectName:meta.transferredProjectName,inputNamesV41:meta.inputNamesV41||[],blobSize:Number(blobSize??row?.blobSize??0)};
  if(row)Object.assign(row,summary);else idx.drafts.push(summary);saveShipmentIndexV46(idx);return summary;
}
app.get('/api/shipment-list-vault',coupangAuth,(req,res)=>{const idx=readShipmentIndexV46();res.set('Cache-Control','no-store');res.json({ok:true,drafts:[...idx.drafts].sort((a,b)=>Number(b.savedAt||0)-Number(a.savedAt||0))})});
app.get('/api/shipment-list-vault/:id',coupangAuth,(req,res)=>{const id=safeShipmentDraftIdV46(req.params.id);if(!id)return res.status(404).json({ok:false,error:'잘못된 보관 ID입니다.'});const meta=readJsonSafe(shipmentDraftPathsV46(id).meta);if(!meta)return res.status(404).json({ok:false,error:'보관본을 찾지 못했습니다.'});res.set('Cache-Control','no-store');res.json({ok:true,draft:meta})});
app.put('/api/shipment-list-vault/:id',coupangAuth,(req,res)=>{
  const id=safeShipmentDraftIdV46(req.params.id);if(!id)return res.status(404).json({ok:false,error:'잘못된 보관 ID입니다.'});
  try{const meta=cleanShipmentMetaV46(req.body||{},id),paths=shipmentDraftPathsV46(id);writeAtomicV46(paths.meta,JSON.stringify(meta));const size=fs.existsSync(paths.blob)?fs.statSync(paths.blob).size:0;const summary=upsertShipmentIndexV46(meta,size);res.json({ok:true,draft:summary,updatedAt:Date.now()})}catch(err){res.status(400).json({ok:false,error:err.message})}
});
app.get('/api/shipment-list-vault/:id/blob',coupangAuth,(req,res)=>{
  const id=safeShipmentDraftIdV46(req.params.id);if(!id)return res.status(404).json({ok:false,error:'잘못된 보관 ID입니다.'});const paths=shipmentDraftPathsV46(id),meta=readJsonSafe(paths.meta)||{};if(!fs.existsSync(paths.blob))return res.status(404).json({ok:false,error:'원본 엑셀을 찾지 못했습니다.'});res.set('Cache-Control','no-store');res.set('Content-Type',meta.fileType||'application/octet-stream');res.set('X-File-Name',encodeURIComponent(meta.fileName||'선적리스트.xlsx'));res.sendFile(paths.blob)
});
app.put('/api/shipment-list-vault/:id/blob',coupangAuth,express.raw({type:'application/octet-stream',limit:'80mb'}),(req,res)=>{
  const id=safeShipmentDraftIdV46(req.params.id);if(!id)return res.status(404).json({ok:false,error:'잘못된 보관 ID입니다.'});
  try{const paths=shipmentDraftPathsV46(id),body=Buffer.isBuffer(req.body)?req.body:Buffer.from(req.body||'');if(!body.length)return res.status(400).json({ok:false,error:'빈 파일은 저장할 수 없습니다.'});ensureDirV46(paths.dir);try{if(fs.existsSync(paths.blob))fs.copyFileSync(paths.blob,paths.blob+'.prev')}catch(_){};writeAtomicV46(paths.blob,body);const meta=readJsonSafe(paths.meta)||cleanShipmentMetaV46({},id);upsertShipmentIndexV46(meta,body.length);res.json({ok:true,size:body.length,updatedAt:Date.now()})}catch(err){res.status(500).json({ok:false,error:err.message})}
});
app.delete('/api/shipment-list-vault/:id',coupangAuth,(req,res)=>{
  const id=safeShipmentDraftIdV46(req.params.id);if(!id)return res.status(404).json({ok:false,error:'잘못된 보관 ID입니다.'});
  try{fs.rmSync(shipmentDraftPathsV46(id).dir,{recursive:true,force:true});const idx=readShipmentIndexV46();idx.drafts=idx.drafts.filter(x=>x.id!==id);saveShipmentIndexV46(idx);res.json({ok:true})}catch(err){res.status(500).json({ok:false,error:err.message})}
});


// =====================================================================
// v62: 발주서 작성 / 제품 목록 관리
// - 회사 공용 제품 마스터는 Render Persistent Disk에 영구 저장합니다.
// - 기존 쿠팡 입고 작업, 선적 리스트, 계정 데이터와 저장경로를 완전히 분리합니다.
// - 제품번호 우선, 바코드 보조 기준으로 동일 제품을 갱신합니다.
// =====================================================================
const PURCHASE_ORDER_ROOT_V62 = path.join(TRADECODE_PERSIST_ROOT_V60, 'purchase-order');
const PURCHASE_PRODUCT_ROOT_V62 = path.join(PURCHASE_ORDER_ROOT_V62, 'product-master');
const PURCHASE_PRODUCT_FILE_V62 = path.join(PURCHASE_PRODUCT_ROOT_V62, 'products.json');
const PURCHASE_IMAGE_ROOT_V62 = path.join(PURCHASE_PRODUCT_ROOT_V62, 'images');
function ensurePurchaseDirsV62(){
  fs.mkdirSync(PURCHASE_IMAGE_ROOT_V62,{recursive:true});
}
ensurePurchaseDirsV62();
function purchaseReadV62(){
  try{
    if(!fs.existsSync(PURCHASE_PRODUCT_FILE_V62)) return [];
    const x=JSON.parse(fs.readFileSync(PURCHASE_PRODUCT_FILE_V62,'utf8')||'[]');
    return Array.isArray(x)?x:(Array.isArray(x?.items)?x.items:[]);
  }catch(e){console.warn('[v62 purchase] 제품목록 읽기 실패:',e.message);return []}
}
function purchaseWriteV62(items){
  ensurePurchaseDirsV62();
  try{if(fs.existsSync(PURCHASE_PRODUCT_FILE_V62))fs.copyFileSync(PURCHASE_PRODUCT_FILE_V62,PURCHASE_PRODUCT_FILE_V62+'.prev')}catch(_){}
  const tmp=`${PURCHASE_PRODUCT_FILE_V62}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify({version:62,updatedAt:Date.now(),items},null,2),'utf8');
  fs.renameSync(tmp,PURCHASE_PRODUCT_FILE_V62);
}
function cleanTextV62(v,max=500){return String(v??'').trim().slice(0,max)}
function cleanBarcodeV62(v){return cleanTextV62(v,160).replace(/\s+/g,'').toUpperCase()}
function cleanProductNoV62(v){return cleanTextV62(v,160).replace(/\.0$/,'').replace(/\s+/g,'')}
function cleanCavityV62(v){const n=Number(String(v??'').replace(/,/g,''));return Number.isFinite(n)&&n>0?n:1}
function imageExtV62(v){v=String(v||'').toLowerCase().replace(/^\./,'');if(v==='jpg')v='jpeg';return ['jpeg','png'].includes(v)?v:''}
function safePurchaseImageNameV62(v){v=path.basename(String(v||''));return /^[A-Za-z0-9_-]+\.(?:jpeg|png)$/i.test(v)?v:''}
function purchasePublicV62(x){
  return {
    id:String(x.id||''), productNumber:String(x.productNumber||''), barcode:String(x.barcode||''),
    productName:String(x.productName||''), cavity:cleanCavityV62(x.cavity), sortIndex:Number(x.sortIndex||0),
    imageFile:String(x.imageFile||''), imageExt:String(x.imageExt||''),
    imageUrl:x.imageFile?`/api/purchase-products/image/${encodeURIComponent(x.imageFile)}`:'',
    createdAt:Number(x.createdAt||0), updatedAt:Number(x.updatedAt||0)
  };
}
function purchaseFindIndexV62(items,raw){
  const pn=cleanProductNoV62(raw?.productNumber),bc=cleanBarcodeV62(raw?.barcode);
  let i=-1;
  if(raw?.id)i=items.findIndex(x=>String(x.id||'')===String(raw.id));
  if(i<0&&pn)i=items.findIndex(x=>cleanProductNoV62(x.productNumber)===pn);
  if(i<0&&bc)i=items.findIndex(x=>cleanBarcodeV62(x.barcode)===bc);
  return i;
}
function nextPurchaseSortV62(items){return items.reduce((m,x)=>Math.max(m,Number(x.sortIndex||0)),0)+1}
function savePurchaseImageV62(item,image){
  if(!image||!image.base64)return item;
  const ext=imageExtV62(image.ext||image.extension||image.type);if(!ext)throw new Error('제품 사진은 JPG/JPEG 또는 PNG만 사용할 수 있습니다.');
  let buf;try{buf=Buffer.from(String(image.base64||'').replace(/^data:[^,]+,/,''),'base64')}catch(_){throw new Error('제품 사진 데이터가 올바르지 않습니다.')}
  if(!buf.length)throw new Error('빈 제품 사진은 저장할 수 없습니다.');
  if(buf.length>2*1024*1024)throw new Error('제품 사진 1장은 2MB 이하로 올려주세요.');
  ensurePurchaseDirsV62();
  const name=`${String(item.id).replace(/[^A-Za-z0-9_-]/g,'_')}.${ext}`;
  const dest=path.join(PURCHASE_IMAGE_ROOT_V62,name),tmp=`${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp,buf);fs.renameSync(tmp,dest);
  if(item.imageFile&&item.imageFile!==name){try{fs.rmSync(path.join(PURCHASE_IMAGE_ROOT_V62,path.basename(item.imageFile)),{force:true})}catch(_){}}
  item.imageFile=name;item.imageExt=ext;return item;
}
function upsertPurchaseProductV62(items,raw,{allowImage=true}={}){
  const now=Date.now(),pn=cleanProductNoV62(raw?.productNumber),bc=cleanBarcodeV62(raw?.barcode),name=cleanTextV62(raw?.productName,500);
  if(!pn&&!bc)throw new Error('상품번호 또는 바코드가 필요합니다.');
  if(!name)throw new Error('상품명이 필요합니다.');
  let idx=purchaseFindIndexV62(items,raw),item;
  if(idx>=0){
    item={...items[idx],productNumber:pn||items[idx].productNumber||'',barcode:bc||items[idx].barcode||'',productName:name,cavity:cleanCavityV62(raw?.cavity??items[idx].cavity),updatedAt:now};
    if(Number(raw?.sortIndex)>0)item.sortIndex=Number(raw.sortIndex);
    if(allowImage&&raw?.image?.base64)savePurchaseImageV62(item,raw.image);
    items[idx]=item;
  }else{
    item={id:`prd_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,productNumber:pn,barcode:bc,productName:name,cavity:cleanCavityV62(raw?.cavity),sortIndex:Number(raw?.sortIndex)>0?Number(raw.sortIndex):nextPurchaseSortV62(items),imageFile:'',imageExt:'',createdAt:now,updatedAt:now};
    if(allowImage&&raw?.image?.base64)savePurchaseImageV62(item,raw.image);
    items.push(item);idx=items.length-1;
  }
  return {item,index:idx};
}
app.get('/api/purchase-products',requireLoginApiV48,(req,res)=>{
  const items=purchaseReadV62().map(purchasePublicV62).sort((a,b)=>(a.sortIndex-b.sortIndex)||a.productName.localeCompare(b.productName,'ko'));
  res.set('Cache-Control','no-store');res.json({ok:true,count:items.length,items,persistent:true,storage:PURCHASE_PRODUCT_FILE_V62});
});
app.get('/api/purchase-products/status',requireLoginApiV48,(req,res)=>{
  const items=purchaseReadV62();res.set('Cache-Control','no-store');res.json({ok:true,count:items.length,persistent:true,root:PURCHASE_PRODUCT_ROOT_V62,imageCount:items.filter(x=>x.imageFile).length});
});
app.get('/api/purchase-products/image/:file',requireLoginApiV48,(req,res)=>{
  const name=safePurchaseImageNameV62(req.params.file);if(!name)return res.status(404).end();
  const file=path.join(PURCHASE_IMAGE_ROOT_V62,name);if(!fs.existsSync(file))return res.status(404).end();
  res.set('Cache-Control','private, max-age=86400');res.type(name.endsWith('.png')?'png':'jpeg');res.sendFile(file);
});
app.post('/api/purchase-products/import',requireLoginApiV48,(req,res)=>{
  try{
    const incoming=Array.isArray(req.body?.items)?req.body.items:[];if(!incoming.length)return res.status(400).json({ok:false,error:'가져올 제품이 없습니다.'});
    if(incoming.length>100)return res.status(400).json({ok:false,error:'한 번에 최대 100개씩 가져올 수 있습니다.'});
    const items=purchaseReadV62();let inserted=0,updated=0,images=0;
    for(const raw of incoming){
      const existed=purchaseFindIndexV62(items,raw)>=0;const result=upsertPurchaseProductV62(items,raw);if(existed)updated++;else inserted++;if(result.item.imageFile&&raw?.image?.base64)images++;
    }
    purchaseWriteV62(items);res.json({ok:true,inserted,updated,images,count:items.length});
  }catch(e){res.status(400).json({ok:false,error:e.message})}
});
app.post('/api/purchase-products',requireLoginApiV48,(req,res)=>{
  try{const items=purchaseReadV62();const existed=purchaseFindIndexV62(items,req.body||{})>=0;const {item}=upsertPurchaseProductV62(items,req.body||{});purchaseWriteV62(items);res.json({ok:true,created:!existed,item:purchasePublicV62(item),count:items.length})}
  catch(e){res.status(400).json({ok:false,error:e.message})}
});
app.delete('/api/purchase-products/:id',requireLoginApiV48,(req,res)=>{
  try{const items=purchaseReadV62(),idx=items.findIndex(x=>String(x.id||'')===String(req.params.id||''));if(idx<0)return res.status(404).json({ok:false,error:'제품을 찾지 못했습니다.'});const [item]=items.splice(idx,1);if(item.imageFile)try{fs.rmSync(path.join(PURCHASE_IMAGE_ROOT_V62,path.basename(item.imageFile)),{force:true})}catch(_){};purchaseWriteV62(items);res.json({ok:true,count:items.length})}catch(e){res.status(500).json({ok:false,error:e.message})}
});


// v62 hotfix: 제품목록 캡처는 브라우저 OCR 대신 기존 ANTHROPIC_API_KEY를 이용한
// 서버측 AI Vision을 우선 사용합니다. 다른 기능/저장 데이터에는 영향이 없습니다.
const purchaseVisionLimiterV62 = createRateLimiter({ windowMs: 60000, max: 12 });
function purchaseVisionMediaTypeV62(v){
  const x=String(v||'').toLowerCase();
  return ['image/png','image/jpeg','image/webp','image/gif'].includes(x)?x:'';
}
function stripJsonFenceV62(v){
  let t=String(v||'').trim();
  t=t.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  const a=t.indexOf('{'),b=t.lastIndexOf('}');
  if(a>=0&&b>a)t=t.slice(a,b+1);
  return t;
}
app.post('/api/purchase-order/vision-extract',requireLoginApiV48,purchaseVisionLimiterV62,async(req,res)=>{
  try{
    if(!ANTHROPIC_KEY)return res.status(503).json({ok:false,error:'ANTHROPIC_API_KEY가 설정되어 있지 않아 AI 캡처 인식을 사용할 수 없습니다.'});
    const mediaType=purchaseVisionMediaTypeV62(req.body?.mediaType);
    const data=String(req.body?.data||'').replace(/^data:[^,]+,/, '').replace(/\s+/g,'');
    if(!mediaType||!data)return res.status(400).json({ok:false,error:'분석할 이미지 데이터가 없습니다.'});
    let raw;
    try{raw=Buffer.from(data,'base64')}catch(_){return res.status(400).json({ok:false,error:'이미지 데이터가 올바르지 않습니다.'})}
    if(!raw.length)return res.status(400).json({ok:false,error:'빈 이미지입니다.'});
    if(raw.length>3.2*1024*1024)return res.status(413).json({ok:false,error:'캡처 이미지가 너무 큽니다. 3MB 이하로 줄여 다시 시도해 주세요.'});

    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),90000);
    let r;
    try{
      r=await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',signal:controller.signal,
        headers:{'content-type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'},
        body:JSON.stringify({
          model:process.env.PURCHASE_VISION_MODEL||'claude-sonnet-4-6',
          max_tokens:4096,
          messages:[{role:'user',content:[
            {type:'image',source:{type:'base64',media_type:mediaType,data}},
            {type:'text',text:`이 이미지는 한국어 쇼핑몰의 제품목록 표 캡처입니다. 표의 각 제품 행을 위에서 아래 순서대로 정확히 읽어 주세요.\n\n필요한 필드:\n- productNumber: 상품번호. 숫자만. 보이지 않거나 확신이 없으면 빈 문자열.\n- productName: 화면에 보이는 한국어 상품명을 그대로. 보이지 않는 글자를 추측하지 말 것.\n- barcode: 바코드 문자열. 보통 R로 시작하는 영문+숫자입니다. 보이지 않거나 확신이 없으면 빈 문자열.\n\n규칙:\n1) 헤더, '출력' 버튼, 티켓 숫자 등은 제품 데이터에서 제외합니다.\n2) 제품 행 하나당 객체 하나를 만듭니다.\n3) 숫자 0/O, 1/I처럼 애매하면 문맥으로 억지 보정하지 말고 실제 화면을 우선합니다.\n4) 임의로 상품을 만들거나 누락된 값을 추측하지 마세요.\n5) 설명/마크다운 없이 아래 JSON 형식만 반환하세요.\n{\"rows\":[{\"productNumber\":\"\",\"productName\":\"\",\"barcode\":\"\"}]}`}
          ]}]
        })
      });
    }finally{clearTimeout(timer)}
    const body=await r.text();
    if(!r.ok){
      let msg=`AI Vision 호출 실패 (${r.status})`;
      try{const j=JSON.parse(body);msg=j?.error?.message||msg}catch(_){}
      return res.status(502).json({ok:false,error:msg});
    }
    let aj;try{aj=JSON.parse(body)}catch(_){return res.status(502).json({ok:false,error:'AI Vision 응답을 해석하지 못했습니다.'})}
    const text=(Array.isArray(aj?.content)?aj.content:[]).filter(x=>x?.type==='text').map(x=>x.text||'').join('\n');
    let parsed;try{parsed=JSON.parse(stripJsonFenceV62(text))}catch(_){return res.status(502).json({ok:false,error:'AI Vision 결과가 JSON 형식이 아닙니다.',raw:text.slice(0,500)})}
    const rows=(Array.isArray(parsed?.rows)?parsed.rows:[]).slice(0,100).map(x=>({
      productNumber:cleanProductNoV62(String(x?.productNumber||'').replace(/\D+/g,'')),
      productName:cleanTextV62(x?.productName,500),
      barcode:cleanBarcodeV62(x?.barcode)
    })).filter(x=>x.productNumber||x.productName||x.barcode);
    res.set('Cache-Control','no-store');
    res.json({ok:true,rows,model:process.env.PURCHASE_VISION_MODEL||'claude-sonnet-4-6'});
  }catch(e){
    const msg=e?.name==='AbortError'?'AI Vision 분석 시간이 초과되었습니다.':e.message;
    res.status(500).json({ok:false,error:msg});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TradeCode Navi 백엔드 프록시 실행 중: http://localhost:${PORT}`);
  console.log(`인증키 설정 여부: ${UNIPASS_KEY ? 'O' : 'X (미설정)'}`);
});
