import { Request, Response } from 'express';
import OpenAI from 'openai';

// Puxa a chave do seu .env
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export class AIController {
    static async scanProduct(req: Request, res: Response) {
        try {
            const { image } = req.body; // A imagem em Base64 enviada pelo frontend

            if (!image) {
                return res.status(400).json({ error: "Nenhuma imagem fornecida" });
            }

            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini", // O modelo mais rápido e barato
                messages: [
                    {
                        role: "user",
                        content: [
                            { 
                                type: "text", 
                                text: "Analise a imagem deste produto (geralmente uma bebida ou item de conveniência). Retorne EXATAMENTE um JSON válido com os seguintes campos: 'name' (Nome completo e volume), 'category' (Cervejas, Vinhos, Destilados, Sem Álcool ou Conveniência), 'price' (apenas se estiver visível, senão retorne vazio) e 'description' (Uma breve descrição atraente para venda, focando no sabor ou utilidade)." 
                            },
                            {
                                type: "image_url",
                                image_url: {
                                    url: image, // O Base64 vai aqui
                                },
                            },
                        ],
                    },
                ],
                response_format: { type: "json_object" }, // Garante que a OpenAI devolva um JSON limpo
                max_tokens: 300,
            });

            const aiResult = JSON.parse(response.choices[0].message.content || "{}");

            return res.json(aiResult);

        } catch (error) {
            console.error("Erro na OpenAI:", error);
            return res.status(500).json({ error: "Erro ao analisar o produto" });
        }
    }
}