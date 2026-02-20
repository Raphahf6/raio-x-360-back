import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../lib/db';

export class CompanyController {
    static async createCompany(req: Request, res: Response) {
        try {
            // Agora recebemos também o ownerEmail enviado pelo frontend
            const { name, ownerEmail } = req.body;

            if (!name) return res.status(400).json({ error: "Nome obrigatório" });

            const slug = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
            const id = uuidv4();

            // Inserimos a loja já vinculada ao e-mail do dono
            await query(
                'INSERT INTO "Company" (id, name, slug, "ownerEmail") VALUES ($1, $2, $3, $4)',
                [id, name, slug, ownerEmail]
            );

            return res.json({ id, name, slug, message: "Empresa criada com sucesso" });
        } catch (error) {
            console.error("Erro ao criar empresa:", error);
            return res.status(500).json({ error: "Erro ao criar empresa (O slug já pode existir)" });
        }
    }

    static async getCompanyByEmail(req: Request, res: Response) {
        try {
            const { email } = req.query;

            if (!email) {
                return res.status(400).json({ error: "E-mail obrigatório" });
            }

            // Busca a empresa que tem esse e-mail como dono
            const result = await query(
                'SELECT * FROM "Company" WHERE "ownerEmail" = $1 LIMIT 1',
                [email]
            );

            if (result.rowCount === 0) {
                return res.status(404).json({ error: "Empresa não encontrada para este usuário" });
            }

            return res.json({ company: result.rows[0] });
        } catch (error) {
            console.error("Erro ao buscar empresa:", error);
            return res.status(500).json({ error: "Erro interno ao buscar empresa" });
        }
    }
}

