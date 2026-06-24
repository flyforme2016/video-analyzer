/**
 * 서버 라이브러리: 업로드·목록·삭제 UI 및 API 연동.
 */

import { dom, escapeHtml, fmtBytes } from './state.js';

/** @type {(file: {id:string, name:string, size:number, uploadedAt:string}) => void} */
let onFilePick = () => {};

/** @type {Map<string, {id:string, name:string, size:number, uploadedAt:string}>} */
const fileCache = new Map();

/**
 * 서버 파일 라이브러리 UI와 이벤트를 초기화한다.
 * @param {(file: {id:string, name:string, size:number, uploadedAt:string}) => void} onSelect 목록 항목 선택 시 호출
 * @returns {void}
 */
export function setupServerLibrary(onSelect) {
  if (!dom.serverFileList || !dom.libraryUploadInput) return;
  onFilePick = onSelect;

  dom.libraryUploadInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) uploadFileToLibrary(file);
  });

  dom.serverFileList.addEventListener('mousedown', (e) => {
    if (e.target.closest('[data-delete-id]')) e.preventDefault();
  });

  dom.serverFileList.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('[data-delete-id]');
    if (deleteBtn) {
      handleDeleteClick(deleteBtn.dataset.deleteId, e);
      return;
    }
    const row = e.target.closest('[data-pick-id]');
    if (row) handlePickClick(row.dataset.pickId);
  });

  refreshServerFileList();
}

/**
 * 서버 라이브러리 목록을 API에서 다시 불러와 렌더한다.
 * @returns {Promise<void>}
 */
export async function refreshServerFileList() {
  if (!dom.serverFileList) return;
  dom.serverFileList.classList.add('loading');
  try {
    const files = await fetchLibraryList();
    renderServerFileList(files);
  } catch (err) {
    setLibraryBusy(false, '목록 조회 실패: ' + (err.message || err));
    dom.serverFileList.innerHTML = '';
    dom.serverFileEmpty.hidden = true;
  } finally {
    dom.serverFileList.classList.remove('loading');
  }
}

/**
 * 파일을 서버 라이브러리에 업로드한다.
 * @param {File} file 업로드할 파일
 * @returns {Promise<void>}
 */
export async function uploadFileToLibrary(file) {
  if (!file) return;
  setLibraryBusy(true, `"${file.name}" 업로드 중…`);
  try {
    const form = new FormData();
    form.append('video', file);
    const res = await fetch('/api/library', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || data.error || '업로드 실패');
    await refreshServerFileList();
    setLibraryBusy(false, '');
  } catch (err) {
    setLibraryBusy(false, '업로드 실패: ' + (err.message || err));
  }
}

/**
 * 서버 라이브러리 파일 목록을 API에서 가져온다.
 * @returns {Promise<Array<{id:string, name:string, size:number, uploadedAt:string}>>}
 * @throws {Error} API 오류 시
 */
async function fetchLibraryList() {
  const res = await fetch('/api/library');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || '목록 조회 실패');
  return Array.isArray(data.files) ? data.files : [];
}

/**
 * 서버 파일 목록 DOM을 갱신한다.
 * @param {Array<{id:string, name:string, size:number, uploadedAt:string}>} files 파일 메타데이터 배열
 * @returns {void}
 */
function renderServerFileList(files) {
  fileCache.clear();
  files.forEach((file) => fileCache.set(file.id, file));
  dom.serverFileEmpty.hidden = files.length > 0;
  if (!files.length) {
    dom.serverFileEmpty.textContent = '업로드된 파일이 없습니다.';
    dom.serverFileList.innerHTML = '';
    return;
  }
  dom.serverFileList.innerHTML = files.map((file) => (
    `<li class="server-file-item">
      <button type="button" class="server-file-pick" data-pick-id="${escapeAttr(file.id)}" title="${escapeAttr(file.name)}">
        <span class="server-file-name">${escapeHtml(file.name)}</span>
        <span class="server-file-meta">${escapeHtml(fmtBytes(file.size))} · ${escapeHtml(formatUploadedAt(file.uploadedAt))}</span>
      </button>
      <button type="button" class="server-file-remove" data-delete-id="${escapeAttr(file.id)}" title="서버에서 삭제" aria-label="서버에서 삭제">×</button>
    </li>`
  )).join('');
}

/**
 * 목록 항목 클릭 시 해당 서버 파일 분석을 시작한다.
 * @param {string} id 파일 ID
 * @returns {void}
 */
function handlePickClick(id) {
  const file = fileCache.get(id);
  if (file) onFilePick(file);
}

/**
 * 삭제 버튼 클릭을 처리한다.
 * @param {string} id 파일 ID
 * @param {Event} e 클릭 이벤트
 * @returns {Promise<void>}
 */
async function handleDeleteClick(id, e) {
  e.preventDefault();
  e.stopPropagation();
  const row = e.target.closest('.server-file-item');
  const name = row?.querySelector('.server-file-name')?.textContent || '이 파일';
  if (!window.confirm(`"${name}"을(를) 서버에서 삭제할까요?`)) return;

  setLibraryBusy(true, '삭제 중…');
  try {
    const res = await fetch(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || data.error || '삭제 실패');
    await refreshServerFileList();
    setLibraryBusy(false, '');
  } catch (err) {
    setLibraryBusy(false, '삭제 실패: ' + (err.message || err));
  }
}

/**
 * 라이브러리 패널 상태 메시지를 표시한다.
 * @param {boolean} busy 로딩 중 여부
 * @param {string} message 상태 메시지
 * @returns {void}
 */
function setLibraryBusy(busy, message) {
  if (dom.libraryStatus) {
    dom.libraryStatus.hidden = !message;
    dom.libraryStatus.textContent = message || '';
    dom.libraryStatus.classList.toggle('loading', busy);
  }
  if (dom.libraryUploadBtn) dom.libraryUploadBtn.classList.toggle('disabled', busy);
}

/**
 * ISO 날짜 문자열을 짧은 로컬 표시로 변환한다.
 * @param {string} iso ISO 8601 문자열
 * @returns {string} 표시용 문자열
 */
function formatUploadedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * HTML 속성값에 넣을 문자열을 이스케이프한다.
 * @param {string} s 원본 문자열
 * @returns {string} 이스케이프된 문자열
 */
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#96;');
}
