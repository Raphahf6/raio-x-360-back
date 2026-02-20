import { Request, Response } from 'express';
import { query } from '../lib/db';

export class CatalogController {
    static async getCatalog(req: Request, res: Response) {
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
    }
}