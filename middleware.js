/* ===========================================================================
   POWER RUSH — Portada "en construcción" hasta que abra la tienda
   Mientras ABIERTO = false, cualquier página muestra /proximamente (la URL no
   cambia). El equipo entra al sitio completo con la clave desde "Acceso":
   /api/acceso la valida y deja una cookie por 30 días (ver api/_acceso.mjs).
   El día que abre la tienda: ABIERTO = true (o borrar este archivo).
   =========================================================================== */
import { COOKIE, tokenValido } from './api/_acceso.mjs';

const ABIERTO = false;

export const config = {
  runtime: 'nodejs',
  // solo páginas; imágenes, scripts, íconos, /api y la propia portada pasan directo
  matcher: ['/((?!api/|assets/|proximamente|favicon|apple-touch-icon|web-app-manifest|site\\.webmanifest|cart\\.js|reviews\\.js).*)'],
};

export default async function middleware(request) {
  if (ABIERTO) return next();
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (m && (await tokenValido(m[1]))) return next();
  return rewrite(new URL('/proximamente', request.url));
}

/* Lo mismo que next() y rewrite() de @vercel/functions, sin sumar dependencias
   a un sitio estático que no tiene package.json. */
function next() {
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}
function rewrite(dest) {
  return new Response(null, { headers: { 'x-middleware-rewrite': dest.toString() } });
}
