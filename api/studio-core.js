/*
 * AVIQO 3D STUDIO - scene model, transforms, groups, history and validation.
 * Pure JavaScript with no rendering dependency, so it can be unit tested in Node.
 * Every edit returns a new state object. The history keeps committed snapshots.
 *
 * Object fields: id, type ('cube'|'sphere'|'cylinder'|'glb'|'group'), name, parentId (null = top level),
 * position/rotation(degrees, XYZ Euler)/scale (local to parent), visible, locked,
 * color/roughness/metalness (null = keep original), glbRef, parts (per-mesh overrides for GLB models).
 */
(function (root) {
  'use strict';

  var SHAPES = ['cube', 'sphere', 'cylinder'];
  var PALETTE = ['#ff8c28', '#4f8cff', '#3ccf91', '#e5484d', '#8e6cff', '#f5c542'];
  var MAX_OBJECTS = 200;
  var HISTORY_LIMIT = 100;
  var MAX_GLB_BYTES = 50 * 1024 * 1024;
  var MIN_SCALE = 0.01;
  var MAX_SCALE = 100;
  var MAX_POS = 1000;
  var TRANSFORM_KEYS = ['name', 'position', 'rotation', 'scale'];
  var MATERIAL_KEYS = ['color', 'roughness', 'metalness'];

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function emptyState() {
    return { objects: [], selectedIds: [], selectedId: null, nextId: 1 };
  }

  function findIndex(state, id) {
    for (var i = 0; i < state.objects.length; i++) {
      if (state.objects[i].id === id) return i;
    }
    return -1;
  }

  function getObject(state, id) {
    var i = findIndex(state, id);
    return i === -1 ? null : state.objects[i];
  }

  function childrenOf(state, id) {
    return state.objects.filter(function (o) { return o.parentId === id; });
  }

  function topLevel(state) {
    return state.objects.filter(function (o) { return !o.parentId; });
  }

  function ancestorsOf(state, id) {
    var out = [];
    var o = getObject(state, id);
    var guard = 0;
    while (o && o.parentId && guard++ < 50) {
      o = getObject(state, o.parentId);
      if (o) out.push(o);
    }
    return out;
  }

  // An object is hidden if it or any ancestor is hidden.
  function isHidden(state, id) {
    var o = getObject(state, id);
    if (!o) return false;
    if (o.visible === false) return true;
    return ancestorsOf(state, id).some(function (a) { return a.visible === false; });
  }

  // An object is locked if it or any ancestor is locked.
  function isLocked(state, id) {
    var o = getObject(state, id);
    if (!o) return false;
    if (o.locked) return true;
    return ancestorsOf(state, id).some(function (a) { return a.locked; });
  }

  // The top-level ancestor of an object (or the object itself).
  function topLevelId(state, id) {
    var o = getObject(state, id);
    var guard = 0;
    while (o && o.parentId && guard++ < 50) {
      var p = getObject(state, o.parentId);
      if (!p) break;
      o = p;
    }
    return o ? o.id : null;
  }

  function nextName(state, type) {
    var count = 0;
    state.objects.forEach(function (o) { if (o.type === type) count++; });
    var label = type === 'glb' ? 'Model' : type.charAt(0).toUpperCase() + type.slice(1);
    return label + ' ' + (count + 1);
  }

  function assertRoom(state, extra) {
    if (state.objects.length + (extra || 0) > MAX_OBJECTS) {
      throw new Error('Scene limit reached (' + MAX_OBJECTS + ' objects). Delete something first.');
    }
  }

  // Selection helpers. Descendants of a selected object are dropped so a group and its child never both move.
  function normalizeSelection(state, ids) {
    var seen = {};
    var picked = [];
    ids.forEach(function (id) {
      if (getObject(state, id) && !seen[id]) { seen[id] = true; picked.push(id); }
    });
    var final = picked.filter(function (id) {
      return !ancestorsOf(state, id).some(function (a) { return seen[a.id]; });
    });
    return final;
  }

  function withSelection(state, ids) {
    var s = clone(state);
    var norm = normalizeSelection(s, ids);
    s.selectedIds = norm;
    s.selectedId = norm.length ? norm[norm.length - 1] : null;
    return s;
  }

  function selectIds(state, ids) { return withSelection(state, ids || []); }
  function selectObject(state, id) { return withSelection(state, id === null || id === undefined ? [] : [id]); }
  function toggleSelect(state, id) {
    if (!getObject(state, id)) throw new Error('Object not found');
    var cur = (state.selectedIds || []).slice();
    var i = cur.indexOf(id);
    if (i === -1) cur.push(id); else cur.splice(i, 1);
    return withSelection(state, cur);
  }
  function selectAll(state) {
    return withSelection(state, topLevel(state).map(function (o) { return o.id; }));
  }
  function clearSelection(state) { return withSelection(state, []); }

  // Adds an object (a shape, an imported GLB or a group). Returns { state, id } and selects it.
  function addObject(state, spec) {
    assertRoom(state, 1);
    var s = clone(state);
    var id = 'o' + s.nextId;
    s.nextId += 1;
    var n = s.objects.filter(function (o) { return !o.parentId; }).length;
    var isGlb = spec.type === 'glb';
    var isGroup = spec.type === 'group';
    var obj = {
      id: id,
      type: spec.type,
      name: (spec.name && String(spec.name).trim().slice(0, 40)) || nextName(s, spec.type),
      parentId: spec.parentId || null,
      position: spec.position ? spec.position.slice() : [(n % 5) * 1.6 - 3.2, 0.5, 0],
      rotation: spec.rotation ? spec.rotation.slice() : [0, 0, 0],
      scale: spec.scale ? spec.scale.slice() : [1, 1, 1],
      visible: true,
      locked: false,
      // imported models keep their own materials until the user edits them (null = keep original)
      color: isGroup ? null : (isGlb ? null : PALETTE[n % PALETTE.length]),
      roughness: isGroup || isGlb ? null : 0.5,
      metalness: isGroup || isGlb ? null : 0.0,
      glbRef: spec.glbRef || null,
      parts: {}
    };
    s.objects.push(obj);
    return { state: withSelection(s, [id]), id: id };
  }

  function addShape(state, shape) {
    if (SHAPES.indexOf(shape) === -1) throw new Error('Unknown shape: ' + shape);
    return addObject(state, { type: shape });
  }

  function vec3(v, limit) {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(isFiniteNum)) throw new Error('Expected three numbers');
    return v.map(function (x) { return clamp(x, -limit, limit); });
  }

  // Applies a validated patch to one object inside an already-cloned state.
  function applyPatch(o, patch) {
    if (patch.name !== undefined) {
      var name = String(patch.name).trim().slice(0, 40);
      if (!name) throw new Error('Name cannot be empty');
      o.name = name;
    }
    if (patch.position !== undefined) o.position = vec3(patch.position, MAX_POS);
    if (patch.rotation !== undefined) o.rotation = vec3(patch.rotation, 360 * 4);
    if (patch.scale !== undefined) {
      var sc = patch.scale;
      if (!Array.isArray(sc) || sc.length !== 3 || !sc.every(isFiniteNum)) throw new Error('Scale must be three numbers');
      o.scale = sc.map(function (v) { return clamp(v, MIN_SCALE, MAX_SCALE); });
    }
    if (patch.color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(String(patch.color))) throw new Error('Color must be a #RRGGBB value');
      o.color = String(patch.color).toLowerCase();
    }
    if (patch.roughness !== undefined) {
      if (!isFiniteNum(patch.roughness)) throw new Error('Roughness must be a number');
      o.roughness = clamp(patch.roughness, 0, 1);
    }
    if (patch.metalness !== undefined) {
      if (!isFiniteNum(patch.metalness)) throw new Error('Metalness must be a number');
      o.metalness = clamp(patch.metalness, 0, 1);
    }
    if (patch.visible !== undefined) o.visible = !!patch.visible;
    if (patch.locked !== undefined) o.locked = !!patch.locked;
  }

  function hasAny(patch, keys) {
    return keys.some(function (k) { return patch[k] !== undefined; });
  }

  // Validates and applies a partial update to one object. Locked objects only accept visible/locked changes.
  function updateObject(state, id, patch) {
    var i = findIndex(state, id);
    if (i === -1) throw new Error('Object not found');
    var o = state.objects[i];
    if (o.type === 'group' && hasAny(patch, MATERIAL_KEYS)) throw new Error('Groups have no material. Select the objects inside.');
    if (hasAny(patch, TRANSFORM_KEYS.concat(MATERIAL_KEYS)) && isLocked(state, id)) {
      throw new Error('This object is locked. Unlock it to edit.');
    }
    var s = clone(state);
    applyPatch(s.objects[findIndex(s, id)], patch);
    return s;
  }

  // Applies the same patch to several objects. Groups skip material fields. Locked objects are skipped and counted.
  function updateMany(state, ids, patch) {
    var s = clone(state);
    var skipped = 0;
    var changed = 0;
    ids.forEach(function (id) {
      var o = getObject(s, id);
      if (!o) return;
      if (o.type === 'group' && hasAny(patch, MATERIAL_KEYS)) return;
      if (hasAny(patch, TRANSFORM_KEYS.concat(MATERIAL_KEYS)) && isLocked(state, id)) { skipped++; return; }
      applyPatch(o, patch);
      changed++;
    });
    if (ids.length && !changed && skipped) throw new Error('Selected objects are locked. Unlock them to edit.');
    return { state: s, skipped: skipped, changed: changed };
  }

  // Per-mesh material override for imported GLB models. partKey comes from the viewport (stable index).
  function setPartMaterial(state, id, partKey, patch) {
    var o = getObject(state, id);
    if (!o) throw new Error('Object not found');
    if (o.type !== 'glb') throw new Error('Part materials apply to imported models only.');
    if (isLocked(state, id)) throw new Error('This object is locked. Unlock it to edit.');
    if (typeof partKey !== 'string' || !/^p\d{1,4}$/.test(partKey)) throw new Error('Unknown part');
    var s = clone(state);
    var target = getObject(s, id);
    var cur = target.parts[partKey] ? clone(target.parts[partKey]) : {};
    if (patch.color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(String(patch.color))) throw new Error('Color must be a #RRGGBB value');
      cur.color = String(patch.color).toLowerCase();
    }
    if (patch.roughness !== undefined) {
      if (!isFiniteNum(patch.roughness)) throw new Error('Roughness must be a number');
      cur.roughness = clamp(patch.roughness, 0, 1);
    }
    if (patch.metalness !== undefined) {
      if (!isFiniteNum(patch.metalness)) throw new Error('Metalness must be a number');
      cur.metalness = clamp(patch.metalness, 0, 1);
    }
    target.parts[partKey] = cur;
    return s;
  }

  function resetPartMaterial(state, id, partKey) {
    var o = getObject(state, id);
    if (!o) throw new Error('Object not found');
    if (isLocked(state, id)) throw new Error('This object is locked. Unlock it to edit.');
    var s = clone(state);
    delete getObject(s, id).parts[partKey];
    return s;
  }

  // ---- transform math (column-major 4x4, same Euler convention as three.js 'XYZ') ----
  var D2R = Math.PI / 180;
  var R2D = 180 / Math.PI;

  function composeTRS(p, r, s) {
    var x = r[0] * D2R, y = r[1] * D2R, z = r[2] * D2R;
    var a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
    var ae = a * e, af = a * f, be = b * e, bf = b * f;
    var te = [
      c * e, af + be * d, bf - ae * d, 0,
      -c * f, ae - bf * d, be + af * d, 0,
      d, -b * c, a * c, 0,
      p[0], p[1], p[2], 1
    ];
    for (var i = 0; i < 4; i++) { te[i] *= s[0]; te[4 + i] *= s[1]; te[8 + i] *= s[2]; }
    return te;
  }

  function multiply(A, B) {
    var C = new Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        var sum = 0;
        for (var k = 0; k < 4; k++) sum += A[k * 4 + r] * B[c * 4 + k];
        C[c * 4 + r] = sum;
      }
    }
    return C;
  }

  function decompose(M) {
    var p = [M[12], M[13], M[14]];
    var sx = Math.hypot(M[0], M[1], M[2]) || 1;
    var sy = Math.hypot(M[4], M[5], M[6]) || 1;
    var sz = Math.hypot(M[8], M[9], M[10]) || 1;
    var n = [M[0] / sx, M[1] / sx, M[2] / sx, 0, M[4] / sy, M[5] / sy, M[6] / sy, 0, M[8] / sz, M[9] / sz, M[10] / sz, 0];
    var m11 = n[0], m12 = n[4], m13 = n[8], m22 = n[5], m23 = n[9], m32 = n[6], m33 = n[10];
    var y = Math.asin(clamp(m13, -1, 1));
    var x, z;
    if (Math.abs(m13) < 0.9999999) {
      x = Math.atan2(-m23, m33);
      z = Math.atan2(-m12, m11);
    } else {
      x = Math.atan2(m32, m22);
      z = 0;
    }
    return { position: p, rotation: [x * R2D, y * R2D, z * R2D], scale: [sx, sy, sz] };
  }

  // World transform of an object, composed through its ancestors.
  function worldTransform(state, id) {
    var chain = ancestorsOf(state, id).reverse().concat([getObject(state, id)]);
    var M = composeTRS([0, 0, 0], [0, 0, 0], [1, 1, 1]);
    chain.forEach(function (o) {
      if (o) M = multiply(M, composeTRS(o.position, o.rotation, o.scale));
    });
    return decompose(M);
  }

  // Groups the selected top-level objects under a new group node. The group sits at their centre.
  function groupSelection(state, ids) {
    if (!ids || ids.length < 2) throw new Error('Select at least two objects to group.');
    var uniq = normalizeSelection(state, ids);
    if (uniq.length < 2) throw new Error('Select at least two separate objects to group.');
    var members = uniq.map(function (id) { return getObject(state, id); });
    if (members.some(function (o) { return o.parentId; })) throw new Error('Ungroup objects that are already inside a group first.');
    if (uniq.some(function (id) { return isLocked(state, id); })) throw new Error('Unlock the selected objects before grouping.');
    assertRoom(state, 1);
    var c = [0, 0, 0];
    members.forEach(function (o) { c[0] += o.position[0]; c[1] += o.position[1]; c[2] += o.position[2]; });
    c = c.map(function (v) { return v / members.length; });
    var r = addObject(state, { type: 'group', position: c, name: 'Group ' + (state.objects.filter(function (o) { return o.type === 'group'; }).length + 1) });
    var s = r.state;
    uniq.forEach(function (id) {
      var o = getObject(s, id);
      o.parentId = r.id;
      o.position = [o.position[0] - c[0], o.position[1] - c[1], o.position[2] - c[2]];
    });
    return { state: withSelection(s, [r.id]), id: r.id };
  }

  // Dissolves a group. Children keep their world position, rotation and scale.
  function ungroup(state, groupId) {
    var g = getObject(state, groupId);
    if (!g || g.type !== 'group') throw new Error('Select a group to ungroup.');
    if (isLocked(state, groupId)) throw new Error('Unlock the group before ungrouping.');
    var s = clone(state);
    var gm = composeTRS(g.position, g.rotation, g.scale);
    var kids = childrenOf(s, groupId);
    kids.forEach(function (k) {
      var world = decompose(multiply(gm, composeTRS(k.position, k.rotation, k.scale)));
      k.position = world.position;
      k.rotation = world.rotation;
      k.scale = world.scale;
      k.parentId = null;
    });
    s.objects = s.objects.filter(function (o) { return o.id !== groupId; });
    var ids = kids.map(function (k) { return k.id; });
    return { state: withSelection(s, ids), ids: ids };
  }

  // Deletes objects and their children. Locked objects block the delete.
  function deleteObjects(state, ids) {
    var targets = normalizeSelection(state, ids);
    var doomed = {};
    targets.forEach(function (id) {
      if (isLocked(state, id)) throw new Error('A selected object is locked. Unlock it before deleting.');
      doomed[id] = true;
      var stack = [id];
      while (stack.length) {
        var cur = stack.pop();
        childrenOf(state, cur).forEach(function (c) { doomed[c.id] = true; stack.push(c.id); });
      }
    });
    var removed = state.objects.filter(function (o) { return doomed[o.id]; });
    var s = clone(state);
    s.objects = s.objects.filter(function (o) { return !doomed[o.id]; });
    return { state: withSelection(s, []), removed: removed, count: removed.length };
  }

  // Deletes one object (compatibility wrapper).
  function deleteObject(state, id) {
    var r = deleteObjects(state, [id]);
    return { state: r.state, removed: getObject(state, id) };
  }

  // Duplicates selected top-level objects with their children. Copies are offset along X and selected.
  function duplicateSelection(state, ids) {
    var roots = normalizeSelection(state, ids);
    if (!roots.length) throw new Error('Select something to duplicate.');
    var all = [];
    roots.forEach(function (id) {
      all.push(getObject(state, id));
      var stack = [id];
      while (stack.length) {
        var cur = stack.pop();
        childrenOf(state, cur).forEach(function (c) { all.push(c); stack.push(c.id); });
      }
    });
    assertRoom(state, all.length);
    var s = clone(state);
    var map = {};
    var nextId = s.nextId;
    all.forEach(function (o) { map[o.id] = 'o' + (nextId++); });
    s.nextId = nextId;
    var rootSet = {};
    roots.forEach(function (id) { rootSet[id] = true; });
    all.forEach(function (o) {
      var copy = clone(o);
      copy.id = map[o.id];
      copy.parentId = o.parentId && map[o.parentId] ? map[o.parentId] : null;
      if (rootSet[o.id]) {
        copy.name = (o.name + ' copy').slice(0, 40);
        copy.position[0] = clamp(copy.position[0] + 1, -MAX_POS, MAX_POS);
      }
      s.objects.push(copy);
    });
    var newRoots = roots.map(function (id) { return map[id]; });
    return { state: withSelection(s, newRoots), ids: newRoots };
  }

  function duplicateObject(state, id) {
    var r = duplicateSelection(state, [id]);
    return { state: r.state, id: r.ids[0] };
  }

  // Snaps a value to a grid step. step <= 0 or missing means no snapping.
  function snapValue(v, step) {
    if (!step || step <= 0) return v;
    return Math.round(v / step) * step;
  }

  // Undo/redo history. preview() changes the present state without an undo entry (live drags and sliders).
  // commit(state, label) creates one undo entry. Selection-only changes never create an entry.
  function createHistory(initial) {
    var committed = clone(initial);
    var committedLabel = 'Start';
    var past = [];
    var pastLabels = [];
    var future = [];
    var futureLabels = [];
    var present = clone(initial);

    function stripSelection(s) {
      var copy = clone(s);
      delete copy.selectedIds;
      delete copy.selectedId;
      return JSON.stringify(copy);
    }

    return {
      get present() { return present; },
      preview: function (s) { present = clone(s); },
      commit: function (s, label) {
        if (stripSelection(s) === stripSelection(committed)) {
          present = clone(s);
          committed = clone(s);   // keep selection in sync without an undo step
          return false;
        }
        past.push(committed);
        pastLabels.push(committedLabel);
        if (past.length > HISTORY_LIMIT) { past.shift(); pastLabels.shift(); }
        committed = clone(s);
        committedLabel = label || 'Edit';
        present = clone(s);
        future = [];
        futureLabels = [];
        return true;
      },
      undo: function () {
        if (!past.length) return null;
        future.push(committed);
        futureLabels.push(committedLabel);
        committed = past.pop();
        committedLabel = pastLabels.pop();
        present = clone(committed);
        return present;
      },
      redo: function () {
        if (!future.length) return null;
        past.push(committed);
        pastLabels.push(committedLabel);
        committed = future.pop();
        committedLabel = futureLabels.pop();
        present = clone(committed);
        return present;
      },
      canUndo: function () { return past.length > 0; },
      canRedo: function () { return future.length > 0; },
      undoLabel: function () { return past.length ? committedLabel : null; },
      redoLabel: function () { return future.length ? futureLabels[futureLabels.length - 1] : null; },
      depth: function () { return past.length; },
      // every snapshot the history can still restore (used to free unused GLB resources)
      snapshots: function () { return past.concat([committed], future); },
      reset: function (s) {
        committed = clone(s); committedLabel = 'Start';
        past = []; pastLabels = []; future = []; futureLabels = [];
        present = clone(s);
      }
    };
  }

  // GLB files start with the 4-byte magic "glTF", a uint32 version (2) and a uint32 length.
  function checkGlb(bytes, size) {
    if (size > MAX_GLB_BYTES) return 'File is larger than 50 MB.';
    if (!bytes || bytes.length < 12) return 'File is too small to be a GLB model.';
    var magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'glTF') return 'This is not a GLB file (wrong file header).';
    var version = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
    if (version !== 2) return 'Unsupported GLB version ' + version + ' (only version 2 is supported).';
    return null;
  }

  var api = {
    SHAPES: SHAPES,
    PALETTE: PALETTE,
    MAX_OBJECTS: MAX_OBJECTS,
    MAX_GLB_BYTES: MAX_GLB_BYTES,
    emptyState: emptyState,
    getObject: getObject,
    childrenOf: childrenOf,
    topLevel: topLevel,
    isHidden: isHidden,
    isLocked: isLocked,
    topLevelId: topLevelId,
    addShape: addShape,
    addObject: addObject,
    updateObject: updateObject,
    updateMany: updateMany,
    setPartMaterial: setPartMaterial,
    resetPartMaterial: resetPartMaterial,
    selectObject: selectObject,
    selectIds: selectIds,
    toggleSelect: toggleSelect,
    selectAll: selectAll,
    clearSelection: clearSelection,
    groupSelection: groupSelection,
    ungroup: ungroup,
    deleteObjects: deleteObjects,
    deleteObject: deleteObject,
    duplicateSelection: duplicateSelection,
    duplicateObject: duplicateObject,
    worldTransform: worldTransform,
    composeTRS: composeTRS,
    multiply: multiply,
    decompose: decompose,
    snapValue: snapValue,
    createHistory: createHistory,
    checkGlb: checkGlb
  };

  root.StudioCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
