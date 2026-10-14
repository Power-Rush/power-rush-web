import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filaEvento, dispositivo } from '../api/_lib/eventos.mjs';
import { esEquipo } from '../api/_lib/equipo.mjs';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const COOKIE = 'pr_ab=precio1.B.0123456789abcdef';
const base = { t: 'precio1', g: 'B', v: '0123456789abcdef', s: 'aaaabbbbccccdddd', e: 'agregar_carrito', p: '/products/powerrush', f: 'bf', q: 2, val: null, d: 'producto', src: 'meta', med: 'paid', cmp: null };

test('evento válido → fila completa', () => {
  assert.deepEqual(filaEvento(base, { ua: IPHONE, pais: 'AR', cookies: COOKIE }), {
    test: 'precio1', grp: 'B', visitor: '0123456789abcdef', session: 'aaaabbbbccccdddd', event: 'agregar_carrito',
    path: '/products/powerrush', flavor: 'bf', qty: 2, value: null, order_id: null, detail: 'producto',
    source: 'meta', medium: 'paid', campaign: null, device: 'mobile', country: 'AR', excluded: null,
  });
});

test('descarta lo que no es del test', () => {
  assert.equal(filaEvento({ ...base, t: 'otro' }, { ua: IPHONE }), null);
  assert.equal(filaEvento({ ...base, g: 'Z' }, { ua: IPHONE }), null);
  assert.equal(filaEvento({ ...base, v: 'corto' }, { ua: IPHONE }), null);
  assert.equal(filaEvento({ ...base, e: 'hackeo' }, { ua: IPHONE }), null);
  assert.equal(filaEvento(null, { ua: IPHONE }), null);
  assert.equal(filaEvento(base, { ua: 'Googlebot/2.1' }), null);
});

test('marca QA y equipo', () => {
  assert.equal(filaEvento(base, { ua: IPHONE, cookies: 'pr_ab=precio1.B.0123456789abcdef.qa' }).excluded, 'qa');
  assert.equal(filaEvento(base, { ua: IPHONE, esEquipo: true, cookies: COOKIE }).excluded, 'internal');
});

test('limpia valores raros', () => {
  const f = filaEvento({ ...base, q: -3, val: 'mucho', p: 'x'.repeat(500), oid: 12345 }, { ua: IPHONE, pais: 'ARG', cookies: COOKIE });
  assert.equal(f.qty, null);
  assert.equal(f.value, null);
  assert.equal(f.path.length, 200);
  assert.equal(f.order_id, '12345');
  assert.equal(f.country, 'AR');
  assert.equal(filaEvento({ ...base, e: 'compra', val: 85948.2 }, { ua: IPHONE }).value, 85948.2);
});

test('dispositivo por user agent', () => {
  assert.equal(dispositivo(IPHONE), 'mobile');
  assert.equal(dispositivo('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'tablet');
  assert.equal(dispositivo('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), 'desktop');
});

test('equipo: sin cookie válida no es equipo', async () => {
  assert.equal(await esEquipo(''), false);
  assert.equal(await esEquipo('pr_acceso=' + 'a'.repeat(64)), false);
});

test('eventos de la web: tienen que venir con la cookie del mismo visitante y grupo', () => {
  const cookie = 'pr_ab=precio1.B.0123456789abcdef';
  assert.ok(filaEvento(base, { ua: IPHONE, cookies: cookie }));
  assert.equal(filaEvento(base, { ua: IPHONE }), null, 'sin cookie');
  assert.equal(filaEvento({ ...base, g: 'A' }, { ua: IPHONE, cookies: cookie }), null, 'otro grupo');
  assert.equal(filaEvento({ ...base, v: 'ffffffffffffffff' }, { ua: IPHONE, cookies: cookie }), null, 'otro visitante');
});

test('eventos del checkout (pixel): sin cookie, solo los tres del checkout', () => {
  for (const e of ['checkout_iniciado', 'pago_ingresado', 'compra']) assert.ok(filaEvento({ ...base, e, p: 'checkout' }, { ua: IPHONE }), e);
  assert.equal(filaEvento({ ...base, e: 'vista', p: 'checkout' }, { ua: IPHONE }), null);
});
