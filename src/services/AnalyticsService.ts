// src/services/AnalyticsService.ts
import { query } from "../lib/db";

export class AnalyticsService {
    static async getRealTimeStats(instanceId: string) {
        const sql = `
            SELECT AVG(EXTRACT(EPOCH FROM (t2.timestamp - t1.timestamp))) as avg_response
            FROM "AuditLog" t1
            JOIN "AuditLog" t2 ON t1."customerHash" = t2."customerHash" 
            AND t1."instanceId" = t2."instanceId"
            WHERE t1.direction = 'IN' 
            AND t2.direction = 'OUT' 
            AND t2.timestamp > t1.timestamp
            AND t1."instanceId" = $1;
        `;

        const res = await query(sql, [instanceId]);
        return {
            avgResponseTime: res.rows[0]?.avg_response || 0
        };
    }
}