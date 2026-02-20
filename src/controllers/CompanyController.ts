import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../lib/db';

export class CompanyController {
    static async createCompany(req: Request, res: Response) {
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
    }
}