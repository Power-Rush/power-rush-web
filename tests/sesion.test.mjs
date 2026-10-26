import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verificarSesion } from '../api/_lib/sesion.mjs';

const OPC = { secreto: 'shpss_prueba', clientId: 'cliente123', shop: '6q1n8a-jw', ahora: 1_800_000_000 };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(payload = {}, { alg = 'HS256', secreto = OPC.secreto } = {}) {
  const cuerpo = {
    iss: 'https://6q1n8a-jw.myshopify.com/admin', dest: 'https://6q1n8a-jw.myshopify.com', aud: 'cliente123',
    sub: '42', exp: OPC.ahora + 60, nbf: OPC.ahora - 1, iat: OPC.ahora - 1, ...payload,
  };
  const h = b64({ alg, typ: 'JWT' }), p = b64(cuerpo);
  return `${h}.${p}.${createHmac('sha256', secreto).update(`${h}.${p}`).digest('base64url')}`;
}

test('token válido', () => assert.equal(verificarSesion(token(), OPC).sub, '42'));
test('firma de otro secreto', () => assert.equal(verificarSesion(token({}, { secreto: 'otro' }), OPC), null));
test('otra app', () => assert.equal(verificarSesion(token({ aud: 'otra' }), OPC), null));
test('otra tienda', () => assert.equal(verificarSesion(token({ dest: 'https://otra.myshopify.com' }), OPC), null));
test('vencido', () => assert.equal(verificarSesion(token({ exp: OPC.ahora - 10 }), OPC), null));
test('todavía no vale', () => assert.equal(verificarSesion(token({ nbf: OPC.ahora + 60 }), OPC), null));
test('alg distinto', () => assert.equal(verificarSesion(token({}, { alg: 'none' }), OPC), null));
test('basura', () => {
  assert.equal(verificarSesion('', OPC), null);
  assert.equal(verificarSesion('a.b', OPC), null);
  assert.equal(verificarSesion('a.b.c', OPC), null);
});
