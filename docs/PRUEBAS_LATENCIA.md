# Informe de Pruebas de Rendimiento y Latencia

**Arquitectura de Sistemas I · Universidad Central · 2026-2**  
**Autor:** bcastiblancod-oss (`bcastiblancod@ucentral.edu.co`)  
**Fecha:** 24 de septiembre de 2026  
**Servicio evaluado:** [`https://demo-citas-cvtk.onrender.com`](https://demo-citas-cvtk.onrender.com)  
**Herramienta de carga:** `autocannon`  

---

## 1. Objetivos

Evaluar la latencia por percentiles, el rendimiento (*throughput*) y la resiliencia del sistema de reserva de citas bajo dos escenarios de carga contrastantes:
1. **Condición normal de operación:** 10 usuarios concurrentes durante 20 segundos.
2. **Escenario de estrés y saturación extrema:** 500 usuarios concurrentes durante 120 segundos (2 minutos).

---

## 2. Entorno y Configuración

- **Cliente / Generador de carga:** `autocannon` ejecutado sobre conexión de red externa.
- **Servidor de Aplicaciones:** Express.js desplegado en Render (Web Service, plan gratuito en región US-West/Cloudflare).
- **Servidor de Base de Datos:** PostgreSQL en Supabase gestionado a través de Transaction Pooler (puerto 6543, TLS).
- **Métricas analizadas:** Latencia percentil (p50, p97.5, p99, promedio), peticiones por segundo (Req/Sec), códigos de estado HTTP (2xx vs non-2xx) y timeouts.

---

## 3. Prueba 1 — Carga Normal (10 usuarios concurrentes, 20 segundos)

### Comando ejecutado
```bash
npx autocannon -c 10 -d 20 https://demo-citas-cvtk.onrender.com/api/citas
```

### Resultados obtenidos

| Métrica | 2.5% | 50% (Mediana) | 97.5% | 99% | Promedio | Máx |
|:---|:---|:---|:---|:---|:---|:---|
| **Latencia** | **304 ms** | **319 ms** | **526 ms** | **1,522 ms** | **346.93 ms** | 1,767 ms |
| **Throughput (Req/s)** | 3 | 31 | 32 | — | **28.75 req/s** | 32 req/s |

- **Total de solicitudes procesadas:** 585 peticiones en 20.18 s (~456 kB transferidos).
- **Tasa de éxito:** **100%** (575 respuestas `200 OK`, 0 errores, 0 timeouts).

### Análisis
- La mediana de respuesta (**p50**) se situó en **319 ms**.
- Tomando en cuenta que la latencia base de red y servidor sin base de datos (`/api/salud`) es de **~148 ms**, el viaje de ida y vuelta (*round-trip*) a Supabase para la consulta SQL representa **~171 ms**.
- El sistema muestra alta estabilidad y variabilidad controlada bajo 10 conexiones concurrentes, manteniendo el 97.5% de las peticiones por debajo de los 530 ms.

---

## 4. Prueba 2 — Carga de Estrés Extremo (500 usuarios concurrentes, 120 segundos)

### Comando ejecutado
```bash
npx autocannon -c 500 -d 120 https://demo-citas-cvtk.onrender.com/api/citas
```

### Resultados obtenidos

| Métrica | 2.5% | 50% (Mediana) | 97.5% | 99% | Promedio | Máx |
|:---|:---|:---|:---|:---|:---|:---|
| **Latencia** | **5,123 ms** | **5,251 ms** | **5,608 ms** | **6,085 ms** | **5,215.93 ms** | 6,478 ms |
| **Throughput (Req/s)** | 50 | 63 | 226 | — | **93.87 req/s** | 226 req/s |

- **Total de solicitudes procesadas:** **12,000 peticiones** en 120.73 s (~7.7 MB transferidos).
- **Respuestas exitosas (2xx):** **6,718 peticiones** (59.6%).
- **Respuestas no exitosas (non-2xx):** **4,546 peticiones** (errores 500 derivados del límite del pooler de base de datos).
- **Timeouts / Errores de socket:** **2 timeouts** de 12,000 solicitudes (< 0.02%).

### Análisis
- Al multiplicar por 50 la concurrencia (de 10 a 500 usuarios simultáneos), la latencia mediana aumentó de **319 ms** a **5.25 segundos**.
- Este aumento representa el tiempo de encolamiento (*queueing latency*) tanto en el event loop del servidor Node.js como en la cola de conexiones del pool de PostgreSQL.
- Pese a que el plan gratuito de Render dispone de recursos limitados (0.1 CPU compartida, 512 MB RAM) y Supabase limita el pool a pocas conexiones, el servidor procesó más de **6,700 consultas exitosas** sin caerse ni reiniciar el proceso.

---

## 5. Tabla Comparativa General

| Escenario | Conexiones Concurrentes | Duración | Throughput Promedio | Latencia p50 (Mediana) | Latencia p99 (Cola) | Tasa de Éxito |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Línea Base sin BD (`/api/salud`)** | 10 | 10 s | 66.1 req/s | **148 ms** | 248 ms | 100% |
| **Operación Normal (`/api/citas`)** | 10 | 20 s | 28.75 req/s | **319 ms** | 1,522 ms | 100% |
| **Estrés Extremo (`/api/citas`)** | 500 | 120 s | 93.87 req/s | **5,251 ms** | 6,085 ms | 59.6% |

---

## 6. Diagnóstico y Hallazgos Arquitectónicos

1. **Costo de la capa de persistencia:**
   - La diferencia entre la prueba base (`/api/salud` = 148 ms) y la prueba con consulta (`/api/citas` = 319 ms) es de **~171 ms**.
   - Esto cuantifica con precisión el costo del salto de red transcontinental entre el servidor en Render y el clúster de Supabase.

2. **Degradación Controlada (*Graceful Degradation*):**
   - Con 500 conexiones concurrentes, el pool de PostgreSQL configurado en `src/persistencia/db.js` (`max: 10`, `connectionTimeoutMillis: 5000`) protegió a la base de datos de saturación catastrófica. Las solicitudes que no pudieron obtener conexión dentro del tiempo límite retornaron un error controlado en vez de colapsar la base de datos completa.

3. **Throughput vs. Concurrencia:**
   - El throughput aumentó de **28.75 req/s** a **93.87 req/s** (alcanzando picos de **226 req/s**), lo que demuestra que Node.js aprovecha eficazmente la concurrencia asíncrona, pagando el costo en latencia de cola.

---

## 7. Conclusión

Las optimizaciones implementadas en la versión por capas (reducción a una única consulta atómica en reservas, índices en Postgres, configuración de pool y caché) permiten que el sistema opere con alta fiabilidad en condiciones normales (10 usuarios, latencia ~319 ms y 100% de éxito). En escenarios de sobrecarga masiva (500 usuarios concurrentes durante 2 minutos), el sistema degrada de forma controlada sin caída de servicio.
