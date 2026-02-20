import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../lib/db';
import { io } from '../server';
import { activeInstances } from './WhatsAppController';

export class OrderController {
    static async createOrder(req: Request, res: Response) {
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
    }

    static async getActiveOrders(req: Request, res: Response) {
        try {
            const { id } = req.params;
            
            const ordersRes = await query(`
                SELECT * FROM "Order" 
                WHERE "instanceId" = $1 AND status IN ('PENDING', 'PREPARING', 'DISPATCHED')
                ORDER BY "createdAt" ASC
            `, [id]);

            const orders = ordersRes.rows;
            if (orders.length === 0) return res.json([]);

            const orderIds = orders.map(o => o.id);
            const itemsRes = await query(`
                SELECT * FROM "OrderItem" WHERE "orderId" = ANY($1::uuid[])
            `, [orderIds]);

            const itemsByOrder = itemsRes.rows.reduce((acc: any, item: any) => {
                if (!acc[item.orderId]) acc[item.orderId] = [];
                acc[item.orderId].push(item);
                return acc;
            }, {});

            const activeOrders = orders.map(o => ({
                ...o,
                items: itemsByOrder[o.id] || []
            }));

            return res.json(activeOrders);
        } catch (error) {
            console.error("Erro ao buscar pedidos ativos:", error);
            return res.status(500).json({ error: "Erro interno ao buscar pedidos" });
        }
    }

    static async updateOrderStatus(req: Request, res: Response) {
        try {
            const { id, orderId } = req.params;
            const { status } = req.body; 

            const updateRes = await query(`
                UPDATE "Order" SET status = $1 WHERE id = $2 AND "instanceId" = $3 RETURNING *
            `, [status, orderId, id]);

            if (updateRes.rowCount === 0) return res.status(404).json({ error: "Pedido não encontrado" });

            const order = updateRes.rows[0];

            io.emit(`update_order_${id}`, { orderId, status });

            const waInstance = activeInstances.get(id);
            
            if (waInstance && waInstance.sock && order.customerPhone) {
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

                if (messageText !== "") {
                    try {
                        await waInstance.sock.sendMessage(jid, { text: messageText });
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
    }
}