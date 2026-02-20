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
    cors: { origin: "*" } 
});

export const activeInstances = new Map<string, WhatsAppInstance>();

// =======================================================
//   ROTAS PÚBLICAS (CATÁLOGO DIGITAL DO CLIENTE)
// =======================================================

app.get('/catalog/:slug', async (req: Request, res: Response) => {
    try {
        const { slug } = req.params;
        
        const companyRes = await query(`
            SELECT c.id, c.name, c.slug, c."deliveryFee", c."isOpen", i.id as "instanceId"
            FROM "Company" c
            JOIN "Instance" i ON c.id = i."companyId"
            WHERE c.slug = $1 LIMIT 1
        `, [slug]);
        
        if (companyRes.rowCount === 0) return res.status(404).json({ error: "Loja não encontrada" });

        const company = companyRes.rows[0];

        const categoriesRes = await query('SELECT * FROM "Category" WHERE "instanceId" = $1', [company.instanceId]);
        const productsRes = await query('SELECT * FROM "Product" WHERE "instanceId" = $1 AND "isAvailable" = true', [company.instanceId]);

        return res.json({
            company,
            categories: categoriesRes.rows,
            products: productsRes.rows
        });

    } catch (error) {
        console.error("Erro ao carregar catálogo público:", error);
        return res.status(500).json({ error: "Erro interno" });
    }
});

app.post('/checkout', async (req: Request, res: Response) => {
    try {
        const { 
            instanceId, customerName, customerPhone, deliveryAddress, 
            cart, paymentMethod, subtotal, deliveryFee, total, changeFor 
        } = req.body;

        const orderId = uuidv4();

        await query(`
            INSERT INTO "Order" (id, "instanceId", "customerName", "customerPhone", "deliveryAddress", subtotal, "deliveryFee", total, "paymentMethod", "changeFor")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [orderId, instanceId, customerName, customerPhone, deliveryAddress, subtotal, deliveryFee, total, paymentMethod, changeFor]);

        for (const item of cart) {
            await query(`
                INSERT INTO "OrderItem" (id, "orderId", "productName", price, quantity)
                VALUES ($1, $2, $3, $4, $5)
            `, [uuidv4(), orderId, item.name, item.price, item.quantity]);
        }

        // TODO: Integração Mercado Pago PIX

        io.emit(`new_order_${instanceId}`, { 
            id: orderId, 
            customerName, 
            total,
            status: 'PENDING',
            createdAt: new Date().toISOString()
        });

        return res.json({ success: true, message: "Pedido recebido com sucesso!", orderId });

    } catch (error) {
        console.error("Erro no checkout:", error);
        return res.status(500).json({ error: "Erro ao processar pedido" });
    }
});

// =======================================================
//   ROTAS DE PEDIDOS / KDS (PDV)
// =======================================================

// 1. Listar pedidos abertos (Para a tela do Kanban)
app.get('/instance/:id/orders/active', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        
        // Busca pedidos que ainda não foram finalizados
        const ordersRes = await query(`
            SELECT * FROM "Order" 
            WHERE "instanceId" = $1 AND status IN ('PENDING', 'PREPARING', 'DISPATCHED')
            ORDER BY "createdAt" ASC
        `, [id]);

        const orders = ordersRes.rows;
        if (orders.length === 0) return res.json([]);

        // Puxa os itens de cada pedido
        const orderIds = orders.map(o => o.id);
        const itemsRes = await query(`
            SELECT * FROM "OrderItem" WHERE "orderId" = ANY($1::uuid[])
        `, [orderIds]);

        // Agrupa os itens pelo ID do pedido
        const itemsByOrder = itemsRes.rows.reduce((acc: any, item: any) => {
            if (!acc[item.orderId]) acc[item.orderId] = [];
            acc[item.orderId].push(item);
            return acc;
        }, {});

        // Junta tudo e envia pro Front
        const activeOrders = orders.map(o => ({
            ...o,
            items: itemsByOrder[o.id] || []
        }));

        return res.json(activeOrders);
    } catch (error) {
        console.error("Erro ao buscar pedidos ativos:", error);
        return res.status(500).json({ error: "Erro interno ao buscar pedidos" });
    }
});

// 2. Atualizar Status do Pedido (E disparar o WhatsApp!)
app.patch('/instance/:id/order/:orderId/status', async (req: Request, res: Response) => {
    try {
        const { id, orderId } = req.params;
        const { status } = req.body; // 'PREPARING', 'DISPATCHED', 'DELIVERED'

        const updateRes = await query(`
            UPDATE "Order" SET status = $1 WHERE id = $2 AND "instanceId" = $3 RETURNING *
        `, [status, orderId, id]);

        if (updateRes.rowCount === 0) return res.status(404).json({ error: "Pedido não encontrado" });

        const order = updateRes.rows[0];

        // Sincroniza outras telas do PDV que possam estar abertas
        io.emit(`update_order_${id}`, { orderId, status });

        // ==========================================
        // MÁGICA DO WHATSAPP AQUI
        // ==========================================
        const waInstance = activeInstances.get(id);
        
        if (waInstance && waInstance.sock && order.customerPhone) {
            // Limpa o número e garante o prefixo 55
            let phone = order.customerPhone.replace(/\D/g, '');
            if (!phone.startsWith('55')) phone = '55' + phone;
            const jid = `${phone}@s.whatsapp.net`;

            let messageText = "";
            
            if (status === 'PREPARING') {
                messageText = `👨‍🍳 *Olá, ${order.customerName}!* Seu pedido #${order.orderNumber} acabou de ser aceito e já está sendo preparado com muito carinho!`;
            } else if (status === 'DISPATCHED') {
                messageText = `🛵 *Uhuu!* Seu pedido #${order.orderNumber} acabou de sair para entrega. Fique de olho no portão!`;
            } else if (status === 'DELIVERED') {
                messageText = `✅ Seu pedido #${order.orderNumber} foi marcado como entregue! Muito obrigado por comprar conosco. Até a próxima!`;
            }

            // Dispara a mensagem se houver texto
            if (messageText !== "") {
                try {
                    await waInstance.sock.sendMessage(jid, { text: messageText });
                    console.log(`[WHATSAPP] Aviso de status '${status}' enviado para ${phone}`);
                } catch (err) {
                    console.error(`Erro ao enviar WhatsApp pro cliente ${phone}:`, err);
                }
            }
        }

        return res.json({ success: true, order });
    } catch (error) {
        console.error("Erro ao atualizar status do pedido:", error);
        return res.status(500).json({ error: "Erro interno" });
    }
});

// =======================================================
//   ROTAS DA API (PAINEL ADMIN / CRM)
// =======================================================

app.post('/company', async (req: Request, res: Response) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: "Nome obrigatório" });
        
        const slug = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
        const id = uuidv4();
        
        await query('INSERT INTO "Company" (id, name, slug) VALUES ($1, $2, $3)', [id, name, slug]);
        
        return res.json({ id, name, slug, message: "Empresa criada com sucesso" });
    } catch (error) {
        return res.status(500).json({ error: "Erro ao criar empresa (O slug já pode existir)" });
    }
});

app.post('/instance/connect', async (req: Request, res: Response) => {
    try {
        const { instanceId, name, companyId } = req.body;

        if (!instanceId || !companyId) return res.status(400).json({ error: "instanceId e companyId obrigatórios" });
        
        const check = await query('SELECT * FROM "Instance" WHERE id = $1', [instanceId]);
        if (check.rowCount === 0) {
            await query(
                'INSERT INTO "Instance" (id, name, "companyId", status) VALUES ($1, $2, $3, $4)',
                [instanceId, name || "Nova Instância", companyId, 'DISCONNECTED']
            );
        }

        if (activeInstances.has(instanceId)) return res.json({ message: "Instância já ativa", instanceId });

        const instance = new WhatsAppInstance(instanceId, io);
        activeInstances.set(instanceId, instance); 
        await instance.init();

        return res.json({ message: "Conexão iniciada", instanceId });

    } catch (error) {
        return res.status(500).json({ error: "Falha interna" });
    }
});

app.get('/instance/:id/dashboard', async (req: Request, res: Response) => {
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
});

app.get('/instance/:id/red-alert', async (req: Request, res: Response) => {
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
});

app.get('/instance/:id/funnel', async (req: Request, res: Response) => {
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
});

app.post('/automation', async (req: Request, res: Response) => {
    try {
        const { instanceId, keyword, response } = req.body;
        if (!instanceId || !keyword || !response) return res.status(400).json({ error: "Dados incompletos" });

        const id = uuidv4();
        await query(`INSERT INTO "AutomationRule" (id, "instanceId", keyword, response) VALUES ($1, $2, $3, $4)`, [id, instanceId, keyword, response]);
        return res.json({ success: true, id });
    } catch (error) {
        return res.status(500).json({ error: "Erro ao criar regra" });
    }
});

app.get('/instance/:id/automation', async (req: Request, res: Response) => {
    try {
        const result = await query(`SELECT * FROM "AutomationRule" WHERE "instanceId" = $1`, [req.params.id]);
        return res.json(result.rows);
    } catch (error) {
        return res.status(500).json({ error: "Erro ao listar regras" });
    }
});

app.get('/instance/:id/customers', async (req: Request, res: Response) => {
    try {
        const result = await query(`SELECT * FROM "Customer" WHERE "instanceId" = $1 ORDER BY "lastContact" DESC LIMIT 100`, [req.params.id]);
        return res.json(result.rows);
    } catch (error) {
        return res.status(500).json({ error: "Erro ao listar CRM" });
    }
});

// =======================================================
//   ROTAS DE GERENCIAMENTO DE CARDÁPIO
// =======================================================

app.post('/instance/:id/category', async (req: Request, res: Response) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: "O nome da categoria é obrigatório" });

        const id = uuidv4();
        await query(`INSERT INTO "Category" (id, "instanceId", name) VALUES ($1, $2, $3) RETURNING *`, [id, req.params.id, name]);
        return res.json({ success: true, message: "Categoria criada com sucesso!", id, name });
    } catch (error) {
        return res.status(500).json({ error: "Erro interno ao criar categoria" });
    }
});

app.get('/instance/:id/categories', async (req: Request, res: Response) => {
    try {
        const result = await query(`SELECT * FROM "Category" WHERE "instanceId" = $1 ORDER BY name ASC`, [req.params.id]);
        return res.json(result.rows);
    } catch (error) {
        return res.status(500).json({ error: "Erro ao buscar categorias" });
    }
});

app.post('/instance/:id/product', async (req: Request, res: Response) => {
    try {
        const instanceId = req.params.id;
        const { id, name, description, price, categoryId, isAvailable } = req.body;

        if (!name || price === undefined) return res.status(400).json({ error: "Nome e preço são obrigatórios" });

        if (id) {
            await query(`
                UPDATE "Product" SET name = $1, description = $2, price = $3, "categoryId" = $4, "isAvailable" = $5
                WHERE id = $6 AND "instanceId" = $7
            `, [name, description, price, categoryId || null, isAvailable !== false, id, instanceId]);
            return res.json({ success: true, message: "Produto atualizado com sucesso!" });
        } else {
            const newId = uuidv4();
            await query(`
                INSERT INTO "Product" (id, "instanceId", name, description, price, "categoryId", "isAvailable") 
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [newId, instanceId, name, description, price, categoryId || null, isAvailable !== false]);
            return res.json({ success: true, message: "Produto criado com sucesso!", id: newId });
        }
    } catch (error) {
        return res.status(500).json({ error: "Erro interno ao salvar produto" });
    }
});

app.get('/instance/:id/products', async (req: Request, res: Response) => {
    try {
        const result = await query(`
            SELECT p.*, c.name as category_name FROM "Product" p
            LEFT JOIN "Category" c ON p."categoryId" = c.id
            WHERE p."instanceId" = $1 ORDER BY c.name ASC, p.name ASC
        `, [req.params.id]);
        return res.json(result.rows);
    } catch (error) {
        return res.status(500).json({ error: "Erro ao buscar produtos" });
    }
});

app.delete('/instance/:id/product/:productId', async (req: Request, res: Response) => {
    try {
        await query(`DELETE FROM "Product" WHERE id = $1 AND "instanceId" = $2`, [req.params.productId, req.params.id]);
        return res.json({ success: true, message: "Produto removido com sucesso!" });
    } catch (error) {
        return res.status(500).json({ error: "Erro ao deletar produto" });
    }
});

// =======================================================
//   RESTAURAÇÃO DE SESSÃO
// =======================================================
async function restoreSessions() {
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
            const instance = new WhatsAppInstance(instanceId, io);
            activeInstances.set(instanceId, instance);
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

httpServer.listen(PORT, async () => {
    console.log(`🚀 R&B Delivery SaaS rodando na porta ${PORT}`);
    console.log(`🔧 Modo: KDS Integrado + WhatsApp Automático`);
    await restoreSessions();
});