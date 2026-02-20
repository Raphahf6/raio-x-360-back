import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../lib/db';
import { activeInstances } from './WhatsAppController';

export class DashboardController {
    static async getMetrics(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const leadsQuery = await query(`
                SELECT COUNT(DISTINCT t1."customerHash") as total FROM "AuditLog" t1
                WHERE t1."instanceId" = $1 AND t1.direction = 'IN' AND t1.timestamp > NOW() - INTERVAL '24 HOURS'
                AND NOT EXISTS (
                    SELECT 1 FROM "AuditLog" t2 WHERE t2."customerHash" = t1."customerHash" AND t2."instanceId" = t1."instanceId"
                    AND t2.timestamp > t1.timestamp AND t2.direction = 'OUT'
                )
            `, [id]);

            const responseTimeQuery = await query(`
                SELECT AVG(EXTRACT(EPOCH FROM (t2.timestamp - t1.timestamp))) as avg_seconds FROM "AuditLog" t1
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
    }

    static async getRedAlerts(req: Request, res: Response) {
        try {
            const sql = `
                SELECT "customerHash", MAX(timestamp) as last_interaction, EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))) / 60 as minutes_waiting
                FROM "AuditLog" WHERE "instanceId" = $1 AND direction = 'IN' GROUP BY "customerHash"
                HAVING EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))) / 60 > 10 ORDER BY minutes_waiting DESC LIMIT 10;
            `;
            const result = await query(sql, [req.params.id]);
            return res.json(result.rows);
        } catch (error) {
            return res.status(500).json({ error: "Erro no red alert" });
        }
    }

    static async getFunnel(req: Request, res: Response) {
        try {
            const keywords = ['pix', 'cardapio', 'entreg', 'atras', 'valor'];
            const results: { keyword: string; count: number }[] = [];
            for (const word of keywords) {
                const count = await query(`SELECT COUNT(*) as total FROM "AuditLog" WHERE "instanceId" = $1 AND content ILIKE $2 AND direction = 'IN'`, [req.params.id, `%${word}%`]);
                results.push({ keyword: word, count: parseInt(count.rows[0]?.total || "0") });
            }
            return res.json(results);
        } catch (error) {
            return res.status(500).json({ error: "Erro no funil" });
        }
    }

    static async getCustomers(req: Request, res: Response) {
        try {
            const result = await query(`SELECT * FROM "Customer" WHERE "instanceId" = $1 ORDER BY "lastContact" DESC LIMIT 100`, [req.params.id]);
            return res.json(result.rows);
        } catch (error) {
            return res.status(500).json({ error: "Erro ao listar CRM" });
        }
    }

    static async createAutomationRule(req: Request, res: Response) {
        try {
            const { instanceId, keyword, response } = req.body;
            if (!instanceId || !keyword || !response) return res.status(400).json({ error: "Dados incompletos" });

            const id = uuidv4();
            await query(`INSERT INTO "AutomationRule" (id, "instanceId", keyword, response) VALUES ($1, $2, $3, $4)`, [id, instanceId, keyword, response]);
            return res.json({ success: true, id });
        } catch (error) {
            return res.status(500).json({ error: "Erro ao criar regra" });
        }
    }

    static async getAutomationRules(req: Request, res: Response) {
        try {
            const result = await query(`SELECT * FROM "AutomationRule" WHERE "instanceId" = $1`, [req.params.id]);
            return res.json(result.rows);
        } catch (error) {
            return res.status(500).json({ error: "Erro ao listar regras" });
        }
    }
}