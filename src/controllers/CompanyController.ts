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
}