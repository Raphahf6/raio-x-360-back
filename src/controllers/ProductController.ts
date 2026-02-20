import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../lib/db';

export class ProductController {
    static async createCategory(req: Request, res: Response) {
        try {
            const { name } = req.body;
            if (!name) return res.status(400).json({ error: "O nome da categoria é obrigatório" });

            const id = uuidv4();
            await query(`INSERT INTO "Category" (id, "instanceId", name) VALUES ($1, $2, $3) RETURNING *`, [id, req.params.id, name]);
            return res.json({ success: true, message: "Categoria criada com sucesso!", id, name });
        } catch (error) {
            return res.status(500).json({ error: "Erro interno ao criar categoria" });
        }
    }

    static async getCategories(req: Request, res: Response) {
        try {
            const result = await query(`SELECT * FROM "Category" WHERE "instanceId" = $1 ORDER BY name ASC`, [req.params.id]);
            return res.json(result.rows);
        } catch (error) {
            return res.status(500).json({ error: "Erro ao buscar categorias" });
        }
    }

    static async createOrUpdateProduct(req: Request, res: Response) {
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
    }

    static async getProducts(req: Request, res: Response) {
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
    }

    static async deleteProduct(req: Request, res: Response) {
        try {
            await query(`DELETE FROM "Product" WHERE id = $1 AND "instanceId" = $2`, [req.params.productId, req.params.id]);
            return res.json({ success: true, message: "Produto removido com sucesso!" });
        } catch (error) {
            return res.status(500).json({ error: "Erro ao deletar produto" });
        }
    }
}