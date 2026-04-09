/**
 * Overlay IIFE — injected into the preview iframe via middleware.
 * Matching engine + hover highlight + click-to-select + click-again-to-edit.
 * Ctrl/Cmd+click jumps to the form field in the editor panel.
 *
 * Exported as a string constant so middleware can inline it into HTML.
 */
export const OVERLAY_SCRIPT = `(function(){
  'use strict';

  var HIGH = 0.7;
  var MED = 0.4;

  // --- State ---
  var mappings = null;      // Map<Element, { fieldPath, confidence, candidate }>
  var fieldToElement = null; // Map<string, { element, confidence }>
  var candidates = null;
  var cacheHash = '';
  var editing = null;         // Element currently being inline-edited
  var selected = null;        // { element, match } — currently selected (click-to-select)
  var arrayRegions = null;    // Map<arrayPath, [{ index, region }]> — computed by co-occurrence matching
  var dragHandles = [];       // cleanup references
  var storedProbeMapping = null; // Durable probe mapping — survives DOM churn
  var bodyRegion = null;        // Detected body/prose container for modal trigger
  var hasBody = false;          // Whether editor has body content to detect

  function detectBodyRegion() {
    bodyRegion = null;
    if (!hasBody) return;
    var selectors = [
      '[data-mimsy-body]', '.prose', 'article', 'main .content', '.content'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (!el) continue;
      // Skip if this element is already mapped to a frontmatter field
      var mapped = false;
      if (fieldToElement) {
        fieldToElement.forEach(function(v) { if (v.element === el) mapped = true; });
      }
      if (!mapped && el.textContent && el.textContent.trim().length > 50) {
        bodyRegion = el;
        return;
      }
    }
  }

  // --- Overlay DOM ---
  var highlight = document.createElement('div');
  highlight.setAttribute('data-mimsy-highlight', '');
  highlight.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;border:2px solid #3b82f6;background:rgba(59,130,246,0.08);border-radius:4px;transition:all 80ms ease-out;opacity:0;';
  document.body.appendChild(highlight);

  var tooltip = document.createElement('div');
  tooltip.setAttribute('data-mimsy-tooltip', '');
  tooltip.style.cssText = 'position:fixed;z-index:100000;background:#1e293b;color:#f8fafc;font-size:11px;font-family:ui-monospace,monospace;padding:3px 8px;border-radius:4px;pointer-events:none;opacity:0;transition:opacity 80ms ease-out;white-space:nowrap;';
  document.body.appendChild(tooltip);

  var dropIndicator = document.createElement('div');
  dropIndicator.setAttribute('data-mimsy-drag', '');
  dropIndicator.style.cssText = 'position:fixed;left:0;right:0;height:3px;background:#3b82f6;border-radius:2px;z-index:99998;display:none;pointer-events:none;';
  document.body.appendChild(dropIndicator);

  // --- Helpers ---
  function normalize(s) {
    return s.toLowerCase().replace(/\\s+/g, ' ').trim();
  }

  function isLeafish(el) {
    if (el.children.length === 0) return true;
    if (el.children.length > 3) return false;
    var fullLen = el.textContent.trim().length;
    var childLen = 0;
    for (var i = 0; i < el.children.length; i++) {
      childLen += (el.children[i].textContent || '').trim().length;
    }
    return fullLen > 0 && ((fullLen - childLen) > fullLen * 0.3 || el.children.length <= 1);
  }

  function scoreMatch(c, el, occ) {
    var text = el.textContent.trim();
    var val = c.value;

    // Signal 1: Text match (0.35)
    var ts = 0;
    if (text === val) ts = 1.0;
    else if (normalize(text) === normalize(val)) ts = 0.85;
    else if (isLeafish(el) && text.indexOf(val) !== -1 && val.length >= 5) ts = 0.5;
    else return 0;

    // Signal 2: Tag appropriateness (0.15)
    var gs = 0.5;
    var tag = el.tagName.toLowerCase();
    var nm = c.fieldName.toLowerCase();
    if (/^h[1-6]$/.test(tag) && /heading|title|name/.test(nm)) gs = 1.0;
    else if (tag === 'p' && /desc|summary|excerpt|sub|text|bio/.test(nm)) gs = 1.0;
    else if ((tag === 'a' || tag === 'button') && /button|link|cta|text/.test(nm)) gs = 0.9;
    else if (/^h[1-6]$/.test(tag)) gs = 0.7;
    else if ('p span li td label div'.split(' ').indexOf(tag) !== -1) gs = 0.6;

    // Signal 3: Uniqueness (0.20)
    var us = 0;
    if (occ === 1) us = 1.0;
    else if (occ === 2) us = 0.5;
    else if (occ <= 5) us = 0.2;
    else us = 0.05;

    // Signal 4: String length (0.15)
    var ls = Math.min(val.length / 25, 1.0);

    // Signal 5: Specificity — deeper = more specific (0.15)
    var depth = 0;
    var p = el;
    while (p && p !== document.body) { depth++; p = p.parentElement; }
    var ss = Math.min(depth / 10, 1.0);

    return ts * 0.35 + gs * 0.15 + us * 0.20 + ls * 0.15 + ss * 0.15;
  }

  function scoreAttrMatch(val, attr) {
    if (!val || !attr) return 0;
    if (attr === val) return 0.95;
    var a = attr.split('?')[0].split('#')[0];
    var v = val.split('?')[0].split('#')[0];
    if (a.substring(0, 2) === './') a = a.substring(1);
    if (v.substring(0, 2) === './') v = v.substring(1);
    if (a === v) return 0.9;
    if (a.length > v.length && a.substring(a.length - v.length) === v && (v.charAt(0) === '/' || a.charAt(a.length - v.length - 1) === '/')) return 0.8;
    if (v.length > a.length && v.substring(v.length - a.length) === a && (a.charAt(0) === '/' || v.charAt(v.length - a.length - 1) === '/')) return 0.8;
    return 0;
  }

  function collectTextElements() {
    var SKIP = { SCRIPT:1, STYLE:1, NOSCRIPT:1, SVG:1, HEAD:1, META:1, LINK:1 };
    var els = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: function(node) {
        if (SKIP[node.tagName]) return NodeFilter.FILTER_REJECT;
        if (node.hasAttribute('data-mimsy-highlight') || node.hasAttribute('data-mimsy-tooltip') || node.hasAttribute('data-mimsy-drag') || node.hasAttribute('data-mimsy-grip')) return NodeFilter.FILTER_REJECT;
        var t = node.textContent;
        if (!t || !t.trim()) return NodeFilter.FILTER_SKIP;
        if (node.children.length <= 5) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
    });
    while (walker.nextNode()) els.push(walker.currentNode);
    return els;
  }

  function collectAttrElements() {
    var els = [];
    var imgs = document.body.querySelectorAll('img[src]');
    for (var i = 0; i < imgs.length; i++) els.push({ element: imgs[i], value: imgs[i].getAttribute('src') });
    var links = document.body.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var h = links[i].getAttribute('href');
      if (h && h !== '#' && h.indexOf('javascript:') !== 0 && h.indexOf('mailto:') !== 0) {
        els.push({ element: links[i], value: h });
      }
    }
    var media = document.body.querySelectorAll('video[src], video[poster], source[src]');
    for (var i = 0; i < media.length; i++) {
      if (media[i].getAttribute('src')) els.push({ element: media[i], value: media[i].getAttribute('src') });
      if (media[i].getAttribute('poster')) els.push({ element: media[i], value: media[i].getAttribute('poster') });
    }
    var styled = document.body.querySelectorAll('[style*="url("]');
    for (var i = 0; i < styled.length; i++) {
      var bg = styled[i].style.backgroundImage;
      if (bg && bg.indexOf('url(') !== -1) {
        var url = bg.slice(bg.indexOf('url(') + 4, bg.lastIndexOf(')'));
        if (url.charAt(0) === '"' || url.charAt(0) === "'") url = url.substring(1, url.length - 1);
        if (url) els.push({ element: styled[i], value: url });
      }
    }
    return els;
  }

  // --- Co-occurrence helpers ---
  function findArrayRegions(anchors) {
    if (anchors.length < 2) return null;
    // Find lowest common ancestor of all anchor elements
    var lca = anchors[0].element;
    for (var i = 1; i < anchors.length; i++) {
      lca = commonParent(lca, anchors[i].element);
    }
    // Walk each anchor up to the direct child of LCA
    var regionMap = {};
    var seen = [];
    for (var i = 0; i < anchors.length; i++) {
      var el = anchors[i].element;
      while (el.parentElement && el.parentElement !== lca) {
        el = el.parentElement;
      }
      if (el === lca || !el.parentElement) return null;
      // Regions must be distinct elements
      if (seen.indexOf(el) !== -1) return null;
      seen.push(el);
      regionMap[anchors[i].index] = el;
    }
    if (!validateSiblingPattern(seen)) return null;
    return regionMap;
  }

  function validateSiblingPattern(els) {
    if (els.length < 2) return false;
    // All elements share same parent (direct children of LCA).
    // Check adjacency: regions must be clustered, not scattered across the page.
    // Allows at most 1 non-region sibling between consecutive regions (handles <hr> separators).
    var parent = els[0].parentElement;
    if (!parent) return false;
    var children = parent.children;
    var indices = [];
    for (var i = 0; i < els.length; i++) {
      for (var j = 0; j < children.length; j++) {
        if (children[j] === els[i]) { indices.push(j); break; }
      }
    }
    if (indices.length !== els.length) return false;
    indices.sort(function(a, b) { return a - b; });
    for (var i = 1; i < indices.length; i++) {
      if (indices[i] - indices[i - 1] > 2) return false;
    }
    return true;
  }

  // --- Matching (co-occurrence: anchor-first, region-constrained) ---
  function runMatching(cands) {
    var textEls = collectTextElements();
    var attrEls = collectAttrElements();

    // Count occurrences (text candidates only)
    var occ = {};
    for (var i = 0; i < textEls.length; i++) {
      var t = textEls[i].textContent.trim();
      for (var j = 0; j < cands.length; j++) {
        if (cands[j].matchMode === 'attribute') continue;
        if (t === cands[j].value || normalize(t) === normalize(cands[j].value)) {
          occ[cands[j].value] = (occ[cands[j].value] || 0) + 1;
        }
      }
    }

    var m = new Map();
    var f2e = new Map();
    var regions = new Map();

    function best(c, els) {
      var top = null, topS = 0, o = occ[c.value] || 0;
      for (var i = 0; i < els.length; i++) {
        var s = scoreMatch(c, els[i], o);
        if (s > topS) { topS = s; top = els[i]; }
      }
      return top && topS >= MED ? { element: top, score: topS } : null;
    }

    function findBest(c, tEls, aEls) {
      if (c.matchMode === 'attribute') {
        var top = null, topS = 0;
        for (var i = 0; i < aEls.length; i++) {
          var s = scoreAttrMatch(c.value, aEls[i].value);
          if (s > topS) { topS = s; top = aEls[i].element; }
        }
        return top && topS >= MED ? { element: top, score: topS } : null;
      }
      return best(c, tEls);
    }

    function commit(c, el, score) {
      var ef = f2e.get(c.fieldPath);
      if (!ef || ef.confidence < score) {
        f2e.set(c.fieldPath, { element: el, confidence: score });
      }
      var ex = m.get(el);
      var isAttr = c.matchMode === 'attribute';
      if (!ex) {
        m.set(el, { fieldPath: c.fieldPath, confidence: score, candidate: c });
      } else if (!isAttr) {
        if (ex.candidate.matchMode === 'attribute' || score > ex.confidence) {
          if (ex.candidate.matchMode !== 'attribute') f2e.delete(ex.fieldPath);
          m.set(el, { fieldPath: c.fieldPath, confidence: score, candidate: c });
        }
      }
    }

    function matchGlobal(list) {
      for (var i = 0; i < list.length; i++) {
        var r = findBest(list[i], textEls, attrEls);
        if (r) commit(list[i], r.element, r.score);
      }
    }

    // Separate array items from standalone candidates
    var byArray = {};
    var standalone = [];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (c.arrayField !== undefined && c.arrayIndex !== undefined) {
        if (!byArray[c.arrayField]) byArray[c.arrayField] = {};
        if (!byArray[c.arrayField][c.arrayIndex]) byArray[c.arrayField][c.arrayIndex] = [];
        byArray[c.arrayField][c.arrayIndex].push(c);
      } else {
        standalone.push(c);
      }
    }

    // Phase 1: Standalone candidates — match globally (same as before)
    matchGlobal(standalone);

    // Phase 2: Array items — anchor-first, region-constrained
    for (var af in byArray) {
      var group = byArray[af];
      var indices = Object.keys(group);
      var anchors = [];

      // Count attribute value occurrences across this array — only unique values can anchor
      var attrValueCounts = {};
      for (var ii = 0; ii < indices.length; ii++) {
        var idx = parseInt(indices[ii]);
        for (var ci = 0; ci < group[idx].length; ci++) {
          if (group[idx][ci].matchMode === 'attribute') {
            var av = group[idx][ci].value;
            attrValueCounts[av] = (attrValueCounts[av] || 0) + 1;
          }
        }
      }

      // Find anchor per item: prefer text, fall back to unique attribute candidates
      for (var ii = 0; ii < indices.length; ii++) {
        var idx = parseInt(indices[ii]);
        var bestAnchor = null;
        // Try text candidates first (richer scoring signals)
        for (var ci = 0; ci < group[idx].length; ci++) {
          if (group[idx][ci].matchMode === 'attribute') continue;
          var r = best(group[idx][ci], textEls);
          if (r && (!bestAnchor || r.score > bestAnchor.score)) {
            bestAnchor = { index: idx, candidate: group[idx][ci], element: r.element, score: r.score };
          }
        }
        // If no text anchor, try unique attribute candidates (shared URLs still excluded)
        if (!bestAnchor) {
          for (var ci = 0; ci < group[idx].length; ci++) {
            var cand = group[idx][ci];
            if (cand.matchMode !== 'attribute') continue;
            if (attrValueCounts[cand.value] > 1) continue;
            var r = findBest(cand, textEls, attrEls);
            if (r && (!bestAnchor || r.score > bestAnchor.score)) {
              bestAnchor = { index: idx, candidate: cand, element: r.element, score: r.score };
            }
          }
        }
        if (bestAnchor) anchors.push(bestAnchor);
      }

      // Try to find validated structural regions from anchors
      var regionMap = anchors.length >= 2 ? findArrayRegions(anchors) : null;

      if (regionMap) {
        var regionList = [];
        for (var ai = 0; ai < anchors.length; ai++) {
          var a = anchors[ai];
          commit(a.candidate, a.element, a.score);
          var region = regionMap[a.index];
          if (region) {
            regionList.push({ index: a.index, region: region });
            // Match remaining candidates within region only
            var rest = group[a.index].filter(function(c) { return c !== a.candidate; });
            if (rest.length > 0) {
              var rEls = textEls.filter(function(el) { return region.contains(el); });
              var rAEls = attrEls.filter(function(ae) { return region.contains(ae.element); });
              for (var ri = 0; ri < rest.length; ri++) {
                var r = findBest(rest[ri], rEls, rAEls);
                if (r) commit(rest[ri], r.element, r.score);
              }
            }
          }
        }
        // Unanchored items — fall back to global matching
        for (var ii = 0; ii < indices.length; ii++) {
          var idx = parseInt(indices[ii]);
          var isAnchored = false;
          for (var ai = 0; ai < anchors.length; ai++) {
            if (anchors[ai].index === idx) { isAnchored = true; break; }
          }
          if (!isAnchored) matchGlobal(group[idx]);
        }
        regionList.sort(function(a, b) {
          return a.region.compareDocumentPosition(b.region) & 2 ? 1 : -1;
        });
        // Verify DOM order matches data index order — non-monotonic means anchors swapped
        var monotonic = true;
        for (var mi = 1; mi < regionList.length; mi++) {
          if (regionList[mi].index <= regionList[mi - 1].index) { monotonic = false; break; }
        }
        if (regionList.length >= 2 && monotonic) regions.set(af, regionList);
      } else {
        // No valid regions — match everything globally
        for (var ii = 0; ii < indices.length; ii++) {
          matchGlobal(group[indices[ii]]);
        }
      }
    }

    return { mappings: m, fieldToElement: f2e, arrayRegions: regions };
  }

  function findMatch(el) {
    if (!mappings) return null;
    var cur = el;
    while (cur && cur !== document.body) {
      if (mappings.has(cur)) return mappings.get(cur);
      cur = cur.parentElement;
    }
    return null;
  }

  function positionHighlight(el) {
    var r = el.getBoundingClientRect();
    highlight.style.top = r.top - 2 + 'px';
    highlight.style.left = r.left - 2 + 'px';
    highlight.style.width = r.width + 4 + 'px';
    highlight.style.height = r.height + 4 + 'px';
    highlight.style.borderColor = '#3b82f6'; // reset to default blue
    highlight.style.opacity = '1';
  }

  var modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '\u2318' : 'Ctrl';

  function showTooltip(text) {
    tooltip.textContent = text;
    var hRect = highlight.getBoundingClientRect();
    tooltip.style.left = hRect.left + 'px';
    tooltip.style.top = Math.max(0, hRect.top - 26) + 'px';
    tooltip.style.opacity = '1';
  }

  function hideHighlight() {
    highlight.style.opacity = '0';
    tooltip.style.opacity = '0';
  }

  // --- Events ---
  var rafPending = false;
  document.addEventListener('mousemove', function(e) {
    if (rafPending || editing || selected) return; // no hover when selected
    rafPending = true;
    requestAnimationFrame(function() {
      rafPending = false;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) { hideHighlight(); return; }
      var match = findMatch(el);
      if (match && match.confidence >= MED) {
        var entry = fieldToElement ? fieldToElement.get(match.fieldPath) : null;
        var target = entry ? entry.element : el;
        positionHighlight(target);
        if (match.confidence >= HIGH) {
          highlight.style.borderStyle = 'solid';
          highlight.style.background = 'rgba(59,130,246,0.08)';
        } else {
          highlight.style.borderStyle = 'dashed';
          highlight.style.background = 'rgba(59,130,246,0.04)';
        }
        var tip = (match.confidence >= HIGH && match.candidate.editable)
          ? match.fieldPath + '  \u00b7  ' + modKey + '+click \u2192 form'
          : match.fieldPath + '  \u00b7  click \u2192 form';
        showTooltip(tip);
      } else if (bodyRegion && bodyRegion.contains(el)) {
        positionHighlight(bodyRegion);
        highlight.style.borderStyle = 'dashed';
        highlight.style.borderColor = '#8b5cf6';
        highlight.style.background = 'rgba(139, 92, 246, 0.04)';
        showTooltip('body content \u00b7 click to edit');
      } else {
        hideHighlight();
      }
    });
  }, { passive: true });

  function selectElement(target, match) {
    selected = { element: target, match: match };
    positionHighlight(target);
    highlight.style.borderWidth = '3px';
    highlight.style.borderStyle = 'solid';
    highlight.style.background = 'rgba(59,130,246,0.12)';
    showTooltip(match.fieldPath + ' \u00b7 click to edit  \u00b7  ' + modKey + '+click \u2192 form');
  }

  function deselect() {
    selected = null;
    hideHighlight();
    highlight.style.borderWidth = '2px';
    highlight.style.borderStyle = 'solid';
    highlight.style.background = 'rgba(59,130,246,0.08)';
  }

  // Click: select → act on second click. Non-editable fields go to panel on first click.
  document.addEventListener('click', function(e) {
    if (!mappings || editing) return;

    // Prevent link navigation in overlay mode
    var link = e.target.closest ? e.target.closest('a[href]') : null;
    if (link) e.preventDefault();

    var match = findMatch(e.target);
    if (!match || match.confidence < MED) {
      // Check if click is inside body region
      if (bodyRegion && bodyRegion.contains(e.target)) {
        e.preventDefault();
        window.parent.postMessage({ type: 'mimsy:focus', fieldPath: '__body__' }, location.origin);
        return;
      }
      deselect();
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    var entry = fieldToElement ? fieldToElement.get(match.fieldPath) : null;
    var target = entry ? entry.element : e.target;
    var canInline = match.candidate.editable && match.confidence >= HIGH;

    // Modifier+click → always go to form field
    if (e.metaKey || e.ctrlKey) {
      window.parent.postMessage({ type: 'mimsy:focus', fieldPath: match.fieldPath }, location.origin);
      deselect();
      return;
    }

    // If clicking the already-selected element → act
    if (selected && selected.element === target) {
      if (canInline) {
        deselect();
        activateInlineEdit(target, match);
      } else {
        window.parent.postMessage({ type: 'mimsy:focus', fieldPath: match.fieldPath }, location.origin);
        deselect();
      }
      return;
    }

    // Non-editable fields: skip select, go straight to panel
    if (!canInline) {
      window.parent.postMessage({ type: 'mimsy:focus', fieldPath: match.fieldPath }, location.origin);
      return;
    }

    // Editable text: select first, inline edit on second click
    selectElement(target, match);
  }, true);

  // Escape to deselect
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && selected && !editing) {
      deselect();
      e.preventDefault();
    }
  }, true);

  function activateInlineEdit(element, match) {
    var original = element.textContent;
    editing = element;
    hideHighlight();

    element.contentEditable = 'plaintext-only';
    element.focus();
    var range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    element.style.outline = '2px solid #3b82f6';
    element.style.outlineOffset = '2px';
    element.style.borderRadius = '2px';

    function commit() {
      var newVal = element.textContent.trim();
      cleanup();
      if (newVal && newVal !== original.trim()) {
        window.parent.postMessage({ type: 'mimsy:edit', fieldPath: match.fieldPath, value: newVal }, location.origin);
      }
    }

    function cancel() {
      element.textContent = original;
      cleanup();
    }

    function cleanup() {
      element.contentEditable = 'false';
      element.style.outline = '';
      element.style.outlineOffset = '';
      element.style.borderRadius = '';
      element.removeEventListener('blur', commit);
      element.removeEventListener('keydown', handleKey);
      element.removeEventListener('paste', handlePaste);
      editing = null;
    }

    function handleKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    }

    function handlePaste(e) {
      e.preventDefault();
      var text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    }

    element.addEventListener('blur', commit);
    element.addEventListener('keydown', handleKey);
    element.addEventListener('paste', handlePaste);
  }

  // --- Gate: Relaxed Array Reorder Safety ---
  // Requires >=60% of items to have HIGH-confidence anchors,
  // remaining items must have at least MED, and validated regions must exist.
  function isArrayReorderSafe(arrayPath) {
    if (!arrayRegions || !arrayRegions.has(arrayPath)) return false;
    if (!candidates || !fieldToElement) return false;
    var regionItems = arrayRegions.get(arrayPath);
    var items = {};
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c.arrayField === arrayPath && c.arrayIndex !== undefined) {
        if (!items[c.arrayIndex]) items[c.arrayIndex] = { high: false, med: false };
        var entry = fieldToElement.get(c.fieldPath);
        if (entry) {
          if (entry.confidence >= HIGH) items[c.arrayIndex].high = true;
          if (entry.confidence >= MED) items[c.arrayIndex].med = true;
        }
      }
    }
    var keys = Object.keys(items);
    if (keys.length < 2) return false;
    // Regions must cover every item — partial coverage means some items can't be dragged
    if (regionItems.length !== keys.length) return false;
    var highCount = 0;
    for (var k = 0; k < keys.length; k++) {
      if (items[keys[k]].high) highCount++;
      else if (!items[keys[k]].med) return false;
    }
    return highCount / keys.length >= 0.6;
  }

  function commonParent(a, b) {
    var aPath = [];
    var node = a;
    while (node) { aPath.push(node); node = node.parentElement; }
    node = b;
    while (node) {
      if (aPath.indexOf(node) !== -1) return node;
      node = node.parentElement;
    }
    return document.body;
  }

  // --- Probe helpers: DOM path for deterministic element identification ---
  function getElementPath(el) {
    var path = [];
    var cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      var parent = cur.parentElement;
      if (!parent) break;
      var idx = 0;
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i] === cur) { idx = i; break; }
      }
      path.unshift(cur.tagName + ':' + idx);
      cur = parent;
    }
    return path;
  }

  function followElementPath(path) {
    var cur = document.body;
    for (var i = 0; i < path.length; i++) {
      var parts = path[i].split(':');
      var tag = parts[0];
      var idx = parseInt(parts[1]);
      if (!cur.children || !cur.children[idx]) return null;
      cur = cur.children[idx];
      if (cur.tagName !== tag) return null;
    }
    return cur;
  }

  /** Walk DOM for probe strings. Returns { fieldPath: [ { path, attribute, inHead? } ] }. */
  function scanForProbes(probeMap) {
    var result = {};
    var PROBE_ATTRS = ['src', 'href', 'poster', 'content', 'alt', 'title', 'placeholder'];
    var probeIds = Object.keys(probeMap);
    if (probeIds.length === 0) return result;

    function addHit(fp, hit) {
      if (!result[fp]) result[fp] = [];
      result[fp].push(hit);
    }

    // Scan text nodes in body (skip script/style — their text is code, not visible content)
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        var p = node.parentElement;
        if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE' || p.tagName === 'NOSCRIPT')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      var text = walker.currentNode.textContent;
      if (!text) continue;
      for (var pi = 0; pi < probeIds.length; pi++) {
        var pid = probeIds[pi];
        if (text.indexOf(pid) !== -1) {
          var el = walker.currentNode.parentElement;
          if (el) addHit(probeMap[pid], { path: getElementPath(el), attribute: null });
        }
      }
    }

    // Scan attributes on all body elements
    var allEls = document.body.querySelectorAll('*');
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      if (el.hasAttribute('data-mimsy-highlight') || el.hasAttribute('data-mimsy-tooltip') || el.hasAttribute('data-mimsy-drag')) continue;
      for (var j = 0; j < PROBE_ATTRS.length; j++) {
        var av = el.getAttribute(PROBE_ATTRS[j]);
        if (!av) continue;
        for (var pi = 0; pi < probeIds.length; pi++) {
          if (av.indexOf(probeIds[pi]) !== -1) {
            addHit(probeMap[probeIds[pi]], { path: getElementPath(el), attribute: PROBE_ATTRS[j] });
          }
        }
      }
      // background-image
      var bg = el.style.backgroundImage;
      if (bg) {
        for (var pi = 0; pi < probeIds.length; pi++) {
          if (bg.indexOf(probeIds[pi]) !== -1) {
            addHit(probeMap[probeIds[pi]], { path: getElementPath(el), attribute: 'backgroundImage' });
          }
        }
      }
    }

    // Scan <head> elements (title, meta)
    var headEls = document.head ? document.head.querySelectorAll('title, meta[content]') : [];
    for (var i = 0; i < headEls.length; i++) {
      var el = headEls[i];
      if (el.tagName === 'TITLE') {
        var tt = el.textContent || '';
        for (var pi = 0; pi < probeIds.length; pi++) {
          if (tt.indexOf(probeIds[pi]) !== -1) addHit(probeMap[probeIds[pi]], { path: ['HEAD:' + i], attribute: null, inHead: true });
        }
      } else {
        var cv = el.getAttribute('content') || '';
        for (var pi = 0; pi < probeIds.length; pi++) {
          if (cv.indexOf(probeIds[pi]) !== -1) addHit(probeMap[probeIds[pi]], { path: ['HEAD:' + i], attribute: 'content', inHead: true });
        }
      }
    }

    // Scan JSON-LD
    var jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < jsonLd.length; i++) {
      var jt = jsonLd[i].textContent || '';
      for (var pi = 0; pi < probeIds.length; pi++) {
        if (jt.indexOf(probeIds[pi]) !== -1) addHit(probeMap[probeIds[pi]], { path: getElementPath(jsonLd[i]), attribute: 'jsonld', inHead: true });
      }
    }

    return result;
  }

  /** Apply a probeMapping to build mappings/fieldToElement from element paths.
   *  probeMapping values are arrays: [ { path, attribute, inHead? }, ... ]
   *  First body hit becomes the interactive target; all hits are mapped. */
  function applyProbeMapping(probeMapping, cands) {
    var PROBED = 1.0;
    mappings = new Map();
    fieldToElement = new Map();

    // Build candidate lookup by fieldPath
    var candMap = {};
    for (var i = 0; i < cands.length; i++) candMap[cands[i].fieldPath] = cands[i];

    for (var fp in probeMapping) {
      var hits = probeMapping[fp];
      // Normalize: accept both single object (legacy) and array format
      if (!Array.isArray(hits)) hits = [hits];
      var cand = candMap[fp];
      if (!cand) continue;

      for (var hi = 0; hi < hits.length; hi++) {
        var entry = hits[hi];
        if (entry.inHead) continue; // Head elements not interactable
        var el = followElementPath(entry.path);
        if (!el) continue;

        mappings.set(el, { fieldPath: fp, confidence: PROBED, candidate: cand });
        // First resolved body element becomes the primary interactive target
        if (!fieldToElement.has(fp)) {
          fieldToElement.set(fp, { element: el, confidence: PROBED });
        }
      }
    }

    // Build array regions from probed elements
    buildProbedRegions(cands);
  }

  /** Check if current probe mapping is stale (no visible elements resolved). */
  function isMappingStale() {
    if (!fieldToElement || fieldToElement.size === 0) return true;
    var visible = 0;
    fieldToElement.forEach(function(v) {
      if (v.element) {
        var r = v.element.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) visible++;
      }
    });
    return visible === 0;
  }

  /** Build array regions from deterministic probe mapping. */
  function buildProbedRegions(cands) {
    if (!fieldToElement) return;
    arrayRegions = new Map();

    // Group mapped elements by arrayField and arrayIndex
    var byArray = {};
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (c.arrayField === undefined || c.arrayIndex === undefined) continue;
      var entry = fieldToElement.get(c.fieldPath);
      if (!entry) continue;
      if (!byArray[c.arrayField]) byArray[c.arrayField] = {};
      if (!byArray[c.arrayField][c.arrayIndex]) byArray[c.arrayField][c.arrayIndex] = [];
      byArray[c.arrayField][c.arrayIndex].push(entry.element);
    }

    for (var af in byArray) {
      var group = byArray[af];
      var indices = Object.keys(group).map(Number).sort(function(a, b) { return a - b; });
      if (indices.length < 2) continue;

      // Find LCA of all item elements, then walk each item's elements up to direct child of LCA
      var allEls = [];
      for (var ii = 0; ii < indices.length; ii++) {
        allEls = allEls.concat(group[indices[ii]]);
      }
      if (allEls.length < 2) continue;
      var lca = allEls[0];
      for (var i = 1; i < allEls.length; i++) lca = commonParent(lca, allEls[i]);

      var regionList = [];
      var seen = [];
      var valid = true;
      for (var ii = 0; ii < indices.length; ii++) {
        var itemEls = group[indices[ii]];
        // Find common parent of this item's elements
        var itemRoot = itemEls[0];
        for (var j = 1; j < itemEls.length; j++) itemRoot = commonParent(itemRoot, itemEls[j]);
        // Walk up to direct child of LCA
        while (itemRoot.parentElement && itemRoot.parentElement !== lca) itemRoot = itemRoot.parentElement;
        if (itemRoot === lca || !itemRoot.parentElement) { valid = false; break; }
        if (seen.indexOf(itemRoot) !== -1) { valid = false; break; }
        seen.push(itemRoot);
        regionList.push({ index: indices[ii], region: itemRoot });
      }

      if (valid && seen.length >= 2 && validateSiblingPattern(seen)) {
        arrayRegions.set(af, regionList);
      }
    }
  }

  function identifyBlockRegions() {
    if (!arrayRegions || arrayRegions.size === 0) return null;
    var safe = new Map();
    arrayRegions.forEach(function(items, ap) {
      if (isArrayReorderSafe(ap)) safe.set(ap, items);
    });
    return safe.size > 0 ? safe : null;
  }

  function cleanupDragHandles() {
    for (var i = 0; i < dragHandles.length; i++) {
      var h = dragHandles[i];
      if (h.region) {
        h.region.removeAttribute('draggable');
        h.region.removeEventListener('dragstart', h.dragstart);
        h.region.removeEventListener('dragend', h.dragend);
        h.region.removeEventListener('dragover', h.dragover);
        h.region.removeEventListener('dragleave', h.dragleave);
        h.region.removeEventListener('drop', h.drop);
        h.region.removeEventListener('mouseenter', h.enter);
        h.region.removeEventListener('mouseleave', h.leave);
        h.region.style.position = h.origPos;
        h.region.style.outline = '';
        h.region.style.outlineOffset = '';
        if (h.grip) h.grip.remove();
      }
    }
    dragHandles = [];
    dropIndicator.style.display = 'none';
  }

  function setupDragHandles() {
    cleanupDragHandles();
    var regs = identifyBlockRegions();
    if (!regs) return;
    regs.forEach(function(items, arrayPath) {
      for (var i = 0; i < items.length; i++) {
        (function(item) {
          var region = item.region;
          var origPos = region.style.position || '';
          if (!origPos || origPos === 'static') region.style.position = 'relative';
          region.setAttribute('draggable', 'true');
          // Persistent grip icon (6-dot 2x3 grid)
          var grip = document.createElement('div');
          grip.setAttribute('data-mimsy-grip', '');
          grip.style.cssText = 'position:absolute;top:50%;left:4px;transform:translateY(-50%);width:10px;display:flex;flex-wrap:wrap;gap:1.5px;justify-content:center;opacity:0.2;transition:opacity 150ms;pointer-events:none;z-index:99997;';
          for (var d = 0; d < 6; d++) {
            var dot = document.createElement('div');
            dot.style.cssText = 'width:2.5px;height:2.5px;border-radius:50%;background:#8b5cf6;';
            grip.appendChild(dot);
          }
          region.appendChild(grip);
          var enter = function() {
            region.style.outline = '2px solid rgba(139,92,246,0.5)';
            region.style.outlineOffset = '-2px';
            region.style.cursor = 'grab';
            grip.style.opacity = '0.6';
          };
          var leave = function() {
            region.style.outline = '';
            region.style.outlineOffset = '';
            region.style.cursor = '';
            grip.style.opacity = '0.2';
          };
          var dragstart = function(e) {
            if (editing) { e.preventDefault(); return; }
            e.dataTransfer.setData('text/plain', JSON.stringify({ arrayPath: arrayPath, index: item.index }));
            e.dataTransfer.effectAllowed = 'move';
            region.style.opacity = '0.4';
          };
          var dragend = function() {
            region.style.opacity = '';
            dropIndicator.style.display = 'none';
          };
          var dragover = function(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            var rect = region.getBoundingClientRect();
            var mid = rect.top + rect.height / 2;
            dropIndicator.style.display = 'block';
            dropIndicator.style.left = rect.left + 'px';
            dropIndicator.style.width = rect.width + 'px';
            dropIndicator.style.top = (e.clientY < mid ? rect.top - 2 : rect.bottom + 1) + 'px';
          };
          var dragleave = function() { dropIndicator.style.display = 'none'; };
          var drop = function(e) {
            e.preventDefault();
            dropIndicator.style.display = 'none';
            try {
              var data = JSON.parse(e.dataTransfer.getData('text/plain'));
              if (typeof data.arrayPath !== 'string' || data.arrayPath !== arrayPath) return;
              if (!Number.isInteger(data.index) || data.index < 0) return;
              var rect = region.getBoundingClientRect();
              var mid = rect.top + rect.height / 2;
              var targetIdx = e.clientY < mid ? item.index : item.index + 1;
              var from = data.index;
              if (from === targetIdx || from === targetIdx - 1) return;
              var to = targetIdx > from ? targetIdx - 1 : targetIdx;
              if (to < 0) return;
              window.parent.postMessage({ type: 'mimsy:reorder', arrayPath: data.arrayPath, from: from, to: to }, location.origin);
            } catch(ex) {}
          };
          region.addEventListener('mouseenter', enter);
          region.addEventListener('mouseleave', leave);
          region.addEventListener('dragstart', dragstart);
          region.addEventListener('dragend', dragend);
          region.addEventListener('dragover', dragover);
          region.addEventListener('dragleave', dragleave);
          region.addEventListener('drop', drop);
          dragHandles.push({ region: region, grip: grip, origPos: origPos, enter: enter, leave: leave, dragstart: dragstart, dragend: dragend, dragover: dragover, dragleave: dragleave, drop: drop });
        })(items[i]);
      }
    });
  }

  // --- PostMessage ---
  window.addEventListener('message', function(e) {
    if (e.source !== window.parent || e.origin !== location.origin) return;
    var d = e.data;
    if (!d || !d.type) return;

    if (d.type === 'mimsy:probe') {
      // Mutation probing: DOM has been rendered with probe sentinels.
      // Walk DOM, find probe strings, report element paths back to editor.
      var probeResult = scanForProbes(d.probeMap || {});
      window.parent.postMessage({ type: 'mimsy:probe-mapped', mapping: probeResult }, location.origin);
    }

    if (d.type === 'mimsy:init') {
      candidates = d.candidates;
      hasBody = !!d.hasBody;
      if (d.contentHash === cacheHash && mappings) {
        // Verify cached elements still in DOM
        var valid = true;
        mappings.forEach(function(v, k) {
          if (!document.body.contains(k)) valid = false;
        });
        if (valid) {
          reportMapped();
          setupDragHandles();
          detectBodyRegion();
          return;
        }
      }

      if (d.probeMapping) {
        // Deterministic mapping from mutation probing — store durably
        storedProbeMapping = d.probeMapping;
        applyProbeMapping(d.probeMapping, candidates);
        // Self-healing: if no mapped elements are visible, mapping is stale
        if (isMappingStale()) {
          storedProbeMapping = null;
          var result = runMatching(candidates);
          mappings = result.mappings;
          fieldToElement = result.fieldToElement;
          arrayRegions = result.arrayRegions;
          window.parent.postMessage({ type: 'mimsy:probe-stale' }, location.origin);
        }
      } else if (storedProbeMapping) {
        // Re-apply durable probe mapping (e.g., after autosave HMR with no new probe)
        applyProbeMapping(storedProbeMapping, candidates);
        if (isMappingStale()) {
          storedProbeMapping = null;
          var result = runMatching(candidates);
          mappings = result.mappings;
          fieldToElement = result.fieldToElement;
          arrayRegions = result.arrayRegions;
        }
      } else {
        // Heuristic fallback (GitHub mode or probing not available)
        var result = runMatching(candidates);
        mappings = result.mappings;
        fieldToElement = result.fieldToElement;
        arrayRegions = result.arrayRegions;
      }
      cacheHash = d.contentHash || '';
      reportMapped();
      setupDragHandles();
      detectBodyRegion();
    }

    if (d.type === 'mimsy:highlight' && fieldToElement) {
      var entry = fieldToElement.get(d.fieldPath);
      if (entry) {
        positionHighlight(entry.element);
        highlight.style.borderStyle = 'solid';
        highlight.style.background = 'rgba(59,130,246,0.08)';
        showTooltip(d.fieldPath + '  \u00b7  ' + modKey + '+click \u2192 form');
      }
    }

    if (d.type === 'mimsy:unhighlight') {
      hideHighlight();
    }

    // Instant DOM patching — update text content without iframe reload
    if (d.type === 'mimsy:update' && fieldToElement) {
      var entry = fieldToElement.get(d.fieldPath);
      if (entry && entry.element) {
        var m = mappings ? mappings.get(entry.element) : null;
        if (m && m.candidate && m.candidate.matchMode !== 'attribute') {
          entry.element.textContent = d.value;
        }
      }
    }
  });

  function reportMapped() {
    var total = 0, high = 0, med = 0;
    if (mappings) {
      mappings.forEach(function(v) {
        total++;
        if (v.confidence >= HIGH) high++;
        else if (v.confidence >= MED) med++;
      });
    }
    window.parent.postMessage({ type: 'mimsy:mapped', total: total, high: high, medium: med }, location.origin);
  }

  // Handle Astro View Transitions in preview
  document.addEventListener('astro:after-swap', function() {
    // DOM changed — reset active state and re-run matching
    if (editing) {
      editing.contentEditable = 'false';
      editing.style.outline = '';
      editing.style.outlineOffset = '';
      editing.style.borderRadius = '';
      editing = null;
    }
    if (selected) deselect();
    if (candidates) {
      // Re-append overlay elements (they may have been removed by swap)
      if (!document.body.contains(highlight)) document.body.appendChild(highlight);
      if (!document.body.contains(tooltip)) document.body.appendChild(tooltip);
      if (!document.body.contains(dropIndicator)) document.body.appendChild(dropIndicator);
      // Re-apply durable probe mapping if available; fall back to heuristics
      if (storedProbeMapping) {
        applyProbeMapping(storedProbeMapping, candidates);
      } else {
        var result = runMatching(candidates);
        mappings = result.mappings;
        fieldToElement = result.fieldToElement;
        arrayRegions = result.arrayRegions;
      }
      reportMapped();
      setupDragHandles();
    }
  });

  // --- MutationObserver: catch dynamic content (island hydration, lazy load, fetch) ---
  var mutationTimer = null;
  var observer = new MutationObserver(function(mutations) {
    // Debounce: re-verify mapping 500ms after last mutation batch
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(function() {
      if (!mappings || !fieldToElement) return;
      // Spot-check: verify a few cached mappings still point to correct elements
      var invalid = 0;
      mappings.forEach(function(v, k) {
        if (!document.body.contains(k)) invalid++;
      });
      if (invalid > 0 && candidates) {
        // Re-apply durable probe mapping if available; fall back to heuristics
        if (storedProbeMapping) {
          applyProbeMapping(storedProbeMapping, candidates);
        } else {
          var result = runMatching(candidates);
          mappings = result.mappings;
          fieldToElement = result.fieldToElement;
          arrayRegions = result.arrayRegions;
        }
        reportMapped();
        setupDragHandles();
      }
    }, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Ready
  window.parent.postMessage({ type: 'mimsy:ready' }, location.origin);
})();`;
