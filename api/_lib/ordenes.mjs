/* Órdenes del test A/B: firma del webhook, grupo y fila para ab_orders.
   Ingreso = mercadería neta de descuentos y reembolsos (current_subtotal_price), sin envío. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import AB from '../../ab.js';

export function verificarHmac(cuerpo, firma, secreto) {
  if (!firma || !secreto) return false;
  const esperada = createHmac('sha256', secreto).update(cuerpo).digest();
  const recibida = Buffer.from(String(firma), 'base64');
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada);
}

function atributo(orden, clave) {
  const a = (orden.note_attributes || []).find((x) => x.name === clave);
  return a ? String(a.value) : null;
}

/* Para órdenes sin atributos: el precio unitario de las líneas dice el grupo. */
export function grupoPorPrecio(orden) {
  const { grupos } = AB.CONFIG;
  for (const li of orden.line_items || []) {
    const precio = Math.round(Number(li.price));
    const g = Object.keys(grupos).find((k) => grupos[k].precio === precio);
    if (g) return g;
  }
  return null;
}

export function estadoOrden(orden) {
  if (orden.cancelled_at) return 'cancelled';
  return orden.financial_status || 'pending';
}

/* Fila para ab_orders, o null si la orden no es del test. */
export function filaOrden(orden) {
  const { CONFIG } = AB;
  const test = atributo(orden, '_ab_test');
  if (test && test !== CONFIG.test) return null;
  let grp = atributo(orden, '_ab_group');
  let inferred = false;
  if (!test || !grp || !Object.hasOwn(CONFIG.grupos, grp)) {
    if (!CONFIG.activo) return null;
    grp = grupoPorPrecio(orden);
    inferred = true;
  }
  if (!grp) return null;
  return {
    order_id: String(orden.id),
    order_name: orden.name || null,
    created_at: orden.created_at,
    shopify_updated_at: orden.updated_at || null,
    test: CONFIG.test,
    grp,
    visitor: atributo(orden, '_ab_visitor'),
    inferred,
    qa: atributo(orden, '_ab_qa') === '1',
    units: (orden.line_items || []).reduce((s, li) => s + (Number(li.quantity) || 0), 0),
    subtotal: Number(orden.total_line_items_price) || 0,
    discounts: Number(orden.total_discounts) || 0,
    total: Number(orden.current_subtotal_price ?? orden.subtotal_price) || 0,
    discount_codes: (orden.discount_codes || []).map((d) => d.code),
    status: estadoOrden(orden),
  };
}

/* Tags a agregar, sin repetir los que la orden ya tiene. */
export function etiquetasPara(fila, tagsActuales) {
  const actuales = String(tagsActuales || '').split(',').map((t) => t.trim());
  const quiero = [`ab-${fila.test}-${fila.grp}`];
  if (fila.qa) quiero.push('ab-qa');
  if (fila.inferred) quiero.push('ab-inferido');
  return quiero.filter((t) => !actuales.includes(t));
}
