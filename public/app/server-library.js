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
 * 파일을 서버 라이브러리에 업로드한다. XMLHttpRequest로 진행률을 표시한다.
 * @param {File} file 업로드할 파일
 * @returns {Promise<void>}
 */
export async function uploadFileToLibrary(file) {
  if (!file) return;
  showUploadProgress(file.name, 0, file.size, file.size > 0);
  try {
    await postLibraryUploadWithProgress(file, (loaded, total) => {
      showUploadProgress(file.name, loaded, total, total > 0);
    });
    hideUploadProgress();
    setLibraryBusy(true, `"${file.name}" 처리 중…`);
    await refreshServerFileList();
    clearLibraryStatus();
  } catch (err) {
    hideUploadProgress();
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
 * FormData 업로드를 XMLHttpRequest로 전송하고 upload progress 이벤트를 받는다.
 * @param {File} file 업로드할 파일
 * @param {(loaded:number, total:number) => void} onProgress 진행 콜백
 * @returns {Promise<{file:object}>} 서버 응답 JSON
 */
function postLibraryUploadWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('video', file);

    xhr.open('POST', '/api/library');
    xhr.upload.addEventListener('progress', (e) => {
      onProgress(e.loaded, e.lengthComputable ? e.total : 0);
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      reject(new Error(data.detail || data.error || `업로드 실패 (HTTP ${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('네트워크 오류')));
    xhr.addEventListener('abort', () => reject(new Error('업로드가 취소되었습니다')));

    xhr.send(form);
  });
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
    clearLibraryStatus();
  } catch (err) {
    setLibraryBusy(false, '삭제 실패: ' + (err.message || err));
  }
}

/**
 * 업로드 진행률 UI를 갱신한다.
 * @param {string} fileName 파일명
 * @param {number} loaded 전송된 바이트
 * @param {number} total 전체 바이트(0이면 불명)
 * @param {boolean} computable total이 신뢰 가능한지
 * @returns {void}
 */
function showUploadProgress(fileName, loaded, total, computable) {
  if (!dom.libraryStatus) return;
  dom.libraryStatus.hidden = false;
  dom.libraryStatus.classList.add('loading');

  if (dom.libraryStatusText) {
    dom.libraryStatusText.textContent = `"${fileName}" 업로드 중…`;
  }
  if (dom.libraryProgress) {
    dom.libraryProgress.hidden = false;
    dom.libraryProgress.classList.toggle('indeterminate', !computable);
  }
  if (dom.libraryProgressBar) {
    const pct = computable && total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    dom.libraryProgressBar.style.width = `${pct}%`;
  }
  if (dom.libraryProgressLabel) {
    if (computable && total > 0) {
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      dom.libraryProgressLabel.textContent = `${pct}% · ${fmtBytes(loaded)} / ${fmtBytes(total)}`;
    } else {
      dom.libraryProgressLabel.textContent = `${fmtBytes(loaded)} 전송됨`;
    }
  }
  if (dom.libraryUploadBtn) dom.libraryUploadBtn.classList.add('disabled');
}

/**
 * 업로드 진행률 UI를 숨긴다.
 * @returns {void}
 */
function hideUploadProgress() {
  if (dom.libraryProgress) {
    dom.libraryProgress.hidden = true;
    dom.libraryProgress.classList.remove('indeterminate');
  }
  if (dom.libraryProgressBar) dom.libraryProgressBar.style.width = '0%';
  if (dom.libraryProgressLabel) dom.libraryProgressLabel.textContent = '';
}

/**
 * 라이브러리 패널 상태 메시지를 표시한다.
 * @param {boolean} busy 로딩 중 여부
 * @param {string} message 상태 메시지
 * @returns {void}
 */
function setLibraryBusy(busy, message) {
  hideUploadProgress();
  if (dom.libraryStatus) {
    dom.libraryStatus.hidden = !message;
    dom.libraryStatus.classList.toggle('loading', busy);
  }
  if (dom.libraryStatusText) dom.libraryStatusText.textContent = message || '';
  if (dom.libraryUploadBtn) dom.libraryUploadBtn.classList.toggle('disabled', busy);
}

/**
 * 라이브러리 상태 배너를 초기화한다.
 * @returns {void}
 */
function clearLibraryStatus() {
  hideUploadProgress();
  if (dom.libraryStatus) {
    dom.libraryStatus.hidden = true;
    dom.libraryStatus.classList.remove('loading');
  }
  if (dom.libraryStatusText) dom.libraryStatusText.textContent = '';
  if (dom.libraryUploadBtn) dom.libraryUploadBtn.classList.remove('disabled');
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
