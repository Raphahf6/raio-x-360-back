import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../lib/db';
import { LocationService } from '../services/LocationService';

export class CustomerController {
    static async getCustomerData(req: Request, res: Response) {
        try {
            const { phone } = req.query;
            const phoneStr = phone as string;

            const addresses = await query(
                `SELECT * FROM "CustomerAddress" WHERE "customerHash" = $1 ORDER BY "createdAt" DESC`, 
                [phoneStr]
            );

            // CORREÇÃO DO ERRO: Usamos '?? 0' para garantir que se for null, vire 0
            const count = addresses.rowCount ?? 0;

            return res.json({
                exists: count > 0,
                addresses: addresses.rows
            });
        } catch (error) {
            return res.status(500).json({ error: "Erro ao buscar cliente" });
        }
    }

    // NOVA FUNÇÃO: Salvar endereço e calcular frete
    static async saveAddress(req: Request, res: Response) {
        try {
            const { phone, street, number, neighborhood, complement, latitude, longitude, instanceId } = req.body;

            // 1. Busca coordenadas da Empresa (Adega)
            const companyRes = await query(
                `SELECT c.latitude, c.longitude FROM "Company" c 
                 JOIN "Instance" i ON c.id = i."companyId" 
                 WHERE i.id = $1`, [instanceId]
            );

            const adegaPos = companyRes.rows[0];
            let deliveryFee = 7.00; // Valor padrão de segurança

            // 2. Cálculo da Distância (Se tivermos as coordenadas da Adega e do Cliente)
            if (adegaPos?.latitude && latitude) {
                const distance = LocationService.calculateDistance(
                    Number(adegaPos.latitude), Number(adegaPos.longitude),
                    Number(latitude), Number(longitude)
                );

                // 3. Busca a regra de frete no banco (DeliveryConfig)
                const configRes = await query(
                    `SELECT fee FROM "DeliveryConfig" 
                     WHERE "instanceId" = $1 AND "maxKm" >= $2 
                     ORDER BY "maxKm" ASC LIMIT 1`, 
                    [instanceId, distance]
                );

                if (configRes.rowCount && configRes.rowCount > 0) {
                    deliveryFee = configRes.rows[0].fee;
                }
            }

            const id = uuidv4();
            await query(
                `INSERT INTO "CustomerAddress" (id, "customerHash", street, number, neighborhood, complement, latitude, longitude, fee)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [id, phone, street, number, neighborhood, complement, latitude, longitude, deliveryFee]
            );

            return res.json({ success: true, fee: deliveryFee, id });
        } catch (error) {
            console.error(error);
            return res.status(500).json({ error: "Erro ao salvar endereço" });
        }
    }
}