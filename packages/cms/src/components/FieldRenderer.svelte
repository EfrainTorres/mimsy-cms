<script>
  /**
   * FieldRenderer — recursive field rendering for schema-driven forms.
   * Handles scalars, nested objects, repeaters (array of objects),
   * and block arrays (discriminated union / union with common literal).
   */
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
    // Shift collapsed state
    const newCollapsed = {};
    for (const [k, v] of Object.entries(collapsed)) {
      const ki = Number(k);
      if (ki < index) newCollapsed[ki] = v;
      else if (ki > index) newCollapsed[ki - 1] = v;
    }
    collapsed = newCollapsed;
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
    <select
      id={fieldId}
      value={value ?? ''}
      onchange={(e) => onchange(e.target.value)}
      class="mimsy-select"
    >
      {#if !fieldDef.required}<option value="">None</option>{/if}
      {#each options as opt}<option value={opt.slug}>{opt.label}</option>{/each}
    </select>
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
    oninput={(e) => onchange(Number(e.target.value))}
    class="mimsy-input"
  />

<!-- String (default) -->
{:else}
  <input
    type="text"
    id={fieldId}
    value={value ?? ''}
    oninput={(e) => onchange(e.target.value)}
    class="mimsy-input"
  />
{/if}
