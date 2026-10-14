/* Aplica db/ab-schema.sql (idempotente). Uso: npm run ab:db */
import { readFileSync } from 'node:fs';
import { db } from '../api/_lib/db.mjs';

const sql = db();
const esquema = readFileSync(new URL('../db/ab-schema.sql', import.meta.url), 'utf8');
for (const sentencia of esquema.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
  await sql.query(sentencia);
}
const tablas = await sql.query("select table_name from information_schema.tables where table_name in ('ab_events', 'ab_orders') order by 1");
console.log('Tablas:', tablas.map((t) => t.table_name).join(', '));
