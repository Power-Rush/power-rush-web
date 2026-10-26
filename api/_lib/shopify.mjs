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
