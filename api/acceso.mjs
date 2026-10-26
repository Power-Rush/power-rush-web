/* POST /api/acceso — valida la clave del formulario "Acceso" de /proximamente
   y deja la cookie que middleware.js pide para mostrar el sitio completo.
   La cookie es sha256('power-rush:' + clave); solo se guarda el sha256 de la cookie.
   Si cambia la clave, actualizar api/_lib/equipo.mjs y middleware.js. */
import { COOKIE, TOKEN_HASH, sha256 } from './_lib/equipo.mjs';

const DIAS = 30;

export async function POST(request) {
  const form = await request.formData().catch(() => null);
  const clave = form ? String(form.get('clave') || '') : '';
  const token = clave ? await sha256('power-rush:' + clave) : '';
  if (!token || (await sha256(token)) !== TOKEN_HASH) return volver(request, '/?acceso=error');
  return volver(request, '/', {
    'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=${DIAS * 86400}; HttpOnly; Secure; SameSite=Lax`,
  });
}

export function GET(request) {
  return volver(request, '/');
}

function volver(request, path, headers = {}) {
  return new Response(null, { status: 303, headers: { Location: new URL(path, request.url).toString(), ...headers } });
}
