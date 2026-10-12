/* POST /api/acceso — valida la clave del formulario "Acceso" de /proximamente
   y deja la cookie que el middleware pide para mostrar el sitio completo. */
import { COOKIE, DIAS, tokenDeClave, tokenValido } from './_acceso.mjs';

export async function POST(request) {
  const form = await request.formData().catch(() => null);
  const clave = form ? String(form.get('clave') || '') : '';
  const token = clave ? await tokenDeClave(clave) : '';
  if (!(await tokenValido(token))) return volver(request, '/?acceso=error');
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
