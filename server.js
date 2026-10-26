/* 食谱小本 - 本地服务：静态托管 + SQLite 数据同步
 * 用法：node server.js  （数据存在同目录 recipes.db）
 * 手机访问 http://电脑IP:8123 即与电脑共用同一个数据库
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 8123;
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'recipes.db');
const BODY_LIMIT = 20 * 1024 * 1024; // 20MB（菜谱可能带图片）

const TYPES = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.db': 'application/octet-stream' };
const SPACES = ['recipes', 'shopping', 'fridge', 'eats'];

/* ---------- 存储层：优先 SQLite，异常时退回 JSON 文件 ---------- */
function makeSqliteStore() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS items(
      space TEXT NOT NULL, id TEXT NOT NULL, updatedAt INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(space, id));
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);`);
  const getItems = space => db.prepare('SELECT data FROM items WHERE space=?').all(space).map(r => JSON.parse(r.data));
  const getItem = (space, id) => {
    const r = db.prepare('SELECT updatedAt, data FROM items WHERE space=? AND id=?').get(space, id);
    return r ? { updatedAt: r.updatedAt, data: JSON.parse(r.data) } : null;
  };
  const putItem = (space, o) => {
    const ua = o.updatedAt || o.createdAt || 0;
    db.prepare('INSERT OR REPLACE INTO items (space,id,updatedAt,data) VALUES (?,?,?,?)').run(space, o.id, ua, JSON.stringify(o));
  };
  const delItem = (space, id) => db.prepare('DELETE FROM items WHERE space=? AND id=?').run(space, id);
  const getMeta = k => { const r = db.prepare('SELECT value FROM meta WHERE key=?').get(k); return r ? JSON.parse(r.value) : null; };
  const setMeta = (k, v) => db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run(k, JSON.stringify(v));
  return { kind: 'sqlite', getItems, getItem, putItem, delItem, getMeta, setMeta };
}
function makeJsonStore() {
  const FILE = DB_PATH + '.json';
  let mem = { items: {}, meta: {} };
  try { if (fs.existsSync(FILE)) mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
  const flush = () => { try { fs.writeFileSync(FILE, JSON.stringify(mem)); } catch (e) { console.error('db write failed', e.message); } };
  return {
    kind: 'json',
    getItems: space => Object.values(mem.items[space] || {}).map(JSON.parse),
    getItem: (space, id) => (mem.items[space] || {})[id] ? { updatedAt: mem.items[space][id].updatedAt, data: JSON.parse(mem.items[space][id].data) } : null,
    putItem: (space, o) => { (mem.items[space] ||= {})[o.id] = { updatedAt: o.updatedAt || o.createdAt || 0, data: JSON.stringify(o) }; flush(); },
    delItem: (space, id) => { if (mem.items[space]) { delete mem.items[space][id]; flush(); } },
    getMeta: k => mem.meta[k] ?? null,
    setMeta: (k, v) => { mem.meta[k] = v; flush(); }
  };
}
let store;
try { store = makeSqliteStore(); } catch (e) { console.warn('sqlite 不可用，退回 JSON 文件存储：', e.message); store = makeJsonStore(); }

let tombstones = store.getMeta('tombstones') || { recipes: {}, shopping: {}, fridge: {} };

/* ---------- 同步逻辑：按条目“最后写入者胜”，删除用墓碑 ---------- */
function handleSync(body) {
  body = body || {};
  SPACES.forEach(space => {
    const tomb = tombstones[space] || (tombstones[space] = {});
    // 1) 合并客户端墓碑（保留更新的时间）
    const incomingTomb = (body.tombstones && body.tombstones[space]) || {};
    for (const [id, ts] of Object.entries(incomingTomb)) {
      if (!tomb[id] || ts > tomb[id]) tomb[id] = ts;
    }
    // 2) 把墓碑应用到库里的数据（比墓碑旧的条目删除）
    for (const [id, ts] of Object.entries(tomb)) {
      const row = store.getItem(space, id);
      if (row && (row.data.updatedAt || row.data.createdAt || 0) <= ts) store.delItem(space, id);
    }
    // 3) 合并客户端条目（只收比库里新的；被墓碑删除且未重新编辑的拒收）
    (Array.isArray(body[space]) ? body[space] : []).forEach(o => {
      if (!o || !o.id) return;
      const t = tomb[o.id];
      if (t && (o.updatedAt || o.createdAt || 0) <= t) return;
      store.putItem(space, o);
    });
  });
  if (body.settings && typeof body.settings === 'object') store.setMeta('settings', body.settings);
  // firstDone 只进不退（true 一旦出现过就保持，避免欢迎页反复出现）
  if (body.firstDone === true || store.getMeta('firstDone') === true) store.setMeta('firstDone', true);
  store.setMeta('tombstones', tombstones);
  return {
    recipes: store.getItems('recipes'),
    shopping: store.getItems('shopping'),
    fridge: store.getItems('fridge'),
    eats: store.getItems('eats'),
    settings: store.getMeta('settings') || {},
    firstDone: !!store.getMeta('firstDone'),
    tombstones,
    serverTime: Date.now()
  };
}

/* ---------- HTTP ---------- */
function send(res, code, data, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(type ? data : JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > BODY_LIMIT) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  try {
    if (urlPath === '/api/sync' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, handleSync(body));
    }
    if (urlPath === '/api/ping') return send(res, 200, { ok: true, store: store.kind, serverTime: Date.now() });

    // 静态文件
    let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(ROOT)) return send(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'not found' });
      send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
    });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`食谱小本服务已启动: http://127.0.0.1:${PORT}  （局域网设备用 http://本机IP:${PORT}）`);
  console.log(`数据库: ${DB_PATH}  [${store.kind}]`);
});
