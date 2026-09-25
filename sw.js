/* =====================================================
 *  写真台帳  Service Worker
 * =====================================================
 *  役割は3つです。
 *   1. アプリ本体を保存しておき、電波がなくても起動できるようにする
 *   2. 写真の読み込みを速くする
 *   3. 未送信の写真があるとき、通信が戻ったら本体に知らせる
 * ===================================================== */

const VERSION    = 'v19.0';
const SHELL      = 'shell-' + VERSION;   // アプリ本体
const IMG_CACHE  = 'img-'   + VERSION;   // 写真
const IMG_LIMIT  = 400;                   // 写真の保存上限（枚）

// 起動に必要なもの
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './pwa/icon-192.png',
  './pwa/icon-512.png'
];

// ── 導入時：本体を保存する ──
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // 1つでも失敗すると全部止まるため、個別に入れる
    await Promise.all(SHELL_FILES.map(f =>
      c.add(new Request(f, { cache:'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

// ── 更新時：古い保存を捨てる ──
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k !== SHELL && k !== IMG_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ── 取得時の振り分け ──
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  // 写真の実体：一度読んだものは保存して次から速くする
  if(url.pathname.includes('/storage/v1/object/')){
    e.respondWith(cacheFirstImage(req));
    return;
  }

  // データベースへの問い合わせ：常に最新を取りに行く（保存しない）
  if(url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/auth/v1/')){
    return;
  }

  // 外部の部品（フォント・ExcelJSなど）
  if(url.origin !== location.origin){
    e.respondWith(staleWhileRevalidate(req, SHELL));
    return;
  }

  // アプリ本体：まず通信、だめなら保存分を出す
  e.respondWith(networkFirst(req));
});

async function networkFirst(req){
  try{
    const res = await fetch(req);
    if(res && res.ok){
      const c = await caches.open(SHELL);
      c.put(req, res.clone());
    }
    return res;
  }catch(e){
    const hit = await caches.match(req);
    if(hit) return hit;
    // 画面遷移なら、保存してあるアプリ本体を返す
    if(req.mode === 'navigate'){
      const shell = await caches.match('./index.html') || await caches.match('./');
      if(shell) return shell;
    }
    return new Response('オフラインです', { status:503, headers:{ 'Content-Type':'text/plain; charset=utf-8' } });
  }
}

async function cacheFirstImage(req){
  const c = await caches.open(IMG_CACHE);
  const hit = await c.match(req, { ignoreSearch:true });   // 署名の違いを無視して探す
  if(hit) return hit;
  try{
    const res = await fetch(req);
    if(res && res.ok){
      c.put(req, res.clone());
      trimCache(IMG_CACHE, IMG_LIMIT);
    }
    return res;
  }catch(e){
    return hit || new Response('', { status:504 });
  }
}

async function staleWhileRevalidate(req, cacheName){
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  const net = fetch(req).then(res => {
    if(res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || net || new Response('', { status:504 });
}

// 保存枚数が増えすぎないように、古いものから捨てる
async function trimCache(name, limit){
  const c = await caches.open(name);
  const keys = await c.keys();
  if(keys.length <= limit) return;
  for(let i = 0; i < keys.length - limit; i++) await c.delete(keys[i]);
}

// ── 通信が戻ったときに本体へ知らせる ──
self.addEventListener('sync', e => {
  if(e.tag === 'photo-upload'){
    e.waitUntil(notifyClients('flush-queue'));
  }
});

self.addEventListener('message', e => {
  if(e.data === 'skip-waiting') self.skipWaiting();
  if(e.data === 'clear-images') caches.delete(IMG_CACHE);
});

async function notifyClients(type){
  const list = await self.clients.matchAll({ includeUncontrolled:true, type:'window' });
  list.forEach(c => c.postMessage({ type }));
}
