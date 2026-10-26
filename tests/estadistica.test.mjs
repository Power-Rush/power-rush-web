import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rng, beta, binomial, probGanaConversion, bootstrapRpv, srm } from '../api/_lib/estadistica.mjs';

test('rng determinístico por semilla', () => {
  const a = rng(3), b = rng(3);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const c = rng(4)();
  assert.ok(c >= 0 && c < 1);
});

test('beta: la media cae donde debe', () => {
  const r = rng(1);
  let s = 0;
  for (let i = 0; i < 20000; i++) s += beta(3, 7, r);
  assert.ok(Math.abs(s / 20000 - 0.3) < 0.01);
});

test('binomial: media n·p en los dos métodos', () => {
  const r = rng(2);
  let chico = 0, grande = 0;
  for (let i = 0; i < 5000; i++) { chico += binomial(1000, 0.01, r); grande += binomial(30000, 0.02, r); }
  assert.ok(Math.abs(chico / 5000 - 10) < 0.3);
  assert.ok(Math.abs(grande / 5000 - 600) < 3);
  assert.equal(binomial(0, 0.5, r), 0);
  assert.equal(binomial(10, 1, r), 10);
});

test('conversión: iguales ≈ 50%, claramente mejor > 99%', () => {
  const igual = probGanaConversion({ exitos: 20, n: 1000 }, { exitos: 20, n: 1000 });
  assert.ok(Math.abs(igual - 0.5) < 0.03, String(igual));
  assert.ok(probGanaConversion({ exitos: 100, n: 1000 }, { exitos: 150, n: 1000 }) > 0.99);
});

test('ingreso por visitante: iguales ≈ 50%, mejor > 95%, intervalo ordenado', () => {
  const ingresos = Array.from({ length: 40 }, (_, i) => 44999 + (i % 3) * 40000);
  const ctrl = { visitantes: 2000, ingresos };
  const igual = bootstrapRpv(ctrl, { visitantes: 2000, ingresos });
  assert.ok(Math.abs(igual.prob - 0.5) < 0.05, String(igual.prob));
  const mejor = bootstrapRpv(ctrl, { visitantes: 2000, ingresos: ingresos.concat(ingresos) });
  assert.ok(mejor.prob > 0.95);
  assert.ok(mejor.dif[0] < mejor.dif[1]);
});

test('reparto: parejo no alarma; desparejo sí', () => {
  assert.ok(srm([1000, 1000, 1000], [1, 1, 1]).p > 0.99);
  assert.ok(srm([1000, 1000, 1300], [1, 1, 1]).p < 0.01);
  assert.deepEqual(srm([0, 0, 0], [1, 1, 1]), { chi2: 0, p: 1 });
});
