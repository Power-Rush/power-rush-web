/* Clave de "Acceso" a la web mientras está en construcción.
   La clave no está en el código (el repo es público): la cookie es
   sha256('power-rush:' + clave) y acá solo se guarda el sha256 de la cookie.
   Para cambiar la clave, regenerar TOKEN_HASH con el mismo esquema. */
export const COOKIE = 'pr_acceso';
export const DIAS = 30;
const TOKEN_HASH = 'ad72e08697c21c5ddba8d95539f4810f9e92158c1f55b50e25349ef408b48ad6';

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function tokenDeClave(clave) {
  return sha256('power-rush:' + clave);
}

export async function tokenValido(token) {
  return /^[a-f0-9]{64}$/.test(token || '') && (await sha256(token)) === TOKEN_HASH;
}
