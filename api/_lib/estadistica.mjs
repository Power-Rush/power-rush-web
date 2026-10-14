/* Estadística del informe del test A/B. Todo usa un generador con semilla para que el
   mismo set de datos dé siempre el mismo informe. */

export function rng(semilla = 1) {            // mulberry32
  let a = semilla >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r) {                          // Box-Muller
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

function gamma(forma, r) {                    // Marsaglia y Tsang
  if (forma < 1) return gamma(forma + 1, r) * Math.pow(r() || 1e-12, 1 / forma);
  const d = forma - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = normal(r); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function beta(a, b, r) {
  const x = gamma(a, r);
  return x / (x + gamma(b, r));
}

export function binomial(n, p, r) {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  const media = n * p;
  if (media < 30) {                           // inversión: pocos éxitos esperados
    let k = 0, prob = Math.pow(1 - p, n), acum = prob;
    const u = r();
    while (u > acum && k < n) {
      prob *= ((n - k) / (k + 1)) * (p / (1 - p));
      k++;
      acum += prob;
    }
    return k;
  }
  const k = Math.round(media + Math.sqrt(media * (1 - p)) * normal(r));
  return Math.min(n, Math.max(0, k));
}

/* P(conversión del tratamiento > la del control), con priors Beta(1, 1). */
export function probGanaConversion(control, trat, { sorteos = 20000, semilla = 7 } = {}) {
  const r = rng(semilla);
  let gana = 0;
  for (let i = 0; i < sorteos; i++) {
    const pc = beta(1 + control.exitos, 1 + control.n - control.exitos, r);
    const pt = beta(1 + trat.exitos, 1 + trat.n - trat.exitos, r);
    if (pt > pc) gana++;
  }
  return gana / sorteos;
}

/* Ingreso por visitante, bootstrap. En cada remuestreo, cuántos compran sale de una
   binomial con la tasa observada y cuánto gasta cada uno, de los compradores reales.
   Devuelve P(tratamiento > control) y el intervalo del 95% de la diferencia en pesos. */
export function bootstrapRpv(control, trat, { iteraciones = 10000, semilla = 11 } = {}) {
  const r = rng(semilla);
  const difs = new Float64Array(iteraciones);
  let gana = 0;
  for (let i = 0; i < iteraciones; i++) {
    const d = remuestreo(trat, r) - remuestreo(control, r);
    difs[i] = d;
    if (d > 0) gana++;
  }
  difs.sort();
  return { prob: gana / iteraciones, dif: [difs[Math.floor(0.025 * iteraciones)], difs[Math.floor(0.975 * iteraciones)]] };
}

function remuestreo(g, r) {
  if (!g.visitantes) return 0;
  const m = g.ingresos.length;
  const k = m ? binomial(g.visitantes, Math.min(1, m / g.visitantes), r) : 0;
  let suma = 0;
  for (let j = 0; j < k; j++) suma += g.ingresos[Math.floor(r() * m)];
  return suma / g.visitantes;
}

/* Control del reparto (sample ratio mismatch): chi-cuadrado contra los pesos.
   Valor p con la fórmula cerrada para grados de libertad pares (3 grupos → 2). */
export function srm(conteos, pesos) {
  const total = conteos.reduce((s, c) => s + c, 0);
  if (!total) return { chi2: 0, p: 1 };
  const sumaPesos = pesos.reduce((s, w) => s + w, 0);
  let chi2 = 0;
  conteos.forEach((c, i) => {
    const e = (total * pesos[i]) / sumaPesos;
    chi2 += (c - e) ** 2 / e;
  });
  const gl = conteos.length - 1;
  if (gl % 2) throw new Error('srm: hace falta una cantidad impar de grupos (gl par)');
  let termino = 1, suma = 1;
  for (let i = 1; i < gl / 2; i++) { termino *= chi2 / 2 / i; suma += termino; }
  return { chi2, p: Math.exp(-chi2 / 2) * suma };
}
