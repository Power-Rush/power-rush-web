/* Conexión a Postgres (Neon) por HTTP. Se crea recién cuando se usa, así un deploy sin
   DATABASE_URL no se cae al cargar la función. */
import { neon } from '@neondatabase/serverless';

let sql = null;

export function db() {
  if (!sql) {
    if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
    sql = neon(process.env.DATABASE_URL);
  }
  return sql;
}
