import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { WhatsAppInstance } from './lib/whatsapp';
import { query } from './lib/db'; // Nossa conexão SQL direta

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: "*" } // Permite conexões de qualquer frontend (localhost ou produção)
});

// Armazena as sessões ativas na memória RAM
export const activeInstances = new Map<string, WhatsAppInstance>();

// Rota 1: Criar Empresa (Cadastro Inicial)
app.post('/company', async (req: Request, res: Response) => {
    try {
        const { name } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: "Nome da empresa é obrigatório" });
        }

        const id = uuidv4();
        
        await query('INSERT INTO "Company" (id, name) VALUES ($1, $2)', [id, name]);
        
        return res.json({ id, name, message: "Empresa criada com sucesso" });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Erro ao criar empresa" });
    }
});

// Rota 2: Conectar Instância (O botão "Conectar WhatsApp" do Painel)
app.post('/instance/connect', async (req: Request, res: Response) => {
    try {
        const { instanceId, name, companyId } = req.body;

        if (!instanceId || !companyId) {
            return res.status(400).json({ error: "instanceId e companyId são obrigatórios" });
        }
        
        // Verifica se a instância já existe no banco
        const check = await query('SELECT * FROM "Instance" WHERE id = $1', [instanceId]);
        
        // Se não existir, cria o registro inicial
        if (check.rowCount === 0) {
            await query(
                'INSERT INTO "Instance" (id, name, "companyId", status) VALUES ($1, $2, $3, $4)',
                [instanceId, name || "Nova Instância", companyId, 'DISCONNECTED']
            );
        }

        // Se já estiver rodando na memória, não recria
        if (activeInstances.has(instanceId)) {
            return res.json({ message: "Instância já está ativa na memória", instanceId });
        }

        // Inicia o motor do WhatsApp
        const instance = new WhatsAppInstance(instanceId, io);
        await instance.init();
        activeInstances.set(instanceId, instance);

        return res.json({ message: "Processo de conexão iniciado. Aguarde o QR Code.", instanceId });

    } catch (error) {
        console.error("Erro ao conectar instância:", error);
        return res.status(500).json({ error: "Falha interna ao iniciar instância" });
    }
});

// Rota 3: Dashboard em Tempo Real (SQL para calcular métricas)
app.get('/instance/:id/dashboard', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        // Query 1: Contar leads não respondidos (Últimas 24h)
        // Lógica: Mensagens que são "IN" e não têm uma "OUT" depois
        const leadsQuery = await query(`
            SELECT COUNT(DISTINCT "customerHash") as total
            FROM "AuditLog"
            WHERE "instanceId" = $1 
            AND direction = 'IN'
            AND timestamp > NOW() - INTERVAL '24 HOURS'
        `, [id]);

        // Query 2: Média de tempo de resposta (Exemplo simples)
        // Em produção, queries mais complexas podem ser necessárias para precisão exata
        const responseTimeQuery = await query(`
            SELECT AVG(EXTRACT(EPOCH FROM (t2.timestamp - t1.timestamp))) as avg_seconds
            FROM "AuditLog" t1
            JOIN "AuditLog" t2 ON t1."customerHash" = t2."customerHash"
            WHERE t1."instanceId" = $1
            AND t1.direction = 'IN' 
            AND t2.direction = 'OUT'
            AND t2.timestamp > t1.timestamp
            AND t2.timestamp < t1.timestamp + INTERVAL '1 HOUR'
        `, [id]);

        return res.json({
            activeLeads: leadsQuery.rows[0]?.total || 0,
            avgResponseTime: parseFloat(responseTimeQuery.rows[0]?.avg_seconds || "0").toFixed(1),
            status: activeInstances.has(id) ? 'ONLINE' : 'OFFLINE'
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Erro ao carregar dashboard" });
    }
});

const PORT = process.env.PORT || 3333;
httpServer.listen(PORT, () => {
    console.log(`🚀 R&B Digital: Raio-X 360 rodando na porta ${PORT}`);
    console.log(`🔧 Modo: SQL Direto (Sem Prisma Client)`);
});