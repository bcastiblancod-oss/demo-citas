// Casos de uso de citas: coordinan las reglas del dominio y los repositorios.
const reglas = require('../dominio/reglasDeAgenda');
const citaRepository = require('../persistencia/citaRepository');
const profesionalRepository = require('../persistencia/profesionalRepository');

async function consultarCitas() {
  return citaRepository.listarTodas();
}

async function consultarProfesionales() {
  return profesionalRepository.listarTodos();
}

async function reservarCita(datos) {
  reglas.validarDatosCompletos(datos);
  reglas.validarFechaFutura(datos.fecha_hora);

  // Optimización de latencia:
  // Se reduce de 2 viajes de red (SELECT + INSERT) a 1 sola operación atómica en la base de datos.
  // El repositorio realiza la inserción y valida la exclusión de horario en un solo paso.
  const id = await citaRepository.guardar(datos);
  return { mensaje: 'Cita creada', id };
}

module.exports = { consultarCitas, consultarProfesionales, reservarCita };
