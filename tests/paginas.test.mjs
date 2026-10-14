import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGINAS = ['index.html', 'products/powerrush/index.html'];
const VIEJOS = ['$24.999', '$22.500', '$21.250', '$44.999', '$63.749', '$800<', 'data-pr-price', 'data-total='];

for (const ruta of PAGINAS) {
  const html = readFileSync(new URL('../' + ruta, import.meta.url), 'utf8');

  test(`${ruta}: carga /ab.js en el head, antes que cualquier otro script`, () => {
    const head = html.slice(0, html.indexOf('</head>'));
    const primerScript = head.match(/<script[^>]*>/);
    assert.ok(primerScript, 'hay un script en el head');
    assert.equal(primerScript[0], '<script src="/ab.js">');
  });

  test(`${ruta}: ningún precio escrito a mano`, () => {
    for (const v of VIEJOS) assert.ok(!html.includes(v), `quedó "${v}"`);
  });

  test(`${ruta}: los elementos de precio vienen vacíos`, () => {
    const llenos = [...html.matchAll(/<([a-z]+)[^>]*data-ab-precio="[^"]*"[^>]*>([^<]*)</g)].filter((m) => m[2].trim() !== '');
    assert.deepEqual(llenos.map((m) => m[0]), []);
  });
}

test('home: dos precios de 1 pote y el precio por porción', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/data-ab-precio="total"/g) || []).length, 2);
  assert.equal((html.match(/data-ab-precio="porcion"/g) || []).length, 1);
});

test('producto: tarjetas de 1, 2 y 3 potes, total y barra fija', () => {
  const html = readFileSync(new URL('../products/powerrush/index.html', import.meta.url), 'utf8');
  for (const n of [1, 2, 3]) assert.equal((html.match(new RegExp(`data-ab-precio="cu" data-ab-n="${n}"`, 'g')) || []).length, 2, `cu ${n}`);
  assert.match(html, /id="prod-price" data-ab-precio="total" data-ab-n="1"/);
  assert.match(html, /id="sb-price" data-ab-precio="total" data-ab-n="1"/);
});
