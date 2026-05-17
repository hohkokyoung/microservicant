const PROCESSOR_LABELS = {
  virusScanner: 'Virus Scanner',
  thumbnailGenerator: 'Thumbnail Generator',
  metadataIndexer: 'Metadata Indexer',
  storageOptimizer: 'Storage Optimizer',
};

const PROCESSOR_ORDER = [
  'virusScanner',
  'thumbnailGenerator',
  'metadataIndexer',
  'storageOptimizer',
];

// fileId → polling interval id
const pollingIntervals = new Map();

// ── Upload handling ──────────────────────────────────────────────────────────

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const uploadingIndicator = document.getElementById('uploading-indicator');

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadFile(fileInput.files[0]);
});

dropzone.addEventListener('dragover', e => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
});

async function uploadFile(file) {
  uploadingIndicator.classList.remove('hidden');

  const form = new FormData();
  form.append('file', file);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    if (!res.ok) throw new Error(await res.text());

    const { fileId, fileName } = await res.json();
    renderFileCard(fileId, fileName, file.size, file.type);
    startPolling(fileId);
  } catch (err) {
    alert('Upload failed: ' + err.message);
  } finally {
    uploadingIndicator.classList.add('hidden');
    fileInput.value = '';
  }
}

// ── Status polling ───────────────────────────────────────────────────────────

function startPolling(fileId) {
  const id = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${fileId}`);
      if (!res.ok) return;
      const status = await res.json();
      updateFileCard(status);

      if (status.overallStatus !== 'processing') {
        clearInterval(id);
        pollingIntervals.delete(fileId);
      }
    } catch (_) {}
  }, 2000);

  pollingIntervals.set(fileId, id);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderFileCard(fileId, fileName, fileSize, mimeType) {
  document.getElementById('emptyState').style.display = 'none';

  const card = document.createElement('div');
  card.className = 'file-card';
  card.id = `card-${fileId}`;
  card.innerHTML = `
    <div class="file-card-header">
      <div>
        <div class="file-name">${escHtml(fileName)}</div>
        <div class="file-meta">${formatBytes(fileSize)} &middot; ${escHtml(mimeType)}</div>
      </div>
      <span class="overall-badge badge-processing">Processing</span>
    </div>
    <div class="processors">
      ${PROCESSOR_ORDER.map(p => processorChipHtml(p, { status: 'pending' }, fileId)).join('')}
    </div>
  `;

  document.getElementById('fileList').prepend(card);
}

function updateFileCard(status) {
  const card = document.getElementById(`card-${status.fileId}`);
  if (!card) return;

  const badge = card.querySelector('.overall-badge');
  badge.className = `overall-badge badge-${status.overallStatus}`;
  badge.textContent = formatOverallStatus(status.overallStatus);

  PROCESSOR_ORDER.forEach(p => {
    const chip = card.querySelector(`#chip-${status.fileId}-${p}`);
    if (chip) chip.outerHTML = processorChipHtml(p, status.processors[p], status.fileId);
  });
}

function processorChipHtml(processorKey, processor, fileId = 'init') {
  const label = PROCESSOR_LABELS[processorKey] ?? processorKey;
  const status = processor?.status ?? 'pending';
  const detail = buildDetail(processorKey, processor);

  return `
    <div class="processor-chip" id="chip-${fileId}-${processorKey}">
      <div class="processor-chip-header">
        <span class="processor-dot dot-${status}"></span>
        <span class="processor-name">${label}</span>
      </div>
      <div class="processor-status-text">${capitalise(status)}</div>
      ${detail ? `<div class="processor-detail">${detail}</div>` : ''}
    </div>
  `;
}

function buildDetail(processor, data) {
  if (!data?.result) return '';
  const r = data.result;

  switch (processor) {
    case 'virusScanner':
      return r.clean
        ? `Clean &middot; ${r.engine} &middot; ${r.scanDurationMs}ms`
        : `Threat: ${escHtml(r.error ?? 'unknown')}`;

    case 'thumbnailGenerator':
      if (!r.generated) return `Placeholder (${escHtml(String(r.iconType))})`;
      return `${r.dimensions?.width}×${r.dimensions?.height} &middot; ${escHtml(r.format)}`;

    case 'metadataIndexer':
      return [
        r.category && capitalise(String(r.category)),
        Array.isArray(r.tags) ? r.tags.map(t => `#${t}`).join(' ') : '',
        r.sizeHuman,
      ].filter(Boolean).join(' &middot; ');

    case 'storageOptimizer':
      return r.optimized
        ? `Saved ${r.compressionRatio} &middot; ${escHtml(r.algorithm)}`
        : `Skipped — ${escHtml(r.reason ?? 'already compressed')}`;

    default:
      return '';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatOverallStatus(s) {
  if (s === 'partial_failure') return 'Partial Failure';
  return capitalise(s);
}

function capitalise(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
