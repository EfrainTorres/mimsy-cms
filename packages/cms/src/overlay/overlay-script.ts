/**
 * Overlay IIFE — injected into the preview iframe via middleware.
 * Gate 1: matching engine + hover highlight + click-to-focus.
 * Gate 2: inline string editing via double-click.
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
  var blockRegions = null;    // Map<arrayPath, [{ index, region }]>
  var dragHandles = [];       // cleanup references

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

  function collectTextElements() {
    var SKIP = { SCRIPT:1, STYLE:1, NOSCRIPT:1, SVG:1, HEAD:1, META:1, LINK:1 };
    var els = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: function(node) {
        if (SKIP[node.tagName]) return NodeFilter.FILTER_REJECT;
        if (node.hasAttribute('data-mimsy-highlight') || node.hasAttribute('data-mimsy-tooltip') || node.hasAttribute('data-mimsy-drag')) return NodeFilter.FILTER_REJECT;
        var t = node.textContent;
        if (!t || !t.trim()) return NodeFilter.FILTER_SKIP;
        if (node.children.length <= 5) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
    });
    while (walker.nextNode()) els.push(walker.currentNode);
    return els;
  }

  function runMatching(cands) {
    var textEls = collectTextElements();

    // Count occurrences
    var occ = {};
    for (var i = 0; i < textEls.length; i++) {
      var t = textEls[i].textContent.trim();
      for (var j = 0; j < cands.length; j++) {
        if (t === cands[j].value || normalize(t) === normalize(cands[j].value)) {
          occ[cands[j].value] = (occ[cands[j].value] || 0) + 1;
        }
      }
    }

    // Score and map
    var m = new Map();
    var f2e = new Map();

    for (var ci = 0; ci < cands.length; ci++) {
      var c = cands[ci];
      var best = null;
      var bestS = 0;
      var o = occ[c.value] || 0;

      for (var ei = 0; ei < textEls.length; ei++) {
        var s = scoreMatch(c, textEls[ei], o);
        if (s > bestS) { bestS = s; best = textEls[ei]; }
      }

      if (best && bestS >= MED) {
        var ex = m.get(best);
        if (!ex || bestS > ex.confidence) {
          if (ex) f2e.delete(ex.fieldPath);
          m.set(best, { fieldPath: c.fieldPath, confidence: bestS, candidate: c });
          f2e.set(c.fieldPath, { element: best, confidence: bestS });
        }
      }
    }

    return { mappings: m, fieldToElement: f2e };
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
    highlight.style.opacity = '1';
  }

  function showTooltip(path, conf) {
    var label = path;
    if (conf < HIGH) label += ' (edit in form)';
    tooltip.textContent = label;
    // Position above highlight
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
  var cursorEl = null;    // element with overridden cursor
  var cursorOrig = '';    // its original cursor value
  document.addEventListener('mousemove', function(e) {
    if (rafPending || editing) return;
    rafPending = true;
    requestAnimationFrame(function() {
      rafPending = false;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) { hideHighlight(); restoreCursor(); return; }
      var match = findMatch(el);
      if (match && match.confidence >= MED) {
        var entry = fieldToElement ? fieldToElement.get(match.fieldPath) : null;
        var target = entry ? entry.element : el;
        positionHighlight(target);
        showTooltip(match.fieldPath, match.confidence);
        // Show text cursor on HIGH-confidence editable elements
        if (match.confidence >= HIGH && match.candidate.editable) {
          if (cursorEl !== target) {
            restoreCursor();
            cursorOrig = target.style.cursor || '';
            target.style.cursor = 'text';
            cursorEl = target;
          }
        } else {
          restoreCursor();
        }
      } else {
        hideHighlight();
        restoreCursor();
      }
    });
  }, { passive: true });

  function restoreCursor() {
    if (cursorEl) {
      cursorEl.style.cursor = cursorOrig;
      cursorEl = null;
      cursorOrig = '';
    }
  }

  // Click: focus field in editor (delayed to allow dblclick)
  var clickTimer = null;
  document.addEventListener('click', function(e) {
    if (!mappings || editing) return;
    var match = findMatch(e.target);
    if (match && match.confidence >= HIGH) {
      e.preventDefault();
      e.stopPropagation();
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(function() {
        clickTimer = null;
        window.parent.postMessage({ type: 'mimsy:focus', fieldPath: match.fieldPath }, location.origin);
      }, 250);
    }
  }, true);

  // Prevent link navigation in overlay mode
  document.addEventListener('click', function(e) {
    var link = e.target.closest ? e.target.closest('a[href]') : null;
    if (link && !e.defaultPrevented) {
      e.preventDefault();
    }
  }, true);

  // Double-click: inline edit (Gate 2)
  document.addEventListener('dblclick', function(e) {
    if (!mappings || editing) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    var match = findMatch(e.target);
    if (!match || match.confidence < HIGH || !match.candidate.editable) return;
    e.preventDefault();
    var entry = fieldToElement ? fieldToElement.get(match.fieldPath) : null;
    if (entry) activateInlineEdit(entry.element, match);
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

  // --- Gate 3: Scoped Array Reorder ---
  // Requires each array item to have at least one HIGH-confidence match (anchor).
  // Not all fields — just one reliable anchor per item to identify its DOM region.
  function isArrayReorderSafe(arrayPath) {
    if (!candidates || !fieldToElement) return false;
    var indices = {};
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c.arrayField === arrayPath && c.arrayIndex !== undefined) {
        if (!indices[c.arrayIndex]) indices[c.arrayIndex] = false;
        var entry = fieldToElement.get(c.fieldPath);
        if (entry && entry.confidence >= HIGH) indices[c.arrayIndex] = true;
      }
    }
    var keys = Object.keys(indices);
    if (keys.length < 2) return false;
    for (var k = 0; k < keys.length; k++) {
      if (!indices[keys[k]]) return false;
    }
    return true;
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

  function findContentAncestor(el) {
    var cur = el;
    while (cur.parentElement && cur.parentElement !== document.body) {
      if (cur.parentElement.children.length >= 2) return cur;
      cur = cur.parentElement;
    }
    return cur;
  }

  function findCommonAncestor(els) {
    if (els.length === 0) return document.body;
    if (els.length === 1) return findContentAncestor(els[0]);
    var a = els[0];
    for (var i = 1; i < els.length; i++) a = commonParent(a, els[i]);
    return findContentAncestor(a);
  }

  function identifyBlockRegions() {
    if (!candidates || !fieldToElement) return null;
    var arrays = {};
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c.arrayField === undefined) continue;
      if (!isArrayReorderSafe(c.arrayField)) continue;
      if (!arrays[c.arrayField]) arrays[c.arrayField] = {};
      if (!arrays[c.arrayField][c.arrayIndex]) arrays[c.arrayField][c.arrayIndex] = [];
      var entry = fieldToElement.get(c.fieldPath);
      if (entry) arrays[c.arrayField][c.arrayIndex].push(entry.element);
    }
    var regions = new Map();
    for (var ap in arrays) {
      var items = [];
      for (var idx in arrays[ap]) {
        var els = arrays[ap][idx];
        if (els.length === 0) continue;
        var region = els.length === 1 ? findContentAncestor(els[0]) : findCommonAncestor(els);
        items.push({ index: parseInt(idx), region: region });
      }
      items.sort(function(a, b) {
        return a.region.compareDocumentPosition(b.region) & 2 ? 1 : -1;
      });
      if (items.length >= 2) regions.set(ap, items);
    }
    return regions.size > 0 ? regions : null;
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
      }
    }
    dragHandles = [];
    dropIndicator.style.display = 'none';
  }

  function setupDragHandles() {
    cleanupDragHandles();
    blockRegions = identifyBlockRegions();
    if (!blockRegions) return;
    blockRegions.forEach(function(items, arrayPath) {
      for (var i = 0; i < items.length; i++) {
        (function(item) {
          var region = item.region;
          var origPos = region.style.position || '';
          if (!origPos || origPos === 'static') region.style.position = 'relative';
          region.setAttribute('draggable', 'true');
          var enter = function() {
            region.style.outline = '2px solid rgba(139,92,246,0.5)';
            region.style.outlineOffset = '-2px';
            region.style.cursor = 'grab';
          };
          var leave = function() {
            region.style.outline = '';
            region.style.outlineOffset = '';
            region.style.cursor = '';
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
          dragHandles.push({ region: region, origPos: origPos, enter: enter, leave: leave, dragstart: dragstart, dragend: dragend, dragover: dragover, dragleave: dragleave, drop: drop });
        })(items[i]);
      }
    });
  }

  // --- PostMessage ---
  window.addEventListener('message', function(e) {
    if (e.source !== window.parent || e.origin !== location.origin) return;
    var d = e.data;
    if (!d || !d.type) return;

    if (d.type === 'mimsy:init') {
      candidates = d.candidates;
      if (d.contentHash === cacheHash && mappings) {
        // Verify cached elements still in DOM
        var valid = true;
        mappings.forEach(function(v, k) {
          if (!document.body.contains(k)) valid = false;
        });
        if (valid) {
          reportMapped();
          setupDragHandles();
          return;
        }
      }
      var result = runMatching(candidates);
      mappings = result.mappings;
      fieldToElement = result.fieldToElement;
      cacheHash = d.contentHash || '';
      reportMapped();
      setupDragHandles();
    }

    if (d.type === 'mimsy:highlight' && fieldToElement) {
      var entry = fieldToElement.get(d.fieldPath);
      if (entry) {
        positionHighlight(entry.element);
        showTooltip(d.fieldPath, entry.confidence);
      }
    }

    if (d.type === 'mimsy:unhighlight') {
      hideHighlight();
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
    // DOM changed — reset any active inline edit and re-run matching
    if (editing) {
      editing.contentEditable = 'false';
      editing.style.outline = '';
      editing.style.outlineOffset = '';
      editing.style.borderRadius = '';
      editing = null;
    }
    if (candidates) {
      // Re-append overlay elements (they may have been removed by swap)
      if (!document.body.contains(highlight)) document.body.appendChild(highlight);
      if (!document.body.contains(tooltip)) document.body.appendChild(tooltip);
      if (!document.body.contains(dropIndicator)) document.body.appendChild(dropIndicator);
      var result = runMatching(candidates);
      mappings = result.mappings;
      fieldToElement = result.fieldToElement;
      reportMapped();
      setupDragHandles();
    }
  });

  // Ready
  window.parent.postMessage({ type: 'mimsy:ready' }, location.origin);
})();`;
