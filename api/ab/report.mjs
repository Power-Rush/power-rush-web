/* GET /api/ab/report — informe del test para la app embebida en el admin de Shopify.
   Solo responde con un token de sesión válido de la app (Authorization: Bearer …). */
import AB from '../../ab.js';
import { verificarSesion } from '../_lib/sesion.mjs';
import { leerDatos, armarInforme, aCsv } from '../_lib/informe.mjs';
import { db } from '../_lib/db.mjs';
import { SHOP } from '../_lib/shopify.mjs';

export async function GET(request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const sesion = verificarSesion(token, {
    secreto: process.env.SHOPIFY_CLIENT_SECRET, clientId: process.env.SHOPIFY_CLIENT_ID, shop: SHOP,
  });
  if (!sesion) return new Response('No autorizado', { status: 401 });

  const informe = armarInforme(await leerDatos(db(), AB.CONFIG.test), AB.CONFIG);
  if (new URL(request.url).searchParams.get('formato') === 'csv') {
    return new Response(aCsv(informe), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="ab-${AB.CONFIG.test}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  return Response.json(informe, { headers: { 'Cache-Control': 'no-store' } });
}
