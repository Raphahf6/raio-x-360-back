import { Request, Response } from 'express';
import { Server } from 'socket.io';
import { WhatsAppInstance } from '../lib/whatsapp';
import { query } from '../lib/db';
import { io } from '../server';

// Mantém as sessões ativas na memória RAM
export const activeInstances = new Map<string, WhatsAppInstance>();

export class WhatsAppController {
    static async connectInstance(req: Request, res: Response) {
        try {
            const { instanceId, name, companyId } = req.body;

            if (!instanceId || !companyId) {
                return res.status(400).json({ error: "instanceId e companyId obrigatórios" });
            }
            
            const check = await query('SELECT * FROM "Instance" WHERE id = $1', [instanceId]);
            if (check.rowCount === 0) {
                await query(
                    'INSERT INTO "Instance" (id, name, "companyId", status) VALUES ($1, $2, $3, $4)',
                    [instanceId, name || "Nova Instância", companyId, 'DISCONNECTED']
                );
            }

            if (activeInstances.has(instanceId)) {
                return res.json({ message: "Instância já ativa", instanceId });
            }

            const instance = new WhatsAppInstance(instanceId, io);
            activeInstances.set(instanceId, instance); 
            await instance.init();

            return res.json({ message: "Conexão iniciada", instanceId });

        } catch (error) {
            console.error("Erro ao conectar:", error);
            return res.status(500).json({ error: "Falha interna" });
        }
    }
}

// Função de auto-reconnect ao iniciar o servidor
export async function restoreSessions(ioInstance: Server) {
    try {
        console.log("🔄 Buscando sessões para restaurar...");
        const result = await query('SELECT * FROM "Instance" WHERE status = $1', ['CONNECTED']);
        
        if (result.rowCount === 0) {
             console.log("ℹ️ Nenhuma sessão ativa encontrada.");
             return;
        }

        for (const row of result.rows) {
            const instanceId = row.id;
            if (activeInstances.has(instanceId)) continue; 
            
            console.log(`🔌 Restaurando instância: ${instanceId}`);
            const instance = new WhatsAppInstance(instanceId, ioInstance);
            activeInstances.set(instanceId, instance);
            await instance.init();
        }
        console.log(`✅ ${result.rowCount} sessões processadas.`);
    } catch (error) {
        console.error("❌ Erro ao restaurar sessões:", error);
    }
}