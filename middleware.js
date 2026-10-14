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
