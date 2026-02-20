import OpenAI from 'openai';
import { query } from '../lib/db';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export class AiService {
    static async generateResponse(instanceId: string, customerHash: string) {
        try {
            // 1. BUSCAR O CATÁLOGO
            const catalogRes = await query(`
                SELECT p.name, p.description, p.price, c.name as category
                FROM "Product" p
                LEFT JOIN "Category" c ON p."categoryId" = c.id
                WHERE p."instanceId" = $1 AND p."isAvailable" = true
            `, [instanceId]);

            let catalogText = "CATÁLOGO DE PRODUTOS DISPONÍVEIS:\n";
            if (catalogRes.rowCount === 0) {
                catalogText += "Nenhum produto cadastrado no momento.\n";
            } else {
                catalogRes.rows.forEach(item => {
                    const desc = item.description ? ` - ${item.description}` : '';
                    catalogText += `- [${item.category || 'Geral'}] ${item.name}: R$ ${item.price}${desc}\n`;
                });
            }

            // 2. BUSCAR HISTÓRICO
            const historyRes = await query(`
                SELECT direction, content 
                FROM "AuditLog"
                WHERE "instanceId" = $1 AND "customerHash" = $2
                ORDER BY timestamp DESC
                LIMIT 10
            `, [instanceId, customerHash]);

            const chatHistory = historyRes.rows.reverse().map(row => ({
                role: row.direction === 'IN' ? 'user' : 'assistant',
                content: row.content
            }));

            // 3. PROMPT DE ENGENHARIA AVANÇADA (Anti-Alucinação e Botões)
            const messages: any[] = [
                {
                    role: "system",
                    content: `Você é o assistente virtual de vendas de uma adega delivery via WhatsApp.
Seja rápido, simpático e persuasivo.

REGRAS DE OURO (NUNCA QUEBRE):
1. NUNCA invente produtos ou preços. Ofereça EXATAMENTE o que está no catálogo abaixo.
2. Se for fazer upsell (oferecer adicionais), verifique se o item EXISTE no catálogo antes de falar. NUNCA ofereça amendoim, carvão ou gelo se não estiver na lista.
3. Se o cliente pedir o cardápio, liste as opções de forma limpa e organizada.
4. Feche a venda pegando o pedido, o endereço e a forma de pagamento (Pix, Dinheiro ou Cartão na entrega).

${catalogText}

FORMATO DE SAÍDA OBRIGATÓRIO (BOTÕES CLICÁVEIS):
Você deve SEMPRE terminar sua resposta oferecendo de 1 a 3 opções curtas (máximo 20 caracteres cada) para o cliente clicar.
Separe o texto da sua resposta e os botões usando exatos três pipes: |||
Separe os botões entre si usando vírgulas.

EXEMPLO DE RESPOSTA CORRETA:
O combo Tanqueray custa R$ 169,90. Vai querer adicionar gelo? ||| Sim, Não, Ver outros combos

EXEMPLO DE RESPOSTA CORRETA 2:
Tudo certo! Qual será a forma de pagamento? ||| Pix, Cartão, Dinheiro`
                },
                ...chatHistory
            ];

            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: messages,
                temperature: 0.2, // Temperatura baixa para focar no catálogo e evitar invenções
                max_tokens: 300,
            });

            return completion.choices[0].message.content || "Desculpe, tive um erro de processamento. ||| Falar com atendente";

        } catch (error) {
            console.error("Erro no AiService:", error);
            return "Poxa, nosso sistema está com uma instabilidade. Aguarde um momento. ||| Tentar novamente";
        }
    }
}