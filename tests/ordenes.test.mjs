import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verificarHmac, filaOrden, etiquetasPara, grupoPorPrecio } from '../api/_lib/ordenes.mjs';

const orden = (cambios = {}) => ({
  id: 6123456789012, name: '#1042', created_at: '2026-11-02T15:04:05-03:00', cancelled_at: null,
  financial_status: 'paid', tags: '',
  note_attributes: [
    { name: '_ab_test', value: 'precio1' }, { name: '_ab_group', value: 'B' }, { name: '_ab_visitor', value: '0123456789abcdef' },
  ],
  line_items: [{ variant_id: 1, quantity: 2, price: '47749.00' }, { variant_id: 2, quantity: 1, price: '47749.00' }],
  total_line_items_price: '143247.00', total_discounts: '21487.05', current_subtotal_price: '121759.95',
  discount_codes: [],
  ...cambios,
});

test('firma HMAC de Shopify', () => {
  const cuerpo = JSON.stringify(orden());
  const firma = createHmac('sha256', 'shpss_x').update(cuerpo).digest('base64');
  assert.equal(verificarHmac(Buffer.from(cuerpo), firma, 'shpss_x'), true);
  assert.equal(verificarHmac(cuerpo, firma, 'otro'), false);
  assert.equal(verificarHmac(cuerpo, 'basura', 'shpss_x'), false);
  assert.equal(verificarHmac(cuerpo, null, 'shpss_x'), false);
});

test('orden con atributos → fila', () => {
  assert.deepEqual(filaOrden(orden()), {
    order_id: '6123456789012', order_name: '#1042', created_at: '2026-11-02T15:04:05-03:00',
    test: 'precio1', grp: 'B', visitor: '0123456789abcdef', inferred: false, qa: false,
    units: 3, subtotal: 143247, discounts: 21487.05, total: 121759.95, discount_codes: [], status: 'paid',
  });
});

test('sin atributos: grupo por precio y marcada como inferida', () => {
  const f = filaOrden(orden({ note_attributes: [], line_items: [{ variant_id: 1, quantity: 1, price: '49999.00' }] }));
  assert.equal(f.grp, 'C');
  assert.equal(f.inferred, true);
  assert.equal(f.visitor, null);
});

test('órdenes que no son del test', () => {
  assert.equal(filaOrden(orden({ note_attributes: [{ name: '_ab_test', value: 'otro' }] })), null);
  assert.equal(filaOrden(orden({ note_attributes: [], line_items: [{ variant_id: 1, quantity: 1, price: '44950.00' }] })), null);
  assert.equal(grupoPorPrecio({ line_items: [] }), null);
});

test('estado: cancelada, reembolsada y QA', () => {
  assert.equal(filaOrden(orden({ cancelled_at: '2026-11-03T10:00:00-03:00' })).status, 'cancelled');
  assert.equal(filaOrden(orden({ financial_status: 'refunded', current_subtotal_price: '0.00' })).total, 0);
  assert.equal(filaOrden(orden({ note_attributes: [...orden().note_attributes, { name: '_ab_qa', value: '1' }] })).qa, true);
});

test('etiquetas sin duplicar (webhook repetido o orders/updated)', () => {
  const f = filaOrden(orden());
  assert.deepEqual(etiquetasPara(f, ''), ['ab-precio1-B']);
  assert.deepEqual(etiquetasPara(f, 'vip, ab-precio1-B'), []);
  assert.deepEqual(etiquetasPara({ ...f, qa: true, inferred: true }, 'ab-precio1-B'), ['ab-qa', 'ab-inferido']);
});
