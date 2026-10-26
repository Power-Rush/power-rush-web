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
