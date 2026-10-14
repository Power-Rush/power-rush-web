import { test } from 'node:test';
import assert from 'node:assert/strict';
import AB from '../ab.js';
import { armarInforme, aCsv } from '../api/_lib/informe.mjs';

const datos = {
  embudo: [
    { grp: 'A', visitantes: 1000, agregaron: 100, fueron_checkout: 40, iniciaron_checkout: 35 },
    { grp: 'B', visitantes: 990, agregaron: 90, fueron_checkout: 36, iniciaron_checkout: 30 },
    { grp: 'C', visitantes: 1010, agregaron: 80, fueron_checkout: 30, iniciaron_checkout: 25 },
  ],
  ordenes: [
    { grp: 'A', visitor: 'v1', total: '44999.00', units: 1, inferred: false },
    { grp: 'A', visitor: 'v1', total: '80998.20', units: 2, inferred: false },
    { grp: 'A', visitor: null, total: '44999.00', units: 1, inferred: true },
    { grp: 'B', visitor: 'v2', total: '47749.00', units: 1, inferred: false },
  ],
  porDispositivo: [{ grp: 'A', segmento: 'mobile', visitantes: 700, compradores: 2, ingreso: '125997.20' }],
  porOrigen: [{ grp: 'B', segmento: '<b>meta</b>', visitantes: 500, compradores: 1, ingreso: '47749.00' }],
  errores: [{ event: 'error_precio', n: 2 }],
};

test('métricas por grupo', () => {
  const inf = armarInforme(datos, AB.CONFIG, new Date('2026-11-10T12:00:00Z'));
  assert.equal(inf.generado, '2026-11-10T12:00:00.000Z');
  const [a, b, c] = inf.grupos;
  assert.equal(a.id, 'A');
  assert.equal(a.ordenes, 3);
  assert.equal(a.compradores, 2);              // v1 compró dos veces; la orden sin visitante cuenta aparte
  assert.equal(a.inferidas, 1);
  assert.equal(a.ingreso, 170996.2);
  assert.equal(a.unidades, 4);
  assert.equal(a.conversion, 2 / 1000);
  assert.equal(a.rpv, 170996.2 / 1000);
  assert.equal(a.vsControl, null);
  assert.equal(b.tasaCarrito, 90 / 990);
  assert.ok(b.vsControl.probConversion >= 0 && b.vsControl.probConversion <= 1);
  assert.ok(Array.isArray(b.vsControl.difRpv));
  assert.equal(c.ordenes, 0);
  assert.equal(c.ticket, null);
  assert.equal(c.vsControl.probRpv, null);   // sin compradores no hay bootstrap
});

test('reparto, errores y segmentos', () => {
  const inf = armarInforme(datos, AB.CONFIG);
  assert.equal(inf.reparto.alarma, false);
  assert.deepEqual(inf.errores, { error_precio: 2 });
  assert.deepEqual(inf.porDispositivo[0], { grupo: 'A', segmento: 'mobile', visitantes: 700, compradores: 2, ingreso: 125997.2, conversion: 2 / 700, rpv: 125997.2 / 700 });
});

test('sin datos no se rompe', () => {
  const inf = armarInforme({ embudo: [], ordenes: [], porDispositivo: [], porOrigen: [], errores: [] }, AB.CONFIG);
  assert.deepEqual(inf.grupos.map((g) => g.visitantes), [0, 0, 0]);
  assert.equal(inf.reparto.p, 1);
});

test('CSV', () => {
  const csv = aCsv(armarInforme(datos, AB.CONFIG)).split('\n');
  assert.equal(csv[0], 'grupo,precio,visitantes,agregaron,fueron_checkout,iniciaron_checkout,compradores,ordenes,inferidas,unidades,ingreso,conversion,rpv,prob_rpv,prob_conversion');
  assert.equal(csv.length, 4);
  assert.match(csv[1], /^A,44999,1000,/);
});
