// Acceso a datos de citas. Todo el SQL de la tabla citas vive en este módulo.
const pool = require('./db');

const { ErrorDeNegocio } = require('../dominio/reglasDeAgenda');

async function listarTodas() {
  const resultado = await pool.query(
    `SELECT c.id, c.paciente, c.fecha_hora, p.nombre AS profesional
       FROM citas c
       JOIN profesionales p ON p.id = c.profesional_id
      ORDER BY c.fecha_hora`
  );
  return resultado.rows;
}

async function existeEnHorario(profesional_id, fecha_hora) {
  const resultado = await pool.query(
    'SELECT id FROM citas WHERE profesional_id = $1 AND fecha_hora = $2',
    [profesional_id, fecha_hora]
  );
  return resultado.rows.length > 0;
}

// Inserción atómica en 1 sola consulta SQL.
// Elimina el viaje de red previo del SELECT (RTT), reduciendo la latencia de reserva
// entre Express y Supabase a la mitad, y previniendo condiciones de carrera.
async function guardar({ paciente, profesional_id, fecha_hora }) {
  try {
    const resultado = await pool.query(
      `INSERT INTO citas (paciente, profesional_id, fecha_hora)
       SELECT $1, $2, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM citas WHERE profesional_id = $2 AND fecha_hora = $3
       )
       RETURNING id`,
      [paciente, profesional_id, fecha_hora]
    );

    if (resultado.rows.length === 0) {
      throw new ErrorDeNegocio(
        'AGENDA_OCUPADA',
        'Regla del servidor: ese profesional ya tiene una cita a esa hora'
      );
    }

    return resultado.rows[0].id;
  } catch (error) {
    if (error.code === '23505') {
      throw new ErrorDeNegocio(
        'AGENDA_OCUPADA',
        'Regla del servidor: ese profesional ya tiene una cita a esa hora'
      );
    }
    throw error;
  }
}

module.exports = { listarTodas, existeEnHorario, guardar };
