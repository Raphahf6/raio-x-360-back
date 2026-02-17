import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { WhatsAppInstance } from './lib/whatsapp';
import { query } from './lib/db';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });
export const activeInstances = new Map<string, WhatsAppInstance>();

// ... (Rotas de Company e Connect iguais ao anterior) ...

// Rota 1: Dashboard Geral (KPIs)
app.get('/instance/:id/dashboard', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        
        // Leads pendentes (Última msg foi IN nas últimas 24h)
        const leadsQuery = await query(`
            SELECT COUNT(DISTINCT t1."customerHash") as total
            FROM "AuditLog" t1
            WHERE t1."instanceId" = $1 
            AND t1.direction = 'IN'
            AND t1.timestamp > NOW() - INTERVAL '24 HOURS'
            AND NOT EXISTS (
                SELECT 1 FROM "AuditLog" t2 
                WHERE t2."customerHash" = t1."customerHash" 
                AND t2."instanceId" = t1."instanceId"
                AND t2.timestamp > t1.timestamp
                AND t2.direction = 'OUT'
            )
        `, [id]);

        // Tempo médio de resposta
        const responseTimeQuery = await query(`
            SELECT AVG(EXTRACT(EPOCH FROM (t2.timestamp - t1.timestamp))) as avg_seconds
            FROM "AuditLog" t1
            JOIN "AuditLog" t2 ON t1."customerHash" = t2."customerHash"
            WHERE t1."instanceId" = $1 AND t1.direction = 'IN' AND t2.direction = 'OUT'
            AND t2.timestamp > t1.timestamp AND t2.timestamp < t1.timestamp + INTERVAL '2 HOURS'
        `, [id]);

        return res.json({
            activeLeads: leadsQuery.rows[0]?.total || 0,
            avgResponseTime: parseFloat(responseTimeQuery.rows[0]?.avg_seconds || "0").toFixed(1),
            status: activeInstances.has(id) ? 'ONLINE' : 'OFFLINE'
        });
    } catch (error) {
        return res.status(500).json({ error: "Erro no dashboard" });
    }
});

// Rota 2: Alerta Vermelho (Quem está esperando há > 10 min?)
app.get('/instance/:id/red-alert', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const sql = `
            SELECT 
                "customerHash", 
                MAX(timestamp) as last_interaction,
                EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))) / 60 as minutes_waiting
            FROM "AuditLog"
            WHERE "instanceId" = $1 AND direction = 'IN'
            GROUP BY "customerHash"
            HAVING EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))) / 60 > 10 -- Mais de 10 min
            ORDER BY minutes_waiting DESC
            LIMIT 10;
        `;
        const result = await query(sql, [id]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: "Erro no red alert" });
    }
});

// Rota 3: Funil de Palavras (O que estão falando?)
app.get('/instance/:id/funnel', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const keywords = ['pix', 'cardapio', 'entreg', 'atras', 'valor'];
        
        // AQUI ESTAVA O ERRO: Precisamos dizer que é um array de qualquer coisa ou tipar o objeto
        const results: { keyword: string; count: number }[] = []; 

        for (const word of keywords) {
            const count = await query(`
                SELECT COUNT(*) as total FROM "AuditLog" 
                WHERE "instanceId" = $1 AND content ILIKE $2 AND direction = 'IN'
            `, [id, `%${word}%`]);
            
            // O Postgres retorna count como string, precisamos converter
            results.push({ 
                keyword: word, 
                count: parseInt(count.rows[0]?.total || "0") 
            });
        }
        return res.json(results);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Erro no funil" });
    }
});

// Rota 4: Criar Regra de Automação (Garanta que está assim)
app.post('/automation', async (req: Request, res: Response) => {
    try {
        const { instanceId, keyword, response } = req.body;
        
        if (!instanceId || !keyword || !response) {
            return res.status(400).json({ error: "Dados incompletos" });
        }

        const id = uuidv4();
        await query(
            `INSERT INTO "AutomationRule" (id, "instanceId", keyword, response) VALUES ($1, $2, $3, $4)`,
            [id, instanceId, keyword, response]
        );
        return res.json({ success: true, id });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Erro ao criar regra" });
    }
});

// Rota 5: Listar Regras (Garanta que está assim)
app.get('/instance/:id/automation', async (req: Request, res: Response) => {
    try {
        const result = await query(`SELECT * FROM "AutomationRule" WHERE "instanceId" = $1`, [req.params.id]);
        return res.json(result.rows);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Erro ao listar regras" });
    }
});

// ... (Resto do código do server: listen port, etc)
const PORT = process.env.PORT || 3333;
httpServer.listen(PORT, () => {
    console.log(`🚀 Raio-X 360 rodando na porta ${PORT}`);
});