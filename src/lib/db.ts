import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Configuração tolerante a falhas de certificado (Ambiente Corporativo)
export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Ignora validação estrita do certificado do proxy
    }
});

// Wrapper para facilitar as queries
export const query = (text: string, params?: any[]) => pool.query(text, params);