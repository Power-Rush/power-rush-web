import { test } from 'node:test';
import assert from 'node:assert/strict';
import AB from '../ab.js';

const { CONFIG, pct, total, porUnidad, money, texto, leerCookie, resolver, atributosCarrito, origenDe, payload } = AB;

test('config: tres precios y A como control', () => {
  assert.equal(CONFIG.test, 'precio1');
  assert.equal(CONFIG.control, 'A');
  assert.deepEqual(Object.keys(CONFIG.grupos), ['A', 'B', 'C']);
  assert.deepEqual(Object.values(CONFIG.grupos).map((g) => g.precio), [44999, 47749, 49999]);
  assert.deepEqual(Object.values(CONFIG.grupos).map((g) => g.peso), [1, 1, 1]);
  assert.equal(CONFIG.grupos.A.variantes.bf, 'gid://shopify/ProductVariant/50221562495224');
  assert.equal(CONFIG.grupos.A.variantes.cp, 'gid://shopify/ProductVariant/50221562462456');
});

test('descuento por cantidad como en Shopify', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(pct), [0, 0, 10, 15, 15]);
});

test('totales iguales a los del checkout (descuento sobre el total)', () => {
  assert.equal(total(44999, 1), 44999);
  assert.equal(total(44999, 2), 80998.2);
  assert.equal(total(44999, 3), 114747.45);
  assert.equal(total(47749, 2), 85948.2);
  assert.equal(total(47749, 3), 121759.95);
  assert.equal(total(49999, 2), 89998.2);
  assert.equal(total(49999, 3), 127497.45);
  assert.equal(total(44999, 4), 152996.6);
  assert.equal(total(44999, 0), 0);
  assert.equal(porUnidad(44999, 2), 40499.1);
});

test('formato de pesos sin centavos', () => {
  assert.equal(money(80998.2), '$80.998');
  assert.equal(money(1499.97), '$1.500');
  assert.equal(money(152996.6), '$152.997');
  assert.equal(money(950), '$950');
});

test('textos por tipo de precio', () => {
  assert.equal(texto('total', 44999, 1), '$44.999');
  assert.equal(texto('total', 47749, 3), '$121.760');
  assert.equal(texto('cu', 44999, 2), '$40.499');
  assert.equal(texto('porcion', 44999), '$1.500');
  assert.equal(texto('porcion', 47749), '$1.592');
  assert.equal(texto('porcion', 49999), '$1.667');
  assert.equal(texto('otro', 44999, 1), null);
});

test('lee la cookie del test', () => {
  assert.deepEqual(leerCookie('a=1; pr_ab=precio1.B.0123456789abcdef; b=2'),
    { test: 'precio1', grupo: 'B', visitante: '0123456789abcdef', qa: false });
  assert.deepEqual(leerCookie('pr_ab=precio1.C.0123456789abcdef.qa'),
    { test: 'precio1', grupo: 'C', visitante: '0123456789abcdef', qa: true });
  assert.equal(leerCookie('pr_ab=precio1.b.0123456789abcdef'), null);
  assert.equal(leerCookie('pr_ab=basura'), null);
  assert.equal(leerCookie(''), null);
});

test('resolver: cookie válida del test activo', () => {
  assert.deepEqual(resolver('pr_ab=precio1.B.0123456789abcdef', ''),
    { grupo: 'B', visitante: '0123456789abcdef', qa: false, registra: true, error: null });
});

test('resolver: grupo que no está en la config → control y error', () => {
  const r = resolver('pr_ab=precio1.Z.0123456789abcdef', '');
  assert.equal(r.grupo, 'A');
  assert.equal(r.registra, true);
  assert.match(r.error, /Z/);
});

test('resolver: sin cookie no registra; ?ab= solo sirve en local', () => {
  assert.deepEqual(resolver('', '?ab=c'), { grupo: 'C', visitante: null, qa: true, registra: false, error: null });
  assert.equal(resolver('', '').grupo, 'A');
  assert.equal(resolver('', '?ab=x').grupo, 'A');
  assert.equal(resolver('pr_ab=viejo.B.0123456789abcdef', '').registra, false);
});

test('atributos del carrito', () => {
  const r = { grupo: 'B', visitante: '0123456789abcdef', qa: true, registra: true };
  assert.deepEqual(atributosCarrito(r), [
    { key: '_ab_test', value: 'precio1' },
    { key: '_ab_group', value: 'B' },
    { key: '_ab_visitor', value: '0123456789abcdef' },
    { key: '_ab_qa', value: '1' },
  ]);
  assert.deepEqual(atributosCarrito({ ...r, registra: false }), []);
});

test('origen del tráfico', () => {
  assert.deepEqual(origenDe('?utm_source=meta&utm_medium=paid&utm_campaign=lanzamiento', '', 'www.powerrush.com.ar'),
    { source: 'meta', medium: 'paid', campaign: 'lanzamiento' });
  assert.deepEqual(origenDe('', 'https://www.google.com/search?q=x', 'www.powerrush.com.ar'),
    { source: 'google.com', medium: 'referral', campaign: null });
  assert.deepEqual(origenDe('', 'https://www.powerrush.com.ar/', 'www.powerrush.com.ar'),
    { source: 'directo', medium: null, campaign: null });
  assert.deepEqual(origenDe('', 'no es una url', 'www.powerrush.com.ar'),
    { source: 'directo', medium: null, campaign: null });
});

test('cuerpo del evento', () => {
  const r = { grupo: 'B', visitante: '0123456789abcdef', qa: false, registra: true };
  const ctx = { sesion: 'abcd1234abcd1234', path: '/products/powerrush', origen: { source: 'meta', medium: 'paid', campaign: null } };
  assert.deepEqual(payload(r, 'agregar_carrito', { sabor: 'bf', cantidad: 2, detalle: 'producto' }, ctx), {
    t: 'precio1', g: 'B', v: '0123456789abcdef', s: 'abcd1234abcd1234', e: 'agregar_carrito', p: '/products/powerrush',
    f: 'bf', q: 2, val: null, d: 'producto', src: 'meta', med: 'paid', cmp: null,
  });
});

function ventanaFalsa(cookie, search = '') {
  const beacons = [];
  const elementos = [];
  const almacen = {};
  const doc = {
    cookie, referrer: '',
    head: { appendChild() {} },
    documentElement: {},
    createElement: () => ({ textContent: '' }),
    querySelectorAll: () => elementos,
    addEventListener() {},
  };
  const win = {
    document: doc,
    location: { search, pathname: '/', hostname: 'www.powerrush.com.ar' },
    sessionStorage: { getItem: (k) => almacen[k] ?? null, setItem: (k, v) => { almacen[k] = String(v); } },
    crypto: globalThis.crypto,
    navigator: { sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } },
    Blob,
    MutationObserver: class { observe() {} disconnect() {} },
  };
  return { win, beacons, elementos };
}
function elemento(attrs) {
  return {
    attrs: { ...attrs }, textContent: '',
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    hasAttribute(k) { return k in this.attrs; },
  };
}

test('boot: expone PR_AB, pinta precios y manda la vista', async () => {
  const { win, beacons } = ventanaFalsa('pr_ab=precio1.B.0123456789abcdef');
  AB.boot(win);
  const ab = win.PR_AB;
  assert.equal(ab.grupo, 'B');
  assert.equal(ab.precio, 47749);
  assert.equal(ab.total(2), 85948.2);
  assert.equal(ab.variantes, CONFIG.grupos.B.variantes);
  const el = elemento({ 'data-ab-precio': 'cu', 'data-ab-n': '3' });
  ab.pintar(el);
  assert.equal(el.textContent, '$40.587');
  assert.ok('data-ab-ok' in el.attrs);
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].url, '/api/ab/event');
  const cuerpo = JSON.parse(await beacons[0].blob.text());
  assert.equal(cuerpo.e, 'vista');
  assert.equal(cuerpo.g, 'B');
  assert.match(cuerpo.s, /^[a-f0-9]{16}$/);
});

test('boot: sin cookie no manda eventos ni atributos', () => {
  const { win, beacons } = ventanaFalsa('', '?ab=c');
  AB.boot(win);
  assert.equal(win.PR_AB.grupo, 'C');
  win.PR_AB.track('agregar_carrito', { sabor: 'bf', cantidad: 1 });
  assert.equal(beacons.length, 0);
  assert.deepEqual(win.PR_AB.atributos(), []);
});

test('boot: cookie con grupo inexistente usa el control y registra error_config', async () => {
  const { win, beacons } = ventanaFalsa('pr_ab=precio1.Z.0123456789abcdef');
  AB.boot(win);
  assert.equal(win.PR_AB.grupo, 'A');
  const eventos = await Promise.all(beacons.map(async (b) => JSON.parse(await b.blob.text()).e));
  assert.deepEqual(eventos.sort(), ['error_config', 'vista']);
});
