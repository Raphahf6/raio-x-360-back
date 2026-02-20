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

            let catalogText = "CATÁLOGO DISPONÍVEL HOJE:\n";
            if (catalogRes.rowCount === 0) {
                catalogText += "Nenhum produto cadastrado no momento.\n";
            } else {
                catalogRes.rows.forEach(item => {
                    const desc = item.description ? ` - ${item.description}` : '';
                    catalogText += `- [${item.category || 'Geral'}] ${item.name}: R$ ${item.price}${desc}\n`;
                });
            }

            // 2. BUSCAR HISTÓRICO (AGORA COM LIMITE DE 1 HORA)
            const historyRes = await query(`
                SELECT direction, content 
                FROM "AuditLog"
                WHERE "instanceId" = $1 
                AND "customerHash" = $2
                AND timestamp >= NOW() - INTERVAL '1 HOUR'
                ORDER BY timestamp DESC
                LIMIT 12
            `, [instanceId, customerHash]);

            const chatHistory = historyRes.rows.reverse().map(row => ({
                role: row.direction === 'IN' ? 'user' : 'assistant',
                content: row.content
            }));

            // 3. PROMPT ESTRITO DO FLUXO DE VENDAS
            const messages: any[] = [
                {
                    role: "system",
                    content: `Você é o assistente virtual de vendas de uma adega delivery via WhatsApp.
O cliente JÁ RECEBEU o cardápio inicial. A partir de agora, você assume para fechar a venda.

REGRAS ESTABELECIDAS PELO DONO DA ADEGA (NUNCA QUEBRE):
1. PREÇOS SÃO FIXOS: NUNCA dê descontos ou abaixe o preço. Se o cliente pedir desconto, diga educadamente que os preços são tabelados.
2. SE O CLIENTE INSISTIR NO DESCONTO: Você DEVE incluir a tag [CHAMAR_HUMANO] na sua resposta. O sistema irá transferir o atendimento.
3. INVENTÁRIO RESTRITO: Ofereça EXATAMENTE e APENAS o que está no catálogo abaixo. NUNCA ofereça adicionais (como gelo ou amendoim) se não estiverem no catálogo.
4. FLUXO DE FECHAMENTO: 
   Passo 1: Confirme o pedido do cliente e pergunte se deseja adicionar mais algo do catálogo.
   Passo 2: Calcule o total exato.
   Passo 3: Peça o endereço completo com ponto de referência.
   Passo 4: Pergunte a forma de pagamento (Pix, Dinheiro com troco, ou Cartão na entrega).
5. PAGAMENTO VIA PIX: Se o cliente escolher PIX, diga o valor total, envie a chave PIX (CNPJ: 12.345.678/0001-90) e diga que o pedido só será confirmado e enviado APÓS o envio do comprovante nesta conversa. Inclua a tag [AGUARDANDO_PIX] na sua resposta.

${catalogText}

FORMATO DE SAÍDA OBRIGATÓRIO (BOTÕES CLICÁVEIS):
Você deve SEMPRE terminar sua resposta oferecendo de 1 a 3 opções curtas (máximo 20 caracteres cada) para o cliente clicar.
Separe o texto da sua resposta e os botões usando exatos três pipes: |||
Separe os botões entre si usando vírgulas.

Exemplo de resposta (Sem desconto):
Infelizmente não conseguimos dar desconto, nossos preços já estão no limite promocional! Vai querer fechar o pedido assim mesmo? ||| Sim, Não, Falar com Atendente

Exemplo de resposta (Insistiu no desconto):
Entendo. Vou chamar o gerente para ver se ele pode te ajudar com isso, um momento! [CHAMAR_HUMANO] ||| 

Exemplo de resposta (Pix Escolhido):
Perfeito! O total é R$ 150,00. Nossa chave PIX é o CNPJ: 12.345.678/0001-90. Por favor, me envie o comprovante aqui para eu liberar o envio do seu pedido imediatamente! [AGUARDANDO_PIX] ||| Enviar Comprovante, Alterar Pagamento`
                },
                ...chatHistory
            ];

            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: messages,
                temperature: 0.1, // Quase zero criatividade para não inventar descontos
                max_tokens: 400,
            });

            return completion.choices[0].message.content || "Desculpe, erro de processamento. ||| Falar com atendente";

        } catch (error) {
            console.error("Erro no AiService:", error);
            return "Poxa, nosso sistema está com uma instabilidade. Aguarde um momento. ||| Tentar novamente";
        }
    }
}