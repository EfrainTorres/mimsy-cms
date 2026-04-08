<script>
  /**
   * MediaLibrary — dual-mode Svelte island.
   * mode='library'  → full-page media manager
   * mode='picker'   → modal invoked via mimsy:media:open CustomEvent
   */
  import { onMount, onDestroy } from 'svelte';

  let {
    mode = 'library',   // 'library' | 'picker'
    basePath = '/admin',
    isR2 = false,
  } = $props();

  // --- Picker-mode state (modal) ---
  let pickerOpen = $state(false);
  let pickerCallback = $state(null);
  let pickerAlt = $state('');

  // --- Shared state ---
  let objects = $state([]);
  let loading = $state(false);
  let error = $state('');
  let cursor = $state(null);
  let hasMore = $state(false);
  let unavailable = $state(false);

  // --- Library-mode state ---
  let selected = $state(null);   // selected object in library mode
  let search = $state('');
  let dragOver = $state(false);

  // --- Picker-mode state ---
  let pickerSelected = $state(null);

  // --- Upload queue ---
  let uploads = $state([]);  // [{ id, name, progress, status, error }]
  const MAX_CONCURRENT = 3;

  // --- Filter ---
  let filtered = $derived(
    search.trim()
      ? objects.filter(o =>
          o.filename.toLowerCase().includes(search.toLowerCase())
        )
      : objects
  );

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async function loadMedia(reset = false) {
    if (loading) return;
    if (!reset && !hasMore && objects.length > 0) return;
    loading = true;
    error = '';
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (!reset && cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/mimsy/media?${params}`);
      const data = await res.json();
      if (data.unavailable) { unavailable = true; loading = false; return; }
      if (!res.ok) { error = data.error || 'Failed to load media'; loading = false; return; }
      if (reset) {
        objects = data.objects;
      } else {
        objects = [...objects, ...data.objects];
      }
      cursor = data.cursor;
      hasMore = data.hasMore;
    } catch (e) {
      error = 'Network error';
    }
    loading = false;
  }

  // --- Upload via XHR (for progress) ---
  function uploadFiles(files) {
    const imageFiles = [...files].filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    const newUploads = imageFiles.map(f => ({
      id: Math.random().toString(36).slice(2),
      name: f.name,
      progress: 0,
      status: 'queued',  // 'queued' | 'uploading' | 'done' | 'error'
      error: '',
      file: f,
      xhr: null,
    }));
    uploads = [...uploads, ...newUploads];
    processUploadQueue();
  }

  function processUploadQueue() {
    const active = uploads.filter(u => u.status === 'uploading').length;
    const queued = uploads.filter(u => u.status === 'queued');
    const slots = MAX_CONCURRENT - active;
    for (let i = 0; i < Math.min(slots, queued.length); i++) {
      startUpload(queued[i].id);
    }
  }

  function startUpload(id) {
    const uploadIdx = uploads.findIndex(u => u.id === id);
    if (uploadIdx === -1) return;

    const upload = uploads[uploadIdx];
    const formData = new FormData();
    formData.append('file', upload.file);

    const xhr = new XMLHttpRequest();
    uploads[uploadIdx] = { ...upload, status: 'uploading', xhr };
    uploads = [...uploads];

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const idx = uploads.findIndex(u => u.id === id);
        if (idx >= 0) {
          uploads[idx] = { ...uploads[idx], progress: Math.round(e.loaded / e.total * 100) };
          uploads = [...uploads];
        }
      }
    });

    xhr.addEventListener('load', () => {
      const idx = uploads.findIndex(u => u.id === id);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          // Prepend to objects grid
          const filename = upload.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const newObj = {
            key: data.key || '',
            url: data.url,
            filename,
            size: upload.file.size,
            contentType: upload.file.type,
            uploaded: new Date().toISOString(),
          };
          objects = [newObj, ...objects];
        } catch {}
        if (idx >= 0) {
          uploads[idx] = { ...uploads[idx], status: 'done', progress: 100 };
          uploads = [...uploads];
        }
      } else {
        let errMsg = 'Upload failed';
        try { errMsg = JSON.parse(xhr.responseText).error || errMsg; } catch {}
        toast(errMsg, 'error');
        if (idx >= 0) {
          uploads[idx] = { ...uploads[idx], status: 'error', error: errMsg };
          uploads = [...uploads];
        }
      }
      // Remove done/error from queue after delay, then process next
      setTimeout(() => {
        const i = uploads.findIndex(u => u.id === id);
        if (i >= 0 && (uploads[i].status === 'done' || uploads[i].status === 'error')) {
          uploads = uploads.filter(u => u.id !== id);
        }
        processUploadQueue();
      }, 1500);
    });

    xhr.addEventListener('error', () => {
      const idx = uploads.findIndex(u => u.id === id);
      if (idx >= 0) {
        uploads[idx] = { ...uploads[idx], status: 'error', error: 'Network error' };
        uploads = [...uploads];
      }
      processUploadQueue();
    });

    xhr.open('POST', '/api/mimsy/upload');
    xhr.send(formData);
  }

  function cancelUpload(id) {
    const idx = uploads.findIndex(u => u.id === id);
    if (idx >= 0 && uploads[idx].xhr) {
      uploads[idx].xhr.abort();
      uploads = uploads.filter(u => u.id !== id);
      processUploadQueue();
    }
  }

  async function deleteObject(obj) {
    if (!confirm(`Delete "${obj.filename}"?\n\nThis image may still be referenced in your content.`)) return;
    try {
      const res = await fetch(`/api/mimsy/media?key=${encodeURIComponent(obj.key)}`, { method: 'DELETE' });
      if (res.ok || res.status === 204) {
        objects = objects.filter(o => o.key !== obj.key);
        if (selected?.key === obj.key) selected = null;
        if (pickerSelected?.key === obj.key) pickerSelected = null;
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.error || 'Delete failed', 'error');
      }
    } catch {
      toast('Network error', 'error');
    }
  }

  function copyUrl(url) {
    navigator.clipboard.writeText(url).then(
      () => toast('URL copied', 'success'),
      () => toast('Copy failed', 'error'),
    );
  }

  function toast(msg, type = 'success') {
    window.dispatchEvent(new CustomEvent('mimsy:toast', { detail: { message: msg, type } }));
  }

  // --- File input ---
  let fileInput = $state(null);
  function triggerFileInput() { fileInput?.click(); }
  function onFileInputChange(e) {
    uploadFiles(e.target.files);
    e.target.value = '';
  }

  // --- Drag & drop (library mode only) ---
  function onBodyDragOver(e) {
    if (mode !== 'library') return;
    e.preventDefault();
    dragOver = true;
  }
  function onBodyDragLeave(e) {
    if (!e.relatedTarget || !document.body.contains(e.relatedTarget)) dragOver = false;
  }
  function onBodyDrop(e) {
    if (mode !== 'library') return;
    e.preventDefault();
    dragOver = false;
    uploadFiles(e.dataTransfer.files);
  }

  // --- Paste (library mode only) ---
  function onWindowPaste(e) {
    if (mode !== 'library') return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) uploadFiles(files);
  }

  // --- Picker event listener ---
  function onMediaOpen(e) {
    pickerCallback = e.detail?.callback ?? null;
    pickerSelected = null;
    pickerAlt = '';
    pickerOpen = true;
    if (objects.length === 0 && !loading) loadMedia(true);
  }

  function pickerInsert() {
    if (!pickerSelected || !pickerCallback) return;
    pickerCallback(pickerSelected.url, pickerAlt);
    pickerOpen = false;
    pickerCallback = null;
  }

  function pickerCancel() {
    pickerOpen = false;
    pickerCallback = null;
  }

  onMount(() => {
    if (mode === 'library') {
      loadMedia(true);
      document.body.addEventListener('dragover', onBodyDragOver);
      document.body.addEventListener('dragleave', onBodyDragLeave);
      document.body.addEventListener('drop', onBodyDrop);
      window.addEventListener('paste', onWindowPaste);
    }
    // Picker listens regardless of mode (always mounted in AdminLayout)
    window.addEventListener('mimsy:media:open', onMediaOpen);
  });

  onDestroy(() => {
    if (mode === 'library') {
      document.body.removeEventListener('dragover', onBodyDragOver);
      document.body.removeEventListener('dragleave', onBodyDragLeave);
      document.body.removeEventListener('drop', onBodyDrop);
      window.removeEventListener('paste', onWindowPaste);
    }
    window.removeEventListener('mimsy:media:open', onMediaOpen);
  });
</script>

<!-- ─── PICKER MODE ─── -->
{#if pickerOpen && mode === 'picker'}
  <div class="mimsy-picker-overlay" role="dialog" aria-modal="true" aria-label="Insert Image">
    <div class="mimsy-picker-panel">
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3 border-b border-stone-200">
        <span class="text-sm font-semibold text-stone-700">Insert Image</span>
        <button onclick={pickerCancel} class="mimsy-toast-close" title="Close">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>

      <!-- Toolbar -->
      <div class="flex items-center gap-3 px-4 py-2.5 border-b border-stone-100 bg-stone-50/50">
        <button onclick={triggerFileInput} class="mimsy-btn-secondary text-xs">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg>
          Upload
        </button>
        <div class="mimsy-search-wrapper flex-1">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>
          <input bind:value={search} type="text" placeholder="Search…" class="mimsy-input text-sm" />
        </div>
      </div>

      <!-- Grid -->
      <div class="mimsy-picker-grid">
        {#if loading && filtered.length === 0}
          <div class="col-span-4 text-center py-8 text-sm text-stone-400">Loading…</div>
        {:else if unavailable}
          <div class="col-span-4 text-center py-8 text-sm text-stone-400">Configure R2 to browse media library</div>
        {:else if filtered.length === 0 && !loading}
          <div class="col-span-4 text-center py-8 text-sm text-stone-400">No images yet. Upload one above.</div>
        {:else}
          {#each filtered as obj}
            <button
              type="button"
              onclick={() => pickerSelected = pickerSelected?.key === obj.key ? null : obj}
              class="mimsy-thumb"
              class:selected={pickerSelected?.key === obj.key}
              title={obj.filename}
            >
              <img src={obj.url} alt={obj.filename} loading="lazy" />
              {#if pickerSelected?.key === obj.key}
                <span class="mimsy-thumb-check">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="m4.5 12.75 6 6 9-13.5" /></svg>
                </span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>

      <!-- Alt text + actions -->
      {#if pickerSelected}
        <div class="px-4 py-3 border-t border-stone-100 bg-stone-50/50 space-y-3">
          <div>
            <label class="mimsy-label" for="picker-alt">Alt text</label>
            <input id="picker-alt" bind:value={pickerAlt} type="text" class="mimsy-input text-sm" placeholder="Describe the image for accessibility" />
          </div>
        </div>
      {/if}

      <div class="flex items-center justify-end gap-2 px-4 py-3 border-t border-stone-200">
        <button onclick={pickerCancel} class="mimsy-btn-secondary text-sm">Cancel</button>
        <button onclick={pickerInsert} disabled={!pickerSelected} class="mimsy-btn-primary text-sm">Insert</button>
      </div>
    </div>
  </div>
{/if}

<!-- ─── LIBRARY MODE ─── -->
{#if mode === 'library'}
  {#if dragOver}
    <div class="mimsy-drag-overlay">Drop images to upload</div>
  {/if}

  <div class="xl:grid xl:grid-cols-3 xl:gap-6 min-h-[calc(100vh-12rem)]">
    <!-- Left: grid + toolbar -->
    <div class="xl:col-span-2 space-y-4">
      <!-- Toolbar -->
      <div class="mimsy-card p-4 flex flex-wrap items-center gap-3">
        <button onclick={triggerFileInput} class="mimsy-btn-primary text-sm">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg>
          Upload
        </button>
        <div class="mimsy-search-wrapper flex-1 min-w-[160px]">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>
          <input bind:value={search} type="text" placeholder="Search…" class="mimsy-input" />
        </div>
      </div>

      <!-- Upload progress -->
      {#if uploads.length > 0}
        <div class="mimsy-card p-4 space-y-2">
          {#each uploads as u}
            <div class="flex items-center gap-3 text-sm">
              <span class="flex-1 truncate text-stone-600 text-xs font-mono">{u.name}</span>
              {#if u.status === 'done'}
                <svg class="w-4 h-4 text-emerald-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m4.5 12.75 6 6 9-13.5" /></svg>
              {:else if u.status === 'error'}
                <span class="text-red-500 text-xs shrink-0">{u.error}</span>
              {:else if u.status === 'queued'}
                <span class="text-stone-400 text-xs shrink-0">Queued</span>
              {:else}
                <div class="flex items-center gap-2 flex-1">
                  <div class="mimsy-progress-track flex-1">
                    <div class="mimsy-progress-fill" style="width:{u.progress}%"></div>
                  </div>
                  <span class="text-xs text-stone-500 tabular-nums w-8 text-right shrink-0">{u.progress}%</span>
                  <button onclick={() => cancelUpload(u.id)} class="text-stone-400 hover:text-red-500 shrink-0" title="Cancel" style="border:none;background:none;cursor:pointer;padding:0;">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <!-- Error -->
      {#if error}
        <div class="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">{error}</div>
      {/if}

      <!-- Unavailable (GitHub without R2) -->
      {#if unavailable}
        <div class="mimsy-card p-12 text-center">
          <p class="text-stone-500 text-sm font-medium">Media library unavailable</p>
          <p class="text-stone-400 text-xs mt-1">Configure R2 in your Mimsy config to browse and manage media.</p>
        </div>

      <!-- Empty state -->
      {:else if filtered.length === 0 && uploads.length === 0 && !loading}
        <div class="mimsy-card border-2 border-dashed border-stone-200 p-16 text-center">
          <svg class="w-10 h-10 text-stone-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
          <p class="text-stone-500 text-sm font-medium">Drop images here or click Upload</p>
          <p class="text-stone-400 text-xs mt-1">PNG, JPG, GIF, WebP, AVIF</p>
          <button onclick={triggerFileInput} class="mimsy-btn-secondary text-sm mt-4">Choose files</button>
        </div>

      <!-- Grid -->
      {:else}
        <div class="mimsy-library-grid">
          {#each filtered as obj}
            <button
              type="button"
              onclick={() => selected = selected?.key === obj.key ? null : obj}
              class="mimsy-thumb"
              class:selected={selected?.key === obj.key}
              title={obj.filename}
            >
              <img src={obj.url} alt={obj.filename} loading="lazy" />
            </button>
          {/each}
        </div>

        {#if loading}
          <div class="text-center py-4 text-sm text-stone-400">Loading…</div>
        {:else if hasMore}
          <div class="text-center py-4">
            <button onclick={() => loadMedia(false)} class="mimsy-btn-secondary text-sm">Load 50 more</button>
          </div>
        {/if}
      {/if}
    </div>

    <!-- Right: detail panel -->
    <div class="mt-5 xl:mt-0">
      {#if selected}
        <div class="mimsy-card p-5 xl:sticky xl:top-6 space-y-4">
          <img src={selected.url} alt={selected.filename} class="w-full rounded-lg object-cover max-h-48" />
          <div>
            <p class="text-sm font-medium text-stone-700 break-all">{selected.filename}</p>
            <p class="text-xs text-stone-400 mt-1">{formatSize(selected.size)} &middot; {formatDate(selected.uploaded)}</p>
            <p class="text-[10px] font-mono text-stone-400 mt-0.5 break-all">{selected.contentType}</p>
          </div>
          <div class="space-y-2">
            <button onclick={() => copyUrl(selected.url)} class="mimsy-btn-secondary text-sm w-full">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" /></svg>
              Copy URL
            </button>
            <button onclick={() => deleteObject(selected)} class="mimsy-btn-danger text-sm w-full">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
              Delete
            </button>
          </div>
        </div>
      {:else}
        <div class="xl:sticky xl:top-6 text-center py-8 px-4 text-stone-400 text-sm">
          <p>Select an image to see details</p>
        </div>
      {/if}
    </div>
  </div>

  <input bind:this={fileInput} type="file" accept="image/*" multiple class="hidden" onchange={onFileInputChange} />
{:else if mode === 'picker'}
  <!-- picker mode but not open — render nothing (just the event listener via onMount) -->
  <input bind:this={fileInput} type="file" accept="image/*" multiple class="hidden" onchange={onFileInputChange} />
{/if}

<style>
  /* ── Picker overlay ── */
  .mimsy-picker-overlay {
    position: fixed;
    inset: 0;
    z-index: 9997;
    background: rgba(28, 25, 23, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .mimsy-picker-panel {
    background: #fff;
    border-radius: 0.75rem;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.18);
    width: 100%;
    max-width: 42rem;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .mimsy-picker-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.5rem;
    padding: 0.75rem;
    overflow-y: auto;
    flex: 1;
    min-height: 200px;
    max-height: 340px;
  }

  /* ── Library grid ── */
  .mimsy-library-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 0.5rem;
  }

  /* ── Thumbnail ── */
  .mimsy-thumb {
    position: relative;
    aspect-ratio: 1;
    border-radius: 0.5rem;
    overflow: hidden;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
    background: #f5f5f4;
    transition: border-color 150ms ease;
  }
  .mimsy-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .mimsy-thumb:hover {
    border-color: #a78bfa;
  }
  .mimsy-thumb.selected {
    border-color: #7c3aed;
  }
  .mimsy-thumb-check {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 20px;
    height: 20px;
    background: #7c3aed;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
  }

  /* ── Drag overlay ── */
  .mimsy-drag-overlay {
    position: fixed;
    inset: 0;
    z-index: 9996;
    background: rgba(124, 58, 237, 0.12);
    border: 3px dashed #7c3aed;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.25rem;
    font-weight: 600;
    color: #7c3aed;
    pointer-events: none;
  }

  /* ── Progress bar ── */
  .mimsy-progress-track {
    height: 4px;
    border-radius: 2px;
    background: #e7e5e4;
    overflow: hidden;
  }
  .mimsy-progress-fill {
    height: 100%;
    background: #7c3aed;
    border-radius: 2px;
    transition: width 100ms linear;
  }
</style>
