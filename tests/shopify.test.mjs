import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, adminGql, sinErrores, _resetToken } from '../api/_lib/shopify.mjs';

process.env.SHOPIFY_CLIENT_ID = 'id-de-prueba';
process.env.SHOPIFY_CLIENT_SECRET = 'secreto-de-prueba';

function fetchFalso(llamadas) {
  return async (url, opciones) => {
    llamadas.push({ url: String(url), opciones });
    if (String(url).endsWith('/admin/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'tok-' + llamadas.length, scope: 'read_products', expires_in: 86399 }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { shop: { name: 'Mi tienda' } } }), { status: 200 });
  };
}

beforeEach(() => _resetToken());

test('pide el token con client credentials y lo reutiliza', async () => {
  const llamadas = [];
  const f = fetchFalso(llamadas);
  const data = await adminGql('{ shop { name } }', {}, { fetchImpl: f });
  await adminGql('{ shop { name } }', {}, { fetchImpl: f });
  assert.deepEqual(data, { shop: { name: 'Mi tienda' } });
  const pedidosDeToken = llamadas.filter((l) => l.url.endsWith('/admin/oauth/access_token'));
  assert.equal(pedidosDeToken.length, 1);
  const cuerpo = new URLSearchParams(pedidosDeToken[0].opciones.body);
  assert.equal(cuerpo.get('grant_type'), 'client_credentials');
  assert.equal(cuerpo.get('client_id'), 'id-de-prueba');
  const gql = llamadas.find((l) => l.url.endsWith('/admin/api/2026-01/graphql.json'));
  assert.equal(gql.opciones.headers['X-Shopify-Access-Token'], 'tok-1');
});

test('pide un token nuevo cuando el anterior está por vencer', async () => {
  const llamadas = [];
  const f = fetchFalso(llamadas);
  const t1 = await adminToken({ fetchImpl: f, ahora: 0 });
  const t2 = await adminToken({ fetchImpl: f, ahora: 86339 * 1000 - 1 });
  const t3 = await adminToken({ fetchImpl: f, ahora: 86339 * 1000 + 1 });
  assert.equal(t1, t2);
  assert.notEqual(t1, t3);
});

test('falla claro si faltan credenciales', async () => {
  const id = process.env.SHOPIFY_CLIENT_ID;
  delete process.env.SHOPIFY_CLIENT_ID;
  await assert.rejects(adminToken({ fetchImpl: fetchFalso([]) }), /SHOPIFY_CLIENT_ID/);
  process.env.SHOPIFY_CLIENT_ID = id;
});

test('sinErrores corta con los userErrors de una mutación', () => {
  assert.throws(() => sinErrores({ userErrors: [{ message: 'precio inválido' }] }, 'productSet'), /productSet: precio inválido/);
  assert.deepEqual(sinErrores({ userErrors: [], ok: 1 }, 'x'), { userErrors: [], ok: 1 });
});
