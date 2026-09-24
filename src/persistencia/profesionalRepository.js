// Acceso a datos del catálogo de profesionales.
const pool = require('./db');

let cacheProfesionales = null;
let ultimaCarga = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minuto de caché en memoria para reducir latencia

async function listarTodos() {
  const ahora = Date.now();
  if (cacheProfesionales && ahora - ultimaCarga < CACHE_TTL_MS) {
    return cacheProfesionales;
  }

  const resultado = await pool.query(
    'SELECT id, nombre, especialidad FROM profesionales ORDER BY nombre'
  );
  cacheProfesionales = resultado.rows;
  ultimaCarga = ahora;
  return cacheProfesionales;
}

module.exports = { listarTodos };
