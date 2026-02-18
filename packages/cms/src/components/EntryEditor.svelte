<script>
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
  } = $props();

  // Local mutable copies of initial data
  let frontmatter = $state(JSON.parse(JSON.stringify(initialFrontmatter)));
  let bodyContent = $state(initialBody + '');
  let status = $state({ message: '', type: '' });
  let saving = $state(false);

  function showStatus(message, type) {
    status = { message, type };
    if (type === 'success') {
      setTimeout(() => { status = { message: '', type: '' }; }, 3000);
    }
  }

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
  }

  function handleArrayFieldChange(key, rawValue) {
    frontmatter[key] = rawValue.split(',').map((s) => s.trim()).filter(Boolean);
  }

  async function save() {
    saving = true;
    try {
      const res = await fetch(`/api/mimsy/content/${collection}/${slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frontmatter, content: bodyContent }),
      });
      if (res.ok) {
        showStatus('Changes saved', 'success');
      } else {
        const data = await res.json();
        showStatus(data.error || 'Failed to save.', 'error');
      }
    } catch {
      showStatus('Network error. Please try again.', 'error');
    }
    saving = false;
  }

  async function del() {
    if (!confirm(`Delete "${slug}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/mimsy/content/${collection}/${slug}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        window.location.href = `${basePath}/${collection}`;
      } else {
        showStatus('Failed to delete.', 'error');
      }
    } catch {
      showStatus('Network error. Please try again.', 'error');
    }
  }

  async function toggleDraft() {
    frontmatter.draft = !frontmatter.draft;
    await save();
    showStatus(frontmatter.draft ? 'Moved to draft' : 'Published', 'success');
  }

  function handleKeydown(e) {
    // Cmd/Ctrl+S → Save
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
    // Escape → Back to collection list (only when not in an input/editor)
    if (e.key === 'Escape') {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        document.activeElement.blur();
      } else {
        window.location.href = `${basePath}/${collection}`;
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
      <button
        onclick={toggleDraft}
        disabled={saving}
        class="mimsy-status-badge cursor-pointer transition-all hover:scale-105 disabled:opacity-50 {frontmatter.draft ? 'mimsy-status-draft' : 'mimsy-status-published'}"
      >
        <span class="mimsy-status-dot"></span>
        {frontmatter.draft ? 'Draft' : 'Published'}
      </button>
      <button onclick={save} disabled={saving} class="mimsy-btn-primary">
        {saving ? 'Saving...' : 'Save'}
      </button>
      <button onclick={del} class="mimsy-btn-danger">Delete</button>
    </div>
  </div>

  <!-- Status toast -->
  {#if status.message}
    <div class="mimsy-toast {status.type === 'success' ? 'mimsy-toast-success' : 'mimsy-toast-error'}">
      {#if status.type === 'success'}
        <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m4.5 12.75 6 6 9-13.5" /></svg>
      {:else}
        <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" /></svg>
      {/if}
      {status.message}
    </div>
  {/if}

  {#if !isDataCollection}
    <!-- Two-column layout for content collections (xl+ = 1280px) -->
    <div class="xl:grid xl:grid-cols-3 xl:gap-6">
      <!-- Sidebar: fields + SEO (first in DOM → shows first on mobile; placed right on desktop) -->
      <div class="mb-5 xl:mb-0 xl:col-start-3">
        <div class="xl:sticky xl:top-6 space-y-5">
          {@render fieldsCard()}
          {@render seoCard()}
        </div>
      </div>

      <!-- Main: content editor (second in DOM → shows after fields on mobile; placed left on desktop) -->
      <div class="xl:col-start-1 xl:col-span-2 xl:row-start-1">
        <div class="mimsy-card p-5">
          <p class="mimsy-section-title">Content</p>
          <TiptapEditor
            content={initialBody}
            onchange={(md) => { bodyContent = md; }}
          />
        </div>
      </div>
    </div>
  {:else}
    <!-- Single column for data collections -->
    <div class="max-w-2xl space-y-5">
      {@render fieldsCard()}
      {@render seoCard()}
    </div>
  {/if}
</div>
