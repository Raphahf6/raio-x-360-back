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
const io = new Server(httpServer, {
    cors: { origin: "*" } // Permite conexões de qualquer frontend
});

// Armazena as sessões ativas na memória RAM
export const activeInstances = new Map<string, WhatsAppInstance>();

// =======================================================
//   ROTAS DA API
// =======================================================

// Rota 1: Criar Empresa
app.post('/company', async (req: Request, res: Response) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: "Nome obrigatório" });
        
        const id = uuidv4();
        await query('INSERT INTO "Company" (id, name) VALUES ($1, $2)', [id, name]);
        
        return res.json({ id, name, message: "Empresa criada com sucesso" });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: "Erro ao criar empresa" });
    }
});

// Rota 2: Conectar Instância (Inicia o WhatsApp)
app.post('/instance/connect', async (req: Request, res: Response) => {
    try {
        const { instanceId, name, companyId } = req.body;

        if (!instanceId || !companyId) {
            return res.status(400).json({ error: "instanceId e companyId obrigatórios" });
        }
        
        // Verifica/Cria registro no banco
        const check = await query('SELECT * FROM "Instance" WHERE id = $1', [instanceId]);
        if (check.rowCount === 0) {
            await query(
                'INSERT INTO "Instance" (id, name, "companyId", status) VALUES ($1, $2, $3, $4)',
                [instanceId, name || "Nova Instância", companyId, 'DISCONNECTED']
            );
        }

        // Se já estiver na memória, retorna
        if (activeInstances.has(instanceId)) {
            return res.json({ message: "Instância já ativa", instanceId });
        }

        // Inicia o motor
        const instance = new WhatsAppInstance(instanceId, io);
        activeInstances.set(instanceId, instance); // Salva na memória antes de iniciar
        await instance.init();

        return res.json({ message: "Conexão iniciada", instanceId });

    } catch (error) {
        console.error("Erro ao conectar:", error);
        return res.status(500).json({ error: "Falha interna" });
    }
});

// Rota 3: Dashboard Geral (KPIs)
app.get('/instance/:id/dashboard', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        
        // Leads pendentes (Última msg foi IN nas últimas 24h sem resposta)
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

// Rota 4: Alerta Vermelho (> 10 min de espera)
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
            HAVING EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))) / 60 > 10
            ORDER BY minutes_waiting DESC
            LIMIT 10;
        `;
        const result = await query(sql, [id]);
        return res.json(result.rows);
    } catch (error) {
        return res.status(500).json({ error: "Erro no red alert" });
    }
});

// Rota 5: Funil de Palavras (CORRIGIDO TYPE ERROR)
app.get('/instance/:id/funnel', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const keywords = ['pix', 'cardapio', 'entreg', 'atras', 'valor'];
        
        // Tipagem explícita para evitar erro 'never'
        const results: { keyword: string; count: number }[] = [];

        for (const word of keywords) {
            const count = await query(`
                SELECT COUNT(*) as total FROM "AuditLog" 
                WHERE "instanceId" = $1 AND content ILIKE $2 AND direction = 'IN'
            `, [id, `%${word}%`]);
            
            results.push({ 
                keyword: word, 
                count: parseInt(count.rows[0]?.total || "0") 
            });
        }
        return res.json(results);
    } catch (error) {
        return res.status(500).json({ error: "Erro no funil" });
    }
});

// Rota 6: Criar Regra de Automação
app.post('/automation', async (req: Request, res: Response) => {
    try {
        const { instanceId, keyword, response } = req.body;
        if (!instanceId || !keyword || !response) return res.status(400).json({ error: "Dados incompletos" });

        const id = uuidv4();
        await query(
            `INSERT INTO "AutomationRule" (id, "instanceId", keyword, response) VALUES ($1, $2, $3, $4)`,
            [id, instanceId, keyword, response]
        );
        return res.json({ success: true, id });
    } catch (error) {
        return res.status(500).json({ error: "Erro ao criar regra" });
    }
});

// =======================================================
//   ROTAS DE GERENCIAMENTO DE CARDÁPIO (PRODUTOS E CATEGORIAS)
// =======================================================

// Rota 1: Criar Categoria (Ex: "Cervejas", "Destilados", "Combos")
app.post('/instance/:id/category', async (req: Request, res: Response) => {
    try {
        const instanceId = req.params.id;
        const { name } = req.body;
        
        if (!name) return res.status(400).json({ error: "O nome da categoria é obrigatório" });

        const id = uuidv4();
        await query(
            `INSERT INTO "Category" (id, "instanceId", name) VALUES ($1, $2, $3) RETURNING *`,
            [id, instanceId, name]
        );

        return res.json({ success: true, message: "Categoria criada com sucesso!", id, name });
    } catch (error) {
        console.error("Erro ao criar categoria:", error);
        return res.status(500).json({ error: "Erro interno ao criar categoria" });
    }
});

// Rota 2: Listar Categorias
app.get('/instance/:id/categories', async (req: Request, res: Response) => {
    try {
        const instanceId = req.params.id;
        const result = await query(`SELECT * FROM "Category" WHERE "instanceId" = $1 ORDER BY name ASC`, [instanceId]);
        
        return res.json(result.rows);
    } catch (error) {
        console.error("Erro ao listar categorias:", error);
        return res.status(500).json({ error: "Erro ao buscar categorias" });
    }
});

// Rota 3: Criar ou Atualizar Produto
app.post('/instance/:id/product', async (req: Request, res: Response) => {
    try {
        const instanceId = req.params.id;
        const { id, name, description, price, categoryId, isAvailable } = req.body;

        if (!name || price === undefined) {
            return res.status(400).json({ error: "Nome e preço são obrigatórios" });
        }

        if (id) {
            // Se enviou ID, é uma ATUALIZAÇÃO
            await query(`
                UPDATE "Product" 
                SET name = $1, description = $2, price = $3, "categoryId" = $4, "isAvailable" = $5
                WHERE id = $6 AND "instanceId" = $7
            `, [name, description, price, categoryId || null, isAvailable !== false, id, instanceId]);
            
            return res.json({ success: true, message: "Produto atualizado com sucesso!" });
        } else {
            // Se não enviou ID, é uma CRIAÇÃO
            const newId = uuidv4();
            await query(`
                INSERT INTO "Product" (id, "instanceId", name, description, price, "categoryId", "isAvailable") 
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [newId, instanceId, name, description, price, categoryId || null, isAvailable !== false]);
            
            return res.json({ success: true, message: "Produto criado com sucesso!", id: newId });
        }
    } catch (error) {
        console.error("Erro ao salvar produto:", error);
        return res.status(500).json({ error: "Erro interno ao salvar produto" });
    }
});

// Rota 4: Listar Produtos (Para exibir na tabela do Painel)
app.get('/instance/:id/products', async (req: Request, res: Response) => {
    try {
        const instanceId = req.params.id;
        
        // Traz os produtos junto com o nome da categoria
        const result = await query(`
            SELECT p.*, c.name as category_name 
            FROM "Product" p
            LEFT JOIN "Category" c ON p."categoryId" = c.id
            WHERE p."instanceId" = $1
            ORDER BY c.name ASC, p.name ASC
        `, [instanceId]);

        return res.json(result.rows);
    } catch (error) {
        console.error("Erro ao listar produtos:", error);
        return res.status(500).json({ error: "Erro ao buscar produtos" });
    }
});

// Rota 5: Deletar Produto
app.delete('/instance/:id/product/:productId', async (req: Request, res: Response) => {
    try {
        const { id, productId } = req.params;
        await query(`DELETE FROM "Product" WHERE id = $1 AND "instanceId" = $2`, [productId, id]);
        return res.json({ success: true, message: "Produto removido com sucesso!" });
    } catch (error) {
        console.error("Erro ao deletar produto:", error);
        return res.status(500).json({ error: "Erro ao deletar produto" });
    }
});

// Rota 7: Listar Regras
app.get('/instance/:id/automation', async (req: Request, res: Response) => {
    try {
        const result = await query(`SELECT * FROM "AutomationRule" WHERE "instanceId" = $1`, [req.params.id]);
        return res.json(result.rows);
    } catch (error) {
        return res.status(500).json({ error: "Erro ao listar regras" });
    }
});

// Rota CRM: Listar Clientes
app.get('/instance/:id/customers', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        // Pega os clientes ordenados por quem falou por último
        const result = await query(`
            SELECT * FROM "Customer" 
            WHERE "instanceId" = $1 
            ORDER BY "lastContact" DESC 
            LIMIT 100
        `, [id]);
        
        return res.json(result.rows);
    } catch (error) {
        return res.status(500).json({ error: "Erro ao listar CRM" });
    }
});

// =======================================================
//   RESTAURAÇÃO DE SESSÃO (AUTO-RECONNECT)
// =======================================================
async function restoreSessions() {
    try {
        console.log("🔄 Buscando sessões para restaurar...");
        // Busca apenas quem estava marcado como CONNECTED
        const result = await query('SELECT * FROM "Instance" WHERE status = $1', ['CONNECTED']);
        
        if (result.rowCount === 0) {
             console.log("ℹ️ Nenhuma sessão ativa encontrada.");
             return;
        }

        for (const row of result.rows) {
            const instanceId = row.id;
            
            if (activeInstances.has(instanceId)) {
                continue; // Já está rodando
            }

            console.log(`🔌 Restaurando instância: ${instanceId}`);
            
            // Recria a classe. O Baileys lerá a pasta 'sessions' do disco automaticamente.
            const instance = new WhatsAppInstance(instanceId, io);
            activeInstances.set(instanceId, instance);
            
            // Inicia a conexão
            await instance.init();
        }
        console.log(`✅ ${result.rowCount} sessões processadas.`);
    } catch (error) {
        console.error("❌ Erro ao restaurar sessões:", error);
    }
}

// =======================================================
//   SERVER START
// =======================================================
const PORT = process.env.PORT || 3333;

// Apenas UM listen no arquivo inteiro
httpServer.listen(PORT, async () => {
    console.log(`🚀 Raio-X 360 rodando na porta ${PORT}`);
    console.log(`🔧 Modo: SQL Direto (Sem Prisma Client)`);
    
    // Tenta restaurar sessões antigas
    await restoreSessions();
});