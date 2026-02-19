<script>
  import { onDestroy, onMount, tick } from 'svelte';
  import { navigate } from 'astro:transitions/client';

  let {
    pagePath,
    pageName,
    basePath,
    previewPath,
    initialFields = [],
    collectionRefs = [],
  } = $props();

  // Local mutable copies (intentionally captures initial value only)
  // svelte-ignore state_referenced_locally
  let fields = $state(JSON.parse(JSON.stringify(initialFields)));

  // Section group collapse state (group id → collapsed)
  let collapsed = $state({});

  // Derive groups from fields. Deterministic order by first field appearance.
  let groups = $derived.by(() => {
    const map = new Map();
    for (let i = 0; i < fields.length; i++) {
      const g = fields[i].group || '';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(i);
    }
    return [...map.entries()].map(([id, indices]) => {
      // Label: first heading field value, fallback to capitalized tag name
      const headingIdx = indices.find(i =>
        fields[i].kind === 'text' && /^h[1-6] text$/.test(fields[i].label)
      );
      const headingValue = headingIdx !== undefined ? fields[headingIdx].value.trim() : '';
      const tagLabel = id ? id.replace(/:\d+$/, '').charAt(0).toUpperCase() + id.replace(/:\d+$/, '').slice(1) : 'Page';
      return {
        id,
        label: headingValue || tagLabel,
        indices,
      };
    });
  });

  let showGroupChrome = $derived(groups.length >= 2);
  let showNavBar = $derived(showGroupChrome && groups.length >= 3);
  let activeGroup = $state('');

  function toggleGroup(id) {
    collapsed[id] = !collapsed[id];
  }

  async function scrollToGroup(id) {
    activeGroup = id;
    if (collapsed[id]) collapsed[id] = false;
    await tick();
    const el = document.getElementById(`mimsy-group-${CSS.escape(id)}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // IntersectionObserver for active group tracking
  let observer = null;
  const visibleGroupIds = new Set();

  onMount(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.dataset.groupId ?? '';
          if (entry.isIntersecting) visibleGroupIds.add(id);
          else visibleGroupIds.delete(id);
        }
        // Active = topmost visible card in document order
        const allCards = document.querySelectorAll('[data-group-id]');
        for (const el of allCards) {
          if (visibleGroupIds.has(el.dataset.groupId)) {
            activeGroup = el.dataset.groupId ?? '';
            return;
          }
        }
      },
      { rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    requestAnimationFrame(() => {
      document.querySelectorAll('[data-group-id]').forEach((el) => observer.observe(el));
    });
  });

  // Autosave + save state
  let saveState = $state('clean');
  let autosaveTimer = null;
  let saveController = null;

  // Preview
  let previewOpen = $state(
    typeof localStorage !== 'undefined' && localStorage.getItem('mimsy-preview') === 'open'
  );

  // Raw code view
  let showRaw = $state(false);

  function copyRaw() {
    const data = {};
    for (const field of fields) data[field.label || field.id] = field.value;
    navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(
      () => toast('Copied to clipboard', 'success'),
      () => toast('Failed to copy', 'error'),
    );
  }

  function toast(message, type) {
    window.dispatchEvent(new CustomEvent('mimsy:toast', { detail: { message, type } }));
  }

  let pendingDirty = false;

  function scheduleAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    if (saveState === 'saving') { pendingDirty = true; return; }
    saveState = 'dirty';
    autosaveTimer = setTimeout(() => save(false), 1500);
  }

  onDestroy(() => {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    if (saveController) saveController.abort();
    if (observer) observer.disconnect();
  });

  function handleFieldInput(index, value) {
    fields[index].value = value;
    scheduleAutosave();
  }

  async function save(manual = true) {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    if (saveController) saveController.abort();
    saveController = new AbortController();
    const { signal } = saveController;
    pendingDirty = false;

    // Build edits: only changed fields
    const edits = [];
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].value !== initialFields[i]?.value) {
        edits.push({
          id: fields[i].id,
          oldValue: initialFields[i].value,
          value: fields[i].value,
        });
      }
    }

    if (edits.length === 0) {
      saveState = 'clean';
      if (manual) toast('No changes to save', 'success');
      return true;
    }

    saveState = 'saving';
    try {
      const res = await fetch(`/api/mimsy/page-text/${pagePath}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits }),
        signal,
      });
      if (signal.aborted) return false;
      if (res.ok) {
        // Update initialFields to reflect saved state
        initialFields = JSON.parse(JSON.stringify(fields));
        saveState = 'saved';
        if (manual) toast('Changes saved', 'success');
        const iframe = document.getElementById('mimsy-preview-frame');
        if (iframe) iframe.src = iframe.src;
        setTimeout(() => { if (saveState === 'saved') saveState = 'clean'; }, 2000);
        if (pendingDirty) scheduleAutosave();
        return true;
      } else {
        const data = await res.json();
        saveState = 'dirty';
        toast(data.error || 'Failed to save.', 'error');
        return false;
      }
    } catch (err) {
      if (err.name === 'AbortError') return false;
      saveState = 'dirty';
      toast('Network error. Please try again.', 'error');
      return false;
    }
  }

  function togglePreview() {
    previewOpen = !previewOpen;
    localStorage.setItem('mimsy-preview', previewOpen ? 'open' : 'closed');
  }

  function handleKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save(true);
    }
    if (e.key === 'Escape') {
      const palette = document.getElementById('mimsy-palette');
      if (palette && !palette.hidden) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        document.activeElement.blur();
      } else {
        navigate(basePath);
      }
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div>
  <!-- Header -->
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
    <div class="flex items-center gap-3 min-w-0">
      <a
        href={basePath}
        class="mimsy-btn-back"
        title="Back"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
      </a>
      <div class="min-w-0">
        <h1 class="mimsy-page-heading truncate">{pageName}</h1>
        <p class="text-xs text-stone-400 font-mono truncate mt-0.5">{pagePath}</p>
      </div>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      {#if saveState === 'dirty'}
        <span class="mimsy-save-state mimsy-save-dirty">Unsaved changes</span>
      {:else if saveState === 'saving'}
        <span class="mimsy-save-state mimsy-save-saving">Saving…</span>
      {:else if saveState === 'saved'}
        <span class="mimsy-save-state mimsy-save-saved">Saved</span>
      {/if}
      <button onclick={() => { showRaw = !showRaw; }} class="mimsy-btn-secondary" class:ring-2={showRaw} class:ring-violet-400={showRaw} title={showRaw ? 'Show form' : 'View raw data'}>
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" /></svg>
      </button>
      <button onclick={togglePreview} class="mimsy-btn-secondary" title={previewOpen ? 'Close preview' : 'Open preview'}>
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
      </button>
      <button onclick={() => save(true)} disabled={saveState === 'saving'} class="mimsy-btn-primary">
        {saveState === 'saving' ? 'Saving...' : 'Save'}
      </button>
    </div>
  </div>

  <div class="mimsy-editor-wrap">
    {#if showRaw}
      <div class="max-w-3xl">
        <div class="mimsy-card p-5">
          <div class="flex items-center justify-between mb-3">
            <p class="mimsy-section-title" style="margin-bottom:0">Raw Data</p>
            <button onclick={copyRaw} class="text-xs text-stone-400 hover:text-stone-600 font-medium transition-colors" style="border:none;background:none;cursor:pointer;">Copy</button>
          </div>
          <pre class="text-xs font-mono leading-relaxed text-stone-600 bg-stone-50 border border-stone-100 rounded-lg p-4 overflow-auto max-h-[60vh] whitespace-pre-wrap break-all">{JSON.stringify(fields.map(f => ({ id: f.id, label: f.label, kind: f.kind, value: f.value, group: f.group || undefined })), null, 2)}</pre>
        </div>
      </div>
    {:else}
    <div class="max-w-2xl space-y-5">
      {#if fields.length === 0}
        <div class="mimsy-card p-8 text-center">
          <p class="text-stone-400 text-sm">No editable text found on this page.</p>
          <p class="text-stone-300 text-xs mt-1">Dynamic expressions and code blocks are not editable.</p>
        </div>
      {:else}
        {#if showNavBar}
          <div class="sticky top-0 z-10 flex gap-1.5 flex-wrap py-2 px-1 -mx-1 bg-white/80 backdrop-blur-sm">
            {#each groups as group}
              <button
                type="button"
                onclick={() => scrollToGroup(group.id)}
                class="px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors duration-100"
                class:bg-stone-800={activeGroup === group.id}
                class:text-white={activeGroup === group.id}
                class:bg-stone-100={activeGroup !== group.id}
                class:text-stone-500={activeGroup !== group.id}
                class:hover:bg-stone-200={activeGroup !== group.id}
              >
                {group.label}
              </button>
            {/each}
          </div>
        {/if}
        {#each groups as group}
          <div class="mimsy-card" id={`mimsy-group-${group.id}`} data-group-id={group.id}>
            {#if showGroupChrome}
              <button
                type="button"
                onclick={() => toggleGroup(group.id)}
                class="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-stone-50/50 transition-colors duration-100"
                style="border: none; background: none; cursor: pointer; border-radius: 0.75rem;"
              >
                <span class="text-xs font-semibold text-stone-500">{group.label}</span>
                <svg
                  class="w-3.5 h-3.5 text-stone-400 transition-transform duration-150"
                  style:transform={collapsed[group.id] ? 'rotate(-90deg)' : 'rotate(0deg)'}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
              </button>
            {/if}
            {#if !showGroupChrome || !collapsed[group.id]}
              <div class="px-5 pb-5" class:pt-5={!showGroupChrome} class:pt-2={showGroupChrome}>
                {#if !showGroupChrome}
                  <p class="mimsy-section-title">Page Text</p>
                {/if}
                <div class="space-y-4">
                  {#each group.indices as idx}
                    {@const field = fields[idx]}
                    <div>
                      <label class="mimsy-label" for={`field-${field.id}`}>
                        {field.label}
                        {#if field.kind === 'attribute'}
                          <span class="text-stone-300 font-normal normal-case tracking-normal">· attr</span>
                        {/if}
                      </label>
                      {#if field.multiline}
                        <textarea
                          id={`field-${field.id}`}
                          value={field.value}
                          oninput={(e) => handleFieldInput(idx, e.target.value)}
                          class="mimsy-input"
                          rows="3"
                        ></textarea>
                      {:else}
                        <input
                          type="text"
                          id={`field-${field.id}`}
                          value={field.value}
                          oninput={(e) => handleFieldInput(idx, e.target.value)}
                          class="mimsy-input"
                        />
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/each}
      {/if}

      {#if collectionRefs.length > 0}
        <div class="mimsy-card p-5">
          <p class="mimsy-section-title">Uses Collections</p>
          <div class="flex flex-wrap gap-2">
            {#each collectionRefs as ref}
              <a
                href={`${basePath}/${ref}`}
                class="mimsy-btn-secondary text-xs"
              >
                {ref.charAt(0).toUpperCase() + ref.slice(1)}
              </a>
            {/each}
          </div>
        </div>
      {/if}
    </div>
    {/if}

    <!-- Preview overlay -->
    <div class="mimsy-preview-panel" class:mimsy-preview-open={previewOpen}>
      <div class="mimsy-preview-header">
        <span class="mimsy-section-title" style="margin-bottom:0">Preview</span>
        <button onclick={togglePreview} class="mimsy-toast-close" title="Close preview">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/></svg>
        </button>
      </div>
      {#if previewOpen}
        <iframe id="mimsy-preview-frame" src={previewPath} title="Page preview" class="mimsy-preview-iframe"></iframe>
      {/if}
    </div>
  </div>
</div>
