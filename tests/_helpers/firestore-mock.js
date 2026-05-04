'use strict';

// In-memory mock of just enough of the Firestore Admin SDK to drive both
// the express routes (server.js) and the rule engine (rules/engine.js)
// without hitting the real Firestore.
//
// Supports: collection(), doc(id), doc() [auto-id], get(), set(), update(),
// delete(), add(), where(), orderBy(), limit(), batch(). Multiple where()
// calls in sequence are AND'd together.

const mockStore = {
  collections: {},
  reset() { this.collections = {}; },
  seed(collectionName, docs) {
    // docs: { id1: {data}, id2: {data} }
    this.collections[collectionName] = JSON.parse(JSON.stringify(docs));
  },
};

let _autoIdCounter = 0;
function autoId() {
  _autoIdCounter++;
  return `auto_${_autoIdCounter}_${Math.random().toString(36).slice(2, 6)}`;
}

function docRef(colName, id) {
  return {
    id,
    path: `${colName}/${id}`,
    async get() {
      const data = mockStore.collections[colName]?.[id];
      return {
        id,
        exists: data !== undefined,
        data: () => (data === undefined ? undefined : { ...data }),
        ref: docRef(colName, id),
      };
    },
    async set(data, opts) {
      mockStore.collections[colName] = mockStore.collections[colName] || {};
      mockStore.collections[colName][id] = opts?.merge
        ? { ...mockStore.collections[colName][id], ...data }
        : { ...data };
    },
    async update(data) {
      mockStore.collections[colName] = mockStore.collections[colName] || {};
      // Resolve dot-path keys like 'onboarding.checklistState'
      const current = { ...mockStore.collections[colName][id] };
      for (const [k, v] of Object.entries(data)) {
        if (k.includes('.')) {
          const parts = k.split('.');
          let target = current;
          for (let i = 0; i < parts.length - 1; i++) {
            target[parts[i]] = target[parts[i]] || {};
            target = target[parts[i]];
          }
          target[parts[parts.length - 1]] = v;
        } else {
          current[k] = v;
        }
      }
      mockStore.collections[colName][id] = current;
    },
    async delete() {
      if (mockStore.collections[colName]) delete mockStore.collections[colName][id];
    },
  };
}

function collectionRef(colName) {
  let _filters = [];
  let _orderBy = null;
  let _limit = null;
  const api = {
    doc(id) {
      return docRef(colName, id || autoId());
    },
    async add(data) {
      const id = autoId();
      mockStore.collections[colName] = mockStore.collections[colName] || {};
      mockStore.collections[colName][id] = { ...data };
      return docRef(colName, id);
    },
    where(field, op, value) {
      _filters.push({ field, op, value });
      return api;
    },
    orderBy(field, dir = 'asc') {
      _orderBy = { field, dir };
      return api;
    },
    limit(n) {
      _limit = n;
      return api;
    },
    async get() {
      const col = mockStore.collections[colName] || {};
      let docs = Object.entries(col).map(([id, data]) => ({ id, data }));
      for (const f of _filters) {
        docs = docs.filter(d => {
          const v = d.data?.[f.field];
          switch (f.op) {
            case '==': return v === f.value;
            case '!=': return v !== f.value;
            case '<':  return v < f.value;
            case '<=': return v <= f.value;
            case '>':  return v > f.value;
            case '>=': return v >= f.value;
            case 'in': return Array.isArray(f.value) && f.value.includes(v);
            case 'array-contains': return Array.isArray(v) && v.includes(f.value);
            default: return true;
          }
        });
      }
      if (_orderBy) {
        docs.sort((a, b) => {
          const va = a.data?.[_orderBy.field];
          const vb = b.data?.[_orderBy.field];
          if (va === vb) return 0;
          const cmp = va < vb ? -1 : 1;
          return _orderBy.dir === 'desc' ? -cmp : cmp;
        });
      }
      if (_limit) docs = docs.slice(0, _limit);
      // Reset chain state so the next get() on a fresh collection() call is clean
      _filters = []; _orderBy = null; _limit = null;
      return {
        docs: docs.map(d => ({
          id: d.id,
          exists: true,
          data: () => ({ ...d.data }),
          ref: docRef(colName, d.id),
        })),
        empty: docs.length === 0,
        size: docs.length,
        forEach(fn) { docs.forEach(d => fn({ id: d.id, data: () => ({ ...d.data }), ref: docRef(colName, d.id) })); },
      };
    },
  };
  return api;
}

function mockBatch() {
  const ops = [];
  return {
    set(ref, data, opts) { ops.push({ type: 'set', ref, data, opts }); return this; },
    update(ref, data) { ops.push({ type: 'update', ref, data }); return this; },
    delete(ref) { ops.push({ type: 'delete', ref }); return this; },
    async commit() {
      for (const op of ops) {
        if (op.type === 'set') await op.ref.set(op.data, op.opts);
        else if (op.type === 'update') await op.ref.update(op.data);
        else if (op.type === 'delete') await op.ref.delete();
      }
    },
  };
}

const mockDb = {
  collection: collectionRef,
  batch: mockBatch,
};

const mockTimestamp = {
  now: () => {
    const d = new Date();
    return {
      _seconds: Math.floor(d.getTime() / 1000),
      seconds: Math.floor(d.getTime() / 1000),
      toDate: () => d,
    };
  },
  fromDate: (d) => ({
    _seconds: Math.floor(d.getTime() / 1000),
    seconds: Math.floor(d.getTime() / 1000),
    toDate: () => d,
  }),
};

module.exports = {
  mockStore,
  mockDb,
  mockTimestamp,
  collectionRef,
  docRef,
  mockBatch,
};
