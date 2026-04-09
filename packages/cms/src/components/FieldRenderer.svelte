<script>
  /**
   * FieldRenderer — recursive field rendering for schema-driven forms.
   * Handles scalars, nested objects, repeaters (array of objects),
   * and block arrays (discriminated union / union with common literal).
   */
  import { getContext } from 'svelte';
  import FieldRenderer from './FieldRenderer.svelte';
  import { formatLabel } from '../utils/format-label.js';

  let {
    fieldDef,
    value,
    onchange,
    referenceOptions = {},
    fieldId = '',
    depth = 0,
  } = $props();

  // basePath is provided via context by EntryEditor / NewEntryForm so it
  // doesn't have to be threaded through every recursive FieldRenderer call.
  const basePath = getContext('mimsyBasePath') ?? '';

  // Reference picker state (per-instance: each FieldRenderer has its own)
  let refQuery = $state('');
  let refOpen = $state(false);

  // Detect string fields that likely hold image URLs — shows browse button + preview.
  // Uses description (.describe() text) and field name as hints.
  // Field stays type 'string' so overlay matching/editing is unaffected.
  const IMAGE_HINT_DESC = /\bimage\b|\bphoto\b|\bavatar\b|\bthumbnail\b|\bposter\b/i;
  const IMAGE_HINT_NAME = /^(image|img|photo|avatar|icon|logo|thumb(nail)?|poster|cover(Image)?|banner|hero(Image)?|og(Image)?|featured(Image)?)$/i;
  let imageHinted = $derived(
    fieldDef.type === 'string' && (
      (fieldDef.description && IMAGE_HINT_DESC.test(fieldDef.description)) ||
      IMAGE_HINT_NAME.test(fieldDef.name)
    )
  );

  // Only show <img> preview when value actually looks like a URL, not random text.
  const URL_LIKE = /^(https?:\/\/|\/|\.\/|\.\.\/)/;
  let showImagePreview = $derived(imageHinted && value && URL_LIKE.test(value));

  // Focus action for search inputs in dropdown
  function focusEl(node) { node.focus(); }

  // Block add dropdown
  let showBlockMenu = $state(false);

  // Collapsed state for repeater/block items (index → boolean)
  let collapsed = $state({});

  // Per-item code view (index → boolean)
  let showCode = $state({});

  function toggleCollapse(index) {
    collapsed[index] = !collapsed[index];
  }

  // Array manipulation
  function addItem(defaultItem) {
    const copy = JSON.parse(JSON.stringify(defaultItem));
    onchange([...(value ?? []), copy]);
  }

  function removeItem(index) {
    const next = [...value];
    next.splice(index, 1);
    // Shift collapsed and showCode states
    const newCollapsed = {};
    const newShowCode = {};
    for (const [k, v] of Object.entries(collapsed)) {
      const ki = Number(k);
      if (ki < index) newCollapsed[ki] = v;
      else if (ki > index) newCollapsed[ki - 1] = v;
    }
    for (const [k, v] of Object.entries(showCode)) {
      const ki = Number(k);
      if (ki < index) newShowCode[ki] = v;
      else if (ki > index) newShowCode[ki - 1] = v;
    }
    collapsed = newCollapsed;
    showCode = newShowCode;
    onchange(next);
  }

  function moveItem(from, to) {
    const next = [...value];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    // Swap collapsed state
    const fc = collapsed[from];
    const tc = collapsed[to];
    collapsed[from] = tc;
    collapsed[to] = fc;
    onchange(next);
  }

  function updateArrayItem(index, newItem) {
    const next = [...value];
    next[index] = newItem;
    onchange(next);
  }

  function updateObjectField(key, newValue) {
    onchange({ ...(value ?? {}), [key]: newValue });
  }

  function getVariantForItem(item) {
    if (!fieldDef.arrayItemType?.blockConfig) return null;
    const disc = fieldDef.arrayItemType.blockConfig.discriminator;
    return fieldDef.arrayItemType.blockConfig.variants.find(v => v.type === item[disc]) ?? null;
  }

  function generateObjectDefaults(fields) {
    const obj = {};
    for (const f of fields) {
      if (f.defaultValue !== undefined) { obj[f.name] = JSON.parse(JSON.stringify(f.defaultValue)); continue; }
      if (!f.required) continue;
      if (f.type === 'string' || f.type === 'reference') obj[f.name] = '';
      else if (f.type === 'number') obj[f.name] = 0;
      else if (f.type === 'boolean') obj[f.name] = false;
      else if (f.type === 'date') obj[f.name] = new Date().toISOString().split('T')[0];
      else if (f.type === 'array') obj[f.name] = [];
      else if (f.type === 'object' && f.objectFields) obj[f.name] = generateObjectDefaults(f.objectFields);
      else obj[f.name] = '';
    }
    return obj;
  }
</script>

<!-- Boolean -->
{#if fieldDef.type === 'boolean'}
  <label class="inline-flex items-center gap-2.5 cursor-pointer group">
    <span class="relative inline-flex items-center">
      <input
        type="checkbox"
        id={fieldId}
        checked={!!value}
        onchange={(e) => onchange(e.target.checked)}
        class="peer sr-only"
      />
      <span class="w-8 h-5 rounded-full bg-stone-200 peer-checked:bg-violet-500 transition-colors"></span>
      <span class="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transform peer-checked:translate-x-3 transition-transform"></span>
    </span>
    <span class="text-sm text-stone-600">{value ? 'Yes' : 'No'}</span>
  </label>

<!-- Enum -->
{:else if fieldDef.type === 'enum' && fieldDef.enumValues}
  <select
    id={fieldId}
    value={value ?? ''}
    onchange={(e) => onchange(e.target.value)}
    class="mimsy-select"
  >
    {#if !fieldDef.required}<option value="">None</option>{/if}
    {#each fieldDef.enumValues as val}<option value={val}>{val}</option>{/each}
  </select>

<!-- Reference -->
{:else if fieldDef.type === 'reference'}
  {@const options = referenceOptions[fieldDef.referenceCollection] ?? referenceOptions[fieldDef.name] ?? []}
  {#if options.length > 0}
    {@const selectedLabel = options.find(o => o.slug === value)?.label ?? (value || '')}
    {@const filtered = refQuery ? options.filter(o =>
      o.label.toLowerCase().includes(refQuery.toLowerCase()) ||
      o.slug.toLowerCase().includes(refQuery.toLowerCase())
    ) : options}
    <div style="position:relative;">
      <!-- Trigger button -->
      <button
        type="button"
        id={fieldId}
        onclick={() => { refOpen = !refOpen; if (refOpen) refQuery = ''; }}
        class="mimsy-input flex items-center justify-between w-full text-left"
        style="cursor:pointer;gap:0.5rem;"
        aria-haspopup="listbox"
        aria-expanded={refOpen}
      >
        <span class="truncate text-sm {value ? 'text-stone-800' : 'text-stone-400'}">{selectedLabel || 'Select…'}</span>
        <svg class="w-4 h-4 text-stone-400 shrink-0 transition-transform duration-150" style:transform={refOpen ? 'rotate(180deg)' : ''} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m19 9-7 7-7-7"/></svg>
      </button>
      {#if refOpen}
        <!-- Backdrop to close on outside click -->
        <div style="position:fixed;inset:0;z-index:49;" onclick={() => { refOpen = false; refQuery = ''; }} role="presentation" aria-hidden="true"></div>
        <!-- Dropdown panel -->
        <div style="position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:50;background:#fff;border:1px solid #e7e5e4;border-radius:0.5rem;box-shadow:0 4px 16px rgba(0,0,0,0.1);overflow:hidden;" role="listbox">
          <!-- Search (only for larger lists) -->
          {#if options.length > 6}
            <div style="padding:0.375rem;border-bottom:1px solid #f5f5f4;">
              <input
                use:focusEl
                type="text"
                placeholder="Search…"
                bind:value={refQuery}
                class="mimsy-input"
                style="padding:0.3125rem 0.625rem;font-size:0.8125rem;"
              />
            </div>
          {/if}
          <!-- Options -->
          <div style="max-height:11rem;overflow-y:auto;padding:0.25rem;">
            {#if !fieldDef.required}
              <button
                type="button"
                onclick={() => { onchange(''); refOpen = false; refQuery = ''; }}
                class="w-full text-left px-3 py-1.5 text-sm text-stone-400 hover:bg-stone-50 rounded"
                style="border:none;background:none;cursor:pointer;"
              >None</button>
            {/if}
            {#each filtered as opt}
              <button
                type="button"
                onclick={() => { onchange(opt.slug); refOpen = false; refQuery = ''; }}
                class="w-full text-left px-3 py-1.5 rounded flex items-center justify-between gap-2 {opt.slug === value ? 'bg-violet-50 text-violet-700 font-medium' : 'text-stone-700 hover:bg-stone-50'}"
                style="border:none;background:none;cursor:pointer;"
                role="option"
                aria-selected={opt.slug === value}
              >
                <span class="text-sm truncate">{opt.label}</span>
                <span style="font-family:monospace;font-size:10px;color:#a8a29e;flex-shrink:0;">{opt.slug}</span>
              </button>
            {/each}
            {#if filtered.length === 0}
              <p class="text-xs text-stone-400 text-center py-3">No matches</p>
            {/if}
          </div>
          <!-- Create new link -->
          {#if basePath && fieldDef.referenceCollection && fieldDef.referenceCollection !== '__unknown__'}
            <div style="border-top:1px solid #f5f5f4;padding:0.3125rem 0.5rem;">
              <a
                href="{basePath}/{fieldDef.referenceCollection}/new"
                target="_blank"
                rel="noopener noreferrer"
                onclick={() => { refOpen = false; }}
                class="flex items-center gap-1.5 text-xs text-violet-600 hover:text-violet-800 font-medium px-2 py-1 rounded hover:bg-violet-50"
                style="text-decoration:none;"
              >
                <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.5v15m7.5-7.5h-15"/></svg>
                Create new {fieldDef.referenceCollection}
              </a>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <input type="text" id={fieldId} value={value ?? ''} oninput={(e) => onchange(e.target.value)} class="mimsy-input" placeholder="Reference slug" />
  {/if}

<!-- Nested Object -->
{:else if fieldDef.type === 'object' && fieldDef.objectFields}
  <div class="space-y-3 pl-3 border-l-2 border-stone-100">
    {#each fieldDef.objectFields as subField}
      <div>
        <label class="mimsy-label" for={`${fieldId}-${subField.name}`}>
          {formatLabel(subField.name)}
          {#if !subField.required}
            <span class="text-stone-300 font-normal normal-case tracking-normal">&middot; optional</span>
          {/if}
        </label>
        <FieldRenderer
          fieldDef={subField}
          value={value?.[subField.name]}
          onchange={(v) => updateObjectField(subField.name, v)}
          {referenceOptions}
          fieldId={`${fieldId}-${subField.name}`}
          depth={depth + 1}
        />
      </div>
    {/each}
  </div>

<!-- Array: Block Builder (discriminated union) -->
{:else if fieldDef.type === 'array' && fieldDef.arrayItemType?.blockConfig}
  {@const config = fieldDef.arrayItemType.blockConfig}
  {@const items = Array.isArray(value) ? value : []}
  <div class="space-y-2">
    {#if items.length === 0}
      <p class="text-xs text-stone-400 py-3">No blocks yet.</p>
    {/if}
    {#each items as item, i}
      {@const variant = getVariantForItem(item)}
      <div class="border border-stone-200 rounded-lg overflow-hidden {depth === 0 ? 'border-l-2 border-l-violet-300' : ''}">
        <!-- Block header -->
        <div class="flex items-center gap-1.5 px-3 py-2 bg-stone-50">
          <button type="button" onclick={() => toggleCollapse(i)} class="flex items-center gap-2 flex-1 min-w-0 text-left" style="border:none;background:none;cursor:pointer;padding:0;">
            <svg
              class="w-3 h-3 text-stone-400 shrink-0 transition-transform duration-150"
              style:transform={collapsed[i] ? 'rotate(-90deg)' : 'rotate(0deg)'}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
            <span class="text-[10px] font-semibold uppercase tracking-wider text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded">
              {formatLabel(variant?.label ?? item[config.discriminator] ?? 'Block')}
            </span>
            {#if variant}
              {@const preview = item[variant.fields[0]?.name]}
              {#if typeof preview === 'string' && preview}
                <span class="text-xs text-stone-400 truncate">{preview}</span>
              {/if}
            {/if}
          </button>
          <div class="flex items-center gap-0.5 shrink-0">
            <button type="button" onclick={() => { showCode[i] = !showCode[i]; }} class="p-1 hover:text-stone-600 {showCode[i] ? 'text-violet-500' : 'text-stone-400'}" title={showCode[i] ? 'Show form' : 'View data'} style="border:none;background:none;cursor:pointer;">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" /></svg>
            </button>
            <button type="button" disabled={i === 0} onclick={() => moveItem(i, i - 1)} class="p-1 text-stone-400 hover:text-stone-600 disabled:opacity-30" title="Move up" style="border:none;background:none;cursor:pointer;">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m4.5 15.75 7.5-7.5 7.5 7.5" /></svg>
            </button>
            <button type="button" disabled={i === items.length - 1} onclick={() => moveItem(i, i + 1)} class="p-1 text-stone-400 hover:text-stone-600 disabled:opacity-30" title="Move down" style="border:none;background:none;cursor:pointer;">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
            </button>
            <button type="button" onclick={() => removeItem(i)} class="p-1 text-stone-400 hover:text-red-500" title="Remove block" style="border:none;background:none;cursor:pointer;">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
        <!-- Block fields / code view -->
        {#if showCode[i]}
          <pre class="px-3 py-3 text-[11px] font-mono leading-relaxed text-stone-500 bg-stone-50/50 overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(item, null, 2)}</pre>
        {:else if !collapsed[i] && variant}
          <div class="px-3 py-3 space-y-3">
            {#each variant.fields as subField}
              <div>
                <label class="mimsy-label" for={`${fieldId}-${i}-${subField.name}`}>
                  {subField.name}
                  {#if !subField.required}
                    <span class="text-stone-300 font-normal normal-case tracking-normal">&middot; optional</span>
                  {/if}
                </label>
                <FieldRenderer
                  fieldDef={subField}
                  value={item[subField.name]}
                  onchange={(v) => {
                    const updated = { ...item, [subField.name]: v };
                    updateArrayItem(i, updated);
                  }}
                  {referenceOptions}
                  fieldId={`${fieldId}-${i}-${subField.name}`}
                  depth={depth + 1}
                />
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
    <!-- Add block button -->
    <div class="relative">
      {#if config.variants.length === 1}
        <button type="button" onclick={() => addItem(config.variants[0].defaultItem)} class="mimsy-btn-secondary text-xs">
          + Add {config.variants[0].label}
        </button>
      {:else}
        <button type="button" onclick={() => { showBlockMenu = !showBlockMenu; }} class="mimsy-btn-secondary text-xs">
          + Add Block
        </button>
        {#if showBlockMenu}
          <div class="absolute left-0 top-full mt-1 z-20 bg-white border border-stone-200 rounded-lg shadow-lg py-1 min-w-[140px]">
            {#each config.variants as variant}
              <button
                type="button"
                onclick={() => { addItem(variant.defaultItem); showBlockMenu = false; }}
                class="w-full text-left px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
                style="border:none;background:none;cursor:pointer;"
              >
                {variant.label}
              </button>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>

<!-- Array: Repeater (array of objects without blockConfig) -->
{:else if fieldDef.type === 'array' && fieldDef.arrayItemType?.type === 'object' && fieldDef.arrayItemType?.objectFields}
  {@const itemFields = fieldDef.arrayItemType.objectFields}
  {@const items = Array.isArray(value) ? value : []}
  <div class="space-y-2">
    {#if items.length === 0}
      <p class="text-xs text-stone-400 py-3">No items yet.</p>
    {/if}
    {#each items as item, i}
      <div class="border border-stone-200 rounded-lg overflow-hidden {depth > 0 ? 'bg-stone-50/30' : ''}">
        <!-- Item header -->
        <div class="flex items-center gap-1.5 px-3 py-2 {depth > 0 ? 'bg-stone-100/50' : 'bg-stone-50'}">
          <button type="button" onclick={() => toggleCollapse(i)} class="flex items-center gap-2 flex-1 min-w-0 text-left" style="border:none;background:none;cursor:pointer;padding:0;">
            <svg
              class="w-3 h-3 text-stone-400 shrink-0 transition-transform duration-150"
              style:transform={collapsed[i] ? 'rotate(-90deg)' : 'rotate(0deg)'}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
            <span class="text-xs font-medium text-stone-500">
              {#if typeof item[itemFields[0]?.name] === 'string' && item[itemFields[0]?.name]}
                {item[itemFields[0].name]}
              {:else}
                Item {i + 1}
              {/if}
            </span>
          </button>
          <div class="flex items-center gap-0.5 shrink-0">
            <button type="button" onclick={() => { showCode[i] = !showCode[i]; }} class="p-1 hover:text-stone-600 {showCode[i] ? 'text-violet-500' : 'text-stone-400'}" title={showCode[i] ? 'Show form' : 'View data'} style="border:none;background:none;cursor:pointer;">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" /></svg>
            </button>
            <button type="button" disabled={i === 0} onclick={() => moveItem(i, i - 1)} class="p-1 text-stone-400 hover:text-stone-600 disabled:opacity-30" title="Move up" style="border:none;background:none;cursor:pointer;">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m4.5 15.75 7.5-7.5 7.5 7.5" /></svg>
            </button>
            <button type="button" disabled={i === items.length - 1} onclick={() => moveItem(i, i + 1)} class="p-1 text-stone-400 hover:text-stone-600 disabled:opacity-30" title="Move down" style="border:none;background:none;cursor:pointer;">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
            </button>
            <button type="button" onclick={() => removeItem(i)} class="p-1 text-stone-400 hover:text-red-500" title="Remove item" style="border:none;background:none;cursor:pointer;">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
        <!-- Item fields / code view -->
        {#if showCode[i]}
          <pre class="px-3 py-3 text-[11px] font-mono leading-relaxed text-stone-500 bg-stone-50/50 overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(item, null, 2)}</pre>
        {:else if !collapsed[i]}
          <div class="px-3 py-3 space-y-3">
            {#each itemFields as subField}
              <div>
                <label class="mimsy-label" for={`${fieldId}-${i}-${subField.name}`}>
                  {subField.name}
                  {#if !subField.required}
                    <span class="text-stone-300 font-normal normal-case tracking-normal">&middot; optional</span>
                  {/if}
                </label>
                <FieldRenderer
                  fieldDef={subField}
                  value={item[subField.name]}
                  onchange={(v) => {
                    const updated = { ...item, [subField.name]: v };
                    updateArrayItem(i, updated);
                  }}
                  {referenceOptions}
                  fieldId={`${fieldId}-${i}-${subField.name}`}
                  depth={depth + 1}
                />
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
    <!-- Add item button -->
    <button type="button" onclick={() => addItem(generateObjectDefaults(itemFields))} class="mimsy-btn-secondary text-xs">
      + Add Item
    </button>
  </div>

<!-- Array: Multi-select reference (z.array(reference('x'))) -->
{:else if fieldDef.type === 'array' && fieldDef.arrayItemType?.type === 'reference'}
  {@const arrRef = fieldDef.arrayItemType.referenceCollection ?? ''}
  {@const options = referenceOptions[arrRef] ?? []}
  {@const selected = Array.isArray(value) ? value : []}
  {@const filtered = options.filter(o =>
    !selected.includes(o.slug) &&
    (!refQuery || o.label.toLowerCase().includes(refQuery.toLowerCase()) || o.slug.toLowerCase().includes(refQuery.toLowerCase()))
  )}
  <div>
    <!-- Selected chips -->
    {#if selected.length > 0}
      <div class="flex flex-wrap gap-1.5 mb-2">
        {#each selected as selSlug}
          {@const label = options.find(o => o.slug === selSlug)?.label ?? selSlug}
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 border border-violet-200 text-xs text-violet-700 font-medium">
            {label}
            <button type="button" onclick={() => onchange(selected.filter(s => s !== selSlug))} style="border:none;background:none;cursor:pointer;padding:0;line-height:1;display:flex;align-items:center;" title="Remove">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/></svg>
            </button>
          </span>
        {/each}
      </div>
    {/if}
    <!-- Add dropdown -->
    <div style="position:relative;display:inline-block;">
      <button type="button" onclick={() => { refOpen = !refOpen; if (refOpen) refQuery = ''; }} class="mimsy-btn-secondary text-xs" style="cursor:pointer;">
        + Add {arrRef || 'item'}
      </button>
      {#if refOpen}
        <div style="position:fixed;inset:0;z-index:49;" onclick={() => { refOpen = false; refQuery = ''; }} role="presentation" aria-hidden="true"></div>
        <div style="position:absolute;top:calc(100% + 4px);left:0;min-width:200px;z-index:50;background:#fff;border:1px solid #e7e5e4;border-radius:0.5rem;box-shadow:0 4px 16px rgba(0,0,0,0.1);overflow:hidden;" role="listbox">
          {#if options.length > 6}
            <div style="padding:0.375rem;border-bottom:1px solid #f5f5f4;">
              <input use:focusEl type="text" placeholder="Search…" bind:value={refQuery} class="mimsy-input" style="padding:0.3125rem 0.625rem;font-size:0.8125rem;" />
            </div>
          {/if}
          <div style="max-height:11rem;overflow-y:auto;padding:0.25rem;">
            {#each filtered as opt}
              <button type="button" onclick={() => { onchange([...selected, opt.slug]); refOpen = false; refQuery = ''; }} class="w-full text-left px-3 py-1.5 rounded flex items-center justify-between gap-2 text-stone-700 hover:bg-stone-50" style="border:none;background:none;cursor:pointer;" role="option" aria-selected="false">
                <span class="text-sm truncate">{opt.label}</span>
                <span style="font-family:monospace;font-size:10px;color:#a8a29e;flex-shrink:0;">{opt.slug}</span>
              </button>
            {/each}
            {#if filtered.length === 0}
              <p class="text-xs text-stone-400 text-center py-3">{selected.length > 0 && selected.length === options.length ? 'All selected' : 'No matches'}</p>
            {/if}
          </div>
          {#if basePath && arrRef && arrRef !== '__unknown__'}
            <div style="border-top:1px solid #f5f5f4;padding:0.3125rem 0.5rem;">
              <a href="{basePath}/{arrRef}/new" target="_blank" rel="noopener noreferrer" onclick={() => { refOpen = false; }} class="flex items-center gap-1.5 text-xs text-violet-600 hover:text-violet-800 font-medium px-2 py-1 rounded hover:bg-violet-50" style="text-decoration:none;">
                <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.5v15m7.5-7.5h-15"/></svg>
                Create new {arrRef}
              </a>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>

<!-- Array: Scalar (comma-separated) -->
{:else if fieldDef.type === 'array'}
  <input
    type="text"
    id={fieldId}
    value={Array.isArray(value) ? value.join(', ') : ''}
    oninput={(e) => onchange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
    class="mimsy-input"
    placeholder="Comma-separated values"
  />

<!-- Date -->
{:else if fieldDef.type === 'date'}
  <input
    type="date"
    id={fieldId}
    value={value instanceof Date ? value.toISOString().split('T')[0] : (value ?? '').toString().split('T')[0]}
    oninput={(e) => onchange(e.target.value)}
    class="mimsy-input max-w-xs"
  />

<!-- Number -->
{:else if fieldDef.type === 'number'}
  <input
    type="number"
    id={fieldId}
    value={value ?? ''}
    oninput={(e) => onchange(e.target.value === '' ? undefined : Number(e.target.value))}
    class="mimsy-input"
  />

<!-- Image field (Astro image() helper) -->
{:else if fieldDef.type === 'image'}
  <div>
    <div class="flex gap-2">
      <input
        type="text"
        id={fieldId}
        value={value ?? ''}
        oninput={(e) => onchange(e.target.value)}
        class="mimsy-input flex-1"
        placeholder="/src/assets/image.jpg or https://…"
      />
      <button
        type="button"
        onclick={() => {
          window.dispatchEvent(new CustomEvent('mimsy:media:open', {
            detail: {
              callback: (url) => onchange(url)
            }
          }));
        }}
        class="mimsy-btn-secondary px-2.5"
        title="Choose from library"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
      </button>
    </div>
    {#if value}
      <img src={value} class="mt-2 max-h-24 rounded object-cover" alt="" />
    {/if}
  </div>

<!-- String (default) — with optional image browse/preview for image-hinted fields -->
{:else}
  {#if imageHinted}
    <div>
      <div class="flex gap-2">
        <input
          type="text"
          id={fieldId}
          value={value ?? ''}
          oninput={(e) => onchange(e.target.value)}
          class="mimsy-input flex-1"
          placeholder="/src/assets/image.jpg or https://…"
        />
        <button
          type="button"
          onclick={() => {
            window.dispatchEvent(new CustomEvent('mimsy:media:open', {
              detail: { callback: (url) => onchange(url) }
            }));
          }}
          class="mimsy-btn-secondary px-2.5"
          title="Choose from library"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
        </button>
      </div>
      {#if showImagePreview}
        <img src={value} class="mt-2 max-h-24 rounded object-cover" alt="" />
      {/if}
    </div>
  {:else}
    <input
      type="text"
      id={fieldId}
      value={value ?? ''}
      oninput={(e) => onchange(e.target.value)}
      class="mimsy-input"
    />
  {/if}
{/if}

{#if fieldDef.description}
  <p class="mt-1.5 text-xs text-stone-400 leading-relaxed">{fieldDef.description}</p>
{/if}
