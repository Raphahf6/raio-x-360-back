import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    delay,
    generateWAMessageFromContent,
    proto
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { Server } from "socket.io";
import { v4 as uuidv4 } from 'uuid';
import { query } from "./db";
import { AiService } from "../services/AiService";

export class WhatsAppInstance {
    public sock: any;
    private instanceId: string;
    private io: Server;

    constructor(instanceId: string, io: Server) {
        this.instanceId = instanceId;
        this.io = io;
    }

    private hashNumber(jid: string) {
        return crypto.createHash('sha256').update(jid).digest('hex');
    }

    // NOVA FUNÇÃO: Botões Nativos (InteractiveMessage - Padrão Ouro Atual)
    private async sendInteractiveButtons(jid: string, text: string, buttonLabels: string[]) {
        if (!buttonLabels || buttonLabels.length === 0 || buttonLabels[0] === '') {
            await this.sock.sendMessage(jid, { text });
            return;
        }

        const dynamicButtons = buttonLabels.slice(0, 3).map((btn, index) => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({
                display_text: btn.trim().substring(0, 20),
                id: `btn_${index}`
            })
        }));

        const msg = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: proto.Message.InteractiveMessage.create({
                        body: proto.Message.InteractiveMessage.Body.create({ text: text }),
                        footer: proto.Message.InteractiveMessage.Footer.create({ text: "Selecione uma opção 👇" }),
                        header: proto.Message.InteractiveMessage.Header.create({ title: "", subtitle: "", hasMediaAttachment: false }),
                        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                            buttons: dynamicButtons
                        })
                    })
                }
            }
        }, { userJid: this.sock.user?.id });

        await this.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    }

    public async init() {
        const authPath = path.resolve(__dirname, '..', '..', 'sessions', this.instanceId);
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['R&B Delivery AI', 'Chrome', '1.0.0'],
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
                    
                    // Lógica robusta para extrair o texto, seja de digitação livre ou clique de botão nativo
                    let content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
                    
                    if (msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
                        try {
                            const params = JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
                            content = params.display_text || params.id || "";
                        } catch (e) { content = ""; }
                    } else if (msg.message?.buttonsResponseMessage?.selectedDisplayText) {
                        content = msg.message.buttonsResponseMessage.selectedDisplayText;
                    } else if (msg.message?.templateButtonReplyMessage?.selectedDisplayText) {
                        content = msg.message.templateButtonReplyMessage.selectedDisplayText;
                    }
                    
                    content = content.trim();
                    if (!content) continue;

                    try {
                        let isFirstContact = false;
                        let customerStatus = 'LEAD';

                        if (!isFromMe) {
                            const checkCustomer = await query(`SELECT "id", "status" FROM "Customer" WHERE "instanceId" = $1 AND "phoneHash" = $2`, [this.instanceId, customerHash]);
                            isFirstContact = checkCustomer.rowCount === 0;
                            
                            if (!isFirstContact) {
                                customerStatus = checkCustomer.rows[0].status;
                            }

                            await query(`
                                INSERT INTO "Customer" (id, "instanceId", "phoneHash", "name", "lastContact", "status")
                                VALUES ($1, $2, $3, $4, NOW(), 'LEAD')
                                ON CONFLICT ("instanceId", "phoneHash") 
                                DO UPDATE SET "lastContact" = NOW();
                            `, [uuidv4(), this.instanceId, customerHash, "Cliente " + customerHash.substring(0,4)]);
                        }

                        // Salva no log
                        const logId = uuidv4();
                        await query(
                            `INSERT INTO "AuditLog" (id, "instanceId", "customerHash", direction, content, timestamp) VALUES ($1, $2, $3, $4, $5, NOW())`,
                            [logId, this.instanceId, customerHash, isFromMe ? 'OUT' : 'IN', content]
                        );

                        this.io.emit(`new_message_${this.instanceId}`, {
                            customerHash, direction: isFromMe ? 'OUT' : 'IN', content, timestamp: new Date()
                        });

                        // Se não for do bot e o status do cliente não for "HUMAN" (Atendimento pausado)
                        if (!isFromMe && content.length > 0) {
                            
                            // SE O CLIENTE JÁ FOI TRANSFERIDO PARA HUMANO, O BOT FICA CALADO
                            if (customerStatus === 'HUMAN' || content.toLowerCase() === 'falar com atendente' || content.toLowerCase() === 'falar com humano') {
                                if (content.toLowerCase().includes('humano') || content.toLowerCase().includes('atendente')) {
                                    await this.sock.sendMessage(jid, { text: "⏳ Certo! Já chamei um de nossos atendentes. Ele já vai te responder por aqui!" });
                                    await query(`UPDATE "Customer" SET status = 'HUMAN' WHERE "instanceId" = $1 AND "phoneHash" = $2`, [this.instanceId, customerHash]);
                                }
                                continue; 
                            }

                            await this.sock.sendPresenceUpdate('composing', jid);
                            await delay(1000); 

                            let finalResponseText = "";
                            let finalButtons: string[] = [];

                            if (isFirstContact) {
                                // MENSAGEM INICIAL COM CARDÁPIO DIRETO DO BANCO E BOTÕES (Custo: $0)
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

                                menuText += `\n🛒 *O que você gostaria de pedir hoje?* (Pode digitar ou clicar nos botões abaixo)`;
                                
                                finalResponseText = menuText;
                                finalButtons = ["Fazer Pedido", "Falar com Humano"];
                            } 
                            else {
                                // IA ASSUME O FECHAMENTO DO PEDIDO E UPSALES
                                const aiRawResponse = await AiService.generateResponse(this.instanceId, customerHash);
                                
                                // Processamento de Tags Ocultas
                                let processedText = aiRawResponse;
                                
                                if (processedText.includes('[CHAMAR_HUMANO]')) {
                                    processedText = processedText.replace('[CHAMAR_HUMANO]', '').trim();
                                    await query(`UPDATE "Customer" SET status = 'HUMAN' WHERE "instanceId" = $1 AND "phoneHash" = $2`, [this.instanceId, customerHash]);
                                    // Notifica no console que escalou
                                    console.log(`🚨 Cliente ${customerHash.substring(0,8)} transferido para HUMANO (Pediu desconto)`);
                                }
                                
                                if (processedText.includes('[AGUARDANDO_PIX]')) {
                                    processedText = processedText.replace('[AGUARDANDO_PIX]', '').trim();
                                    // Futuro: Adicionar lógica na tabela Order
                                }

                                // Separa os botões da IA
                                const parts = processedText.split('|||');
                                finalResponseText = parts[0].trim();
                                if (parts[1]) {
                                    finalButtons = parts[1].split(',').filter(b => b.trim() !== '');
                                }
                            }

                            // Envia usando a função nativa mais nova do Baileys
                            await this.sendInteractiveButtons(jid, finalResponseText, finalButtons);
                            
                            await this.sock.sendPresenceUpdate('paused', jid);
                            
                            await query(
                                `INSERT INTO "AuditLog" (id, "instanceId", "customerHash", direction, content, timestamp) VALUES ($1, $2, $3, 'OUT', $4, NOW())`,
                                [uuidv4(), this.instanceId, customerHash, finalResponseText]
                            );
                        }

                    } catch (error) {
                        console.error("Erro no processamento:", error);
                    }
                }
            }
        });
    }
}