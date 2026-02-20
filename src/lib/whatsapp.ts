import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    delay
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "path";
import fs from "fs"; // Importação nativa do Node para manipular arquivos
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

    // Função interna para formatar e enviar botões
    private async sendButtonMessage(jid: string, text: string, buttonLabels: string[]) {
        const buttons = buttonLabels.slice(0, 3).map((btn, index) => ({
            buttonId: `btn_${index}`,
            buttonText: { displayText: btn.trim().substring(0, 20) }, 
            type: 1
        }));

        const buttonMessage = {
            text: text,
            footer: 'Selecione uma opção 👇',
            buttons: buttons,
            headerType: 1
        };

        await this.sock.sendMessage(jid, buttonMessage);
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

            if (qr) {
                // Emite o QR Code para o front-end
                this.io.emit(`qr_${this.instanceId}`, qr);
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                
                // Verifica se foi deslogado pelo celular (401 device_removed ou loggedOut)
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

                await query('UPDATE "Instance" SET status = $1 WHERE id = $2', ['DISCONNECTED', this.instanceId]);
                this.io.emit(`status_${this.instanceId}`, 'DISCONNECTED');

                if (isLoggedOut) {
                    console.log(`⚠️ Dispositivo deslogado pelo usuário. Limpando sessão ${this.instanceId}...`);
                    
                    // Apaga a pasta de credenciais que foi invalidada
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                    }
                    
                    // Inicia a instância do zero. Como a pasta não existe mais, ele vai gerar um NOVO QR Code
                    this.init();
                } else {
                    // Queda de internet ou reinício do servidor, apenas tenta reconectar com os mesmos arquivos
                    console.log(`🔄 Tentando reconectar instância ${this.instanceId}...`);
                    this.init();
                }
            } else if (connection === 'open') {
                await query('UPDATE "Instance" SET status = $1 WHERE id = $2', ['CONNECTED', this.instanceId]);
                this.io.emit(`status_${this.instanceId}`, 'CONNECTED');
                console.log(`✅ Instância ${this.instanceId} conectada com sucesso!`);
            }
        });

        this.sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
            if (type === 'notify') {
                for (const msg of messages) {
                    const jid = msg.key.remoteJid;
                    if (!jid || jid.includes('@g.us') || jid.includes('status@broadcast')) continue;

                    const customerHash = this.hashNumber(jid);
                    const isFromMe = msg.key.fromMe;
                    
                    const content = (
                        msg.message?.conversation || 
                        msg.message?.extendedTextMessage?.text || 
                        msg.message?.buttonsResponseMessage?.selectedDisplayText || 
                        ""
                    ).trim();

                    if (!content) continue;

                    try {
                        let isFirstContact = false;

                        if (!isFromMe) {
                            const checkCustomer = await query(`SELECT "id" FROM "Customer" WHERE "instanceId" = $1 AND "phoneHash" = $2`, [this.instanceId, customerHash]);
                            isFirstContact = checkCustomer.rowCount === 0;

                            await query(`
                                INSERT INTO "Customer" (id, "instanceId", "phoneHash", "name", "lastContact", "status")
                                VALUES ($1, $2, $3, $4, NOW(), 'LEAD')
                                ON CONFLICT ("instanceId", "phoneHash") 
                                DO UPDATE SET "lastContact" = NOW();
                            `, [uuidv4(), this.instanceId, customerHash, "Cliente " + customerHash.substring(0,4)]);
                        }

                        const logId = uuidv4();
                        await query(
                            `INSERT INTO "AuditLog" (id, "instanceId", "customerHash", direction, content, timestamp) VALUES ($1, $2, $3, $4, $5, NOW())`,
                            [logId, this.instanceId, customerHash, isFromMe ? 'OUT' : 'IN', content]
                        );

                        this.io.emit(`new_message_${this.instanceId}`, {
                            customerHash,
                            direction: isFromMe ? 'OUT' : 'IN',
                            content,
                            timestamp: new Date()
                        });

                        if (!isFromMe && content.length > 0) {
                            await this.sock.sendPresenceUpdate('composing', jid);
                            await delay(1500); 

                            let finalResponseText = "";

                            if (isFirstContact) {
                                finalResponseText = "Olá! 👋 Bem-vindo ao nosso Delivery rápido. O que você gostaria de pedir hoje?";
                                await this.sendButtonMessage(jid, finalResponseText, ["Ver Catálogo", "Falar com Humano"]);
                            } 
                            else {
                                const aiRawResponse = await AiService.generateResponse(this.instanceId, customerHash);
                                
                                const parts = aiRawResponse.split('|||');
                                finalResponseText = parts[0].trim();
                                const buttonsPart = parts[1] ? parts[1].split(',').filter(b => b.trim() !== '') : [];

                                if (buttonsPart.length > 0) {
                                    await this.sendButtonMessage(jid, finalResponseText, buttonsPart);
                                } else {
                                    await this.sock.sendMessage(jid, { text: finalResponseText });
                                }
                            }

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