import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    delay
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { Server } from "socket.io";
import { v4 as uuidv4 } from 'uuid';
import { query } from "./db";
import { AiService } from "../services/AiService";

// Palavras-chave que forçam a volta ao menu inicial
const RESET_KEYWORDS = ["oi", "olá", "ola", "menu", "cardapio", "cardápio", "início", "inicio"];
// Tempo limite de inatividade (1 hora em milissegundos)
const INACTIVITY_TIMEOUT = 60 * 60 * 1000;

export class WhatsAppInstance {
    public sock: any;
    private instanceId: string;
    private io: Server;
    
    // FILA DE MENSAGENS (DEBOUNCE 5s)
    private messageQueues = new Map<string, { timer: NodeJS.Timeout, texts: string[], jid: string }>();

    constructor(instanceId: string, io: Server) {
        this.instanceId = instanceId;
        this.io = io;
    }

    private hashNumber(jid: string) {
        return crypto.createHash('sha256').update(jid).digest('hex');
    }

    public async init() {
        const authPath = path.resolve(__dirname, '..', '..', 'sessions', this.instanceId);
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['R&B Digital Soluções', 'Chrome', '1.0.0'],
            defaultQueryTimeoutMs: undefined,
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', async (update: any) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) this.io.emit(`qr_${this.instanceId}`, qr);

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

                await query('UPDATE "Instance" SET status = $1 WHERE id = $2', ['DISCONNECTED', this.instanceId]);
                this.io.emit(`status_${this.instanceId}`, 'DISCONNECTED');

                if (isLoggedOut) {
                    console.log(`⚠️ Sessão invalidada. Gerando novo QR...`);
                    if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
                    this.init();
                } else {
                    this.init();
                }
            } else if (connection === 'open') {
                await query('UPDATE "Instance" SET status = $1 WHERE id = $2', ['CONNECTED', this.instanceId]);
                this.io.emit(`status_${this.instanceId}`, 'CONNECTED');
            }
        });

        this.sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
            if (type === 'notify') {
                for (const msg of messages) {
                    const jid = msg.key.remoteJid;
                    if (!jid || jid.includes('@g.us') || jid.includes('status@broadcast')) continue;

                    const customerHash = this.hashNumber(jid);
                    const isFromMe = msg.key.fromMe;
                    
                    // Extração de texto simplificada (Sem botões nativos)
                    let content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
                    content = content.trim();
                    
                    if (!content) continue;

                    // Se a mensagem foi enviada por nós mesmos (ex: pelo WhatsApp Web), 
                    // apenas salva no log e ignora o fluxo do bot
                    if (isFromMe) {
                        try {
                            await query(
                                `INSERT INTO "AuditLog" (id, "instanceId", "customerHash", direction, content, timestamp) VALUES ($1, $2, $3, 'OUT', $4, NOW())`,
                                [uuidv4(), this.instanceId, customerHash, content]
                            );
                            this.io.emit(`new_message_${this.instanceId}`, {
                                customerHash, direction: 'OUT', content, timestamp: new Date()
                            });
                        } catch (err) {
                            console.error("Erro ao registrar mensagem enviada manualmente:", err);
                        }
                        continue;
                    }

                    // ============================================================
                    // ENFILEIRAMENTO DE MENSAGENS DO CLIENTE (DEBOUNCE 5s)
                    // ============================================================
                    const queueKey = `${this.instanceId}:${customerHash}`;
                    
                    if (this.messageQueues.has(queueKey)) {
                        const q = this.messageQueues.get(queueKey)!;
                        clearTimeout(q.timer); 
                        q.texts.push(content); 
                        
                        q.timer = setTimeout(() => this.processGroupedMessage(queueKey), 5000); 
                    } else {
                        const timer = setTimeout(() => this.processGroupedMessage(queueKey), 5000);
                        this.messageQueues.set(queueKey, { timer, texts: [content], jid });
                    }
                }
            }
        });
    }

    /**
     * PROCESSAMENTO PRINCIPAL - Roda após o cliente ficar 5 segundos sem digitar
     */
    private async processGroupedMessage(queueKey: string) {
        const q = this.messageQueues.get(queueKey);
        if (!q) return;
        
        this.messageQueues.delete(queueKey); 

        const { texts, jid } = q;
        const customerHash = queueKey.split(':')[1];
        
        const combinedContent = texts.join('\n'); 

        try {
            let isFirstContact = false;
            let customerStatus = 'LEAD';
            let shouldReset = false;

            // 1. Busca no Banco de Dados
            const checkCustomer = await query(`SELECT "id", "status", "lastContact" FROM "Customer" WHERE "instanceId" = $1 AND "phoneHash" = $2`, [this.instanceId, customerHash]);
            isFirstContact = checkCustomer.rowCount === 0;
            
            if (!isFirstContact) {
                customerStatus = checkCustomer.rows[0].status;
                const lastContactDate = new Date(checkCustomer.rows[0].lastContact).getTime();
                const now = Date.now();
                
                // Regra 1: Timeout de 1 hora
                if (now - lastContactDate > INACTIVITY_TIMEOUT) {
                    shouldReset = true;
                    console.log(`[SISTEMA] Cliente inativo por +1h. Resetando fluxo.`);
                }
            }

            // Regra 2: Verifica se ALGUMA das mensagens aglomeradas tinha palavra-chave
            const hasKeyword = texts.some(text => RESET_KEYWORDS.includes(text.toLowerCase()));
            if (hasKeyword) {
                shouldReset = true;
                console.log(`[SISTEMA] Palavra-chave detectada no bloco de mensagens. Resetando fluxo.`);
            }

            if (shouldReset && customerStatus !== 'LEAD') {
                customerStatus = 'LEAD';
                await query(`UPDATE "Customer" SET status = 'LEAD' WHERE "instanceId" = $1 AND "phoneHash" = $2`, [this.instanceId, customerHash]);
            }

            // 2. Atualiza os Registros no Banco
            await query(`
                INSERT INTO "Customer" (id, "instanceId", "phoneHash", "name", "lastContact", "status")
                VALUES ($1, $2, $3, $4, NOW(), 'LEAD')
                ON CONFLICT ("instanceId", "phoneHash") 
                DO UPDATE SET "lastContact" = NOW();
            `, [uuidv4(), this.instanceId, customerHash, "Cliente " + customerHash.substring(0,4)]);

            const logId = uuidv4();
            await query(
                `INSERT INTO "AuditLog" (id, "instanceId", "customerHash", direction, content, timestamp) VALUES ($1, $2, $3, 'IN', $4, NOW())`,
                [logId, this.instanceId, customerHash, combinedContent]
            );

            this.io.emit(`new_message_${this.instanceId}`, {
                customerHash, direction: 'IN', content: combinedContent, timestamp: new Date()
            });

            // 3. Verifica Escalonamento Humano no bloco agrupado
            const askedForHuman = texts.some(t => t.toLowerCase().includes('humano') || t.toLowerCase().includes('atendente'));
            if (customerStatus === 'HUMAN' || askedForHuman || texts.some(t => t.toLowerCase() === 'falar com atendente')) {
                if (askedForHuman && customerStatus !== 'HUMAN') {
                    await this.sock.sendMessage(jid, { text: "⏳ Certo! Já chamei um de nossos atendentes. Ele já vai te responder por aqui!" });
                    await query(`UPDATE "Customer" SET status = 'HUMAN' WHERE "instanceId" = $1 AND "phoneHash" = $2`, [this.instanceId, customerHash]);
                }
                return; 
            }

            await this.sock.sendPresenceUpdate('composing', jid);
            await delay(1500); // Aumentei levemente o delay para dar tempo de processamento seguro

            let finalResponseText = "";
            let finalButtons: string[] = [];

            // 4. Fluxo de Menu
            if (isFirstContact || shouldReset) {
                const catalogRes = await query(`
                    SELECT p.name, p.price, c.name as category 
                    FROM "Product" p 
                    LEFT JOIN "Category" c ON p."categoryId" = c.id 
                    WHERE p."instanceId" = $1 AND p."isAvailable" = true
                    ORDER BY c.name, p.name
                `, [this.instanceId]);

                let menuText = "Olá! 👋 Bem-vindo ao nosso Delivery.\n\n📋 *NOSSO CARDÁPIO ATUAL:*\n";
                let currentCategory = "";

                catalogRes.rows.forEach(item => {
                    if (item.category !== currentCategory) {
                        menuText += `\n📦 *${item.category || 'Geral'}*\n`;
                        currentCategory = item.category;
                    }
                    menuText += `▪️ ${item.name} - R$ ${item.price}\n`;
                });

                menuText += `\n🛒 *O que você gostaria de pedir hoje?*`;
                
                finalResponseText = menuText;
                finalButtons = ["Fazer Pedido", "Falar com Atendente"];
            } 
            // 5. Fluxo da IA
            else {
                const aiRawResponse = await AiService.generateResponse(this.instanceId, customerHash);
                
                let processedText = aiRawResponse;
                
                if (processedText.includes('[CHAMAR_HUMANO]')) {
                    processedText = processedText.replace('[CHAMAR_HUMANO]', '').trim();
                    await query(`UPDATE "Customer" SET status = 'HUMAN' WHERE "instanceId" = $1 AND "phoneHash" = $2`, [this.instanceId, customerHash]);
                    console.log(`🚨 Cliente ${customerHash.substring(0,8)} transferido para HUMANO`);
                }
                
                if (processedText.includes('[AGUARDANDO_PIX]')) {
                    processedText = processedText.replace('[AGUARDANDO_PIX]', '').trim();
                }

                const parts = processedText.split('|||');
                finalResponseText = parts[0].trim();
                if (parts[1]) {
                    finalButtons = parts[1].split(',').filter(b => b.trim() !== '');
                }
            }

            // ============================================================
            // 6. FORMATAÇÃO SEGURA (TEXTO PURO EM VEZ DE BOTÕES NATIVOS)
            // ============================================================
            let textToSend = finalResponseText;
            
            // Se a IA gerou botões, nós convertemos em um menu de texto
            if (finalButtons && finalButtons.length > 0) {
                textToSend += "\n\n*Responda com uma das opções:*";
                finalButtons.forEach(btn => {
                    textToSend += `\n👉 ${btn.trim()}`;
                });
            }

            // Envio garantido via texto simples
            await this.sock.sendMessage(jid, { text: textToSend });
            await this.sock.sendPresenceUpdate('paused', jid);
            
            await query(
                `INSERT INTO "AuditLog" (id, "instanceId", "customerHash", direction, content, timestamp) VALUES ($1, $2, $3, 'OUT', $4, NOW())`,
                [uuidv4(), this.instanceId, customerHash, textToSend]
            );

        } catch (error) {
            console.error("Erro no processamento agrupado:", error);
        }
    }
}