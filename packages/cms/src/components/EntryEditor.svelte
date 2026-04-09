<script>
  import { onDestroy, setContext } from 'svelte';
  import { navigate } from 'astro:transitions/client';
  import TiptapEditor from './TiptapEditor.svelte';
  import SeoPreview from './SeoPreview.svelte';
  import FieldRenderer from './FieldRenderer.svelte';
  import HistoryDrawer from './HistoryDrawer.svelte';
  import { formatLabel } from '../utils/format-label.js';
  import { toast } from '../utils/toast.js';
  import { buildCandidates, generateProbes } from '../overlay/build-candidates.js';
  import { djb2Hash, setNestedValue, getNestedValue, focusFieldInEditor } from '../overlay/bridge.js';

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

  // Make basePath available to all nested FieldRenderer instances via context
  setContext('mimsyBasePath', basePath);

  // Local mutable copies of initial data
  let frontmatter = $state(JSON.parse(JSON.stringify(initialFrontmatter)));
  let bodyContent = $state(initialBody + '');

  // Version history
  let historyOpen = $state(false);
  let historyRevision = $state(0);
  let restoredFrom = $state(''); // non-empty when content was restored but not yet saved
  let tiptapKey = $state(0);    // increment to force TiptapEditor remount on restore

  // Save state: 'clean' | 'draft' | 'saving' | 'saved' | 'error'
  let saveState = $state('clean');
  let saveController = null;
  let draftSyncTimer = null;
  let structuralChangePending = false;

  // Body editor modal (split layout: body opens in overlay)
  let bodyModalOpen = $state(false);

  // Mobile preview overlay
  let mobilePreviewOpen = $state(false);

  // Window width for responsive split layout detection
  let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
  let resizeTimer = null;
  function handleResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { windowWidth = window.innerWidth; }, 150);
  }

  // Duplicate dialog
  let dupeOpen = $state(false);
  let dupeSlug = $state('');
  let dupeHint = $state(/** @type {'checking'|'available'|'taken'|'invalid'|''} */ (''));
  let duplicating = $state(false);
  let dupeCheckTimer = null;

  // Rename dialog
  let renameOpen = $state(false);
  let renameSlug = $state('');
  let renameHint = $state(/** @type {'checking'|'available'|'taken'|'invalid'|''} */ (''));
  let renaming = $state(false);
  let renameCheckTimer = null;
  let renameUpdateRefs = $state(true);

  const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

  function checkSlugAvailability(value, setHint, timer) {
    if (timer) clearTimeout(timer);
    if (!value) { setHint(''); return null; }
    if (!SLUG_PATTERN.test(value)) { setHint('invalid'); return null; }
    setHint('checking');
    return setTimeout(async () => {
      try {
        const res = await fetch(`/api/mimsy/content/${collection}/${value}`, { method: 'HEAD' });
        setHint(res.ok ? 'taken' : 'available');
      } catch { setHint(''); }
    }, 300);
  }

  // Raw code view
  let showRaw = $state(false);

  function copyRaw() {
    const fm = JSON.stringify(JSON.parse(JSON.stringify(frontmatter)), null, 2);
    const text = isDataCollection ? fm : `${fm}\n\n---\n\n${bodyContent}`;
    navigator.clipboard.writeText(text).then(
      () => toast('Copied to clipboard', 'success'),
      () => toast('Failed to copy', 'error'),
    );
  }
  let previewAvailable = $state(/** @type {'unknown'|'yes'|'no'} */ ('unknown'));

  // Check if the preview route exists (same-origin HEAD request)
  if (typeof window !== 'undefined') {
    fetch(previewPath, { method: 'HEAD' })
      .then(r => { previewAvailable = r.ok ? 'yes' : 'no'; })
      .catch(() => { previewAvailable = 'no'; });
  }

  // Split layout: iframe left + fields right (desktop, content collection with route)
  let splitLayout = $derived(
    !isDataCollection && previewAvailable === 'yes' && !showRaw && windowWidth >= 1024
  );

  // Close mobile preview when entering split layout (prevent duplicate iframe IDs)
  $effect(() => { if (splitLayout && mobilePreviewOpen) mobilePreviewOpen = false; });

  // Always include overlay query param — visual editing is always on
  let iframeSrc = $derived(`${previewPath}?__mimsy=1`);

  function isUrlLike(v) {
    return /^(https?:\/\/|\/|\.\/|\.\.\/)/.test(v);
  }

  function scheduleDraftSync() {
    if (draftSyncTimer) clearTimeout(draftSyncTimer);
    if (saveState !== 'draft' && saveState !== 'error') saveState = 'draft';
    // Cancel in-flight probe (draft takes precedence)
    if (probeState === 'probing') stopProbe(true);

    draftSyncTimer = setTimeout(async () => {
      // 1. Persist to sessionStorage (crash recovery)
      try {
        sessionStorage.setItem(`mimsy-draft-${collection}/${slug}`, JSON.stringify({
          frontmatter: JSON.parse(JSON.stringify(frontmatter)),
          bodyContent,
          timestamp: Date.now(),
        }));
      } catch {}

      // 2. Sync frontmatter to Vite server (for iframe preview)
      if (!isDataCollection) {
        try {
          await fetch('/__mimsy_draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'set', collection, slug,
              frontmatter: JSON.parse(JSON.stringify(frontmatter)),
            }),
          });
        } catch {}

        // 3. Reload iframe only for structural changes
        if (structuralChangePending && (splitLayout || mobilePreviewOpen)) {
          const iframe = document.getElementById('mimsy-preview-frame');
          if (iframe) iframe.src = iframe.src;
          structuralChangePending = false;
        }
      }
    }, 300);
  }

  async function clearDraft() {
    try { sessionStorage.removeItem(`mimsy-draft-${collection}/${slug}`); } catch {}
    try {
      await fetch('/__mimsy_draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear' }),
      });
    } catch {}
  }

  // SEO field detection — unambiguous names only
  const SEO_NAMES = new Set([
    'metatitle', 'seotitle', 'ogtitle',
    'metadescription', 'seodescription', 'ogdescription',
    'ogimage', 'socialimage',
    'canonicalurl', 'canonical',
    'noindex', 'nofollow', 'robots',
  ]);

  function isSeoField(key) {
    return SEO_NAMES.has(key.toLowerCase().replace(/[-_]/g, ''));
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

  function isBlockField(key) {
    const def = getFieldDef(key);
    return def?.type === 'array' && !!def?.arrayItemType?.blockConfig;
  }

  function getBlockFieldKeys() {
    return getFieldKeys().filter(k => isBlockField(k));
  }

  function getRegularFieldKeys() {
    return getFieldKeys().filter(k => !isSeoField(k) && !isBlockField(k));
  }

  let seoFieldData = $derived(
    getFieldKeys().filter(k => isSeoField(k)).map(key => ({
      key,
      fieldDef: getFieldDef(key),
      fieldType: getFieldType(key, frontmatter[key]),
    }))
  );

  function handleFieldChange(key, value) {
    frontmatter[key] = value;

    // Instant DOM patch for simple text fields (zero latency)
    const fieldType = getFieldType(key, value);
    if (typeof value === 'string' && fieldType === 'string' && !isUrlLike(value)) {
      const iframe = document.getElementById('mimsy-preview-frame');
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({
          type: 'mimsy:update', fieldPath: key, value,
        }, location.origin);
      }
    } else {
      structuralChangePending = true;
    }

    scheduleDraftSync();
  }


  async function save() {
    if (draftSyncTimer) clearTimeout(draftSyncTimer);
    if (saveController) saveController.abort();
    saveController = new AbortController();
    const { signal } = saveController;

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
        restoredFrom = '';
        recoveredDraft = null;
        historyRevision++;
        clearDraft();
        toast('Changes saved', 'success');
        window.dispatchEvent(new CustomEvent('mimsy:mutate'));
        // File write triggers Vite HMR → iframe reloads with committed data
        setTimeout(() => { if (saveState === 'saved') saveState = 'clean'; }, 2000);
        return true;
      } else {
        const data = await res.json();
        saveState = 'error';
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
      saveState = 'error';
      toast('Network error. Please try again.', 'error');
      return false;
    }
  }

  function openDuplicateDialog() {
    dupeSlug = slug + '-copy';
    dupeHint = '';
    duplicating = false;
    dupeOpen = true;
    dupeCheckTimer = checkSlugAvailability(dupeSlug, (h) => { dupeHint = h; }, dupeCheckTimer);
  }

  async function submitDuplicate() {
    if (!dupeSlug || !SLUG_PATTERN.test(dupeSlug) || dupeHint === 'taken' || duplicating) return;
    duplicating = true;
    try {
      const res = await fetch(`/api/mimsy/content/${collection}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: dupeSlug, frontmatter: JSON.parse(JSON.stringify(frontmatter)), content: bodyContent }),
      });
      if (res.ok) {
        toast('Entry duplicated', 'success');
        window.dispatchEvent(new CustomEvent('mimsy:mutate'));
        dupeOpen = false;
        navigate(`${basePath}/${collection}/${dupeSlug}`);
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.error || 'Failed to duplicate', 'error');
      }
    } catch {
      toast('Network error', 'error');
    } finally {
      duplicating = false;
    }
  }

  function openRenameDialog() {
    renameSlug = slug;
    renameHint = '';
    renaming = false;
    renameUpdateRefs = true;
    renameOpen = true;
  }

  async function submitRename() {
    if (!renameSlug || !SLUG_PATTERN.test(renameSlug) || renameSlug === slug || renameHint === 'taken' || renaming) return;
    renaming = true;
    try {
      const res = await fetch(`/api/mimsy/content/${collection}/${slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newSlug: renameSlug, updateReferences: renameUpdateRefs }),
      });
      if (res.ok) {
        const data = await res.json();
        const refMsg = data.referencesUpdated > 0 ? ` (${data.referencesUpdated} reference${data.referencesUpdated === 1 ? '' : 's'} updated)` : '';
        toast(`Renamed to ${data.slug}${refMsg}`, 'success');
        window.dispatchEvent(new CustomEvent('mimsy:mutate'));
        // Clear old draft
        try { sessionStorage.removeItem(`mimsy-draft-${collection}/${slug}`); } catch {}
        renameOpen = false;
        navigate(`${basePath}/${collection}/${data.slug}`);
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.error || 'Failed to rename', 'error');
      }
    } catch {
      toast('Network error', 'error');
    } finally {
      renaming = false;
    }
  }

  async function handleRollback() {
    try {
      const res = await fetch(`/api/mimsy/content/${collection}/${slug}`);
      if (res.ok) {
        const entry = await res.json();
        frontmatter = entry.frontmatter;
        bodyContent = entry.body ?? '';
        tiptapKey++;
        restoredFrom = '';
        saveState = 'clean';
        historyRevision++;
        clearDraft();
      }
    } catch {}
  }

  async function del() {
    if (!confirm(`Delete "${slug}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/mimsy/content/${collection}/${slug}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast('Entry deleted', 'success');
        window.dispatchEvent(new CustomEvent('mimsy:mutate'));
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
    const ok = await save();
    if (ok) {
      toast(frontmatter.draft ? 'Moved to draft' : 'Published', 'success');
    } else {
      frontmatter.draft = !frontmatter.draft; // revert on failure
    }
  }

  function toggleMobilePreview() {
    mobilePreviewOpen = !mobilePreviewOpen;
  }

  function handleRestore(fm, body, versionDate) {
    frontmatter = JSON.parse(JSON.stringify(fm));
    bodyContent = body;
    tiptapKey++; // remount TiptapEditor with restored content
    const d = new Date(versionDate);
    restoredFrom = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    structuralChangePending = true;
    scheduleDraftSync();
  }

  // --- Mutation Probing State Machine ---
  // States: 'idle' | 'probing' | 'mapped' | 'failed'
  // Probes inject sentinels via Vite plugin (no file writes, no HMR broadcast).
  const probeCacheKey = `mimsy-probe-v2-${collection}/${slug}`;
  let probeState = 'idle';
  let cachedProbeMapping = null;  // Cached { fieldPath: [{ path, attribute }] }
  let probeMap = null;            // Current { probeId: fieldPath } for in-flight probe
  let probeTimeout = null;

  // Restore cached probe mapping from sessionStorage (survives page reloads)
  if (typeof sessionStorage !== 'undefined') {
    try {
      const cached = sessionStorage.getItem(probeCacheKey);
      if (cached) {
        cachedProbeMapping = JSON.parse(cached);
        probeState = 'mapped';
      }
    } catch { /* ignore corrupt cache */ }
  }

  function sendInitToOverlay(probeMapping) {
    const iframe = document.getElementById('mimsy-preview-frame');
    if (!iframe?.contentWindow) return;
    const cands = buildCandidates(JSON.parse(JSON.stringify(frontmatter)), schemaFields);
    iframe.contentWindow.postMessage({
      type: 'mimsy:init',
      candidates: cands,
      contentHash: djb2Hash(JSON.stringify(frontmatter)),
      probeMapping: probeMapping || null,
      mode: 'collection',
      hasBody: !isDataCollection && bodyContent.length > 0,
    }, location.origin);
  }

  async function startProbe() {
    if (probeState === 'probing') return;

    const fmCopy = JSON.parse(JSON.stringify(frontmatter));
    const result = generateProbes(fmCopy, schemaFields);
    probeMap = result.probeMap;

    // Activate probe on the Vite dev server — no file writes, no HMR
    try {
      const res = await fetch('/__mimsy_probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          collection,
          slug,
          probeMap: result.probeMap,
        }),
      });
      if (!res.ok) {
        probeState = 'failed';
        return;
      }
    } catch {
      probeState = 'failed';
      return;
    }

    probeState = 'probing';
    // Reload only the preview iframe — admin panel stays mounted
    const iframe = document.getElementById('mimsy-preview-frame');
    if (iframe) iframe.src = iframe.src;
    // Safety timeout: if overlay doesn't respond within 5s, deactivate and fall back
    probeTimeout = setTimeout(() => stopProbe(true), 5000);
  }

  async function stopProbe(timedOut = false) {
    if (probeTimeout) { clearTimeout(probeTimeout); probeTimeout = null; }
    // Deactivate probe on the Vite dev server
    try {
      await fetch('/__mimsy_probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
    } catch { /* server auto-clears after 30s */ }

    probeState = timedOut ? 'failed' : 'mapped';

    if (!timedOut) {
      // Reload iframe to render clean data with deterministic mapping applied
      const iframe = document.getElementById('mimsy-preview-frame');
      if (iframe) iframe.src = iframe.src;
    }
  }

  function handleOverlayMessage(e) {
    const iframe = document.getElementById('mimsy-preview-frame');
    if (!iframe || e.source !== iframe.contentWindow || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || !d.type) return;

    if (d.type === 'mimsy:ready') {
      if (probeState === 'probing') {
        // Iframe rendered with probe sentinels — ask overlay to scan
        iframe.contentWindow.postMessage({
          type: 'mimsy:probe',
          probeMap: probeMap,
        }, location.origin);
      } else if (probeState === 'mapped') {
        // Send cached deterministic mapping
        sendInitToOverlay(cachedProbeMapping);
      } else {
        // 'idle' or 'failed' — heuristic matching first
        sendInitToOverlay(null);
      }
    }

    if (d.type === 'mimsy:mapped') {
      // Upgrade from heuristics to probing (one-shot: only triggers from 'idle')
      if (probeState === 'idle') {
        startProbe();
      }
    }

    if (d.type === 'mimsy:probe-mapped') {
      // Overlay found probe sentinels and reported element paths
      if (probeTimeout) { clearTimeout(probeTimeout); probeTimeout = null; }
      cachedProbeMapping = d.mapping;
      probeMap = null;
      // Persist to sessionStorage — survives page reloads from manual saves
      try { sessionStorage.setItem(probeCacheKey, JSON.stringify(cachedProbeMapping)); } catch {}
      // Deactivate probe and reload with clean data + mapping
      stopProbe(false);
    }

    if (d.type === 'mimsy:probe-stale') {
      // Cached probe mapping was stale — clear it and re-probe
      cachedProbeMapping = null;
      try { sessionStorage.removeItem(probeCacheKey); } catch {}
      probeState = 'idle';
      startProbe();
    }

    if (d.type === 'mimsy:focus') {
      if (d.fieldPath === '__body__') {
        bodyModalOpen = true;
        return;
      }
      // In split layout, preview stays open; on mobile, close preview first
      if (!splitLayout) mobilePreviewOpen = false;
      requestAnimationFrame(() => focusFieldInEditor(d.fieldPath));
    }
    if (d.type === 'mimsy:edit') {
      setNestedValue(frontmatter, d.fieldPath, d.value);
      frontmatter = { ...frontmatter };
      scheduleDraftSync();
    }
    if (d.type === 'mimsy:reorder') {
      const from = d.from;
      const to = d.to;
      const arr = typeof d.arrayPath === 'string' ? getNestedValue(frontmatter, d.arrayPath) : null;
      if (
        Array.isArray(arr) &&
        Number.isInteger(from) && from >= 0 && from < arr.length &&
        Number.isInteger(to) && to >= 0 && to < arr.length &&
        from !== to
      ) {
        const [item] = arr.splice(from, 1);
        arr.splice(to, 0, item);
        frontmatter = { ...frontmatter };
        structuralChangePending = true;
        scheduleDraftSync();
      }
    }
  }

  // Navigation guard + cleanup on page unload
  function handleBeforeUnload(e) {
    if (probeState === 'probing') {
      navigator.sendBeacon('/__mimsy_probe', new Blob(
        [JSON.stringify({ action: 'stop' })],
        { type: 'application/json' },
      ));
    }
    // Warn on unsaved draft
    if (saveState === 'draft' || saveState === 'error') {
      e.preventDefault();
      e.returnValue = 'You have unsaved changes.';
      return e.returnValue;
    }
  }

  // Communicate dirty state to AdminLayout's navigation guard
  $effect(() => {
    if (typeof document !== 'undefined') {
      if (saveState === 'draft' || saveState === 'error') {
        document.body.setAttribute('data-mimsy-dirty', '');
      } else {
        document.body.removeAttribute('data-mimsy-dirty');
      }
    }
  });

  // Crash recovery: check for existing draft in sessionStorage
  let recoveredDraft = $state(null);

  if (typeof sessionStorage !== 'undefined') {
    try {
      const stored = sessionStorage.getItem(`mimsy-draft-${collection}/${slug}`);
      if (stored) {
        const draft = JSON.parse(stored);
        const currentHash = djb2Hash(JSON.stringify(initialFrontmatter) + initialBody);
        const draftHash = djb2Hash(JSON.stringify(draft.frontmatter) + draft.bodyContent);
        if (currentHash !== draftHash) {
          recoveredDraft = draft;
        } else {
          sessionStorage.removeItem(`mimsy-draft-${collection}/${slug}`);
        }
      }
    } catch {}
  }

  function recoverDraft() {
    if (!recoveredDraft) return;
    frontmatter = JSON.parse(JSON.stringify(recoveredDraft.frontmatter));
    bodyContent = recoveredDraft.bodyContent;
    tiptapKey++;
    recoveredDraft = null;
    scheduleDraftSync();
  }

  function discardRecoveredDraft() {
    recoveredDraft = null;
    try { sessionStorage.removeItem(`mimsy-draft-${collection}/${slug}`); } catch {}
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('message', handleOverlayMessage);
    window.addEventListener('beforeunload', handleBeforeUnload);
  }

  onDestroy(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', handleOverlayMessage);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    }
    if (draftSyncTimer) clearTimeout(draftSyncTimer);
    if (dupeCheckTimer) clearTimeout(dupeCheckTimer);
    if (renameCheckTimer) clearTimeout(renameCheckTimer);
    if (saveController) saveController.abort();
    if (resizeTimer) clearTimeout(resizeTimer);
    if (probeTimeout) clearTimeout(probeTimeout);
    if (probeState === 'probing') {
      fetch('/__mimsy_probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      }).catch(() => {});
    }
  });

  function handleKeydown(e) {
    // Cmd/Ctrl+S → manual save (with toast)
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
    // Escape — close modals, then blur fields, then confirm discard, then navigate
    if (e.key === 'Escape') {
      const palette = document.getElementById('mimsy-palette');
      if (palette && !palette.hidden) return;
      if (dupeOpen) { dupeOpen = false; return; }
      if (renameOpen) { renameOpen = false; return; }
      if (bodyModalOpen) { bodyModalOpen = false; return; }
      if (mobilePreviewOpen) { mobilePreviewOpen = false; return; }
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        document.activeElement.blur();
      } else {
        if (saveState === 'draft' || saveState === 'error') {
          if (!confirm('You have unsaved changes. Discard them?')) return;
          clearDraft();
          saveState = 'clean';
        }
        navigate(`${basePath}/${collection}`);
      }
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} onresize={handleResize} />

<HistoryDrawer
  {collection}
  {slug}
  {isDataCollection}
  revision={historyRevision}
  bind:open={historyOpen}
  onrestore={handleRestore}
  onrollback={handleRollback}
/>

<!-- Reusable field snippets -->
{#snippet fieldsCard()}
  <div class="mimsy-card p-5">
    <p class="mimsy-section-title">Fields</p>
    <div class="space-y-4">
      {#each getRegularFieldKeys() as key}
        {@const fieldDef = getFieldDef(key)}
        {@const fieldType = getFieldType(key, frontmatter[key])}
        <div>
          <label class="mimsy-label" for={`field-${key}`}>
            {formatLabel(key)}
            {#if fieldDef && !fieldDef.required}
              <span class="text-stone-300 font-normal normal-case tracking-normal">&middot; optional</span>
            {/if}
          </label>
          <FieldRenderer
            fieldDef={fieldDef ?? { name: key, type: fieldType, required: true }}
            value={frontmatter[key]}
            onchange={(v) => handleFieldChange(key, v)}
            {referenceOptions}
            fieldId={`field-${key}`}
          />
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
    seoFields={seoFieldData}
    {frontmatter}
    onFieldChange={handleFieldChange}
    {referenceOptions}
  />
{/snippet}

{#snippet blockCards()}
  {#each getBlockFieldKeys() as key}
    {@const fieldDef = getFieldDef(key)}
    <div class="mimsy-card p-5">
      <p class="mimsy-section-title">{formatLabel(key)}</p>
      <FieldRenderer
        fieldDef={fieldDef}
        value={frontmatter[key]}
        onchange={(v) => handleFieldChange(key, v)}
        {referenceOptions}
        fieldId={`field-${key}`}
      />
    </div>
  {/each}
{/snippet}

<!-- Shared header snippet for non-split layouts -->
{#snippet editorHeader()}
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
    <div class="flex items-center gap-3 min-w-0">
      <a href={`${basePath}/${collection}`} class="mimsy-btn-back" title="Back">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
      </a>
      <h1 class="mimsy-page-heading truncate">{frontmatter.title || frontmatter.name || slug}</h1>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      {#if saveState === 'draft'}
        <span class="mimsy-save-state mimsy-save-draft">Draft</span>
      {:else if saveState === 'error'}
        <span class="mimsy-save-state mimsy-save-error">Error</span>
      {:else if saveState === 'saving'}
        <span class="mimsy-save-state mimsy-save-saving">Saving…</span>
      {:else if saveState === 'saved'}
        <span class="mimsy-save-state mimsy-save-saved">Saved</span>
      {/if}
      <button onclick={toggleDraft} disabled={saveState === 'saving'}
        class="mimsy-status-badge cursor-pointer transition-all hover:scale-105 disabled:opacity-50 {frontmatter.draft ? 'mimsy-status-draft' : 'mimsy-status-published'}">
        <span class="mimsy-status-dot"></span>
        {frontmatter.draft ? 'Draft' : 'Published'}
      </button>
      <button onclick={() => { showRaw = !showRaw; }} class="mimsy-btn-secondary" class:ring-2={showRaw} class:ring-violet-400={showRaw} title={showRaw ? 'Show form' : 'View raw data'}>
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" /></svg>
      </button>
      <button onclick={() => { historyOpen = !historyOpen; }} class="mimsy-btn-secondary" class:ring-2={historyOpen} class:ring-violet-400={historyOpen} title="Version history">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>
      </button>
      {#if !isDataCollection}
        <button onclick={toggleMobilePreview} class="mimsy-btn-secondary" title="Preview">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>
        </button>
      {/if}
      <button onclick={openRenameDialog} class="mimsy-btn-secondary" title="Rename slug">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" /></svg>
      </button>
      <button onclick={openDuplicateDialog} class="mimsy-btn-secondary" title="Duplicate entry">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.688a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" /></svg>
      </button>
      <button onclick={() => save()} disabled={saveState === 'saving'} class="mimsy-btn-primary" class:ring-2={saveState === 'draft'} class:ring-violet-400={saveState === 'draft'}>
        {saveState === 'saving' ? 'Saving...' : 'Save'}
      </button>
      <button onclick={del} class="mimsy-btn-danger">Delete</button>
    </div>
  </div>
{/snippet}

<div>
  <!-- Crash recovery banner -->
  {#if recoveredDraft}
    <div class="mimsy-restore-banner" style={splitLayout ? 'margin: 0 1.25rem 0.5rem' : ''}>
      <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/>
      </svg>
      <span>Unsaved draft from {new Date(recoveredDraft.timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
      <button onclick={recoverDraft} class="ml-auto text-amber-800 hover:text-amber-900 font-semibold transition-colors text-xs" style="border:none;background:none;cursor:pointer;">Recover</button>
      <button onclick={discardRecoveredDraft} class="ml-1 hover:text-amber-900 transition-colors" style="border:none;background:none;cursor:pointer;" title="Discard draft">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
  {/if}

  <!-- Restore banner (version history) -->
  {#if restoredFrom}
    <div class="mimsy-restore-banner" style={splitLayout ? 'margin: 0 1.25rem 0.5rem' : ''}>
      <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>
      </svg>
      <span>Loaded from {restoredFrom} — not saved yet.</span>
      <button onclick={() => restoredFrom = ''} class="ml-auto flex-shrink-0 hover:text-amber-900 transition-colors" title="Dismiss">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
  {/if}

  {#if splitLayout}
    <!-- ═══ SPLIT LAYOUT: iframe left, fields right (desktop, content collections) ═══ -->
    <div class="mimsy-split-layout">
      <div class="mimsy-split-iframe">
        <iframe id="mimsy-preview-frame" src={iframeSrc} title="Page preview"></iframe>
      </div>

      <div class="mimsy-split-panel">
        <!-- Panel header: two clean rows -->
        <div class="mimsy-split-panel-header" style="flex-direction:column;gap:0.375rem;">
          <!-- Row 1: back + title + save state -->
          <div class="flex items-center gap-2 w-full min-w-0">
            <a href={`${basePath}/${collection}`} class="mimsy-btn-back" title="Back" style="width:1.5rem;height:1.5rem;flex-shrink:0;">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
            </a>
            <h1 class="text-sm font-semibold text-stone-800 truncate flex-1">{frontmatter.title || frontmatter.name || slug}</h1>
            {#if saveState === 'draft'}
              <span class="mimsy-save-state mimsy-save-draft text-[10px] shrink-0">Draft</span>
            {:else if saveState === 'error'}
              <span class="mimsy-save-state mimsy-save-error text-[10px] shrink-0">Error</span>
            {:else if saveState === 'saving'}
              <span class="mimsy-save-state mimsy-save-saving text-[10px] shrink-0">Saving…</span>
            {:else if saveState === 'saved'}
              <span class="mimsy-save-state mimsy-save-saved text-[10px] shrink-0">Saved</span>
            {/if}
          </div>
          <!-- Row 2: actions -->
          <div class="flex items-center gap-1.5 w-full">
            <button onclick={toggleDraft} disabled={saveState === 'saving'}
              class="mimsy-status-badge cursor-pointer text-[10px] {frontmatter.draft ? 'mimsy-status-draft' : 'mimsy-status-published'}">
              <span class="mimsy-status-dot"></span>
              {frontmatter.draft ? 'Draft' : 'Published'}
            </button>
            <div class="flex-1"></div>
            <button onclick={() => { showRaw = !showRaw; }} class="mimsy-btn-secondary p-1.5" class:ring-2={showRaw} class:ring-violet-400={showRaw} title="Raw data">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" /></svg>
            </button>
            <button onclick={() => { historyOpen = !historyOpen; }} class="mimsy-btn-secondary p-1.5" class:ring-2={historyOpen} class:ring-violet-400={historyOpen} title="History">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>
            </button>
            <button onclick={openRenameDialog} class="mimsy-btn-secondary p-1.5" title="Rename">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" /></svg>
            </button>
            <button onclick={openDuplicateDialog} class="mimsy-btn-secondary p-1.5" title="Duplicate">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.688a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" /></svg>
            </button>
            <button onclick={del} class="mimsy-btn-danger p-1.5" title="Delete">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
            </button>
            <button onclick={() => save()} disabled={saveState === 'saving'} class="mimsy-btn-primary text-xs px-2.5 py-1.5" class:ring-2={saveState === 'draft'} class:ring-violet-400={saveState === 'draft'}>Save</button>
          </div>
        </div>

        <!-- Scrollable fields area -->
        <div class="mimsy-split-panel-scroll space-y-4">
          <!-- Body content button (opens modal editor) -->
          <button
            type="button"
            onclick={() => { bodyModalOpen = true; }}
            class="mimsy-card w-full text-left p-4 hover:border-violet-200 transition-colors cursor-pointer"
            style="border-style: dashed;"
          >
            <p class="mimsy-section-title">Content</p>
            <p class="text-xs text-stone-400 line-clamp-2">
              {bodyContent ? bodyContent.slice(0, 120) + (bodyContent.length > 120 ? '…' : '') : 'Click to edit body content…'}
            </p>
          </button>

          {@render fieldsCard()}
          {@render seoCard()}
          {@render blockCards()}
        </div>
      </div>
    </div>

  {:else if showRaw}
    <!-- ═══ RAW DATA VIEW ═══ -->
    <div class="max-w-7xl mx-auto px-5 py-7 lg:px-8 lg:py-9">
      {@render editorHeader()}
      <div class="max-w-3xl">
        <div class="mimsy-card p-5">
          <div class="flex items-center justify-between mb-3">
            <p class="mimsy-section-title" style="margin-bottom:0">Raw Data</p>
            <button onclick={copyRaw} class="text-xs text-stone-400 hover:text-stone-600 font-medium transition-colors" style="border:none;background:none;cursor:pointer;">Copy</button>
          </div>
          {#if !isDataCollection}
            <p class="text-[10px] font-medium text-stone-400 uppercase tracking-wider mb-1.5">Frontmatter</p>
          {/if}
          <pre class="text-xs font-mono leading-relaxed text-stone-600 bg-stone-50 border border-stone-100 rounded-lg p-4 overflow-auto max-h-[50vh] whitespace-pre-wrap break-all">{JSON.stringify(JSON.parse(JSON.stringify(frontmatter)), null, 2)}</pre>
          {#if !isDataCollection}
            <p class="text-[10px] font-medium text-stone-400 uppercase tracking-wider mb-1.5 mt-4">Body</p>
            <pre class="text-xs font-mono leading-relaxed text-stone-600 bg-stone-50 border border-stone-100 rounded-lg p-4 overflow-auto max-h-[40vh] whitespace-pre-wrap break-all">{bodyContent || '(empty)'}</pre>
          {/if}
        </div>
      </div>
    </div>

  {:else if !isDataCollection}
    <!-- ═══ MOBILE / FORM-FIRST (content collections, <1024px or no preview) ═══ -->
    <div class="max-w-7xl mx-auto px-5 py-7 lg:px-8 lg:py-9">
      {@render editorHeader()}
      <div class="mimsy-editor-wrap">
        <div class="xl:grid xl:grid-cols-3 xl:gap-6">
          <div class="mb-5 xl:mb-0 xl:col-start-3">
            <div class="xl:sticky xl:top-6 space-y-5">
              {@render fieldsCard()}
              {@render seoCard()}
              {#if previewAvailable === 'no'}
                <p class="text-[11px] text-stone-400 leading-relaxed px-1">No frontend route found for <code class="text-stone-500 bg-stone-800/40 rounded px-1 py-0.5 text-[10px]">/{collection}/{slug}</code>. Create <code class="text-stone-500 bg-stone-800/40 rounded px-1 py-0.5 text-[10px]">src/pages/{collection}/[...slug].astro</code> to enable preview.</p>
              {/if}
            </div>
          </div>
          <div class="xl:col-start-1 xl:col-span-2 xl:row-start-1 space-y-5">
            <div class="mimsy-card p-5">
              <p class="mimsy-section-title">Content</p>
              {#key tiptapKey}
                <TiptapEditor
                  content={bodyContent}
                  onchange={(md) => { bodyContent = md; structuralChangePending = true; scheduleDraftSync(); }}
                />
              {/key}
            </div>
            {@render blockCards()}
          </div>
        </div>
      </div>
    </div>

  {:else}
    <!-- ═══ DATA COLLECTIONS (single column, no preview) ═══ -->
    <div class="max-w-7xl mx-auto px-5 py-7 lg:px-8 lg:py-9">
      {@render editorHeader()}
      <div class="max-w-2xl space-y-5">
        {@render fieldsCard()}
        {@render blockCards()}
        {@render seoCard()}
      </div>
    </div>
  {/if}
</div>

<!-- ═══ BODY EDITOR MODAL ═══ -->
<div class="mimsy-body-modal-backdrop" class:mimsy-body-modal-open={bodyModalOpen}
  onclick={() => { bodyModalOpen = false; }}
  role="presentation"
></div>
<div class="mimsy-body-modal" class:mimsy-body-modal-open={bodyModalOpen}>
  <div class="mimsy-body-modal-header">
    <p class="mimsy-section-title" style="margin-bottom:0">Content</p>
    <div class="flex items-center gap-3">
      <span class="text-xs text-stone-400">{bodyContent.length} chars</span>
      <button onclick={() => { bodyModalOpen = false; }} class="mimsy-toast-close" title="Close">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/></svg>
      </button>
    </div>
  </div>
  <div class="mimsy-body-modal-body">
    {#if bodyModalOpen}
      {#key tiptapKey}
        <TiptapEditor
          content={bodyContent}
          onchange={(md) => { bodyContent = md; structuralChangePending = true; scheduleDraftSync(); }}
        />
      {/key}
    {/if}
  </div>
</div>

<!-- ═══ MOBILE PREVIEW MODAL ═══ -->
{#if !isDataCollection}
  <div class="mimsy-mobile-preview" class:mimsy-mobile-preview-open={mobilePreviewOpen}>
    <div class="mimsy-preview-header">
      <span class="mimsy-section-title" style="margin-bottom:0">Preview</span>
      <button onclick={() => { mobilePreviewOpen = false; }} class="mimsy-toast-close" title="Close preview">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/></svg>
      </button>
    </div>
    {#if mobilePreviewOpen}
      <iframe id="mimsy-preview-frame" src={iframeSrc} title="Page preview" class="flex-1 w-full border-none"></iframe>
    {/if}
  </div>
{/if}

<!-- ═══ DUPLICATE DIALOG ═══ -->
{#if dupeOpen}
  <div class="mimsy-dialog-overlay" onclick={(e) => { if (e.target === e.currentTarget) dupeOpen = false; }}>
    <div class="mimsy-dialog-panel">
      <div class="mimsy-dialog-title">Duplicate Entry</div>
      <label class="mimsy-label" for="mimsy-dupe-slug">New slug</label>
      <input
        id="mimsy-dupe-slug"
        type="text"
        class="mimsy-input w-full"
        style="font-family: var(--mimsy-font-mono);"
        bind:value={dupeSlug}
        oninput={() => { dupeCheckTimer = checkSlugAvailability(dupeSlug, (h) => { dupeHint = h; }, dupeCheckTimer); }}
        onkeydown={(e) => { if (e.key === 'Enter') submitDuplicate(); }}
      />
      <div class="mimsy-dialog-hint {dupeHint === 'available' ? 'mimsy-dialog-hint-ok' : dupeHint === 'taken' || dupeHint === 'invalid' ? 'mimsy-dialog-hint-err' : 'mimsy-dialog-hint-muted'}">
        {#if dupeHint === 'checking'}Checking...{:else if dupeHint === 'available'}Available{:else if dupeHint === 'taken'}Already taken{:else if dupeHint === 'invalid'}Invalid slug format{/if}
      </div>
      <div class="mimsy-dialog-actions">
        <button class="mimsy-btn-secondary" onclick={() => { dupeOpen = false; }}>Cancel</button>
        <button class="mimsy-btn-primary" onclick={submitDuplicate}
          disabled={duplicating || !dupeSlug || dupeHint === 'taken' || dupeHint === 'invalid' || dupeHint === 'checking'}>
          {duplicating ? 'Duplicating...' : 'Duplicate'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ═══ RENAME DIALOG ═══ -->
{#if renameOpen}
  <div class="mimsy-dialog-overlay" onclick={(e) => { if (e.target === e.currentTarget) renameOpen = false; }}>
    <div class="mimsy-dialog-panel">
      <div class="mimsy-dialog-title">Rename Entry</div>
      <label class="mimsy-label" for="mimsy-rename-slug">New slug</label>
      <input
        id="mimsy-rename-slug"
        type="text"
        class="mimsy-input w-full"
        style="font-family: var(--mimsy-font-mono);"
        bind:value={renameSlug}
        oninput={() => {
          if (renameSlug === slug) { renameHint = ''; }
          else { renameCheckTimer = checkSlugAvailability(renameSlug, (h) => { renameHint = h; }, renameCheckTimer); }
        }}
        onkeydown={(e) => { if (e.key === 'Enter') submitRename(); }}
      />
      <div class="mimsy-dialog-hint {renameHint === 'available' ? 'mimsy-dialog-hint-ok' : renameHint === 'taken' || renameHint === 'invalid' ? 'mimsy-dialog-hint-err' : 'mimsy-dialog-hint-muted'}">
        {#if renameSlug === slug}Enter a different slug{:else if renameHint === 'checking'}Checking...{:else if renameHint === 'available'}Available{:else if renameHint === 'taken'}Already taken{:else if renameHint === 'invalid'}Invalid slug format{/if}
      </div>
      <label class="flex items-center gap-2 mt-3 text-xs text-stone-600 cursor-pointer">
        <input type="checkbox" bind:checked={renameUpdateRefs} class="rounded" />
        Update references in other entries
      </label>
      <div class="mimsy-dialog-actions">
        <button class="mimsy-btn-secondary" onclick={() => { renameOpen = false; }}>Cancel</button>
        <button class="mimsy-btn-primary" onclick={submitRename}
          disabled={renaming || !renameSlug || renameSlug === slug || renameHint === 'taken' || renameHint === 'invalid' || renameHint === 'checking'}>
          {renaming ? 'Renaming...' : 'Rename'}
        </button>
      </div>
    </div>
  </div>
{/if}
