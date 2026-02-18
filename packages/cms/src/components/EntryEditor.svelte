<script>
  import { onDestroy } from 'svelte';
  import { navigate } from 'astro:transitions/client';
  import TiptapEditor from './TiptapEditor.svelte';
  import SeoPreview from './SeoPreview.svelte';

  /**
   * @typedef {Object} SchemaField
   * @property {string} name
   * @property {string} type
   * @property {boolean} required
   * @property {*} [defaultValue]
   * @property {string[]} [enumValues]
   * @property {string} [referenceCollection]
   */

  let {
    collection,
    slug,
    basePath,
    initialFrontmatter = {},
    initialBody = '',
    isDataCollection = false,
    schemaFields = [],
    referenceOptions = {},
    previewPath = `/${collection}/${slug}`,
  } = $props();

  // Local mutable copies of initial data
  let frontmatter = $state(JSON.parse(JSON.stringify(initialFrontmatter)));
  let bodyContent = $state(initialBody + '');

  // Autosave + save state
  let saveState = $state('clean'); // 'clean' | 'dirty' | 'saving' | 'saved'
  let autosaveTimer = null;
  let saveController = null;

  // Preview
  let previewOpen = $state(
    typeof localStorage !== 'undefined' && localStorage.getItem('mimsy-preview') === 'open'
  );

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
  });

  function getFieldDef(key) {
    return schemaFields.find((f) => f.name === key);
  }

  function getFieldType(key, value) {
    const def = getFieldDef(key);
    if (def) return def.type;
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Date) return 'date';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
    return 'string';
  }

  function getFieldKeys() {
    if (schemaFields.length > 0) {
      const schemaKeys = schemaFields.map((f) => f.name);
      const extraKeys = Object.keys(frontmatter).filter((k) => !schemaKeys.includes(k));
      return [...schemaKeys, ...extraKeys];
    }
    return Object.keys(frontmatter);
  }

  function handleFieldChange(key, value) {
    frontmatter[key] = value;
    scheduleAutosave();
  }

  function handleArrayFieldChange(key, rawValue) {
    frontmatter[key] = rawValue.split(',').map((s) => s.trim()).filter(Boolean);
    scheduleAutosave();
  }

  async function save(manual = true) {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    if (saveController) saveController.abort();
    saveController = new AbortController();
    const { signal } = saveController;
    pendingDirty = false;

    saveState = 'saving';
    try {
      const res = await fetch(`/api/mimsy/content/${collection}/${slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frontmatter, content: bodyContent }),
        signal,
      });
      if (signal.aborted) return false;
      if (res.ok) {
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
        let msg = data.error || 'Failed to save.';
        if (data.fieldErrors) {
          const details = Object.entries(data.fieldErrors)
            .map(([field, errs]) => `${field}: ${errs.join(', ')}`)
            .join(' · ');
          if (details) msg += ' — ' + details;
        }
        toast(msg, 'error');
        return false;
      }
    } catch (err) {
      if (err.name === 'AbortError') return false;
      saveState = 'dirty';
      toast('Network error. Please try again.', 'error');
      return false;
    }
  }

  async function del() {
    if (!confirm(`Delete "${slug}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/mimsy/content/${collection}/${slug}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast('Entry deleted', 'success');
        navigate(`${basePath}/${collection}`);
      } else {
        toast('Failed to delete.', 'error');
      }
    } catch {
      toast('Network error. Please try again.', 'error');
    }
  }

  async function toggleDraft() {
    frontmatter.draft = !frontmatter.draft;
    const ok = await save(false);
    if (ok) {
      toast(frontmatter.draft ? 'Moved to draft' : 'Published', 'success');
    } else {
      frontmatter.draft = !frontmatter.draft; // revert on failure
    }
  }

  function togglePreview() {
    previewOpen = !previewOpen;
    localStorage.setItem('mimsy-preview', previewOpen ? 'open' : 'closed');
  }

  function handleKeydown(e) {
    // Cmd/Ctrl+S → manual save (with toast)
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save(true);
    }
    // Escape — let command palette handle first if open
    if (e.key === 'Escape') {
      const palette = document.getElementById('mimsy-palette');
      if (palette && !palette.hidden) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        document.activeElement.blur();
      } else {
        navigate(`${basePath}/${collection}`);
      }
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Reusable fields card snippet (used in both two-column and single-column layouts) -->
{#snippet fieldsCard()}
  <div class="mimsy-card p-5">
    <p class="mimsy-section-title">Fields</p>
    <div class="space-y-4">
      {#each getFieldKeys() as key}
        {@const fieldType = getFieldType(key, frontmatter[key])}
        {@const fieldDef = getFieldDef(key)}
        <div>
          <label class="mimsy-label" for={`field-${key}`}>
            {key}
            {#if fieldDef && !fieldDef.required}
              <span class="text-stone-300 font-normal normal-case tracking-normal">&middot; optional</span>
            {/if}
          </label>

          {#if fieldType === 'boolean'}
            <label class="inline-flex items-center gap-2.5 cursor-pointer group">
              <span class="relative inline-flex items-center">
                <input
                  type="checkbox"
                  id={`field-${key}`}
                  checked={!!frontmatter[key]}
                  onchange={(e) => handleFieldChange(key, e.target.checked)}
                  class="peer sr-only"
                />
                <span class="w-8 h-5 rounded-full bg-stone-200 peer-checked:bg-violet-500 transition-colors"></span>
                <span class="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transform peer-checked:translate-x-3 transition-transform"></span>
              </span>
              <span class="text-sm text-stone-600">{frontmatter[key] ? 'Yes' : 'No'}</span>
            </label>

          {:else if fieldType === 'enum' && fieldDef?.enumValues}
            <select
              id={`field-${key}`}
              value={frontmatter[key] ?? ''}
              onchange={(e) => handleFieldChange(key, e.target.value)}
              class="mimsy-select"
            >
              {#if !fieldDef.required}
                <option value="">None</option>
              {/if}
              {#each fieldDef.enumValues as val}
                <option value={val}>{val}</option>
              {/each}
            </select>

          {:else if fieldType === 'reference'}
            {@const options = referenceOptions[fieldDef?.referenceCollection] ?? referenceOptions[key] ?? []}
            {#if options.length > 0}
              <select
                id={`field-${key}`}
                value={frontmatter[key] ?? ''}
                onchange={(e) => handleFieldChange(key, e.target.value)}
                class="mimsy-select"
              >
                {#if !fieldDef?.required}
                  <option value="">None</option>
                {/if}
                {#each options as opt}
                  <option value={opt.slug}>{opt.label}</option>
                {/each}
              </select>
            {:else}
              <input
                type="text"
                id={`field-${key}`}
                value={frontmatter[key] ?? ''}
                oninput={(e) => handleFieldChange(key, e.target.value)}
                class="mimsy-input"
                placeholder="Reference slug"
              />
            {/if}

          {:else if fieldType === 'array'}
            <input
              type="text"
              id={`field-${key}`}
              value={Array.isArray(frontmatter[key]) ? frontmatter[key].join(', ') : ''}
              oninput={(e) => handleArrayFieldChange(key, e.target.value)}
              class="mimsy-input"
              placeholder="Comma-separated values"
            />

          {:else if fieldType === 'date'}
            <input
              type="date"
              id={`field-${key}`}
              value={frontmatter[key] instanceof Date
                ? frontmatter[key].toISOString().split('T')[0]
                : (frontmatter[key] ?? '').toString().split('T')[0]}
              oninput={(e) => handleFieldChange(key, e.target.value)}
              class="mimsy-input max-w-xs"
            />

          {:else if fieldType === 'number'}
            <input
              type="number"
              id={`field-${key}`}
              value={frontmatter[key] ?? ''}
              oninput={(e) => handleFieldChange(key, Number(e.target.value))}
              class="mimsy-input"
            />

          {:else}
            <input
              type="text"
              id={`field-${key}`}
              value={frontmatter[key] ?? ''}
              oninput={(e) => handleFieldChange(key, e.target.value)}
              class="mimsy-input"
            />
          {/if}
        </div>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet seoCard()}
  <SeoPreview
    title={frontmatter.title || frontmatter.name || ''}
    description={frontmatter.description || ''}
    {slug}
    {collection}
    {basePath}
  />
{/snippet}

<div>
  <!-- Header -->
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
    <div class="flex items-center gap-3 min-w-0">
      <a
        href={`${basePath}/${collection}`}
        class="mimsy-btn-back"
        title="Back"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
      </a>
      <h1 class="mimsy-page-heading truncate">
        {frontmatter.title || frontmatter.name || slug}
      </h1>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      {#if saveState === 'dirty'}
        <span class="mimsy-save-state mimsy-save-dirty">Unsaved changes</span>
      {:else if saveState === 'saving'}
        <span class="mimsy-save-state mimsy-save-saving">Saving…</span>
      {:else if saveState === 'saved'}
        <span class="mimsy-save-state mimsy-save-saved">Saved</span>
      {/if}
      <button
        onclick={toggleDraft}
        disabled={saveState === 'saving'}
        class="mimsy-status-badge cursor-pointer transition-all hover:scale-105 disabled:opacity-50 {frontmatter.draft ? 'mimsy-status-draft' : 'mimsy-status-published'}"
      >
        <span class="mimsy-status-dot"></span>
        {frontmatter.draft ? 'Draft' : 'Published'}
      </button>
      {#if !isDataCollection}
        <button onclick={togglePreview} class="mimsy-btn-secondary" title={previewOpen ? 'Close preview' : 'Open preview'}>
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
        </button>
      {/if}
      <button onclick={() => save(true)} disabled={saveState === 'saving'} class="mimsy-btn-primary">
        {saveState === 'saving' ? 'Saving...' : 'Save'}
      </button>
      <button onclick={del} class="mimsy-btn-danger">Delete</button>
    </div>
  </div>

  <div class="mimsy-editor-wrap">
    {#if !isDataCollection}
      <!-- Two-column layout for content collections (xl+ = 1280px) -->
      <div class="xl:grid xl:grid-cols-3 xl:gap-6">
        <!-- Sidebar: fields + SEO -->
        <div class="mb-5 xl:mb-0 xl:col-start-3">
          <div class="xl:sticky xl:top-6 space-y-5">
            {@render fieldsCard()}
            {@render seoCard()}
          </div>
        </div>

        <!-- Main: content editor -->
        <div class="xl:col-start-1 xl:col-span-2 xl:row-start-1">
          <div class="mimsy-card p-5">
            <p class="mimsy-section-title">Content</p>
            <TiptapEditor
              content={initialBody}
              onchange={(md) => { bodyContent = md; scheduleAutosave(); }}
            />
          </div>
        </div>
      </div>

      <!-- Preview overlay (always in DOM, animated via CSS) -->
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
    {:else}
      <!-- Single column for data collections -->
      <div class="max-w-2xl space-y-5">
        {@render fieldsCard()}
        {@render seoCard()}
      </div>
    {/if}
  </div>
</div>
