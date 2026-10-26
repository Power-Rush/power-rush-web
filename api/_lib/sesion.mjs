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
