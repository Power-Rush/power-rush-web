/* ===========================================================================
   POWER RUSH — Portada "en construcción" hasta que abra la tienda
   Mientras ABIERTO = false, cualquier página muestra /proximamente (la URL no
   cambia). El equipo entra al sitio completo con la clave desde "Acceso":
   /api/acceso la valida y deja una cookie por 30 días.
   El día que abre la tienda: ABIERTO = true (o borrar este archivo).

   La clave no está en el código (el repo es público): la cookie es
   sha256('power-rush:' + clave) y acá solo se guarda el sha256 de la cookie.
   Para cambiar la clave, regenerar TOKEN_HASH acá y en api/acceso.mjs.
   Sin imports a propósito: Vercel compila este archivo como CommonJS.
   =========================================================================== */
const ABIERTO = false;
const COOKIE = 'pr_acceso';
const TOKEN_HASH = '1133fb0e866dcc5f001d96c612b2fc390b0654c934ece0d962b2621eb1a62540';

export const config = {
  runtime: 'nodejs',
  // solo páginas; imágenes, scripts, íconos, /api y la propia portada pasan directo
  matcher: ['/((?!api/|assets/|proximamente|favicon|apple-touch-icon|web-app-manifest|site\\.webmanifest|cart\\.js|reviews\\.js).*)'],
};

export default async function middleware(request) {
  if (ABIERTO) return next();
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})'));
  if (m && (await sha256(m[1])) === TOKEN_HASH) return next();
  return rewrite(new URL('/proximamente', request.url));
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* Lo mismo que next() y rewrite() de @vercel/functions, sin sumar dependencias
   a un sitio estático que no tiene package.json. */
function next() {
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}
function rewrite(dest) {
  return new Response(null, { headers: { 'x-middleware-rewrite': dest.toString() } });
}
