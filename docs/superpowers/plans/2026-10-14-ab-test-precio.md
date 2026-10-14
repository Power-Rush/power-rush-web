# Test A/B de precio — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cada visitante vea y pague uno de tres precios (A $44.999, B $47.749, C $49.999) asignado al azar y fijo por cookie, con todo el embudo y cada orden registrados y un informe dentro del admin de Shopify.

**Architecture:** El middleware de Vercel sortea el grupo y deja la cookie `pr_ab`. `ab.js` (en el `<head>`) define el precio del grupo y lo pinta antes del primer dibujo; `cart.js` arma el carrito de Shopify con la variante del grupo (pack de 1 unidad o duplicado oculto) y atributos `_ab_*`. Los eventos van a Postgres (Neon) por `/api/ab/event` (web y pixel del checkout); las órdenes llegan por webhook a `/api/ab/order`, que las etiqueta y guarda. El informe es una app embebida en el admin (`/app`) que lee `/api/ab/report` con el token de sesión de Shopify.

**Tech Stack:** HTML/JS estático sin build, Vercel Routing Middleware y Functions (Node 24), `@neondatabase/serverless@1.1.0`, Shopify Admin API y Storefront API `2026-01`, App Bridge + Polaris web components (CDN), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-14-ab-test-precio-design.md`

## Global Constraints

- Sin build ni framework. Única dependencia npm: `@neondatabase/serverless` `1.1.0`.
- `package.json` sin campo `"type"`: `ab.js` es CommonJS/script clásico; funciones y scripts son `.mjs`.
- `middleware.js` sin imports (Vercel lo compila como CommonJS).
- Repo público: secretos solo en variables de entorno (`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `DATABASE_URL`). Local: `.env.local` y `.env.vercel.local`, ignorados por git.
- Tienda `6q1n8a-jw`; Admin API y Storefront API versión `2026-01`.
- Test `precio1`; grupos A (control) 44999, B 47749, C 49999; pesos 1/1/1; cookie `pr_ab`, 180 días.
- Descuentos por cantidad: 2 potes −10% (AHORROPACK), 3 o más −15% (AHORRO15%), sobre el total.
- Precios en pantalla sin centavos, formato `$44.999`.
- Canal de la web: `gid://shopify/Publication/213151154424`. Producto original: `gid://shopify/Product/10286359806200`.
- Node local ≥ 22.9 (usa `--env-file-if-exists`). Tests: `npm test`.
- Publicar = commit + `vercel deploy --prod` desde una copia limpia (`git archive HEAD`) vinculada a `power-rush-playground`. El push a GitHub no publica.
- Textos visibles en español rioplatense; comentarios del código en español, como el resto del repo.

## Cambios respecto del spec (decididos al planear, ya reflejados en el spec)

- Estado de las órdenes: se mantiene al día con el webhook `orders/updated` (además de `orders/create`) en vez de releer Shopify al generar el informe. Evita el límite de 60 días de órdenes sin `read_all_orders` y deja el informe en SQL.
- Ingreso = mercadería neta de descuentos y reembolsos (`current_subtotal_price`), sin envío: el envío no depende del grupo.
- `ab_events` suma la columna `detail` (origen del botón, detalle de errores). `ab_orders` no tiene `excluded`: tiene `qa` y la exclusión se cruza por visitante.
- El equipo se detecta del lado del servidor (la cookie `pr_acceso` es `HttpOnly`).

## Review Focus

1. **Precio con conexión lenta o si `ab.js` no carga**: nunca debe verse un precio que después cambia. Los elementos de precio quedan vacíos en el HTML y ocultos hasta pintarse; sin `ab.js`, el carrito usa el precio de Shopify. → test de páginas en Task 7.
2. **Webhook repetido o desordenado** (`orders/updated` antes que `orders/create`, reintentos): una fila por orden y tags sin duplicar. → tests de `filaOrden`/`etiquetasPara` en Task 11.
3. **Órdenes sin visitante** (sin cookie: QA local, middleware caído): se infieren por precio y no rompen el informe. → test de `armarInforme` con `visitor: null` en Task 15.
4. **Cookie de un test viejo o con un grupo que ya no existe**: se sortea de nuevo (middleware) o se usa el control y se registra `error_config` (cliente). → tests en Tasks 2 y 5.
5. **Alguien cambia el precio del producto en el admin durante el test**: se registra `error_precio` y el informe lo muestra. → test de `armarInforme` (errores) en Task 15 y verificación manual en Task 8.

---

### Task 1: Base del proyecto y cliente de la Admin API

**Files:**
- Create: `package.json`, `.vercelignore`, `api/_lib/shopify.mjs`, `tests/shopify.test.mjs`

**Interfaces:**
- Produces: `api/_lib/shopify.mjs` → `SHOP` (`'6q1n8a-jw'`), `API_VERSION` (`'2026-01'`), `adminToken({ fetchImpl?, ahora? }): Promise<string>`, `adminGql(query: string, variables?: object, { fetchImpl? }?): Promise<object>` (devuelve `data`), `sinErrores(resultado: object, nombre: string): object` (tira si hay `userErrors`), `_resetToken(): void`.

- [ ] **Step 1: Crear `package.json` y `.vercelignore`**

`package.json`:
```json
{
  "name": "power-rush-web",
  "private": true,
  "scripts": {
    "test": "node --test \"tests/*.test.mjs\"",
    "ab:shopify": "node --env-file-if-exists=.env.local scripts/ab-shopify.mjs",
    "ab:db": "node --env-file-if-exists=.env.local --env-file-if-exists=.env.vercel.local scripts/ab-db.mjs"
  },
  "dependencies": {
    "@neondatabase/serverless": "1.1.0"
  }
}
```

`.vercelignore` (no se suben al deploy; nada de esto lo usa el sitio ni las funciones):
```
docs
tests
scripts
db
shopify
.env*
```

Run: `npm install`
Expected: crea `node_modules/` y `package-lock.json` sin errores.

- [ ] **Step 2: Escribir el test que falla**

`tests/shopify.test.mjs`:
```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, adminGql, sinErrores, _resetToken } from '../api/_lib/shopify.mjs';

process.env.SHOPIFY_CLIENT_ID = 'id-de-prueba';
process.env.SHOPIFY_CLIENT_SECRET = 'secreto-de-prueba';

function fetchFalso(llamadas) {
  return async (url, opciones) => {
    llamadas.push({ url: String(url), opciones });
    if (String(url).endsWith('/admin/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'tok-' + llamadas.length, scope: 'read_products', expires_in: 86399 }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { shop: { name: 'Mi tienda' } } }), { status: 200 });
  };
}

beforeEach(() => _resetToken());

test('pide el token con client credentials y lo reutiliza', async () => {
  const llamadas = [];
  const f = fetchFalso(llamadas);
  const data = await adminGql('{ shop { name } }', {}, { fetchImpl: f });
  await adminGql('{ shop { name } }', {}, { fetchImpl: f });
  assert.deepEqual(data, { shop: { name: 'Mi tienda' } });
  const pedidosDeToken = llamadas.filter((l) => l.url.endsWith('/admin/oauth/access_token'));
  assert.equal(pedidosDeToken.length, 1);
  const cuerpo = new URLSearchParams(pedidosDeToken[0].opciones.body);
  assert.equal(cuerpo.get('grant_type'), 'client_credentials');
  assert.equal(cuerpo.get('client_id'), 'id-de-prueba');
  const gql = llamadas.find((l) => l.url.endsWith('/admin/api/2026-01/graphql.json'));
  assert.equal(gql.opciones.headers['X-Shopify-Access-Token'], 'tok-1');
});

test('pide un token nuevo cuando el anterior está por vencer', async () => {
  const llamadas = [];
  const f = fetchFalso(llamadas);
  const t1 = await adminToken({ fetchImpl: f, ahora: 0 });
  const t2 = await adminToken({ fetchImpl: f, ahora: 86339 * 1000 - 1 });
  const t3 = await adminToken({ fetchImpl: f, ahora: 86339 * 1000 + 1 });
  assert.equal(t1, t2);
  assert.notEqual(t1, t3);
});

test('falla claro si faltan credenciales', async () => {
  const id = process.env.SHOPIFY_CLIENT_ID;
  delete process.env.SHOPIFY_CLIENT_ID;
  await assert.rejects(adminToken({ fetchImpl: fetchFalso([]) }), /SHOPIFY_CLIENT_ID/);
  process.env.SHOPIFY_CLIENT_ID = id;
});

test('sinErrores corta con los userErrors de una mutación', () => {
  assert.throws(() => sinErrores({ userErrors: [{ message: 'precio inválido' }] }, 'productSet'), /productSet: precio inválido/);
  assert.deepEqual(sinErrores({ userErrors: [], ok: 1 }, 'x'), { userErrors: [], ok: 1 });
});
```

- [ ] **Step 3: Correr y ver que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../api/_lib/shopify.mjs'`.

- [ ] **Step 4: Implementar `api/_lib/shopify.mjs`**

```js
/* Cliente de la Admin API de Shopify para las funciones y los scripts del test A/B.
   El token sale del client credentials grant de la app "Power Rush AB" (dura 24 h):
   se guarda en memoria y se pide de nuevo un minuto antes de que venza.
   Las credenciales vienen de SHOPIFY_CLIENT_ID y SHOPIFY_CLIENT_SECRET. */
export const SHOP = '6q1n8a-jw';
export const API_VERSION = '2026-01';

let cache = { token: null, vence: 0 };

export function _resetToken() {
  cache = { token: null, vence: 0 };
}

export async function adminToken({ fetchImpl = fetch, ahora = Date.now() } = {}) {
  if (cache.token && ahora < cache.vence) return cache.token;
  const { SHOPIFY_CLIENT_ID: id, SHOPIFY_CLIENT_SECRET: secreto } = process.env;
  if (!id || !secreto) throw new Error('Faltan SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET');
  const res = await fetchImpl(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secreto }).toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Token de Shopify: ' + (data.error_description || data.error || res.status));
  }
  cache = { token: data.access_token, vence: ahora + (data.expires_in - 60) * 1000 };
  return cache.token;
}

export async function adminGql(query, variables = {}, { fetchImpl = fetch } = {}) {
  const token = await adminToken({ fetchImpl });
  const res = await fetchImpl(`https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error('Admin API: ' + JSON.stringify(data.errors));
  return data.data;
}

/* Corta con error si una mutación devolvió userErrors. */
export function sinErrores(resultado, nombre) {
  const errores = resultado && resultado.userErrors;
  if (errores && errores.length) throw new Error(nombre + ': ' + errores.map((e) => e.message).join('; '));
  return resultado;
}
```

- [ ] **Step 5: Correr y ver que pasa**

Run: `npm test`
Expected: PASS (4 tests).

- [ ] **Step 6: Probar contra la tienda real**

Run: `node --env-file=.env.local --input-type=module -e "import { adminGql } from './api/_lib/shopify.mjs'; console.log(await adminGql('{ shop { name plan { displayName } } }'))"`
Expected: `{ shop: { name: 'Mi tienda', plan: { displayName: 'Shopify' } } }`

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .vercelignore api/_lib/shopify.mjs tests/shopify.test.mjs
git commit -m "Test A/B: base de tests y cliente de la Admin API"
```

---

### Task 2: `ab.js` — config del test y cálculos

**Files:**
- Create: `ab.js`, `tests/ab.test.mjs`

**Interfaces:**
- Produces (en Node, `import AB from '../ab.js'`; en el navegador, los mismos nombres dentro del módulo):
  - `AB.CONFIG = { activo: boolean, test: string, control: string, porciones: number, grupos: { [g]: { precio: number, peso: number, variantes: { bf: string|null, cp: string|null } } } }`
  - `AB.pct(cantidad: number): 0|10|15`
  - `AB.total(precio: number, cantidad: number): number` (pesos con centavos, igual que Shopify)
  - `AB.porUnidad(precio, cantidad): number`, `AB.porPorcion(precio): number`
  - `AB.money(n: number): string` (`'$80.998'`)
  - `AB.texto(tipo: 'total'|'cu'|'porcion', precio: number, n: number): string|null`
  - `AB.leerCookie(cookieHeader: string): { test, grupo, visitante, qa } | null`
  - `AB.resolver(cookieHeader: string, search: string): { grupo, visitante, qa, registra: boolean, error: string|null }`
  - `AB.atributosCarrito(r): Array<{ key, value }>`
  - `AB.origenDe(search, referrer, host): { source, medium, campaign }`
  - `AB.payload(r, evento, datos, ctx): object` (cuerpo del POST a `/api/ab/event`, ver Task 10)
  - `AB.boot(window)`: se agrega en Task 6.

- [ ] **Step 1: Escribir el test que falla**

`tests/ab.test.mjs`:
```js
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
```

- [ ] **Step 2: Correr y ver que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../ab.js'`.

- [ ] **Step 3: Implementar `ab.js` (parte de cálculo)**

```js
/* ===========================================================================
   POWER RUSH — Test A/B de precio (cliente)
   Va en el <head> de cada página, sin defer y antes que cart.js: define el precio del
   grupo del visitante antes de que se dibuje la página.
   El middleware sortea el grupo y deja la cookie pr_ab=<test>.<grupo>.<visitante>[.qa].
   En Node (tests, scripts y funciones de /api) este archivo exporta la config y los
   cálculos; en el navegador arranca solo (boot).
   Los grupos y pesos tienen que coincidir con AB en middleware.js.
   =========================================================================== */
(function (factory) {
  var AB = factory();
  if (typeof module === 'object' && module.exports) { module.exports = AB; return; }
  AB.boot(window);
})(function () {
  'use strict';

  var CONFIG = {
    activo: true,
    test: 'precio1',
    control: 'A',
    porciones: 30,
    grupos: {
      A: { precio: 44999, peso: 1, variantes: { bf: 'gid://shopify/ProductVariant/50221562495224', cp: 'gid://shopify/ProductVariant/50221562462456' } },
      B: { precio: 47749, peso: 1, variantes: { bf: null, cp: null } },   // Task 4 completa los IDs
      C: { precio: 49999, peso: 1, variantes: { bf: null, cp: null } }
    }
  };

  var RE_COOKIE = /^([a-z0-9-]+)\.([A-Z])\.([a-f0-9]{16})(\.qa)?$/;

  function grupoValido(g) { return Object.prototype.hasOwnProperty.call(CONFIG.grupos, g); }

  /* AHORROPACK (−10% desde 2 potes) y AHORRO15% (−15% desde 3) en Shopify. */
  function pct(cantidad) { return cantidad >= 3 ? 15 : cantidad === 2 ? 10 : 0; }

  /* Total como lo calcula Shopify: porcentaje sobre el total, en centavos exactos. */
  function total(precio, cantidad) {
    if (!(cantidad > 0)) return 0;
    return Math.round(precio * cantidad * (100 - pct(cantidad))) / 100;
  }
  function porUnidad(precio, cantidad) { return cantidad > 0 ? total(precio, cantidad) / cantidad : 0; }
  function porPorcion(precio) { return precio / CONFIG.porciones; }

  /* $80.998: sin centavos y con punto de miles en cualquier navegador. */
  function money(n) { return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

  function texto(tipo, precio, n) {
    n = n || 1;
    if (tipo === 'total') return money(total(precio, n));
    if (tipo === 'cu') return money(porUnidad(precio, n));
    if (tipo === 'porcion') return money(porPorcion(precio));
    return null;
  }

  function leerCookie(cookieHeader) {
    var m = String(cookieHeader || '').match(/(?:^|;\s*)pr_ab=([^;]+)/);
    var p = m && m[1].match(RE_COOKIE);
    return p ? { test: p[1], grupo: p[2], visitante: p[3], qa: !!p[4] } : null;
  }

  /* Qué grupo usa la página: cookie del test activo > ?ab= (solo sin cookie: desarrollo
     local, que no corre el middleware) > control. Sin cookie no se registra nada. */
  function resolver(cookieHeader, search) {
    if (!CONFIG.activo) return { grupo: CONFIG.control, visitante: null, qa: false, registra: false, error: null };
    var c = leerCookie(cookieHeader);
    if (c && c.test === CONFIG.test) {
      if (grupoValido(c.grupo)) return { grupo: c.grupo, visitante: c.visitante, qa: c.qa, registra: true, error: null };
      return { grupo: CONFIG.control, visitante: c.visitante, qa: c.qa, registra: true, error: 'grupo ' + c.grupo + ' no está en la config' };
    }
    var q = (String(search || '').match(/[?&]ab=([A-Za-z])(?:&|$)/) || [])[1];
    q = q ? q.toUpperCase() : null;
    return { grupo: q && grupoValido(q) ? q : CONFIG.control, visitante: null, qa: true, registra: false, error: null };
  }

  /* Atributos ocultos del carrito: Shopify los copia a la orden. */
  function atributosCarrito(r) {
    if (!r.registra) return [];
    var a = [
      { key: '_ab_test', value: CONFIG.test },
      { key: '_ab_group', value: r.grupo },
      { key: '_ab_visitor', value: r.visitante }
    ];
    if (r.qa) a.push({ key: '_ab_qa', value: '1' });
    return a;
  }

  function origenDe(search, referrer, host) {
    var p = new URLSearchParams(search || '');
    if (p.get('utm_source')) {
      return { source: p.get('utm_source'), medium: p.get('utm_medium') || null, campaign: p.get('utm_campaign') || null };
    }
    var ref = '';
    try { ref = referrer ? new URL(referrer).hostname : ''; } catch (e) { ref = ''; }
    if (ref && ref !== host) return { source: ref.replace(/^www\./, ''), medium: 'referral', campaign: null };
    return { source: 'directo', medium: null, campaign: null };
  }

  function payload(r, evento, datos, ctx) {
    datos = datos || {};
    return {
      t: CONFIG.test, g: r.grupo, v: r.visitante, s: ctx.sesion, e: evento, p: ctx.path,
      f: datos.sabor || null,
      q: datos.cantidad == null ? null : datos.cantidad,
      val: datos.valor == null ? null : datos.valor,
      d: datos.detalle || null,
      src: ctx.origen.source, med: ctx.origen.medium, cmp: ctx.origen.campaign
    };
  }

  function boot() {}   // Task 6

  return {
    CONFIG: CONFIG, pct: pct, total: total, porUnidad: porUnidad, porPorcion: porPorcion, money: money,
    texto: texto, leerCookie: leerCookie, resolver: resolver, atributosCarrito: atributosCarrito,
    origenDe: origenDe, payload: payload, boot: boot
  };
});
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `npm test`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add ab.js tests/ab.test.mjs
git commit -m "Test A/B: config, precios por cantidad y cookie en ab.js"
```

---

### Task 3: Prueba del pack de 1 unidad (paso 0 del spec)

Decide el mecanismo del checkout: **pack** (bundle fijo) o **duplicado**. Toca la tienda real: el producto de prueba se crea solo en el canal de la web y se borra al final.

**Files:**
- Create: `scripts/ab-shopify.mjs` (comandos `spike`, `borrar`, `estado`)
- Modify: `docs/superpowers/specs/2026-10-14-ab-test-precio-design.md` (decisión)

**Interfaces:**
- Consumes: `adminGql`, `sinErrores` (Task 1); `AB.CONFIG` (Task 2).
- Produces: dentro de `scripts/ab-shopify.mjs`, `crearProductoGrupo(grupo, modo: 'pack'|'duplicado', sabores?: string[]): Promise<{ productId, variantes: { bf?, cp? } }>`, que usa Task 4 en el mismo archivo (el script no se importa desde otro lado: al cargarse ejecuta el comando).

- [ ] **Step 1: Escribir `scripts/ab-shopify.mjs`**

```js
/* Configuración del test A/B en Shopify (Admin API). Uso:
     npm run ab:shopify -- <comando> [argumento]
   Comandos:
     spike                    pack de prueba: grupo B, solo Blue Fizz, en el canal de la web
     borrar <productId>       borra un producto creado por este script (tag ab-test)
     catalogo <pack|duplicado>  crea los productos de B y C con los dos sabores (Task 4)
     precio-control           pone las variantes originales al precio de A (Task 4)
     webhooks                 registra orders/create y orders/updated (Task 11)
     estado                   productos del test, precios, canales y webhooks */
import AB from '../ab.js';
import { adminGql, sinErrores } from '../api/_lib/shopify.mjs';

const { CONFIG } = AB;
const PRODUCTO_ORIGINAL = 'gid://shopify/Product/10286359806200';
const CANAL_WEB = 'gid://shopify/Publication/213151154424';
const WEBHOOK_URI = 'https://www.powerrush.com.ar/api/ab/order';
const STOREFRONT = { url: 'https://6q1n8a-jw.myshopify.com/api/2026-01/graphql.json', token: '86f826b1c8e239cacd6e97100784c83f' };
const SABORES = ['bf', 'cp'];

const Q_ORIGINAL = `query Original($id: ID!) {
  product(id: $id) {
    title
    descriptionHtml
    vendor
    productType
    options { name }
    variants(first: 10) { nodes { id title price media(first: 1) { nodes { ... on MediaImage { image { url altText } } } } } }
  }
}`;
const M_PRODUCT_SET = `mutation CrearProducto($input: ProductSetInput!) {
  productSet(input: $input, synchronous: true) {
    product { id variants(first: 10) { nodes { id title price } } }
    userErrors { field message code }
  }
}`;
const M_COMPONENTES = `mutation Componentes($input: [ProductVariantRelationshipUpdateInput!]!) {
  productVariantRelationshipBulkUpdate(input: $input) {
    parentProductVariants { id requiresComponents productVariantComponents(first: 5) { nodes { quantity productVariant { id } } } }
    userErrors { code field message }
  }
}`;
const M_PUBLICAR = `mutation Publicar($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) { userErrors { field message } }
}`;
const Q_CANALES = `query Canales($id: ID!) {
  product(id: $id) {
    resourcePublicationsV2(first: 10, onlyPublished: true) { nodes { publication { id name } isPublished } }
  }
}`;
const Q_PACK = `query Pack($id: ID!) {
  productVariant(id: $id) {
    id
    price
    requiresComponents
    inventoryQuantity
    productVariantComponents(first: 5) { nodes { quantity productVariant { id title } } }
  }
}`;
const Q_ETIQUETAS = `query Etiquetas($id: ID!) { product(id: $id) { id title tags } }`;
const M_BORRAR = `mutation Borrar($input: ProductDeleteInput!) {
  productDelete(input: $input) { deletedProductId userErrors { field message } }
}`;
const Q_POR_TAG = `query PorTag($q: String!) {
  products(first: 20, query: $q) {
    nodes {
      id
      title
      tags
      status
      variants(first: 5) { nodes { id title price } }
      resourcePublicationsV2(first: 10, onlyPublished: true) { nodes { publication { id } } }
    }
  }
}`;
const Q_WEBHOOKS = `query Webhooks { webhookSubscriptions(first: 20) { nodes { id topic uri } } }`;
const M_CART = `mutation Probar($input: CartInput!) {
  cartCreate(input: $input) {
    cart { checkoutUrl attributes { key value } cost { subtotalAmount { amount } totalAmount { amount } } }
    userErrors { message }
  }
}`;

async function storefront(query, variables) {
  const res = await fetch(STOREFRONT.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': STOREFRONT.token },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error('Storefront: ' + JSON.stringify(data.errors));
  return data.data;
}

/* Datos del producto original que se copian a los productos del test. */
async function original() {
  const { product } = await adminGql(Q_ORIGINAL, { id: PRODUCTO_ORIGINAL });
  const porId = Object.fromEntries(product.variants.nodes.map((v) => [v.id, v]));
  const sabores = {};
  for (const s of SABORES) {
    const v = porId[CONFIG.grupos.A.variantes[s]];
    if (!v) throw new Error(`La variante original de ${s} no está en el producto`);
    const img = v.media.nodes[0] && v.media.nodes[0].image;
    sabores[s] = { id: v.id, titulo: v.title, imagen: img ? img.url : null, alt: (img && img.altText) || v.title };
  }
  return { producto: product, opcion: product.options[0].name, sabores };
}

async function verificarCanales(id) {
  const { product } = await adminGql(Q_CANALES, { id });
  const canales = product.resourcePublicationsV2.nodes.map((n) => n.publication.id);
  if (canales.length !== 1 || canales[0] !== CANAL_WEB) {
    throw new Error(`${id} está publicado en [${canales.join(', ')}]: tiene que estar solo en el canal de la web`);
  }
}

/* Crea el producto de un grupo: mismo título, descripción, sabores y fotos que el original,
   al precio del grupo, publicado solo en el canal de la web.
   pack: cada variante es un bundle fijo con 1 unidad de la variante original (stock compartido).
   duplicado: variantes sin control de stock (Task 12 descuenta del original). */
async function crearProductoGrupo(grupo, modo, sabores = SABORES) {
  if (!['pack', 'duplicado'].includes(modo)) throw new Error('Modo: pack o duplicado');
  const o = await original();
  const precio = CONFIG.grupos[grupo].precio;
  const input = {
    title: o.producto.title,
    descriptionHtml: o.producto.descriptionHtml,
    vendor: o.producto.vendor,
    productType: o.producto.productType,
    status: 'ACTIVE',
    tags: ['ab-test', `ab-${CONFIG.test}-${grupo}`, `ab-modo-${modo}`],
    productOptions: [{ name: o.opcion, values: sabores.map((s) => ({ name: o.sabores[s].titulo })) }],
    variants: sabores.map((s) => ({
      optionValues: [{ optionName: o.opcion, name: o.sabores[s].titulo }],
      price: precio,
      ...(modo === 'duplicado' ? { inventoryItem: { tracked: false } } : {}),
      ...(o.sabores[s].imagen
        ? { file: { originalSource: o.sabores[s].imagen, contentType: 'IMAGE', alt: o.sabores[s].alt } }
        : {}),
    })),
  };
  const creado = sinErrores((await adminGql(M_PRODUCT_SET, { input })).productSet, 'productSet').product;
  const variantes = {};
  for (const s of sabores) variantes[s] = creado.variants.nodes.find((v) => v.title === o.sabores[s].titulo).id;

  if (modo === 'pack') {
    const relaciones = sabores.map((s) => ({
      parentProductVariantId: variantes[s],
      productVariantRelationshipsToCreate: [{ id: o.sabores[s].id, quantity: 1 }],
    }));
    sinErrores((await adminGql(M_COMPONENTES, { input: relaciones })).productVariantRelationshipBulkUpdate,
      'productVariantRelationshipBulkUpdate');
  }
  sinErrores((await adminGql(M_PUBLICAR, { id: creado.id, input: [{ publicationId: CANAL_WEB }] })).publishablePublish,
    'publishablePublish');
  await verificarCanales(creado.id);
  return { productId: creado.id, variantes };
}

async function spike() {
  const { productId, variantes } = await crearProductoGrupo('B', 'pack', ['bf']);
  console.log('Producto de prueba:', productId);
  console.log('Variante pack B Blue Fizz:', variantes.bf);
  const { productVariant: v } = await adminGql(Q_PACK, { id: variantes.bf });
  console.log('requiresComponents:', v.requiresComponents, '| precio:', v.price, '| stock vendible:', v.inventoryQuantity);
  console.log('componentes:', v.productVariantComponents.nodes.map((c) => `${c.quantity} × ${c.productVariant.title} (${c.productVariant.id})`).join(', '));
  for (const cantidad of [1, 2]) {
    const { cartCreate } = await storefront(M_CART, {
      input: {
        lines: [{ merchandiseId: variantes.bf, quantity: cantidad }],
        attributes: [{ key: '_ab_test', value: CONFIG.test }, { key: '_ab_group', value: 'B' }, { key: '_ab_qa', value: '1' }],
      },
    });
    if (cartCreate.userErrors.length) { console.log(`cartCreate (${cantidad}):`, cartCreate.userErrors); continue; }
    const c = cartCreate.cart;
    console.log(`\n${cantidad} pote(s): subtotal $${c.cost.subtotalAmount.amount} · total $${c.cost.totalAmount.amount}`);
    console.log('atributos:', JSON.stringify(c.attributes));
    console.log('checkout:', c.checkoutUrl);
  }
}

async function borrar(id) {
  if (!id) throw new Error('Uso: borrar <productId>');
  const { product } = await adminGql(Q_ETIQUETAS, { id });
  if (!product || !product.tags.includes('ab-test')) throw new Error('Solo borro productos con el tag ab-test');
  sinErrores((await adminGql(M_BORRAR, { input: { id } })).productDelete, 'productDelete');
  console.log('Borrado', product.title, id);
}

async function estado() {
  const { products } = await adminGql(Q_POR_TAG, { q: 'tag:ab-test' });
  if (!products.nodes.length) console.log('No hay productos del test.');
  for (const p of products.nodes) {
    console.log(`\n${p.id} · ${p.status} · tags: ${p.tags.join(', ')}`);
    console.log('  canales:', p.resourcePublicationsV2.nodes.map((n) => n.publication.id).join(', ') || 'ninguno');
    for (const v of p.variants.nodes) console.log(`  ${v.title}: $${v.price} (${v.id})`);
  }
  const { webhookSubscriptions } = await adminGql(Q_WEBHOOKS);
  console.log('\nWebhooks:', webhookSubscriptions.nodes.map((w) => `${w.topic} → ${w.uri}`).join('; ') || 'ninguno');
}

const [comando, arg] = process.argv.slice(2);
const comandos = { spike, borrar: () => borrar(arg), estado };
if (!comandos[comando]) {
  console.error('Comandos: ' + Object.keys(comandos).join(', '));
  process.exit(1);
}
await comandos[comando]();
```

- [ ] **Step 2: Correr la prueba**

Run: `npm run ab:shopify -- spike`
Expected: imprime el producto de prueba, `requiresComponents: true`, `componentes: 1 × Blue Fizz (gid://shopify/ProductVariant/50221562495224)`, y para 2 potes `total` = 85948.2 (AHORROPACK aplicado). Si `productVariantRelationshipBulkUpdate` o `cartCreate` devuelven error, anotarlo: es un "falla" del criterio 1 o 2.

- [ ] **Step 3: Revisar el checkout (lo hace una persona del equipo)**

La tienda tiene contraseña: primero entrar a `checkout.powerrush.com.ar/password` con la clave de la tienda. Abrir el `checkout` impreso para 1 pote y sacar captura. Criterio: se ve el nombre del producto, "Blue Fizz" y $47.749, sin precio tachado ni "Descuento". Si además muestra el contenido del pack ("1 × Blue Fizz"), decidir si es aceptable.

- [ ] **Step 4: Compra de prueba (equipo)**

Con el checkout de 1 pote, comprar con el medio de pago de la tienda. Verificar en el admin:
- el stock de Blue Fizz original bajó 1;
- la orden tiene los atributos `_ab_test=precio1`, `_ab_group=B`, `_ab_qa=1`.
Después reembolsar y cancelar la orden desde el admin.

- [ ] **Step 5: Decidir y limpiar**

- Si se cumplen los 5 criterios del spec (paso 0): **modo = pack**. Si falla cualquiera: **modo = duplicado**.
- Run: `npm run ab:shopify -- borrar <productId de la prueba>`
  Expected: `Borrado ... <id>`.
- Agregar al spec, al final de la sección 6, una línea: `Decisión del paso 0 (AAAA-MM-DD): <pack|duplicado>. <motivo en una frase>.`

- [ ] **Step 6: Commit**

```bash
git add scripts/ab-shopify.mjs docs/superpowers/specs/2026-10-14-ab-test-precio-design.md
git commit -m "Test A/B: script de Shopify y resultado de la prueba del pack"
```

---

### Task 4: Productos de B y C, precio del control y config completa

**Files:**
- Modify: `scripts/ab-shopify.mjs` (comandos `catalogo`, `precio-control`)
- Modify: `ab.js` (IDs de B y C en `CONFIG`)
- Modify: `tests/ab.test.mjs`

**Interfaces:**
- Consumes: `crearProductoGrupo` (Task 3); modo decidido en Task 3.
- Produces: `CONFIG.grupos.B.variantes` y `CONFIG.grupos.C.variantes` con IDs reales.

- [ ] **Step 1: Test que falla: config completa**

Agregar a `tests/ab.test.mjs`:
```js
test('config completa: cada grupo tiene variante para los dos sabores', () => {
  const ids = [];
  for (const [g, grupo] of Object.entries(CONFIG.grupos)) {
    for (const s of ['bf', 'cp']) {
      assert.match(String(grupo.variantes[s]), /^gid:\/\/shopify\/ProductVariant\/\d+$/, `${g}.${s}`);
      ids.push(grupo.variantes[s]);
    }
  }
  assert.equal(new Set(ids).size, ids.length, 'ninguna variante repetida entre grupos');
});
```

Run: `npm test`
Expected: FAIL — `B.bf` es `null`.

- [ ] **Step 2: Agregar los comandos al script**

En `scripts/ab-shopify.mjs`, antes de `const [comando, arg]`, agregar:
```js
const M_PRECIO = `mutation PrecioControl($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price }
    userErrors { field message }
  }
}`;

async function catalogo(modo) {
  const resultado = {};
  for (const g of Object.keys(CONFIG.grupos)) {
    if (g === CONFIG.control) continue;
    const { products } = await adminGql(Q_POR_TAG, { q: `tag:ab-${CONFIG.test}-${g}` });
    if (products.nodes.length) throw new Error(`Ya existe el producto del grupo ${g} (${products.nodes[0].id}). Borralo antes de recrearlo.`);
    resultado[g] = (await crearProductoGrupo(g, modo)).variantes;
    console.log(`Grupo ${g} listo.`);
  }
  console.log('\nPegá esto en CONFIG.grupos de ab.js (variantes de cada grupo):');
  console.log(JSON.stringify(resultado, null, 2));
}

async function precioControl() {
  const grupo = CONFIG.grupos[CONFIG.control];
  const variants = SABORES.map((s) => ({ id: grupo.variantes[s], price: grupo.precio }));
  const r = sinErrores((await adminGql(M_PRECIO, { productId: PRODUCTO_ORIGINAL, variants })).productVariantsBulkUpdate,
    'productVariantsBulkUpdate');
  for (const v of r.productVariants) console.log(`${v.id} → $${v.price}`);
}
```
y reemplazar la línea `const comandos = ...` por:
```js
const comandos = {
  spike,
  borrar: () => borrar(arg),
  catalogo: () => catalogo(arg),
  'precio-control': precioControl,
  estado,
};
```

- [ ] **Step 3: Crear los productos y fijar el precio de A**

Run: `npm run ab:shopify -- catalogo <modo de Task 3>`
Expected: `Grupo B listo.`, `Grupo C listo.` y un JSON `{ "B": { "bf": "gid://…", "cp": "gid://…" }, "C": { … } }`.

Run: `npm run ab:shopify -- precio-control`
Expected: las dos variantes originales `→ $44999.00`.

Run: `npm run ab:shopify -- estado`
Expected: dos productos con tag `ab-test`, cada uno con canales `gid://shopify/Publication/213151154424` solamente, B a $47749.00 y C a $49999.00.

- [ ] **Step 4: Pegar los IDs en `ab.js`**

Reemplazar en `CONFIG.grupos` las líneas de B y C por las del JSON impreso, por ejemplo:
```js
      B: { precio: 47749, peso: 1, variantes: { bf: 'gid://shopify/ProductVariant/<id que imprimió catalogo>', cp: 'gid://shopify/ProductVariant/<id>' } },
      C: { precio: 49999, peso: 1, variantes: { bf: 'gid://shopify/ProductVariant/<id>', cp: 'gid://shopify/ProductVariant/<id>' } }
```
(los `<id>` son los números del JSON del Step 3; borrar el comentario `// Task 4 completa los IDs`).

- [ ] **Step 5: Correr y ver que pasa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ab.js scripts/ab-shopify.mjs tests/ab.test.mjs
git commit -m "Test A/B: productos de B y C en el canal de la web y precio de control"
```

---

### Task 5: Middleware — sorteo del grupo y cookie

**Files:**
- Modify: `middleware.js`
- Create: `tests/middleware.test.mjs`

**Interfaces:**
- Consumes: nada (sin imports). Debe coincidir con `AB.CONFIG` (test, grupos, pesos).
- Produces: cookie `pr_ab=<test>.<grupo>.<visitante 16 hex>[.qa]`; exports con nombre `AB_MW` (config) y `asignarGrupo(request, url, cookies): string|null` (Set-Cookie o null).

- [ ] **Step 1: Escribir el test que falla**

`tests/middleware.test.mjs`:
```js
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
```

- [ ] **Step 2: Correr y ver que falla**

Run: `npm test`
Expected: FAIL — `asignarGrupo` no existe.

- [ ] **Step 3: Implementar en `middleware.js`**

Reemplazar el archivo completo por:
```js
/* ===========================================================================
   POWER RUSH — Portada "en construcción" y sorteo del test A/B de precio
   Mientras ABIERTO = false, cualquier página muestra /proximamente (la URL no
   cambia). El equipo entra al sitio completo con la clave desde "Acceso":
   /api/acceso la valida y deja una cookie por 30 días.
   El día que abre la tienda: ABIERTO = true.

   La clave no está en el código (el repo es público): la cookie es
   sha256('power-rush:' + clave) y acá solo se guarda el sha256 de la cookie.
   Para cambiar la clave, regenerar TOKEN_HASH acá y en api/_lib/equipo.mjs.

   Test A/B: en la primera visita se sortea el grupo y se deja la cookie
   pr_ab=<test>.<grupo>.<visitante>[.qa] por 180 días. La pone el servidor porque
   Safari borra a los 7 días las cookies creadas por scripts. AB_MW tiene que
   coincidir con CONFIG en /ab.js (test, grupos y pesos).
   Sin imports a propósito: Vercel compila este archivo como CommonJS.
   =========================================================================== */
const ABIERTO = false;
const COOKIE = 'pr_acceso';
const TOKEN_HASH = '1133fb0e866dcc5f001d96c612b2fc390b0654c934ece0d962b2621eb1a62540';

export const AB_MW = { activo: true, test: 'precio1', grupos: { A: 1, B: 1, C: 1 } };
const AB_COOKIE = 'pr_ab';
const AB_DIAS = 180;
const BOTS = /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|meta-externalagent|whatsapp|telegram|discord|slack|preview|lighthouse|pagespeed|headless|curl|wget|python|axios|node-fetch|go-http|java\//i;
const SIN_PORTADA = ['/app', '/app.html'];   // informe embebido en el admin de Shopify

export const config = {
  runtime: 'nodejs',
  // solo páginas; imágenes, scripts, íconos, /api y la propia portada pasan directo
  matcher: ['/((?!api/|assets/|proximamente|favicon|apple-touch-icon|web-app-manifest|site\\.webmanifest|cart\\.js|reviews\\.js|ab\\.js).*)'],
};

export default async function middleware(request) {
  const url = new URL(request.url);
  if (SIN_PORTADA.includes(url.pathname)) return next();
  const cookies = request.headers.get('cookie') || '';
  if (!ABIERTO && !(await esEquipo(cookies))) return rewrite(new URL('/proximamente', request.url));
  const cookie = asignarGrupo(request, url, cookies);
  return next(cookie ? { 'Set-Cookie': cookie } : undefined);
}

async function esEquipo(cookies) {
  const m = cookies.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})'));
  return !!m && (await sha256(m[1])) === TOKEN_HASH;
}

/* Set-Cookie a mandar, o null si no hay que tocar nada. */
export function asignarGrupo(request, url, cookies) {
  if (!AB_MW.activo) return null;
  if (BOTS.test(request.headers.get('user-agent') || '')) return null;
  const actual = leerAb(cookies);
  const qa = (url.searchParams.get('ab') || '').toUpperCase();
  if (/^[A-Z]$/.test(qa) && Object.hasOwn(AB_MW.grupos, qa)) {
    return cookieAb(`${AB_MW.test}.${qa}.${actual ? actual.visitante : idVisitante()}.qa`, url.hostname);
  }
  if (actual && actual.test === AB_MW.test && Object.hasOwn(AB_MW.grupos, actual.grupo)) return null;
  return cookieAb(`${AB_MW.test}.${sortear()}.${actual ? actual.visitante : idVisitante()}`, url.hostname);
}

function leerAb(cookies) {
  const m = cookies.match(/(?:^|;\s*)pr_ab=([a-z0-9-]+)\.([A-Z])\.([a-f0-9]{16})(\.qa)?(?:;|$)/);
  return m ? { test: m[1], grupo: m[2], visitante: m[3], qa: !!m[4] } : null;
}

function sortear() {
  const grupos = Object.keys(AB_MW.grupos);
  const suma = grupos.reduce((s, g) => s + AB_MW.grupos[g], 0);
  let r = (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * suma;
  for (const g of grupos) {
    r -= AB_MW.grupos[g];
    if (r < 0) return g;
  }
  return grupos[grupos.length - 1];
}

function idVisitante() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function cookieAb(valor, host) {
  const dominio = /(^|\.)powerrush\.com\.ar$/.test(host) ? '; Domain=.powerrush.com.ar' : '';
  return `${AB_COOKIE}=${valor}; Path=/; Max-Age=${AB_DIAS * 86400}; Secure; SameSite=Lax${dominio}`;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* Lo mismo que next() y rewrite() de @vercel/functions, sin sumar dependencias.
   Los headers de next() (Set-Cookie) llegan a la respuesta final. */
function next(headers) {
  return new Response(null, { headers: { ...(headers || {}), 'x-middleware-next': '1' } });
}
function rewrite(dest) {
  return new Response(null, { headers: { 'x-middleware-rewrite': dest.toString() } });
}
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `npm test`
Expected: PASS. (Node puede avisar `MODULE_TYPELESS_PACKAGE_JSON` por `middleware.js`; es solo un aviso.)

- [ ] **Step 5: Commit**

```bash
git add middleware.js tests/middleware.test.mjs
git commit -m "Test A/B: el middleware sortea el grupo y deja la cookie pr_ab"
```

---

### Task 6: `ab.js` en el navegador — pintar precios y registrar eventos

**Files:**
- Modify: `ab.js` (reemplazar `function boot() {}`)
- Modify: `tests/ab.test.mjs`

**Interfaces:**
- Consumes: todo lo de Task 2.
- Produces: `window.PR_AB = { test, grupo, visitante, qa, registra, precio: number, variantes: { bf, cp }, pct(n), total(n), porUnidad(n), money(n), pintar(el), track(evento, datos?), atributos(): Array<{key,value}> }`. Atributos de página: `data-ab-precio="total|cu|porcion"` y `data-ab-n="1|2|3"`.

- [ ] **Step 1: Test que falla: `boot` con un DOM mínimo**

Agregar a `tests/ab.test.mjs`:
```js
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
```

Run: `npm test`
Expected: FAIL — `win.PR_AB` es `undefined`.

- [ ] **Step 2: Implementar `boot` en `ab.js`**

Reemplazar `function boot() {}   // Task 6` por:
```js
  function idAleatorio(win, bytes) {
    var a = new Uint8Array(bytes);
    win.crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  /* Sesión y origen del tráfico: se fijan en la primera página de la sesión. */
  function sesionYOrigen(win) {
    var ss = null;
    try { ss = win.sessionStorage; } catch (e) { ss = null; }
    var s = ss && ss.getItem('pr_ab_s');
    var o = ss && ss.getItem('pr_ab_o');
    if (!s) { s = idAleatorio(win, 8); try { ss.setItem('pr_ab_s', s); } catch (e) {} }
    if (!o) {
      o = JSON.stringify(origenDe(win.location.search, win.document.referrer, win.location.hostname));
      try { ss.setItem('pr_ab_o', o); } catch (e) {}
    }
    return { sesion: s, origen: JSON.parse(o) };
  }

  function boot(win) {
    var doc = win.document;
    var r = resolver(doc.cookie, win.location.search);
    var g = CONFIG.grupos[r.grupo];
    var ctx = sesionYOrigen(win);

    function track(evento, datos) {
      if (!r.registra) return;
      ctx.path = win.location.pathname;
      var json = JSON.stringify(payload(r, evento, datos, ctx));
      try {
        if (win.navigator.sendBeacon && win.navigator.sendBeacon('/api/ab/event', new win.Blob([json], { type: 'text/plain' }))) return;
      } catch (e) {}
      try { win.fetch('/api/ab/event', { method: 'POST', body: json, keepalive: true, headers: { 'Content-Type': 'text/plain' } }); } catch (e) {}
    }

    /* Los precios quedan ocultos hasta que se pintan: nunca se ve uno y después otro. */
    var estilo = doc.createElement('style');
    estilo.textContent = '[data-ab-precio]:not([data-ab-ok]){visibility:hidden}';
    doc.head.appendChild(estilo);

    function pintar(el) {
      var t = texto(el.getAttribute('data-ab-precio'), g.precio, parseInt(el.getAttribute('data-ab-n'), 10) || 1);
      if (t != null) el.textContent = t;
      el.setAttribute('data-ab-ok', '');
    }
    function pintarDentro(raiz) {
      var els = raiz.querySelectorAll('[data-ab-precio]');
      for (var i = 0; i < els.length; i++) pintar(els[i]);
    }
    /* Pinta cada precio apenas el parser lo agrega, antes del primer dibujo. Los elementos
       de precio vienen vacíos en el HTML, así que el parser no les agrega texto después. */
    var mo = new win.MutationObserver(function (cambios) {
      for (var i = 0; i < cambios.length; i++) {
        var nodos = cambios[i].addedNodes;
        for (var j = 0; j < nodos.length; j++) {
          var n = nodos[j];
          if (n.nodeType !== 1) continue;
          if (n.hasAttribute('data-ab-precio')) pintar(n);
          if (n.firstElementChild) pintarDentro(n);
        }
      }
    });
    mo.observe(doc.documentElement, { childList: true, subtree: true });
    doc.addEventListener('DOMContentLoaded', function () { pintarDentro(doc); mo.disconnect(); });

    win.PR_AB = {
      test: CONFIG.test, grupo: r.grupo, visitante: r.visitante, qa: r.qa, registra: r.registra,
      precio: g.precio, variantes: g.variantes,
      pct: pct,
      total: function (n) { return total(g.precio, n); },
      porUnidad: function (n) { return porUnidad(g.precio, n); },
      money: money,
      pintar: pintar,
      track: track,
      atributos: function () { return atributosCarrito(r); }
    };

    track('vista');
    if (r.error) track('error_config', { detalle: r.error });
  }
```

- [ ] **Step 3: Correr y ver que pasa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ab.js tests/ab.test.mjs
git commit -m "Test A/B: ab.js pinta los precios del grupo y registra eventos"
```

---

### Task 7: Páginas — precios del grupo sin números escritos a mano

**Files:**
- Modify: `index.html` (head, líneas ~695, 1043, 1059, 1325)
- Modify: `products/powerrush/index.html` (head, líneas ~742–790, 1283, 1387–1424)
- Create: `tests/paginas.test.mjs`

**Interfaces:**
- Consumes: `/ab.js` y `window.PR_AB.pintar` (Task 6).
- Produces: elementos `data-ab-precio` vacíos; `PowerCart.add(sabor, cantidad, 'producto')` desde la página de producto (lo implementa Task 8).

- [ ] **Step 1: Test que falla**

`tests/paginas.test.mjs`:
```js
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
```

Run: `npm test`
Expected: FAIL (no hay `/ab.js` y quedan precios viejos).

- [ ] **Step 2: Editar `index.html`**

1. Después de `<meta name="viewport" content="width=device-width, initial-scale=1.0">` agregar:
```html
  <script src="/ab.js"></script>
```
2. Línea ~695: `.p-price span:not([data-pr-price])` → `.p-price span:not([data-ab-precio])`.
3. Líneas 1043 y 1059: `<span data-pr-price>$24.999</span>` → `<span data-ab-precio="total"></span>` (las dos).
4. Línea 1325: `<span class="v-num">$800</span>` → `<span class="v-num" data-ab-precio="porcion"></span>`.

- [ ] **Step 3: Editar `products/powerrush/index.html`**

1. Después de `<meta name="viewport" ...>` agregar `  <script src="/ab.js"></script>`.
2. En las tres tarjetas de cantidad: sacar `data-total="…"` del `<div class="qty-card"…>` y reemplazar los precios:
```html
          <div class="qty-card active" data-n="1" onclick="selectQty(1, this)">
            <span class="qty-radio"></span>
            <span class="qty-num">1</span>
            <span class="qty-info">
              <span class="qty-unit">Pote</span>
              <span class="qty-per"><span data-ab-precio="cu" data-ab-n="1"></span> c/u · 30 porciones</span>
            </span>
            <span class="qty-meta">
              <span class="qty-total" data-ab-precio="cu" data-ab-n="1"></span>
            </span>
          </div>
```
Igual para 2 y 3 potes, con `data-n="2"`/`"3"`, `selectQty(2, this)`/`(3, this)`, `data-ab-n="2"`/`"3"` en los dos spans y el resto del markup (60/90 porciones, "cada uno", "✓ Envío gratis") sin cambios.
3. `<div class="prod-price" id="prod-price">$24.999</div>` → `<div class="prod-price" id="prod-price" data-ab-precio="total" data-ab-n="1"></div>`.
4. `<div class="sb-price" id="sb-price">$24.999</div>` → `<div class="sb-price" id="sb-price" data-ab-precio="total" data-ab-n="1"></div>`.
5. Reemplazar `function selectQty(n, el) { … }` por:
```js
function selectQty(n, el) {
  currentQty = n;
  document.querySelectorAll('.qty-card').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('sb-detail').textContent = n + (n===1?' pote':' potes') + ' · ' + (n*30) + ' porciones';
  ['prod-price', 'sb-price'].forEach(function (id) {
    var p = document.getElementById(id);
    p.setAttribute('data-ab-n', n);
    if (window.PR_AB) PR_AB.pintar(p);
  });
  const ship = document.getElementById('price-ship');
  ship.textContent = n >= 2 ? 'Envío gratis' : 'Envío a calcular';
  ship.classList.toggle('ship-free', n >= 2);
}
```
6. `function addToCart() { if (window.PowerCart) PowerCart.add(currentFlavor, currentQty); }` → `function addToCart() { if (window.PowerCart) PowerCart.add(currentFlavor, currentQty, 'producto'); }`.
7. En el listener `pr:catalog`: cambiar el comentario a `/* ===== CATÁLOGO VIVO — el stock sale de Shopify (ver cart.js); los precios los pinta /ab.js ===== */` y borrar el bloque desde `// los tres escalones de cantidad se recalculan sobre el precio real` hasta el cierre de `if (active) { … }` inclusive (el resto del handler, stock y sabores agotados, queda igual).

- [ ] **Step 4: Correr y ver que pasa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Verificar en el navegador (local, sin middleware)**

Run: `preview_start` con `power-rush-web` (live-server en :8080). Abrir `http://localhost:8080/?ab=b` y `http://localhost:8080/products/powerrush?ab=c`.
Expected:
- home con `?ab=b`: las dos tarjetas dicen $47.749; la tabla comparativa dice $1.592 por porción.
- producto con `?ab=c`: 1 pote $49.999; 2 potes $44.999 c/u; 3 potes $42.499 c/u; al elegir 3, total y barra fija $127.497.
- sin `?ab`: $44.999; 2 potes $40.499 c/u; 3 potes $38.249 c/u; porción $1.500.
- `read_console_messages` sin errores. Captura con la red en "Slow 3G": ningún precio visible antes del correcto.

- [ ] **Step 6: Commit**

```bash
git add index.html products/powerrush/index.html tests/paginas.test.mjs
git commit -m "Test A/B: las páginas toman el precio del grupo de ab.js"
```

---

### Task 8: `cart.js` — precio, variante y atributos del grupo

**Files:**
- Modify: `cart.js`

**Interfaces:**
- Consumes: `window.PR_AB` (Task 6).
- Produces: `PowerCart.add(id, q, origen?)`; eventos `agregar_carrito`, `abrir_carrito`, `clic_comprar`, `error_checkout`, `error_precio`; carrito de Shopify con `PR_AB.variantes` y `PR_AB.atributos()`.

- [ ] **Step 1: `gql` con variables**

Reemplazar `function gql(query, cb) { … }` por:
```js
  function gql(query, cb, variables) {
    try {
      fetch('https://' + SHOPIFY.domain + '/api/' + SHOPIFY.api + '/graphql.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': SHOPIFY.token },
        body: JSON.stringify({ query: query, variables: variables || {} })
      }).then(function (r) { return r.json(); }).then(cb).catch(function () { cb(null); });
    } catch (e) { cb(null); }
  }
```

- [ ] **Step 2: Precios del grupo**

Reemplazar desde `var BASE_FALLBACK = 24999;` hasta `function savePct() { … }` inclusive por:
```js
  /* Precio y descuentos del test A/B: salen de /ab.js (window.PR_AB), que fija el grupo del
     visitante antes de que cargue la página. Sin ab.js: precio de Shopify, sin descuento. */
  function AB() { return window.PR_AB || null; }
  function base() { var ab = AB(); return ab ? ab.precio : (PRODUCTS.bf.price || PRODUCTS.cp.price || 0); }
  function variante(id) { var ab = AB(); return (ab && ab.variantes[id]) || SHOPIFY.variants[id]; }
  function track(evento, datos) { var ab = AB(); if (ab) ab.track(evento, datos); }
  function discPct(tq) { tq = (tq == null) ? totalQty() : tq; var ab = AB(); return ab ? ab.pct(tq) : 0; }
  function subtotal(tq) { tq = (tq == null) ? totalQty() : tq; var ab = AB(); return ab ? ab.total(tq) : base() * tq; }
  function unitPrice(tq) { tq = (tq == null) ? totalQty() : tq; return tq > 0 ? subtotal(tq) / tq : base(); }
  function baseTotal() { return base() * totalQty(); }
  function savings() { return baseTotal() - subtotal(); }
  function savePct() { var b = baseTotal(); return b > 0 ? Math.round(savings() / b * 100) : 0; }
```
y reemplazar `function money(n) { return '$' + Math.round(n).toLocaleString('es-AR'); }` por:
```js
  function money(n) { var ab = AB(); return ab ? ab.money(n) : '$' + Math.round(n).toLocaleString('es-AR'); }
```

- [ ] **Step 3: Eventos de carrito**

Reemplazar `function add(id, q) { … }` por:
```js
  function add(id, q, origen) {
    if (!PRODUCTS[id] || soldOut(id)) return;
    q = q || 1;
    setQty(id, qtyOf(id) + q);
    track('agregar_carrito', { sabor: id, cantidad: q, detalle: origen || 'pagina' });
    open(); pulse();
  }
```
En el listener global de clicks, reemplazar las dos líneas de `addEl` y `openEl` por:
```js
    var addEl = e.target.closest('[data-pr-add]');
    if (addEl) {
      e.preventDefault();
      add(addEl.getAttribute('data-pr-add'), parseInt(addEl.getAttribute('data-pr-qty'), 10) || 1,
        drawer && drawer.contains(addEl) ? 'carrito' : 'pagina');
      return;
    }
    var openEl = e.target.closest('[data-pr-open]');
    if (openEl) { e.preventDefault(); open(); track('abrir_carrito'); }
```

- [ ] **Step 4: Checkout con la variante y los atributos del grupo**

Reemplazar `function checkout() { … }` completa por:
```js
  function checkout() {
    if (totalQty() === 0 || checkout.busy) return;
    var btn = foot.querySelector('[data-pr-checkout]');
    checkout.busy = true;
    if (btn) { btn.classList.add('loading'); btn.textContent = 'Preparando tu pedido…'; }
    track('clic_comprar', { cantidad: totalQty(), valor: subtotal() });

    var input = {
      lines: ORDER.filter(function (id) { return qtyOf(id) > 0 && variante(id); })
        .map(function (id) { return { merchandiseId: variante(id), quantity: qtyOf(id) }; }),
      attributes: AB() ? AB().atributos() : []
    };
    var code = discountCode();
    if (code) input.discountCodes = [code];

    gql('mutation Crear($input: CartInput!){cartCreate(input:$input){cart{checkoutUrl} userErrors{message}}}', function (res) {
      var data = res && res.data && res.data.cartCreate;
      var url = data && data.cart && data.cart.checkoutUrl;
      if (url) { window.location.href = url; return; }
      track('error_checkout', {
        detalle: data && data.userErrors && data.userErrors.length
          ? data.userErrors.map(function (u) { return u.message; }).join('; ')
          : 'sin respuesta de Shopify'
      });
      checkout.busy = false;
      if (btn) { btn.classList.remove('loading'); btn.textContent = 'Comprar'; }
      alert('No pudimos abrir el checkout. Probá de nuevo en unos segundos.');
    }, { input: input });
  }
```

- [ ] **Step 5: Catálogo: stock del original y control de precio**

Reemplazar `function syncCatalog() { … }` por:
```js
  function syncCatalog() {
    var ids = [];
    ORDER.forEach(function (id) {
      if (SHOPIFY.variants[id]) ids.push(SHOPIFY.variants[id]);
      if (variante(id) && ids.indexOf(variante(id)) < 0) ids.push(variante(id));
    });
    if (!ids.length) return;

    gql('query Catalogo($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{id availableForSale quantityAvailable price{amount} image{url}}}}', function (res) {
      var nodes = res && res.data && res.data.nodes;
      if (!nodes) return;                                   // sin respuesta: se queda el fallback local
      var porId = {};
      nodes.forEach(function (n) { if (n && n.id) porId[n.id] = n; });
      revisarPrecios(porId);

      /* Stock y fotos salen siempre de las variantes originales: el pack comparte su
         stock y el duplicado no lo controla. */
      var priced = 0, found = [];
      ORDER.forEach(function (id) {
        var n = porId[SHOPIFY.variants[id]];
        if (!n) return;
        found.push({ id: id, n: n });
        var img = n.image && n.image.url;                   // solo la foto de la variante, no la del producto
        if (img) PRODUCTS[id].img = img + (img.indexOf('?') > -1 ? '&' : '?') + 'width=420';
        var amount = n.price && parseFloat(n.price.amount);
        if (amount > 0) { PRODUCTS[id].price = amount; priced++; }
      });

      /* Mientras la tienda no tenga precios cargados, no tomamos su stock como
         verdad: la página seguiría con todo "sin stock" por una config a medias. */
      if (!priced) { paintPhotos(); render(); return; }

      found.forEach(function (f) {
        LIVE.stock[f.id] = {
          avail: f.n.availableForSale !== false,
          qty: (typeof f.n.quantityAvailable === 'number' && f.n.quantityAvailable > 0) ? f.n.quantityAvailable : null
        };
      });

      LIVE.ready = true;
      ORDER.forEach(function (id) {                          // el carrito guardado no puede exceder el stock
        var max = maxFor(id);
        if (soldOut(id)) delete state[id];
        else if (qtyOf(id) > max) state[id] = max;
      });
      save();
      paintStock();
      render();
    }, { ids: ids });
  }

  /* Lo que cobra Shopify tiene que ser el precio del grupo; si no, la config del test está mal. */
  function revisarPrecios(porId) {
    var ab = AB();
    if (!ab) return;
    ORDER.forEach(function (id) {
      var n = porId[variante(id)];
      var amount = n && n.price && parseFloat(n.price.amount);
      if (amount > 0 && Math.abs(amount - ab.precio) > 0.005) {
        track('error_precio', { sabor: id, valor: amount, detalle: 'Shopify $' + amount + ' / config $' + ab.precio + ' (grupo ' + ab.grupo + ')' });
      }
    });
  }
```

- [ ] **Step 6: `paintPhotos` sin precios**

Reemplazar el comentario y las dos primeras líneas de `paintPhotos` (`/* Fotos y precio base …*/`, `var px = …`, `for (var p = 0; …)`) por:
```js
  /* Fotos tal como están cargadas en Shopify. Los precios los pinta /ab.js. */
  function paintPhotos() {
```
(el loop de `[data-pr-photo]` queda igual).

- [ ] **Step 7: Verificar en el navegador**

Con live-server (`http://localhost:8080`), en la consola: `document.cookie = 'pr_ab=precio1.B.0123456789abcdef.qa; path=/'` y recargar `/products/powerrush`.
Expected:
- precios de B en la página y en el carrito (2 potes: $42.974 c/u, subtotal $85.948, "Ahorrás 10%");
- `read_network_requests`: POST a `/api/ab/event` (404 en local, es esperable) con `e: "vista"`, luego `agregar_carrito` con `d: "producto"` al tocar Comprar en la página;
- al tocar Comprar en el carrito, el `cartCreate` lleva las variantes de B y `attributes` `_ab_test`, `_ab_group: "B"`, `_ab_visitor`, `_ab_qa`; la respuesta trae `checkoutUrl`;
- en la consola: `PowerCart.subtotal(3)` → `121759.95`.
Para el Review Focus 5: con la cookie de B, cambiar a mano en la consola `PR_AB.precio = 1` y llamar `PowerCart.refresh()`: sale un POST `error_precio`. Recargar para volver.
Borrar la cookie al terminar: `document.cookie = 'pr_ab=; Max-Age=0; path=/'`.

- [ ] **Step 8: Commit**

```bash
git add cart.js
git commit -m "Test A/B: el carrito usa precio, variante y atributos del grupo"
```

---

### Task 9: Base de datos (Neon) y variables de entorno en Vercel

**Files:**
- Create: `db/ab-schema.sql`, `api/_lib/db.mjs`, `scripts/ab-db.mjs`

**Interfaces:**
- Produces: tablas `ab_events` y `ab_orders`; `api/_lib/db.mjs` → `db(): NeonQueryFunction` (tagged template y `.query(text, params)`).

- [ ] **Step 1: Vincular el repo y provisionar Neon**

```bash
vercel link --yes --project power-rush-playground --scope marcosballester1-8989s-projects
vercel integration add neon
```
Expected: Neon queda conectado al proyecto con `DATABASE_URL` en Production, Preview y Development. Si el CLI pide aceptar términos o terminar en el navegador, pedirle a Marcos que lo complete y seguir.

- [ ] **Step 2: Cargar las credenciales de Shopify en Vercel**

```bash
set -a; . ./.env.local; set +a
for entorno in production preview; do
  printf '%s' "$SHOPIFY_CLIENT_ID" | vercel env add SHOPIFY_CLIENT_ID "$entorno"
  printf '%s' "$SHOPIFY_CLIENT_SECRET" | vercel env add SHOPIFY_CLIENT_SECRET "$entorno"
done
vercel env pull .env.vercel.local --yes
vercel env ls
```
Expected: `vercel env ls` muestra `DATABASE_URL`, `SHOPIFY_CLIENT_ID` y `SHOPIFY_CLIENT_SECRET` (solo nombres). `.env.vercel.local` existe y `git status` no lo muestra.

- [ ] **Step 3: Esquema**

`db/ab-schema.sql`:
```sql
create table if not exists ab_events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  test       text not null,
  grp        text not null,
  visitor    text not null,
  session    text,
  event      text not null,
  path       text,
  flavor     text,
  qty        int,
  value      numeric(12,2),
  order_id   text,
  detail     text,
  source     text,
  medium     text,
  campaign   text,
  device     text,
  country    text,
  excluded   text
);
create index if not exists ab_events_test_grp_event on ab_events (test, grp, event);
create index if not exists ab_events_test_visitor on ab_events (test, visitor);

create table if not exists ab_orders (
  order_id       text primary key,
  order_name     text,
  created_at     timestamptz not null,
  updated_at     timestamptz not null default now(),
  test           text not null,
  grp            text not null,
  visitor        text,
  inferred       boolean not null default false,
  qa             boolean not null default false,
  units          int not null,
  subtotal       numeric(12,2) not null,
  discounts      numeric(12,2) not null,
  total          numeric(12,2) not null,
  discount_codes text[],
  status         text not null
);
create index if not exists ab_orders_test_grp on ab_orders (test, grp);
```

`api/_lib/db.mjs`:
```js
/* Conexión a Postgres (Neon) por HTTP. Se crea recién cuando se usa, así un deploy sin
   DATABASE_URL no se cae al cargar la función. */
import { neon } from '@neondatabase/serverless';

let sql = null;

export function db() {
  if (!sql) {
    if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
    sql = neon(process.env.DATABASE_URL);
  }
  return sql;
}
```

`scripts/ab-db.mjs`:
```js
/* Aplica db/ab-schema.sql (idempotente). Uso: npm run ab:db */
import { readFileSync } from 'node:fs';
import { db } from '../api/_lib/db.mjs';

const sql = db();
const esquema = readFileSync(new URL('../db/ab-schema.sql', import.meta.url), 'utf8');
for (const sentencia of esquema.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
  await sql.query(sentencia);
}
const tablas = await sql.query("select table_name from information_schema.tables where table_name in ('ab_events', 'ab_orders') order by 1");
console.log('Tablas:', tablas.map((t) => t.table_name).join(', '));
```

- [ ] **Step 4: Aplicar el esquema**

Run: `npm run ab:db`
Expected: `Tablas: ab_events, ab_orders`. Correrlo dos veces da lo mismo.

- [ ] **Step 5: Commit**

```bash
git add db/ab-schema.sql api/_lib/db.mjs scripts/ab-db.mjs
git commit -m "Test A/B: tablas de eventos y órdenes en Postgres"
```

---

### Task 10: `/api/ab/event` — registro de eventos

**Files:**
- Create: `api/_lib/equipo.mjs`, `api/_lib/eventos.mjs`, `api/ab/event.mjs`, `tests/eventos.test.mjs`
- Modify: `api/acceso.mjs`

**Interfaces:**
- Consumes: `AB.CONFIG` (Task 2); cuerpo de `AB.payload` (Task 2): `{ t, g, v, s, e, p, f, q, val, d, src, med, cmp }` y, desde el pixel, `oid`.
- Produces: `api/_lib/equipo.mjs` → `COOKIE`, `TOKEN_HASH`, `sha256(texto)`, `esEquipo(cookies): Promise<boolean>`. `api/_lib/eventos.mjs` → `EVENTOS: Set<string>`, `BOTS: RegExp`, `dispositivo(ua): 'mobile'|'tablet'|'desktop'`, `filaEvento(cuerpo, { cookies, ua, pais, esEquipo }): object|null`. `POST /api/ab/event` → siempre 204.

- [ ] **Step 1: Test que falla**

`tests/eventos.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filaEvento, dispositivo } from '../api/_lib/eventos.mjs';
import { esEquipo } from '../api/_lib/equipo.mjs';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const base = { t: 'precio1', g: 'B', v: '0123456789abcdef', s: 'aaaabbbbccccdddd', e: 'agregar_carrito', p: '/products/powerrush', f: 'bf', q: 2, val: null, d: 'producto', src: 'meta', med: 'paid', cmp: null };

test('evento válido → fila completa', () => {
  assert.deepEqual(filaEvento(base, { ua: IPHONE, pais: 'AR' }), {
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
  assert.equal(filaEvento(base, { ua: IPHONE, esEquipo: true }).excluded, 'internal');
});

test('limpia valores raros', () => {
  const f = filaEvento({ ...base, q: -3, val: 'mucho', p: 'x'.repeat(500), oid: 12345 }, { ua: IPHONE, pais: 'ARG' });
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
```

Run: `npm test`
Expected: FAIL — no existen los módulos.

- [ ] **Step 2: `api/_lib/equipo.mjs` y `api/acceso.mjs`**

`api/_lib/equipo.mjs`:
```js
/* Cookie de acceso del equipo (formulario "Acceso" de /proximamente).
   La cookie es sha256('power-rush:' + clave); acá solo se guarda el sha256 de la cookie.
   Si cambia la clave, actualizar TOKEN_HASH acá y en middleware.js. */
export const COOKIE = 'pr_acceso';
export const TOKEN_HASH = '1133fb0e866dcc5f001d96c612b2fc390b0654c934ece0d962b2621eb1a62540';

export async function sha256(texto) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function esEquipo(cookies) {
  const m = String(cookies || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})'));
  return !!m && (await sha256(m[1])) === TOKEN_HASH;
}
```

En `api/acceso.mjs`: cambiar el comentario de cabecera a `... Si cambia la clave, actualizar api/_lib/equipo.mjs y middleware.js. */`, borrar las constantes `COOKIE` y `TOKEN_HASH` y la función `sha256`, y agregar arriba:
```js
import { COOKIE, TOKEN_HASH, sha256 } from './_lib/equipo.mjs';
```
(`DIAS`, `POST`, `GET` y `volver` quedan igual).

- [ ] **Step 3: `api/_lib/eventos.mjs`**

```js
/* Validación de los eventos del test A/B (web y pixel del checkout). */
import AB from '../../ab.js';

export const EVENTOS = new Set([
  'vista', 'agregar_carrito', 'abrir_carrito', 'clic_comprar',
  'checkout_iniciado', 'pago_ingresado', 'compra',
  'error_precio', 'error_config', 'error_checkout',
]);
// Igual que BOTS en middleware.js
export const BOTS = /bot|crawl|spider|slurp|facebookexternalhit|facebookcatalog|meta-externalagent|whatsapp|telegram|discord|slack|preview|lighthouse|pagespeed|headless|curl|wget|python|axios|node-fetch|go-http|java\//i;

const corto = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
const entero = (v) => (Number.isInteger(v) && v >= 0 && v < 1000 ? v : null);
const numero = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v * 100) / 100 : null);

export function dispositivo(ua) {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

/* Fila para ab_events, o null si el evento no es válido o viene de un bot. */
export function filaEvento(cuerpo, { cookies = '', ua = '', pais = null, esEquipo = false } = {}) {
  const { CONFIG } = AB;
  if (!cuerpo || typeof cuerpo !== 'object') return null;
  if (cuerpo.t !== CONFIG.test) return null;
  if (typeof cuerpo.g !== 'string' || !Object.hasOwn(CONFIG.grupos, cuerpo.g)) return null;
  if (typeof cuerpo.v !== 'string' || !/^[a-f0-9]{16}$/.test(cuerpo.v)) return null;
  if (!EVENTOS.has(cuerpo.e)) return null;
  if (BOTS.test(ua)) return null;
  const qa = /(?:^|;\s*)pr_ab=[^;]*\.qa(?:;|$)/.test(cookies);
  return {
    test: cuerpo.t, grp: cuerpo.g, visitor: cuerpo.v, session: corto(cuerpo.s, 32), event: cuerpo.e,
    path: corto(cuerpo.p, 200), flavor: corto(cuerpo.f, 8), qty: entero(cuerpo.q), value: numero(cuerpo.val),
    order_id: corto(cuerpo.oid, 64), detail: corto(cuerpo.d, 300),
    source: corto(cuerpo.src, 100), medium: corto(cuerpo.med, 100), campaign: corto(cuerpo.cmp, 150),
    device: dispositivo(ua), country: corto(pais, 2),
    excluded: qa ? 'qa' : esEquipo ? 'internal' : null,
  };
}
```

- [ ] **Step 4: `api/ab/event.mjs`**

```js
/* POST /api/ab/event — eventos del test A/B desde la web (sendBeacon) y desde el pixel
   del checkout de Shopify. Siempre responde 204: un error acá nunca afecta a la página. */
import { filaEvento } from '../_lib/eventos.mjs';
import { esEquipo } from '../_lib/equipo.mjs';
import { db } from '../_lib/db.mjs';

const CORS = { 'Access-Control-Allow-Origin': '*' };

export async function POST(request) {
  try {
    const texto = await request.text();
    if (texto.length <= 4000) {
      let cuerpo = null;
      try { cuerpo = JSON.parse(texto); } catch { cuerpo = null; }
      const cookies = request.headers.get('cookie') || '';
      const fila = filaEvento(cuerpo, {
        cookies,
        ua: request.headers.get('user-agent') || '',
        pais: request.headers.get('x-vercel-ip-country'),
        esEquipo: await esEquipo(cookies),
      });
      if (fila) await insertar(fila);
    }
  } catch (e) {
    console.error('ab/event', e);
  }
  return new Response(null, { status: 204, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' },
  });
}

async function insertar(f) {
  await db()`insert into ab_events
    (test, grp, visitor, session, event, path, flavor, qty, value, order_id, detail, source, medium, campaign, device, country, excluded)
    values (${f.test}, ${f.grp}, ${f.visitor}, ${f.session}, ${f.event}, ${f.path}, ${f.flavor}, ${f.qty}, ${f.value},
            ${f.order_id}, ${f.detail}, ${f.source}, ${f.medium}, ${f.campaign}, ${f.device}, ${f.country}, ${f.excluded})`;
}
```

- [ ] **Step 5: Correr y ver que pasa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Probar el handler contra la base real**

Run:
```bash
node --env-file=.env.vercel.local --input-type=module -e "
import { POST } from './api/ab/event.mjs';
import { db } from './api/_lib/db.mjs';
const r = await POST(new Request('https://x/api/ab/event', { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)', cookie: 'pr_ab=precio1.A.0000000000000000.qa' }, body: JSON.stringify({ t: 'precio1', g: 'A', v: '0000000000000000', e: 'vista', p: '/' }) }));
console.log(r.status, await db()\`select event, excluded from ab_events where visitor = '0000000000000000'\`);
await db()\`delete from ab_events where visitor = '0000000000000000'\`;"
```
Expected: `204 [ { event: 'vista', excluded: 'qa' } ]`.

- [ ] **Step 7: Commit**

```bash
git add api/_lib/equipo.mjs api/_lib/eventos.mjs api/ab/event.mjs api/acceso.mjs tests/eventos.test.mjs
git commit -m "Test A/B: endpoint de eventos y cookie del equipo en un solo lugar"
```

---

### Task 11: `/api/ab/order` — webhook de órdenes

**Files:**
- Create: `api/_lib/ordenes.mjs`, `api/ab/order.mjs`, `tests/ordenes.test.mjs`
- Modify: `scripts/ab-shopify.mjs` (comando `webhooks`)

**Interfaces:**
- Consumes: `AB.CONFIG`; `adminGql`, `sinErrores` (Task 1); `db` (Task 9).
- Produces: `api/_lib/ordenes.mjs` → `verificarHmac(cuerpo: Buffer|string, firma: string, secreto: string): boolean`, `grupoPorPrecio(orden): string|null`, `estadoOrden(orden): string`, `filaOrden(orden): object|null`, `etiquetasPara(fila, tagsActuales: string): string[]`. `POST /api/ab/order` (401 sin firma válida, 200 si procesó, 500 para que Shopify reintente).

- [ ] **Step 1: Test que falla**

`tests/ordenes.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verificarHmac, filaOrden, etiquetasPara, grupoPorPrecio } from '../api/_lib/ordenes.mjs';

const orden = (cambios = {}) => ({
  id: 6123456789012, name: '#1042', created_at: '2026-11-02T15:04:05-03:00', cancelled_at: null,
  financial_status: 'paid', tags: '',
  note_attributes: [
    { name: '_ab_test', value: 'precio1' }, { name: '_ab_group', value: 'B' }, { name: '_ab_visitor', value: '0123456789abcdef' },
  ],
  line_items: [{ variant_id: 1, quantity: 2, price: '47749.00' }, { variant_id: 2, quantity: 1, price: '47749.00' }],
  total_line_items_price: '143247.00', total_discounts: '21487.05', current_subtotal_price: '121759.95',
  discount_codes: [],
  ...cambios,
});

test('firma HMAC de Shopify', () => {
  const cuerpo = JSON.stringify(orden());
  const firma = createHmac('sha256', 'shpss_x').update(cuerpo).digest('base64');
  assert.equal(verificarHmac(Buffer.from(cuerpo), firma, 'shpss_x'), true);
  assert.equal(verificarHmac(cuerpo, firma, 'otro'), false);
  assert.equal(verificarHmac(cuerpo, 'basura', 'shpss_x'), false);
  assert.equal(verificarHmac(cuerpo, null, 'shpss_x'), false);
});

test('orden con atributos → fila', () => {
  assert.deepEqual(filaOrden(orden()), {
    order_id: '6123456789012', order_name: '#1042', created_at: '2026-11-02T15:04:05-03:00',
    test: 'precio1', grp: 'B', visitor: '0123456789abcdef', inferred: false, qa: false,
    units: 3, subtotal: 143247, discounts: 21487.05, total: 121759.95, discount_codes: [], status: 'paid',
  });
});

test('sin atributos: grupo por precio y marcada como inferida', () => {
  const f = filaOrden(orden({ note_attributes: [], line_items: [{ variant_id: 1, quantity: 1, price: '49999.00' }] }));
  assert.equal(f.grp, 'C');
  assert.equal(f.inferred, true);
  assert.equal(f.visitor, null);
});

test('órdenes que no son del test', () => {
  assert.equal(filaOrden(orden({ note_attributes: [{ name: '_ab_test', value: 'otro' }] })), null);
  assert.equal(filaOrden(orden({ note_attributes: [], line_items: [{ variant_id: 1, quantity: 1, price: '44950.00' }] })), null);
  assert.equal(grupoPorPrecio({ line_items: [] }), null);
});

test('estado: cancelada, reembolsada y QA', () => {
  assert.equal(filaOrden(orden({ cancelled_at: '2026-11-03T10:00:00-03:00' })).status, 'cancelled');
  assert.equal(filaOrden(orden({ financial_status: 'refunded', current_subtotal_price: '0.00' })).total, 0);
  assert.equal(filaOrden(orden({ note_attributes: [...orden().note_attributes, { name: '_ab_qa', value: '1' }] })).qa, true);
});

test('etiquetas sin duplicar (webhook repetido o orders/updated)', () => {
  const f = filaOrden(orden());
  assert.deepEqual(etiquetasPara(f, ''), ['ab-precio1-B']);
  assert.deepEqual(etiquetasPara(f, 'vip, ab-precio1-B'), []);
  assert.deepEqual(etiquetasPara({ ...f, qa: true, inferred: true }, 'ab-precio1-B'), ['ab-qa', 'ab-inferido']);
});
```

Run: `npm test`
Expected: FAIL — no existe `api/_lib/ordenes.mjs`.

- [ ] **Step 2: `api/_lib/ordenes.mjs`**

```js
/* Órdenes del test A/B: firma del webhook, grupo y fila para ab_orders.
   Ingreso = mercadería neta de descuentos y reembolsos (current_subtotal_price), sin envío. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import AB from '../../ab.js';

export function verificarHmac(cuerpo, firma, secreto) {
  if (!firma || !secreto) return false;
  const esperada = createHmac('sha256', secreto).update(cuerpo).digest();
  const recibida = Buffer.from(String(firma), 'base64');
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada);
}

function atributo(orden, clave) {
  const a = (orden.note_attributes || []).find((x) => x.name === clave);
  return a ? String(a.value) : null;
}

/* Para órdenes sin atributos: el precio unitario de las líneas dice el grupo. */
export function grupoPorPrecio(orden) {
  const { grupos } = AB.CONFIG;
  for (const li of orden.line_items || []) {
    const precio = Math.round(Number(li.price));
    const g = Object.keys(grupos).find((k) => grupos[k].precio === precio);
    if (g) return g;
  }
  return null;
}

export function estadoOrden(orden) {
  if (orden.cancelled_at) return 'cancelled';
  return orden.financial_status || 'pending';
}

/* Fila para ab_orders, o null si la orden no es del test. */
export function filaOrden(orden) {
  const { CONFIG } = AB;
  const test = atributo(orden, '_ab_test');
  if (test && test !== CONFIG.test) return null;
  let grp = atributo(orden, '_ab_group');
  let inferred = false;
  if (!test || !grp || !Object.hasOwn(CONFIG.grupos, grp)) {
    if (!CONFIG.activo) return null;
    grp = grupoPorPrecio(orden);
    inferred = true;
  }
  if (!grp) return null;
  return {
    order_id: String(orden.id),
    order_name: orden.name || null,
    created_at: orden.created_at,
    test: CONFIG.test,
    grp,
    visitor: atributo(orden, '_ab_visitor'),
    inferred,
    qa: atributo(orden, '_ab_qa') === '1',
    units: (orden.line_items || []).reduce((s, li) => s + (Number(li.quantity) || 0), 0),
    subtotal: Number(orden.total_line_items_price) || 0,
    discounts: Number(orden.total_discounts) || 0,
    total: Number(orden.current_subtotal_price ?? orden.subtotal_price) || 0,
    discount_codes: (orden.discount_codes || []).map((d) => d.code),
    status: estadoOrden(orden),
  };
}

/* Tags a agregar, sin repetir los que la orden ya tiene. */
export function etiquetasPara(fila, tagsActuales) {
  const actuales = String(tagsActuales || '').split(',').map((t) => t.trim());
  const quiero = [`ab-${fila.test}-${fila.grp}`];
  if (fila.qa) quiero.push('ab-qa');
  if (fila.inferred) quiero.push('ab-inferido');
  return quiero.filter((t) => !actuales.includes(t));
}
```

- [ ] **Step 3: `api/ab/order.mjs`**

```js
/* POST /api/ab/order — webhooks orders/create y orders/updated de Shopify.
   Guarda (o actualiza) la orden en ab_orders y le pone el tag del grupo.
   Si algo falla responde 500 y Shopify reintenta; todo es idempotente. */
import { verificarHmac, filaOrden, etiquetasPara } from '../_lib/ordenes.mjs';
import { adminGql, sinErrores } from '../_lib/shopify.mjs';
import { db } from '../_lib/db.mjs';

const M_TAGS = `mutation Etiquetar($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
}`;

export async function POST(request) {
  const crudo = Buffer.from(await request.arrayBuffer());
  if (!verificarHmac(crudo, request.headers.get('x-shopify-hmac-sha256'), process.env.SHOPIFY_CLIENT_SECRET)) {
    return new Response('firma inválida', { status: 401 });
  }
  let orden;
  try { orden = JSON.parse(crudo.toString('utf8')); } catch { return new Response(null, { status: 400 }); }

  const fila = filaOrden(orden);
  if (!fila) return new Response(null, { status: 200 });

  await guardar(fila);
  const nuevas = etiquetasPara(fila, orden.tags);
  if (nuevas.length) {
    const r = await adminGql(M_TAGS, { id: `gid://shopify/Order/${fila.order_id}`, tags: nuevas });
    sinErrores(r.tagsAdd, 'tagsAdd');
  }
  return new Response(null, { status: 200 });
}

async function guardar(f) {
  await db()`insert into ab_orders
    (order_id, order_name, created_at, test, grp, visitor, inferred, qa, units, subtotal, discounts, total, discount_codes, status)
    values (${f.order_id}, ${f.order_name}, ${f.created_at}, ${f.test}, ${f.grp}, ${f.visitor}, ${f.inferred}, ${f.qa},
            ${f.units}, ${f.subtotal}, ${f.discounts}, ${f.total}, ${f.discount_codes}, ${f.status})
    on conflict (order_id) do update set
      status = excluded.status, total = excluded.total, discounts = excluded.discounts,
      units = excluded.units, updated_at = now()`;
}
```

- [ ] **Step 4: Comando `webhooks` en el script**

En `scripts/ab-shopify.mjs`, antes de `const [comando, arg]`, agregar:
```js
const M_WEBHOOK = `mutation Webhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
    webhookSubscription { id topic uri }
    userErrors { field message }
  }
}`;

async function webhooks() {
  const { webhookSubscriptions } = await adminGql(Q_WEBHOOKS);
  for (const topic of ['ORDERS_CREATE', 'ORDERS_UPDATED']) {
    if (webhookSubscriptions.nodes.some((w) => w.topic === topic && w.uri === WEBHOOK_URI)) {
      console.log(topic, 'ya estaba');
      continue;
    }
    const r = sinErrores((await adminGql(M_WEBHOOK, { topic, sub: { uri: WEBHOOK_URI, format: 'JSON' } })).webhookSubscriptionCreate,
      'webhookSubscriptionCreate');
    console.log(topic, '→', r.webhookSubscription.uri);
  }
}
```
y sumar `webhooks,` al objeto `comandos`. (Se corre recién en Task 17, con el endpoint publicado.)

- [ ] **Step 5: Correr y ver que pasa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/_lib/ordenes.mjs api/ab/order.mjs tests/ordenes.test.mjs scripts/ab-shopify.mjs
git commit -m "Test A/B: webhook de órdenes que etiqueta y guarda cada orden"
```

---

### Task 12: Stock de los duplicados (solo si Task 3 eligió `duplicado`)

Si la decisión fue **pack**, saltear esta tarea: Shopify descuenta el stock del original solo.

**Files:**
- Modify: `api/_lib/ordenes.mjs`, `api/ab/order.mjs`, `tests/ordenes.test.mjs`

**Interfaces:**
- Consumes: `AB.CONFIG.grupos[g].variantes` (Task 4).
- Produces: `ajustesStock(orden): Array<{ original: string, cantidad: number }>`.

- [ ] **Step 1: Test que falla**

Agregar a `tests/ordenes.test.mjs`:
```js
import AB from '../ab.js';
import { ajustesStock } from '../api/_lib/ordenes.mjs';

test('stock: las líneas de duplicados descuentan de la variante original', () => {
  const { grupos } = AB.CONFIG;
  const num = (gid) => Number(gid.split('/').pop());
  const o = { line_items: [
    { variant_id: num(grupos.B.variantes.bf), quantity: 2 },
    { variant_id: num(grupos.B.variantes.cp), quantity: 1 },
    { variant_id: num(grupos.A.variantes.bf), quantity: 5 },
  ] };
  assert.deepEqual(ajustesStock(o), [
    { original: grupos.A.variantes.bf, cantidad: 2 },
    { original: grupos.A.variantes.cp, cantidad: 1 },
  ]);
});
```

Run: `npm test`
Expected: FAIL — `ajustesStock` no existe.

- [ ] **Step 2: Implementar en `api/_lib/ordenes.mjs`**

```js
/* Duplicados: no controlan stock; cada unidad vendida se descuenta de la variante original. */
export function ajustesStock(orden) {
  const { CONFIG } = AB;
  const control = CONFIG.grupos[CONFIG.control].variantes;
  const original = {};
  for (const [g, grupo] of Object.entries(CONFIG.grupos)) {
    if (g === CONFIG.control) continue;
    for (const [sabor, gid] of Object.entries(grupo.variantes)) original[gid.split('/').pop()] = control[sabor];
  }
  return (orden.line_items || [])
    .filter((li) => original[String(li.variant_id)])
    .map((li) => ({ original: original[String(li.variant_id)], cantidad: Number(li.quantity) || 0 }));
}
```

- [ ] **Step 3: Usarlo en `api/ab/order.mjs` solo en `orders/create`**

Agregar al import: `import { verificarHmac, filaOrden, etiquetasPara, ajustesStock } from '../_lib/ordenes.mjs';` y las consultas:
```js
const Q_STOCK = `query StockOriginal($id: ID!) {
  productVariant(id: $id) {
    inventoryItem { id inventoryLevels(first: 1) { nodes { location { id } } } }
  }
}`;
const M_STOCK = `mutation Stock($input: InventoryAdjustQuantitiesInput!, $key: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
    userErrors { field message }
  }
}`;

async function descontarStock(orden) {
  for (const { original, cantidad } of ajustesStock(orden)) {
    const { productVariant } = await adminGql(Q_STOCK, { id: original });
    const item = productVariant.inventoryItem;
    const input = {
      name: 'available',
      reason: 'correction',
      referenceDocumentUri: `gid://shopify/Order/${orden.id}`,
      changes: [{ inventoryItemId: item.id, locationId: item.inventoryLevels.nodes[0].location.id, delta: -cantidad, changeFromQuantity: null }],
    };
    const r = await adminGql(M_STOCK, { input, key: `ab-stock-${orden.id}-${original.split('/').pop()}` });
    sinErrores(r.inventoryAdjustQuantities, 'inventoryAdjustQuantities');
  }
}
```
y en `POST`, después de `await guardar(fila);`:
```js
  if (request.headers.get('x-shopify-topic') === 'orders/create') await descontarStock(orden);
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/ordenes.mjs api/ab/order.mjs tests/ordenes.test.mjs
git commit -m "Test A/B: las ventas de duplicados descuentan stock del original"
```

---

### Task 13: Pixel del checkout

**Files:**
- Create: `shopify/ab-pixel.js`

**Interfaces:**
- Consumes: atributos `_ab_test`, `_ab_group`, `_ab_visitor` del carrito (Task 8); `POST /api/ab/event` (Task 10).
- Produces: eventos `checkout_iniciado`, `pago_ingresado`, `compra` (con `oid` y `val`).

- [ ] **Step 1: Escribir el pixel**

`shopify/ab-pixel.js`:
```js
/* Pixel personalizado del test A/B de precio.
   Se pega en Shopify: Configuración → Eventos de clientes → Agregar pixel personalizado
   ("Power Rush AB"). Este archivo es la copia versionada; si cambia, volver a pegarlo.
   Lee el grupo de los atributos del carrito y manda el evento a la web. */
const ENDPOINT = 'https://www.powerrush.com.ar/api/ab/event';
const EVENTOS = {
  checkout_started: 'checkout_iniciado',
  payment_info_submitted: 'pago_ingresado',
  checkout_completed: 'compra',
};

function atributo(checkout, clave) {
  const a = (checkout.attributes || []).find((x) => x.key === clave);
  return a ? a.value : null;
}

Object.keys(EVENTOS).forEach((nombre) => {
  analytics.subscribe(nombre, (event) => {
    const checkout = event.data && event.data.checkout;
    if (!checkout || !atributo(checkout, '_ab_test')) return;
    const cuerpo = {
      t: atributo(checkout, '_ab_test'),
      g: atributo(checkout, '_ab_group'),
      v: atributo(checkout, '_ab_visitor'),
      e: EVENTOS[nombre],
      p: 'checkout',
      q: (checkout.lineItems || []).reduce((s, l) => s + (l.quantity || 0), 0),
      val: checkout.subtotalPrice ? Number(checkout.subtotalPrice.amount) : null,
      oid: checkout.order && checkout.order.id ? String(checkout.order.id) : null,
    };
    fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(cuerpo), keepalive: true, mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } });
  });
});
```

- [ ] **Step 2: Instalarlo en Shopify (después del deploy de Task 17)**

Admin de Shopify → Configuración → Eventos de clientes → Agregar pixel personalizado → nombre `Power Rush AB` → pegar el contenido de `shopify/ab-pixel.js` → Guardar → Conectar. Dejar los permisos de privacidad por defecto (la tienda no tiene banner de consentimiento). Lo puede hacer Marcos o el agente desde el navegador con la sesión de Marcos.

- [ ] **Step 3: Commit**

```bash
git add shopify/ab-pixel.js
git commit -m "Test A/B: pixel del checkout que manda checkout iniciado, pago y compra"
```

---

### Task 14: Estadística del informe

**Files:**
- Create: `api/_lib/estadistica.mjs`, `tests/estadistica.test.mjs`

**Interfaces:**
- Produces: `rng(semilla): () => number`, `beta(a, b, r): number`, `binomial(n, p, r): number`, `probGanaConversion({ exitos, n }, { exitos, n }, { sorteos?, semilla? }): number`, `bootstrapRpv({ visitantes, ingresos: number[] }, { visitantes, ingresos }, { iteraciones?, semilla? }): { prob: number, dif: [number, number] }`, `srm(conteos: number[], pesos: number[]): { chi2: number, p: number }`.

- [ ] **Step 1: Test que falla**

`tests/estadistica.test.mjs`:
```js
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
```

Run: `npm test`
Expected: FAIL — no existe el módulo.

- [ ] **Step 2: Implementar `api/_lib/estadistica.mjs`**

```js
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
```

- [ ] **Step 3: Correr y ver que pasa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add api/_lib/estadistica.mjs tests/estadistica.test.mjs
git commit -m "Test A/B: estadística del informe (conversión, ingreso por visitante, reparto)"
```

---

### Task 15: `/api/ab/report` — informe protegido por la sesión de Shopify

**Files:**
- Create: `api/_lib/sesion.mjs`, `api/_lib/informe.mjs`, `api/ab/report.mjs`, `tests/sesion.test.mjs`, `tests/informe.test.mjs`

**Interfaces:**
- Consumes: `estadistica.mjs` (Task 14), `db` (Task 9), `SHOP` (Task 1), `AB.CONFIG`.
- Produces: `verificarSesion(token, { secreto, clientId, shop, ahora? }): object|null`; `leerDatos(sql, test): Promise<{ embudo, ordenes, porDispositivo, porOrigen, errores }>`; `armarInforme(datos, CONFIG, ahora?): Informe`; `aCsv(informe): string`. `GET /api/ab/report` (JSON) y `GET /api/ab/report?formato=csv`, ambos con `Authorization: Bearer <token de sesión>`.
- Forma de `Informe`: `{ test, generado, control, grupos: [{ id, precio, visitantes, agregaron, fueronCheckout, iniciaronCheckout, compradores, ordenes, inferidas, unidades, ingreso, tasaCarrito, tasaCheckout, conversion, ticket, unidadesPorOrden, rpv, vsControl: null | { probConversion, probRpv, difRpv } }], reparto: { chi2, p, alarma }, errores: { [evento]: n }, porDispositivo: [{ grupo, segmento, visitantes, compradores, ingreso, conversion, rpv }], porOrigen: [igual] }`.

- [ ] **Step 1: Tests que fallan**

`tests/sesion.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verificarSesion } from '../api/_lib/sesion.mjs';

const OPC = { secreto: 'shpss_prueba', clientId: 'cliente123', shop: '6q1n8a-jw', ahora: 1_800_000_000 };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(payload = {}, { alg = 'HS256', secreto = OPC.secreto } = {}) {
  const cuerpo = {
    iss: 'https://6q1n8a-jw.myshopify.com/admin', dest: 'https://6q1n8a-jw.myshopify.com', aud: 'cliente123',
    sub: '42', exp: OPC.ahora + 60, nbf: OPC.ahora - 1, iat: OPC.ahora - 1, ...payload,
  };
  const h = b64({ alg, typ: 'JWT' }), p = b64(cuerpo);
  return `${h}.${p}.${createHmac('sha256', secreto).update(`${h}.${p}`).digest('base64url')}`;
}

test('token válido', () => assert.equal(verificarSesion(token(), OPC).sub, '42'));
test('firma de otro secreto', () => assert.equal(verificarSesion(token({}, { secreto: 'otro' }), OPC), null));
test('otra app', () => assert.equal(verificarSesion(token({ aud: 'otra' }), OPC), null));
test('otra tienda', () => assert.equal(verificarSesion(token({ dest: 'https://otra.myshopify.com' }), OPC), null));
test('vencido', () => assert.equal(verificarSesion(token({ exp: OPC.ahora - 10 }), OPC), null));
test('todavía no vale', () => assert.equal(verificarSesion(token({ nbf: OPC.ahora + 60 }), OPC), null));
test('alg distinto', () => assert.equal(verificarSesion(token({}, { alg: 'none' }), OPC), null));
test('basura', () => {
  assert.equal(verificarSesion('', OPC), null);
  assert.equal(verificarSesion('a.b', OPC), null);
  assert.equal(verificarSesion('a.b.c', OPC), null);
});
```

`tests/informe.test.mjs`:
```js
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
```

Run: `npm test`
Expected: FAIL — no existen los módulos.

- [ ] **Step 2: `api/_lib/sesion.mjs`**

```js
/* Token de sesión de Shopify (App Bridge, shopify.idToken()): JWT HS256 firmado con el
   client secret de la app. Devuelve el payload si es válido para esta app y esta tienda. */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verificarSesion(token, { secreto, clientId, shop, ahora = Math.floor(Date.now() / 1000) }) {
  const partes = String(token || '').split('.');
  if (partes.length !== 3 || !secreto) return null;
  const [h, p, firma] = partes;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;
  const esperada = createHmac('sha256', secreto).update(`${h}.${p}`).digest();
  const recibida = Buffer.from(firma, 'base64url');
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return null;
  if (payload.aud !== clientId) return null;
  if (payload.dest !== `https://${shop}.myshopify.com`) return null;
  if (typeof payload.exp !== 'number' || ahora > payload.exp + 5) return null;
  if (typeof payload.nbf === 'number' && ahora < payload.nbf - 5) return null;
  return payload;
}
```

- [ ] **Step 3: `api/_lib/informe.mjs`**

```js
/* Informe del test A/B: lectura de la base y cálculo de métricas por grupo.
   Excluye a los visitantes del equipo y de QA (por cualquier evento o orden marcada). */
import { probGanaConversion, bootstrapRpv, srm } from './estadistica.mjs';

const EXCL = `excl as (
  select distinct visitor from ab_events where test = $1 and excluded is not null
  union
  select visitor from ab_orders where test = $1 and qa and visitor is not null
)`;

function segmentoSql(columna) {   // columna fija: 'device' o 'source'
  return `with ${EXCL},
    primera as (
      select distinct on (visitor) visitor, grp, coalesce(${columna}, 'desconocido') as segmento
      from ab_events
      where test = $1 and event = 'vista'
        and not exists (select 1 from excl where excl.visitor = ab_events.visitor)
      order by visitor, at
    ),
    compras as (
      select visitor, sum(total) as ingreso from ab_orders
      where test = $1 and not qa and status <> 'cancelled' and visitor is not null
      group by visitor
    )
    select p.grp, p.segmento, count(*)::int as visitantes, count(c.visitor)::int as compradores,
           coalesce(sum(c.ingreso), 0) as ingreso
    from primera p left join compras c on c.visitor = p.visitor
    group by p.grp, p.segmento
    order by p.grp, visitantes desc`;
}

export async function leerDatos(sql, test) {
  const [embudo, ordenes, porDispositivo, porOrigen, errores] = await Promise.all([
    sql.query(`with ${EXCL}
      select grp,
        count(distinct visitor) filter (where event = 'vista')::int as visitantes,
        count(distinct visitor) filter (where event = 'agregar_carrito')::int as agregaron,
        count(distinct visitor) filter (where event = 'clic_comprar')::int as fueron_checkout,
        count(distinct visitor) filter (where event = 'checkout_iniciado')::int as iniciaron_checkout
      from ab_events
      where test = $1 and not exists (select 1 from excl where excl.visitor = ab_events.visitor)
      group by grp`, [test]),
    sql.query(`with ${EXCL}
      select grp, visitor, total, units, inferred from ab_orders
      where test = $1 and not qa and status <> 'cancelled'
        and not exists (select 1 from excl where excl.visitor = ab_orders.visitor)`, [test]),
    sql.query(segmentoSql('device'), [test]),
    sql.query(segmentoSql('source'), [test]),
    sql.query(`select event, count(*)::int as n from ab_events
      where test = $1 and event in ('error_precio', 'error_config', 'error_checkout') group by event`, [test]),
  ]);
  return { embudo, ordenes, porDispositivo, porOrigen, errores };
}

const tasa = (a, b) => (b ? Number(a || 0) / b : null);

function segmentos(filas) {
  return filas.map((s) => {
    const visitantes = Number(s.visitantes), ingreso = Number(s.ingreso), compradores = Number(s.compradores);
    return { grupo: s.grp, segmento: s.segmento, visitantes, compradores, ingreso, conversion: tasa(compradores, visitantes), rpv: tasa(ingreso, visitantes) };
  });
}

export function armarInforme(datos, CONFIG, ahora = new Date()) {
  const ids = Object.keys(CONFIG.grupos);
  const grupos = ids.map((id) => {
    const e = datos.embudo.find((x) => x.grp === id) || {};
    const ords = datos.ordenes.filter((o) => o.grp === id);
    const porVisitante = new Map();
    ords.forEach((o, i) => {
      const k = o.visitor || `orden-${i}`;
      porVisitante.set(k, (porVisitante.get(k) || 0) + Number(o.total));
    });
    const visitantes = Number(e.visitantes) || 0;
    const ingreso = Math.round(ords.reduce((s, o) => s + Number(o.total), 0) * 100) / 100;
    const unidades = ords.reduce((s, o) => s + Number(o.units), 0);
    return {
      id, precio: CONFIG.grupos[id].precio, visitantes,
      agregaron: Number(e.agregaron) || 0, fueronCheckout: Number(e.fueron_checkout) || 0, iniciaronCheckout: Number(e.iniciaron_checkout) || 0,
      compradores: porVisitante.size, ordenes: ords.length, inferidas: ords.filter((o) => o.inferred).length,
      unidades, ingreso,
      tasaCarrito: tasa(e.agregaron, visitantes), tasaCheckout: tasa(e.fueron_checkout, visitantes),
      conversion: tasa(porVisitante.size, visitantes),
      ticket: ords.length ? ingreso / ords.length : null,
      unidadesPorOrden: ords.length ? unidades / ords.length : null,
      rpv: tasa(ingreso, visitantes),
      ingresos: [...porVisitante.values()],
    };
  });

  const control = grupos.find((g) => g.id === CONFIG.control);
  for (const g of grupos) {
    if (g === control || !control.visitantes || !g.visitantes) { g.vsControl = null; continue; }
    const conBootstrap = control.compradores > 0 && g.compradores > 0;
    const b = conBootstrap ? bootstrapRpv({ visitantes: control.visitantes, ingresos: control.ingresos }, { visitantes: g.visitantes, ingresos: g.ingresos }) : null;
    g.vsControl = {
      probConversion: probGanaConversion({ exitos: control.compradores, n: control.visitantes }, { exitos: g.compradores, n: g.visitantes }),
      probRpv: b ? b.prob : null,
      difRpv: b ? b.dif : null,
    };
  }
  for (const g of grupos) delete g.ingresos;

  const visitantes = grupos.map((g) => g.visitantes);
  const reparto = srm(visitantes, ids.map((id) => CONFIG.grupos[id].peso));
  return {
    test: CONFIG.test,
    generado: ahora.toISOString(),
    control: CONFIG.control,
    grupos,
    reparto: { ...reparto, alarma: reparto.p < 0.01 && visitantes.reduce((s, v) => s + v, 0) >= 300 },
    errores: Object.fromEntries(datos.errores.map((e) => [e.event, Number(e.n)])),
    porDispositivo: segmentos(datos.porDispositivo),
    porOrigen: segmentos(datos.porOrigen),
  };
}

export function aCsv(informe) {
  const cab = ['grupo', 'precio', 'visitantes', 'agregaron', 'fueron_checkout', 'iniciaron_checkout', 'compradores', 'ordenes', 'inferidas', 'unidades', 'ingreso', 'conversion', 'rpv', 'prob_rpv', 'prob_conversion'];
  const val = (v) => (v == null ? '' : String(v));
  const filas = informe.grupos.map((g) => [
    g.id, g.precio, g.visitantes, g.agregaron, g.fueronCheckout, g.iniciaronCheckout, g.compradores, g.ordenes, g.inferidas,
    g.unidades, g.ingreso, g.conversion, g.rpv, g.vsControl && g.vsControl.probRpv, g.vsControl && g.vsControl.probConversion,
  ].map(val).join(','));
  return [cab.join(','), ...filas].join('\n');
}
```

- [ ] **Step 4: `api/ab/report.mjs`**

```js
/* GET /api/ab/report — informe del test para la app embebida en el admin de Shopify.
   Solo responde con un token de sesión válido de la app (Authorization: Bearer …). */
import AB from '../../ab.js';
import { verificarSesion } from '../_lib/sesion.mjs';
import { leerDatos, armarInforme, aCsv } from '../_lib/informe.mjs';
import { db } from '../_lib/db.mjs';
import { SHOP } from '../_lib/shopify.mjs';

export async function GET(request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const sesion = verificarSesion(token, {
    secreto: process.env.SHOPIFY_CLIENT_SECRET, clientId: process.env.SHOPIFY_CLIENT_ID, shop: SHOP,
  });
  if (!sesion) return new Response('No autorizado', { status: 401 });

  const informe = armarInforme(await leerDatos(db(), AB.CONFIG.test), AB.CONFIG);
  if (new URL(request.url).searchParams.get('formato') === 'csv') {
    return new Response(aCsv(informe), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="ab-${AB.CONFIG.test}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  return Response.json(informe, { headers: { 'Cache-Control': 'no-store' } });
}
```

- [ ] **Step 5: Correr y ver que pasa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Probar las consultas contra la base real**

Run:
```bash
node --env-file=.env.vercel.local --input-type=module -e "
import AB from './ab.js';
import { db } from './api/_lib/db.mjs';
import { leerDatos, armarInforme } from './api/_lib/informe.mjs';
console.log(JSON.stringify(armarInforme(await leerDatos(db(), AB.CONFIG.test), AB.CONFIG), null, 2).slice(0, 800));"
```
Expected: JSON con tres grupos en 0 y `reparto.p: 1` (base vacía); sin errores de SQL.

- [ ] **Step 7: Commit**

```bash
git add api/_lib/sesion.mjs api/_lib/informe.mjs api/ab/report.mjs tests/sesion.test.mjs tests/informe.test.mjs
git commit -m "Test A/B: informe por grupo con token de sesión de Shopify"
```

---

### Task 16: Pantalla de resultados dentro del admin de Shopify

**Files:**
- Create: `app.html`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `GET /api/ab/report` (Task 15); App Bridge (`shopify.idToken()`).
- Produces: `/app`, cargada por Shopify en Apps → Power Rush AB.

- [ ] **Step 1: `app.html`**

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="shopify-api-key" content="3864182d8cf8df067fb0e1d5df5a6044">
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <script src="https://cdn.shopify.com/shopifycloud/polaris-1.js"></script>
  <title>Power Rush AB</title>
</head>
<body>
  <s-page heading="Test de precio">
    <s-button slot="primary-action" id="csv">Descargar CSV</s-button>
    <div id="alertas"></div>
    <s-section heading="Resultados por grupo">
      <div id="tabla"><s-spinner accessibilityLabel="Cargando"></s-spinner></div>
    </s-section>
    <s-section heading="Por dispositivo"><div id="dispositivo"></div></s-section>
    <s-section heading="Por origen del tráfico"><div id="origen"></div></s-section>
    <s-section heading="Cómo leerlo">
      <s-paragraph>La métrica principal es el ingreso por visitante: un precio más alto baja la conversión, y lo que importa es cuánta plata deja cada persona que entra.</s-paragraph>
      <s-paragraph>"Prob. de ganarle al control" arriba de 95% es una señal fuerte; cerca de 50% todavía no hay diferencia. No cortar antes de 2 semanas completas.</s-paragraph>
      <s-text color="subdued">Excluye al equipo, las compras de prueba y los bots. Ingreso = mercadería neta de descuentos y reembolsos, sin envío.</s-text>
    </s-section>
  </s-page>
  <script>
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const pesos = (n) => n == null ? '—' : (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('es-AR');
    const pct = (n) => n == null ? '—' : (n * 100).toLocaleString('es-AR', { maximumFractionDigits: 2 }) + '%';
    const num = (n) => n == null ? '—' : Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 });
    const prob = (p) => p == null ? '—' : `<s-badge tone="${p >= 0.95 ? 'success' : p <= 0.05 ? 'critical' : 'neutral'}">${pct(p)}</s-badge>`;

    function tabla(cabeceras, filas) {
      return '<s-table><s-table-header-row>' +
        cabeceras.map((c, i) => `<s-table-header${i ? ' format="numeric"' : ''}>${esc(c)}</s-table-header>`).join('') +
        '</s-table-header-row><s-table-body>' +
        filas.map((f) => '<s-table-row>' + f.map((c) => `<s-table-cell>${c}</s-table-cell>`).join('') + '</s-table-row>').join('') +
        '</s-table-body></s-table>';
    }
    function banner(tono, titulo, texto) {
      return `<s-banner tone="${tono}" heading="${esc(titulo)}"><s-paragraph>${esc(texto)}</s-paragraph></s-banner>`;
    }

    async function api(formato) {
      const token = await shopify.idToken();
      const res = await fetch('/api/ab/report' + (formato ? '?formato=' + formato : ''), { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error('El informe respondió ' + res.status);
      return res;
    }

    function render(inf) {
      const G = inf.grupos;
      const fila = (nombre, f) => [esc(nombre), ...G.map(f)];
      $('tabla').innerHTML = tabla(
        ['Métrica', ...G.map((g) => `${g.id}${g.id === inf.control ? ' (control)' : ''} · ${pesos(g.precio)}`)],
        [
          fila('Visitantes', (g) => num(g.visitantes)),
          fila('Agregan al carrito', (g) => pct(g.tasaCarrito)),
          fila('Van al checkout', (g) => pct(g.tasaCheckout)),
          fila('Compran (conversión)', (g) => pct(g.conversion)),
          fila('Órdenes', (g) => num(g.ordenes) + (g.inferidas ? ` (${g.inferidas} inferidas)` : '')),
          fila('Unidades por orden', (g) => num(g.unidadesPorOrden)),
          fila('Ticket promedio', (g) => pesos(g.ticket)),
          fila('Ingreso', (g) => pesos(g.ingreso)),
          fila('Ingreso por visitante', (g) => pesos(g.rpv)),
          fila('Prob. de ganarle al control (ingreso por visitante)', (g) => g.vsControl ? prob(g.vsControl.probRpv) : '—'),
          fila('Diferencia de ingreso por visitante (95%)', (g) => g.vsControl && g.vsControl.difRpv ? `${pesos(g.vsControl.difRpv[0])} a ${pesos(g.vsControl.difRpv[1])}` : '—'),
          fila('Prob. de ganarle al control (conversión)', (g) => g.vsControl ? prob(g.vsControl.probConversion) : '—'),
        ]);
      const seg = (lista) => lista.length
        ? tabla(['Grupo', 'Segmento', 'Visitantes', 'Conversión', 'Ingreso por visitante'],
            lista.map((s) => [esc(s.grupo), esc(s.segmento), num(s.visitantes), pct(s.conversion), pesos(s.rpv)]))
        : '<s-paragraph>Todavía no hay datos.</s-paragraph>';
      $('dispositivo').innerHTML = seg(inf.porDispositivo);
      $('origen').innerHTML = seg(inf.porOrigen);

      const alertas = [];
      if (inf.reparto.alarma) alertas.push(banner('critical', 'Reparto desparejo', 'Los visitantes no se reparten según los pesos del test (p = ' + inf.reparto.p.toExponential(1) + '). Revisar la asignación antes de sacar conclusiones.'));
      const errores = Object.entries(inf.errores);
      if (errores.length) alertas.push(banner('warning', 'Errores registrados', errores.map(([e, n]) => `${e}: ${n}`).join(' · ')));
      $('alertas').innerHTML = alertas.join('');
    }

    api().then((r) => r.json()).then(render).catch((e) => {
      $('tabla').innerHTML = banner('critical', 'No se pudo cargar el informe', e.message);
    });

    $('csv').addEventListener('click', async () => {
      try {
        const blob = await (await api('csv')).blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'ab-test-precio.csv';
        a.click();
      } catch (e) {
        shopify.toast.show('No se pudo descargar el CSV', { isError: true });
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Header para que solo el admin de Shopify la muestre**

`vercel.json` (agregar `headers`, el resto igual):
```json
{
  "cleanUrls": true,
  "trailingSlash": false,
  "redirects": [
    { "source": "/product.html", "destination": "/products/powerrush", "permanent": true },
    { "source": "/product", "destination": "/products/powerrush", "permanent": true }
  ],
  "headers": [
    {
      "source": "/app",
      "headers": [
        { "key": "Content-Security-Policy", "value": "frame-ancestors https://6q1n8a-jw.myshopify.com https://admin.shopify.com;" }
      ]
    }
  ]
}
```

- [ ] **Step 3: Validar el markup de Polaris**

Pasar el HTML de `<s-page>…</s-page>` y los fragmentos que arma `render` por el validador de Shopify (`polaris-app-home`, `language: html`).
Expected: válido.

- [ ] **Step 4: Configurar la app en el Dev Dashboard (lo hace quien tenga acceso)**

En dev.shopify.com → Power Rush AB → nueva versión:
- **App URL**: `https://www.powerrush.com.ar/app`
- **Embed app in Shopify admin**: activado
- **Access scopes**: solo `read_products, write_products, read_orders, write_orders, read_discounts, read_publications, write_publications, read_inventory, write_inventory, read_locations`
- **Release**. Si Shopify pide aprobar la versión en la tienda, la aprueba el dueño.

- [ ] **Step 5: Commit**

```bash
git add app.html vercel.json
git commit -m "Test A/B: pantalla de resultados embebida en el admin de Shopify"
```

---

### Task 17: Publicar, QA y arranque

**Files:**
- Modify: `middleware.js` (solo el día de apertura: `ABIERTO = true`)

- [ ] **Step 1: Todo verde**

Run: `npm test`
Expected: PASS, 0 fallas.

- [ ] **Step 2: Publicar en producción (la tienda sigue cerrada al público)**

```bash
git push
DIR=$(mktemp -d)
git archive HEAD | tar -x -C "$DIR"
cp -R .vercel "$DIR"/
(cd "$DIR" && vercel deploy --prod)
```
Expected: deploy `Ready`, alias `www.powerrush.com.ar`.

- [ ] **Step 3: Humo**

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://www.powerrush.com.ar/ab.js
curl -sI https://www.powerrush.com.ar/ | grep -i -E 'set-cookie|x-matched-path'
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://www.powerrush.com.ar/api/ab/event -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' https://www.powerrush.com.ar/api/ab/report
curl -sI https://www.powerrush.com.ar/app | grep -i content-security-policy
curl -s -o /dev/null -w '%{http_code}\n' https://www.powerrush.com.ar/tests/ab.test.mjs
curl -s -o /dev/null -w '%{http_code}\n' https://www.powerrush.com.ar/node_modules/@neondatabase/serverless/package.json
```
Expected: `200 application/javascript`; sin `set-cookie: pr_ab` para el público (tienda cerrada); `204`; `401`; el header `frame-ancestors`; `404` y `404` (ni los tests ni las dependencias se publican).

- [ ] **Step 4: Webhooks y pixel**

Run: `npm run ab:shopify -- webhooks`
Expected: `ORDERS_CREATE → https://www.powerrush.com.ar/api/ab/order` y `ORDERS_UPDATED → …`.
Instalar el pixel (Task 13, Step 2).

- [ ] **Step 5: QA con el equipo (con la cookie de acceso)**

Para cada grupo, abrir `https://www.powerrush.com.ar/?ab=A`, `?ab=B`, `?ab=C`:
- la cookie `pr_ab` queda con `.qa` y dura 180 días (DevTools → Application → Cookies);
- precios correctos en home, producto (1/2/3 potes, total, barra fija), tabla por porción y carrito;
- con la red en "Slow 3G", ningún precio aparece y después cambia;
- el checkout muestra el precio del grupo, y con 2 potes, AHORROPACK.
Una compra real por grupo (equipo), después reembolsar y cancelar:
- la orden tiene tags `ab-precio1-<grupo>` y `ab-qa`;
- `ab_orders` tiene una fila por orden y el estado pasa a `cancelled`/`refunded` (webhook `orders/updated`);
- `ab_events` tiene `vista`, `agregar_carrito`, `clic_comprar`, `checkout_iniciado` y `compra` para ese visitante, con `excluded = 'qa'` en los eventos de la web;
- el stock del original bajó (pack: solo; duplicado: Task 12).
En el admin de Shopify → Apps → Power Rush AB: la pantalla carga, los tres grupos en 0 (QA excluido) y el CSV se descarga. Si la descarga queda bloqueada dentro del iframe, anotarlo y cambiar el botón para que muestre el CSV en un `s-text-area` copiable.
En Safari (iPhone): entrar, volver a los días y confirmar que el grupo es el mismo.

- [ ] **Step 6: Rotar el secreto de la app**

Dev Dashboard → App settings → Credentials → rotar el client secret. Actualizar `.env.local` y en Vercel:
```bash
vercel env rm SHOPIFY_CLIENT_SECRET production --yes && vercel env rm SHOPIFY_CLIENT_SECRET preview --yes
set -a; . ./.env.local; set +a
for entorno in production preview; do printf '%s' "$SHOPIFY_CLIENT_SECRET" | vercel env add SHOPIFY_CLIENT_SECRET "$entorno"; done
```
Volver a publicar (Step 2) y repetir el humo del webhook con una compra de prueba.

- [ ] **Step 7: Día de apertura**

- `middleware.js`: `const ABIERTO = true;`, commit, publicar (Step 2).
- Sacar la contraseña de la tienda en Shopify (bloquea también el checkout).
- A las 24–48 h: en la app, el reparto sin alarma y sin `error_precio`.
- Regla de corte: mínimo 2 semanas completas y la cantidad mínima de órdenes por grupo que defina el equipo con el tráfico de esas semanas.

```bash
git add middleware.js
git commit -m "Abre la tienda: ABIERTO = true"
```

---

## Fuera de este plan

- Terminar el test (precio ganador en el original, `activo: false` en `ab.js` y `middleware.js`, archivar packs/duplicados a los 30 días).
- `assets/product_conseccion.html`: copia vieja de la página de producto, servida públicamente con precios viejos; conviene borrarla aparte.
