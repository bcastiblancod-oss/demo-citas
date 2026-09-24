// Conexión a Postgres (Supabase). La cadena llega por variable de entorno
// para no versionar credenciales; ver .env.example.
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase exige TLS
  max: 10,                            // Conexiones en el pool
  idleTimeoutMillis: 30000,           // Cierre de conexiones inactivas
  connectionTimeoutMillis: 5000,      // Timeout para adquisición rápida
});

module.exports = pool;
