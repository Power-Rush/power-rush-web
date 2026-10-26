/* POST /api/ab/event — eventos del test A/B desde la web (sendBeacon) y desde el pixel
   del checkout de Shopify. Siempre responde 204: un error acá nunca afecta a la página. */
import { filaEvento } from '../_lib/eventos.mjs';
import { esEquipo } from '../_lib/equipo.mjs';
import { db } from '../_lib/db.mjs';

const CORS = { 'Access-Control-Allow-Origin': '*' };

export async function POST(request) {
  try {
    const texto = await request.text();
    if (texto.length <= 4000) {
      let cuerpo = null;
      try { cuerpo = JSON.parse(texto); } catch { cuerpo = null; }
      const cookies = request.headers.get('cookie') || '';
      const fila = filaEvento(cuerpo, {
        cookies,
        ua: request.headers.get('user-agent') || '',
        pais: request.headers.get('x-vercel-ip-country'),
        esEquipo: await esEquipo(cookies),
      });
      if (fila) await insertar(fila);
    }
  } catch (e) {
    console.error('ab/event', e);
  }
  return new Response(null, { status: 204, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' },
  });
}

async function insertar(f) {
  await db()`insert into ab_events
    (test, grp, visitor, session, event, path, flavor, qty, value, order_id, detail, source, medium, campaign, device, country, excluded)
    values (${f.test}, ${f.grp}, ${f.visitor}, ${f.session}, ${f.event}, ${f.path}, ${f.flavor}, ${f.qty}, ${f.value},
            ${f.order_id}, ${f.detail}, ${f.source}, ${f.medium}, ${f.campaign}, ${f.device}, ${f.country}, ${f.excluded})`;
}
