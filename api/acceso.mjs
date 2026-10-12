/* POST /api/acceso — valida la clave del formulario "Acceso" de /proximamente
   y deja la cookie que middleware.js pide para mostrar el sitio completo.
   La cookie es sha256('power-rush:' + clave); acá y en middleware.js solo se
   guarda el sha256 de la cookie. Si cambia la clave, actualizar los dos. */
const COOKIE = 'pr_acceso';
const TOKEN_HASH = 'ad72e08697c21c5ddba8d95539f4810f9e92158c1f55b50e25349ef408b48ad6';
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

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function volver(request, path, headers = {}) {
  return new Response(null, { status: 303, headers: { Location: new URL(path, request.url).toString(), ...headers } });
}
