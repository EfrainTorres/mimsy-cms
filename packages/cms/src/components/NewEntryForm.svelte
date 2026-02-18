<script>
  import { navigate } from 'astro:transitions/client';
  import TiptapEditor from './TiptapEditor.svelte';

  let {
    collection,
    basePath,
    isDataCollection = false,
    schemaFields = [],
    referenceOptions = {},
    templateBody = '',
    templateFrontmatter = {},
  } = $props();

  let title = $state('');
  let slug = $state('');
  let slugManuallyEdited = $state(false);
  let bodyContent = $state(templateBody || '');
  let creating = $state(false);

  function toast(message, type) {
    window.dispatchEvent(new CustomEvent('mimsy:toast', { detail: { message, type } }));
  }
  let slugWarning = $state('');
  let checkingSlug = $state(false);
  let slugCheckTimer = null;

  let extraFields = $state({});

  $effect(() => {
    const defaults = {};
    for (const field of schemaFields) {
      if (field.name === 'title' || field.name === 'name') continue;
      if (field.defaultValue !== undefined) {
        defaults[field.name] = field.defaultValue;
      } else if (field.type === 'boolean') {
        defaults[field.name] = false;
      } else if (field.type === 'array') {
        defaults[field.name] = [];
      } else {
        defaults[field.name] = '';
      }
    }
    if (templateFrontmatter && typeof templateFrontmatter === 'object') {
      for (const [key, value] of Object.entries(templateFrontmatter)) {
        if (key === 'title' || key === 'name' || key === 'draft') continue;
        if (value !== undefined && value !== '') {
          defaults[key] = value;
        }
      }
    }
    extraFields = defaults;
  });

  function generateSlug(text) {
    return text.toLowerCase().trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  async function checkSlugUniqueness() {
    const trimmed = slug.trim();
    if (!trimmed) { slugWarning = ''; return; }
    checkingSlug = true;
    slugWarning = '';
    try {
      const res = await fetch(`/api/mimsy/content/${collection}/${trimmed}`);
      slugWarning = res.status === 200 ? 'taken' : res.status === 404 ? 'available' : '';
    } catch { slugWarning = ''; }
    checkingSlug = false;
  }

  function debouncedSlugCheck() {
    if (slugCheckTimer) clearTimeout(slugCheckTimer);
    slugCheckTimer = setTimeout(checkSlugUniqueness, 500);
  }

  function handleTitleInput(e) {
    title = e.target.value;
    if (!slugManuallyEdited) {
      slug = generateSlug(title);
      debouncedSlugCheck();
    }
  }

  function handleSlugInput(e) {
    slug = e.target.value;
    slugManuallyEdited = true;
  }

  function getFieldDef(key) {
    return schemaFields.find((f) => f.name === key);
  }

  function getExtraFieldKeys() {
    if (schemaFields.length > 0) {
      return schemaFields.map((f) => f.name).filter((k) => k !== 'title' && k !== 'name' && k !== 'draft');
    }
    return [];
  }

  function handleFieldChange(key, value) {
    extraFields = { ...extraFields, [key]: value };
  }

  function handleArrayFieldChange(key, rawValue) {
    extraFields = { ...extraFields, [key]: rawValue.split(',').map((s) => s.trim()).filter(Boolean) };
  }

  async function create() {
    const trimmedTitle = title.trim();
    const trimmedSlug = slug.trim();
    if (!trimmedTitle || !trimmedSlug) {
      toast('Title and slug are required.', 'error');
      return;
    }
    creating = true;

    const frontmatter = { title: trimmedTitle, draft: true };
    for (const [key, value] of Object.entries(extraFields)) {
      if (value !== '' && value !== undefined) {
        frontmatter[key] = value;
      }
    }

    try {
      const res = await fetch(`/api/mimsy/content/${collection}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: trimmedSlug, frontmatter, content: bodyContent }),
      });
      if (res.ok) {
        toast('Entry created', 'success');
        navigate(`${basePath}/${collection}/${trimmedSlug}`);
      } else if (res.status === 409) {
        toast('An entry with this slug already exists.', 'error');
      } else {
        const data = await res.json();
        toast(data.error || 'Failed to create entry.', 'error');
      }
    } catch {
      toast('Network error. Please try again.', 'error');
    }
    creating = false;
  }

  function handleKeydown(e) {
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

<div class="max-w-3xl">
  <!-- Header -->
  <div class="flex items-center gap-3 mb-8">
    <a
      href={`${basePath}/${collection}`}
      class="mimsy-btn-back"
      title="Back"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
    </a>
    <h1 class="mimsy-page-heading capitalize">New {collection} Entry</h1>
  </div>

  <!-- Title + Slug + Extra fields -->
  <div class="mimsy-card p-5 sm:p-6 mb-5 space-y-4">
    <!-- Title -->
    <div>
      <label class="mimsy-label" for="field-title">Title</label>
      <input
        type="text"
        id="field-title"
        value={title}
        oninput={handleTitleInput}
        class="mimsy-input"
        placeholder="Enter a title..."
      />
    </div>

    <!-- Slug -->
    <div>
      <label class="mimsy-label" for="field-slug">Slug</label>
      <input
        type="text"
        id="field-slug"
        value={slug}
        oninput={handleSlugInput}
        onblur={checkSlugUniqueness}
        class="mimsy-input font-mono text-xs"
        placeholder="auto-generated-from-title"
      />
      {#if checkingSlug}
        <p class="mt-1.5 text-[11px] text-stone-400 flex items-center gap-1">
          <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
          Checking...
        </p>
      {:else if slugWarning === 'taken'}
        <p class="mt-1.5 text-[11px] text-red-600 flex items-center gap-1">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12" /></svg>
          Already taken
        </p>
      {:else if slugWarning === 'available'}
        <p class="mt-1.5 text-[11px] text-emerald-600 flex items-center gap-1">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m4.5 12.75 6 6 9-13.5" /></svg>
          Available
        </p>
      {/if}
    </div>

    <!-- Schema-driven extra fields -->
    {#each getExtraFieldKeys() as key}
      {@const fieldDef = getFieldDef(key)}
      {#if fieldDef}
        <div>
          <label class="mimsy-label" for={`field-${key}`}>
            {key}
            {#if !fieldDef.required}
              <span class="text-stone-300 font-normal normal-case tracking-normal">&middot; optional</span>
            {/if}
          </label>

          {#if fieldDef.type === 'boolean'}
            <label class="inline-flex items-center gap-2.5 cursor-pointer group">
              <span class="relative inline-flex items-center">
                <input
                  type="checkbox"
                  id={`field-${key}`}
                  checked={!!extraFields[key]}
                  onchange={(e) => handleFieldChange(key, e.target.checked)}
                  class="peer sr-only"
                />
                <span class="w-8 h-5 rounded-full bg-stone-200 peer-checked:bg-violet-500 transition-colors"></span>
                <span class="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transform peer-checked:translate-x-3 transition-transform"></span>
              </span>
              <span class="text-sm text-stone-600">{extraFields[key] ? 'Yes' : 'No'}</span>
            </label>

          {:else if fieldDef.type === 'enum' && fieldDef.enumValues}
            <select
              id={`field-${key}`}
              value={extraFields[key] ?? ''}
              onchange={(e) => handleFieldChange(key, e.target.value)}
              class="mimsy-select"
            >
              {#if !fieldDef.required}<option value="">None</option>{/if}
              {#each fieldDef.enumValues as val}<option value={val}>{val}</option>{/each}
            </select>

          {:else if fieldDef.type === 'reference'}
            {@const options = referenceOptions[fieldDef.referenceCollection] ?? referenceOptions[key] ?? []}
            {#if options.length > 0}
              <select
                id={`field-${key}`}
                value={extraFields[key] ?? ''}
                onchange={(e) => handleFieldChange(key, e.target.value)}
                class="mimsy-select"
              >
                {#if !fieldDef.required}<option value="">None</option>{/if}
                {#each options as opt}<option value={opt.slug}>{opt.label}</option>{/each}
              </select>
            {:else}
              <input type="text" id={`field-${key}`} value={extraFields[key] ?? ''} oninput={(e) => handleFieldChange(key, e.target.value)} class="mimsy-input" placeholder="Reference slug" />
            {/if}

          {:else if fieldDef.type === 'array'}
            <input type="text" id={`field-${key}`} value={Array.isArray(extraFields[key]) ? extraFields[key].join(', ') : ''} oninput={(e) => handleArrayFieldChange(key, e.target.value)} class="mimsy-input" placeholder="Comma-separated values" />

          {:else if fieldDef.type === 'date'}
            <input type="date" id={`field-${key}`} value={extraFields[key] ?? ''} oninput={(e) => handleFieldChange(key, e.target.value)} class="mimsy-input max-w-xs" />

          {:else if fieldDef.type === 'number'}
            <input type="number" id={`field-${key}`} value={extraFields[key] ?? ''} oninput={(e) => handleFieldChange(key, Number(e.target.value))} class="mimsy-input" />

          {:else}
            <input type="text" id={`field-${key}`} value={extraFields[key] ?? ''} oninput={(e) => handleFieldChange(key, e.target.value)} class="mimsy-input" />
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <!-- Body editor -->
  {#if !isDataCollection}
    <div class="mimsy-card p-5 sm:p-6 mb-5">
      <p class="mimsy-section-title">Content</p>
      <TiptapEditor
        content={templateBody || ''}
        onchange={(md) => { bodyContent = md; }}
      />
    </div>
  {/if}

  <!-- Actions -->
  <div class="flex items-center gap-3">
    <button onclick={create} disabled={creating} class="mimsy-btn-primary">
      {creating ? 'Creating...' : 'Create Entry'}
    </button>
    <a href={`${basePath}/${collection}`} class="mimsy-btn-secondary">Cancel</a>
  </div>
</div>
