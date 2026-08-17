const CACHE_NAME = 'workout-logger-shell-v2';

const ARQUIVOS_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(ARQUIVOS_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(
        nomes
          .filter(function (nome) { return nome !== CACHE_NAME; })
          .map(function (nome) { return caches.delete(nome); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Cache-first para os arquivos do próprio app (HTML/CSS/JS/ícones — estáticos).
// Chamadas à API do Apps Script (fetch pro domínio script.google.com) NÃO
// passam por aqui — precisam de rede de verdade pra ler/escrever na planilha.
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // deixa passar direto (ex: chamadas à API do Apps Script)

  event.respondWith(
    caches.match(event.request).then(function (cacheado) {
      if (cacheado) return cacheado;

      return fetch(event.request).then(function (resposta) {
        var copia = resposta.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(event.request, copia);
        });
        return resposta;
      });
    })
  );
});
