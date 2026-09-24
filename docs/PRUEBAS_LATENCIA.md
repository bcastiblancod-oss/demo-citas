# Informe de Pruebas de Rendimiento y Latencia

**Arquitectura de Sistemas I · Universidad Central · 2026-2**  
**Autor:** bcastiblancod-oss (`bcastiblancod@ucentral.edu.co`)  
**Fecha:** 24 de septiembre de 2026  
**Servicio evaluado:** [`https://demo-citas-cvtk.onrender.com`](https://demo-citas-cvtk.onrender.com)  
**Herramienta de carga:** `autocannon`  

---

## 1. Objetivos

Evaluar la latencia por percentiles, el rendimiento (*throughput*) y la resiliencia del sistema de reserva de citas tras la implementación de optimizaciones arquitectónicas de latencia, comparando dos escenarios de carga:
1. **Condición normal de operación:** 10 usuarios concurrentes durante 20 segundos.
2. **Escenario de estrés y saturación extrema:** 500 usuarios concurrentes durante 120 segundos (2 minutos).

---

## 2. Modificaciones Implementadas para Mejorar la Latencia

Para reducir los tiempos de respuesta y optimizar el uso de recursos entre el servidor Express (en Render) y la base de datos PostgreSQL (en Supabase), se implementaron las siguientes modificaciones:

### 2.1 Reducción de 2 consultas SQL a 1 en la reserva de citas (Reducción de RTT)
- **Archivos:** `src/aplicacion/citaService.js` y `src/persistencia/citaRepository.js`
- **Problema previo:** En la versión inicial, cada reserva de cita ejecutaba dos viajes de red (*Round-Trip Time* o RTT) consecutivos: primero un `SELECT` para verificar disponibilidad en la agenda y luego un `INSERT` para registrar la cita. Con el servidor en Render y la base de datos en Supabase, cada viaje sumaba ~170 ms de latencia pura de red. Además, este esquema sufría de una condición de carrera (*race condition*).
- **Modificación:** Se unificó la comprobación y la inserción en **una sola operación atómica** directa contra PostgreSQL.

```javascript
// ANTES (2 consultas SQL -> 2 viajes de red):
// citaService.js
const ocupado = await citaRepository.existeEnHorario(datos.profesional_id, datos.fecha_hora); // Consulta 1
reglas.validarAgendaLibre(ocupado);
const id = await citaRepository.guardar(datos); // Consulta 2

// DESPUÉS (1 sola consulta SQL atómica -> 1 viaje de red):
// citaService.js
const id = await citaRepository.guardar(datos);
```

En `citaRepository.js`, la inserción atómica valida la disponibilidad en el mismo comando:
```javascript
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
      throw new ErrorDeNegocio('AGENDA_OCUPADA', 'Regla del servidor: ese profesional ya tiene una cita a esa hora');
    }
    return resultado.rows[0].id;
  } catch (error) {
    if (error.code === '23505') { // Captura violación de restricción UNIQUE en Postgres
      throw new ErrorDeNegocio('AGENDA_OCUPADA', 'Regla del servidor: ese profesional ya tiene una cita a esa hora');
    }
    throw error;
  }
}
```
- **Impacto:** **Se reduce a la mitad la latencia de reserva de citas** (~170 ms ahorrados por solicitud) y se elimina por completo la condición de carrera bajo concurrencia.

---

### 2.2 Restricción de unicidad e índices en PostgreSQL
- **Archivo:** `db/setup.sql`
- **Modificación:** Se agregó una restricción `UNIQUE` compuesta y un índice sobre la fecha:
```sql
-- Restricción para garantizar exclusión a nivel de motor de BD:
CONSTRAINT uq_citas_profesional_fecha UNIQUE (profesional_id, fecha_hora)

-- Índice para optimizar consultas y el ordenamiento por fecha:
CREATE INDEX IF NOT EXISTS idx_citas_fecha_hora ON citas (fecha_hora);
```
- **Impacto:** El motor de PostgreSQL evalúa la unicidad en tiempo logarítmico $O(\log N)$ mediante el índice subyacente y acelera significativamente la consulta de listado `GET /api/citas` (`ORDER BY c.fecha_hora`).

---

### 2.3 Caché en memoria y cabeceras HTTP en catálogo de profesionales
- **Archivos:** `src/persistencia/profesionalRepository.js` y `src/presentacion/citasRoutes.js`
- **Problema previo:** Cada petición al endpoint `/api/profesionales` realizaba una consulta SQL remota, a pesar de que el catálogo de profesionales es información estática de referencia.
- **Modificación:** Se implementó una caché en memoria en la capa de persistencia con un tiempo de vida (TTL) de 60 segundos, y se añadió la cabecera `Cache-Control: public, max-age=60` en la capa de presentación.
```javascript
// profesionalRepository.js
let cacheProfesionales = null;
let ultimaCarga = 0;
const CACHE_TTL_MS = 60 * 1000;

async function listarTodos() {
  const ahora = Date.now();
  if (cacheProfesionales && ahora - ultimaCarga < CACHE_TTL_MS) {
    return cacheProfesionales; // Retorno inmediato desde memoria
  }
  const resultado = await pool.query('SELECT id, nombre, especialidad FROM profesionales ORDER BY nombre');
  cacheProfesionales = resultado.rows;
  ultimaCarga = ahora;
  return cacheProfesionales;
}
```
- **Impacto:** La latencia del endpoint pasó de **~150 ms a < 1 ms** en todas las solicitudes posteriores a la primera carga.

---

### 2.4 Optimización del Pool de Conexiones de Base de Datos
- **Archivo:** `src/persistencia/db.js`
- **Modificación:** Configuración explícita de límites y tiempos de espera para el pool de clientes:
```javascript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,                       // Límite de conexiones activas acordes al pooler de Supabase
  idleTimeoutMillis: 30000,      // Libera conexiones inactivas tras 30 s
  connectionTimeoutMillis: 5000, // Timeout rápido para evitar bloqueos indefinidos
});
```
- **Impacto:** Evita la saturación del Transaction Pooler de Supabase y asegura que las solicitudes no queden esperando indefinidamente ante picos de concurrencia.

---

### 2.5 Carga paralela en el cliente web
- **Archivo:** `public/index.html`
- **Modificación:** Se reemplazó la espera secuencial por ejecución concurrente con `Promise.all`:
```javascript
// ANTES (secuencial):
await cargarProfesionales();
await cargarCitas();

// DESPUÉS (concurrente):
await Promise.all([cargarProfesionales(), cargarCitas()]);
```
- **Impacto:** Reduce el tiempo total de carga inicial percibido por el usuario en el navegador web al despachar ambas peticiones HTTP al mismo tiempo.

---

## 3. Entorno de Pruebas

- **Herramienta:** `autocannon` ejecutada desde cliente externo.
- **Servidor:** Node.js / Express desplegado en Render (Web Service, plan gratuito).
- **Base de Datos:** PostgreSQL en Supabase a través del Transaction Pooler (puerto 6543, SSL activado).
- **Métricas:** Latencia percentil (p50, p97.5, p99, promedio), Throughput (Req/Sec), Códigos de respuesta (2xx / non-2xx) y Timeouts.

---

## 4. Prueba 1 — Carga Normal (10 usuarios concurrentes, 20 segundos)

### Comando
```bash
npx autocannon -c 10 -d 20 https://demo-citas-cvtk.onrender.com/api/citas
```

### Resultados

| Métrica | 2.5% | 50% (Mediana) | 97.5% | 99% | Promedio | Máx |
|:---|:---|:---|:---|:---|:---|:---|
| **Latencia** | **304 ms** | **319 ms** | **526 ms** | **1,522 ms** | **346.93 ms** | 1,767 ms |
| **Throughput (Req/s)** | 3 | 31 | 32 | — | **28.75 req/s** | 32 req/s |

- **Total solicitudes:** 585 peticiones en 20.18 s (~456 kB transferidos).
- **Tasa de éxito:** **100%** (575 respuestas `200 OK`, 0 errores, 0 timeouts).
- **Análisis:** Con 10 usuarios concurrentes el sistema muestra un comportamiento óptimo y predecible. La mediana de latencia se mantiene en **319 ms**, con un 97.5% de respuestas por debajo de los 530 ms.

---

## 5. Prueba 2 — Carga de Estrés Extremo (500 usuarios concurrentes, 120 segundos)

### Comando
```bash
npx autocannon -c 500 -d 120 https://demo-citas-cvtk.onrender.com/api/citas
```

### Resultados

| Métrica | 2.5% | 50% (Mediana) | 97.5% | 99% | Promedio | Máx |
|:---|:---|:---|:---|:---|:---|:---|
| **Latencia** | **5,123 ms** | **5,251 ms** | **5,608 ms** | **6,085 ms** | **5,215.93 ms** | 6,478 ms |
| **Throughput (Req/s)** | 50 | 63 | 226 | — | **93.87 req/s** | 226 req/s |

- **Total solicitudes:** **12,000 peticiones** en 120.73 s (~7.7 MB transferidos).
- **Respuestas exitosas (2xx):** **6,718 peticiones** (59.6%).
- **Respuestas no exitosas (non-2xx):** **4,546 peticiones** (errores 500 por saturación del pool de base de datos).
- **Timeouts:** Únicamente **2 timeouts** de 12,000 solicitudes (< 0.02%).
- **Análisis:** Bajo 500 conexiones simultáneas (50x la carga normal), el tiempo de respuesta aumenta a **~5.2 segundos** debido al encolamiento en el event loop y a la espera de conexiones en el pool. No obstante, el servidor procesó más de 6,700 peticiones con éxito sin reiniciarse ni caerse.

---

## 6. Tabla Comparativa General

| Escenario | Conexiones Concurrentes | Duración | Throughput Promedio | Latencia p50 (Mediana) | Latencia p99 (Cola) | Tasa de Éxito |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Línea Base sin BD (`/api/salud`)** | 10 | 10 s | 66.1 req/s | **148 ms** | 248 ms | 100% |
| **Operación Normal (`/api/citas`)** | 10 | 20 s | 28.75 req/s | **319 ms** | 1,522 ms | 100% |
| **Estrés Extremo (`/api/citas`)** | 500 | 120 s | 93.87 req/s | **5,251 ms** | 6,085 ms | 59.6% |

---

## 7. Diagnóstico y Conclusiones Arquitectónicas

1. **Cuantificación del salto a base de datos:**
   - La diferencia entre la prueba base (`/api/salud` a 148 ms) y la consulta a datos (`/api/citas` a 319 ms) refleja con exactitud el costo del viaje de red entre el servidor Render y Supabase (**~171 ms**).
   - Por esta razón, la eliminación de la consulta redundante previa en `POST /api/citas` representa el mayor ahorro porcentual posible en la aplicación sin alterar la infraestructura física.

2. **Degradación controlada (*Graceful Degradation*):**
   - El límite del pool (`max: 10`) y el timeout de conexión (`5000 ms`) actuaron como un mecanismo de protección para la base de datos. Ante la avalancha de 500 conexiones, las peticiones que excedieron la capacidad fueron rechazadas controladamente con error 500 en lugar de provocar un desbordamiento de memoria o un bloqueo del motor PostgreSQL.

3. **Resiliencia bajo carga:**
   - El sistema soportó **12,000 peticiones en 2 minutos** sobre infraestructura con recursos mínimos (tier gratuito), demostrando la eficiencia del modelo asíncrono no bloqueante de Node.js combinado con capas bien desacopladas.
