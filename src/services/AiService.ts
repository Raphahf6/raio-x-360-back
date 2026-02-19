import OpenAI from 'openai';
import { query } from '../lib/db';

// Inicializa a OpenAI com a chave do seu .env
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export class AiService {
    static async generateResponse(instanceId: string, customerHash: string) {
        try {
            // 1. BUSCAR O CATÁLOGO DA ADEGA (Apenas produtos disponíveis)
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

            // 2. BUSCAR O HISTÓRICO DA CONVERSA (Últimas 10 mensagens para não gastar muitos tokens)
            const historyRes = await query(`
                SELECT direction, content 
                FROM "AuditLog"
                WHERE "instanceId" = $1 AND "customerHash" = $2
                ORDER BY timestamp DESC
                LIMIT 10
            `, [instanceId, customerHash]);

            // Como a query traz do mais novo pro mais velho (DESC), precisamos inverter (reverse)
            // para a OpenAI ler na ordem cronológica correta.
            const chatHistory = historyRes.rows.reverse().map(row => ({
                role: row.direction === 'IN' ? 'user' : 'assistant',
                content: row.content
            }));

            // 3. CONSTRUIR O PROMPT DO SISTEMA (A Personalidade do Agente)
            const messages: any[] = [
                {
                    role: "system",
                    content: `Você é o assistente virtual de vendas de uma adega de bebidas delivery via WhatsApp.
Seja simpático, rápido e persuasivo. Use linguagem natural de WhatsApp (brasileiro), com emojis de forma moderada.

SUA MISSÃO:
1. Tirar dúvidas sobre o cardápio.
2. Fazer upsell (se o cliente pedir combo de destilado, ofereça gelo e energético; se pedir cerveja, ofereça amendoim/carvão, desde que tenha no catálogo).
3. Anotar o pedido completo.
4. Calcular o total da compra.
5. Solicitar o endereço de entrega completo.
6. Solicitar a forma de pagamento (Dinheiro, Cartão na entrega, ou Pix).

REGRAS RÍGIDAS:
- NUNCA invente produtos ou preços. Use APENAS o catálogo fornecido abaixo.
- Se o cliente pedir algo que não está no catálogo, diga educadamente que não temos e ofereça uma alternativa similar.
- Responda de forma concisa. Textões não funcionam bem no WhatsApp.

${catalogText}`
                },
                ...chatHistory // Injeta as mensagens trocadas até agora (incluindo a última que o cliente acabou de mandar)
            ];

            // 4. CHAMAR A OPENAI (Usando o modelo ultrarrápido e barato)
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: messages,
                temperature: 0.7, // Criatividade controlada (0 a 1)
                max_tokens: 300,  // Respostas curtas
            });

            return completion.choices[0].message.content || "Desculpe, tive um problema ao processar sua mensagem.";

        } catch (error) {
            console.error("Erro no AiService:", error);
            return "Poxa, nosso sistema de atendimento está passando por uma pequena instabilidade. Aguarde um minutinho e mande a mensagem de novo, por favor!";
        }
    }
}