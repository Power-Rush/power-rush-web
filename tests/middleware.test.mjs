import { test } from 'node:test';
import assert from 'node:assert/strict';
import middleware, { asignarGrupo, AB_MW } from '../middleware.js';
import AB from '../ab.js';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
function pedir(ruta, { cookie = '', ua = UA, host = 'www.powerrush.com.ar' } = {}) {
  const url = new URL(ruta, `https://${host}`);
  const request = new Request(url, { headers: { cookie, 'user-agent': ua } });
  return { request, url, cookie };
}
function asignar(ruta, opciones) {
  const { request, url, cookie } = pedir(ruta, opciones);
  return asignarGrupo(request, url, cookie);
}

test('la config del middleware coincide con ab.js', () => {
  assert.equal(AB_MW.test, AB.CONFIG.test);
  assert.equal(AB_MW.activo, AB.CONFIG.activo);
  assert.deepEqual(AB_MW.grupos, Object.fromEntries(Object.entries(AB.CONFIG.grupos).map(([g, v]) => [g, v.peso])));
});

test('visitante nuevo: cookie de 180 días con dominio propio', () => {
  const c = asignar('/');
  assert.match(c, /^pr_ab=precio1\.[ABC]\.[a-f0-9]{16}; Path=\/; Max-Age=15552000; Secure; SameSite=Lax; Domain=\.powerrush\.com\.ar$/);
});

test('en un deploy de preview la cookie va sin Domain', () => {
  const c = asignar('/', { host: 'power-rush-playground-abc.vercel.app' });
  assert.ok(c && !c.includes('Domain='));
});

test('cookie válida del test: no se toca', () => {
  assert.equal(asignar('/', { cookie: 'pr_ab=precio1.B.0123456789abcdef' }), null);
});

test('cookie de otro test o grupo inexistente: nuevo sorteo, mismo visitante', () => {
  assert.match(asignar('/', { cookie: 'pr_ab=viejo.B.0123456789abcdef' }), /^pr_ab=precio1\.[ABC]\.[a-f0-9]{16}; /);
  assert.match(asignar('/', { cookie: 'pr_ab=precio1.Z.0123456789abcdef' }), /^pr_ab=precio1\.[ABC]\.[a-f0-9]{16}; /);
});

test('?ab= fija el grupo como QA y conserva el visitante', () => {
  assert.match(asignar('/?ab=b', { cookie: 'pr_ab=precio1.A.0123456789abcdef' }), /^pr_ab=precio1\.B\.0123456789abcdef\.qa; /);
  assert.match(asignar('/?ab=C'), /^pr_ab=precio1\.C\.[a-f0-9]{16}\.qa; /);
  assert.match(asignar('/?ab=zz'), /^pr_ab=precio1\.[ABC]\.[a-f0-9]{16}; /);
});

test('bots: sin cookie', () => {
  assert.equal(asignar('/', { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }), null);
  assert.equal(asignar('/', { ua: 'facebookexternalhit/1.1' }), null);
  assert.equal(asignar('/', { ua: 'curl/8.7.1' }), null);
});

test('reparto parejo: 100.000 sorteos quedan en 1/3 ± 1%', () => {
  const n = 100000, cuenta = { A: 0, B: 0, C: 0 };
  for (let i = 0; i < n; i++) cuenta[asignar('/').match(/^pr_ab=precio1\.([ABC])\./)[1]]++;
  for (const g of ['A', 'B', 'C']) assert.ok(Math.abs(cuenta[g] / n - 1 / 3) < 0.01, `${g}: ${cuenta[g]}`);
});

test('tienda cerrada: el público ve la portada y no recibe cookie', async () => {
  const { request } = pedir('/');
  const res = await middleware(request);
  assert.equal(res.headers.get('x-middleware-rewrite'), 'https://www.powerrush.com.ar/proximamente');
  assert.equal(res.headers.get('set-cookie'), null);
});

test('/app (informe en Shopify) no pasa por la portada ni por el sorteo', async () => {
  const res = await middleware(pedir('/app?embedded=1').request);
  assert.equal(res.headers.get('x-middleware-next'), '1');
  assert.equal(res.headers.get('x-middleware-rewrite'), null);
  assert.equal(res.headers.get('set-cookie'), null);
});
