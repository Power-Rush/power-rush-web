/* POST /api/ab/order — webhooks orders/create y orders/updated de Shopify.
   Guarda (o actualiza) la orden en ab_orders y le pone el tag del grupo.
   Si algo falla responde 500 y Shopify reintenta; todo es idempotente. */
import { verificarHmac, filaOrden, etiquetasPara } from '../_lib/ordenes.mjs';
import { adminGql, sinErrores } from '../_lib/shopify.mjs';
import { db } from '../_lib/db.mjs';

const M_TAGS = `mutation Etiquetar($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
}`;

export async function POST(request) {
  const crudo = Buffer.from(await request.arrayBuffer());
  if (!verificarHmac(crudo, request.headers.get('x-shopify-hmac-sha256'), process.env.SHOPIFY_CLIENT_SECRET)) {
    return new Response('firma inválida', { status: 401 });
  }
  let orden;
  try { orden = JSON.parse(crudo.toString('utf8')); } catch { return new Response(null, { status: 400 }); }

  const fila = filaOrden(orden);
  if (!fila) return new Response(null, { status: 200 });

  await guardar(fila);
  const nuevas = etiquetasPara(fila, orden.tags);
  if (nuevas.length) {
    const r = await adminGql(M_TAGS, { id: `gid://shopify/Order/${fila.order_id}`, tags: nuevas });
    sinErrores(r.tagsAdd, 'tagsAdd');
  }
  return new Response(null, { status: 200 });
}

async function guardar(f) {
  await db()`insert into ab_orders
    (order_id, order_name, created_at, test, grp, visitor, inferred, qa, units, subtotal, discounts, total, discount_codes, status)
    values (${f.order_id}, ${f.order_name}, ${f.created_at}, ${f.test}, ${f.grp}, ${f.visitor}, ${f.inferred}, ${f.qa},
            ${f.units}, ${f.subtotal}, ${f.discounts}, ${f.total}, ${f.discount_codes}, ${f.status})
    on conflict (order_id) do update set
      status = excluded.status, total = excluded.total, discounts = excluded.discounts,
      units = excluded.units, updated_at = now()`;
}
