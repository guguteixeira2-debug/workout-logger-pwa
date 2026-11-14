const CACHE_NAME = 'workout-logger-shell-v3';

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

// Rede primeiro, cache como reserva. Assim, quando você publica uma versão nova no
// GitHub Pages ela chega no próximo carregamento (com cache-first o app ficava preso
// na versão antiga). Sem internet, usa o que está guardado no cache.
// Chamadas à API do Apps Script (outro domínio) não passam por aqui.
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  var url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request).then(function (resposta) {
      if (resposta && resposta.ok) {
        var copia = resposta.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(event.request, copia);
        });
      }
      return resposta;
    }).catch(function () {
      return caches.match(event.request).then(function (cacheado) {
        return cacheado || caches.match('./index.html');
      });
    })
  );
});
