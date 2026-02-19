import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    delay
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "path";
import crypto from "crypto";
import { Server } from "socket.io";
import { v4 as uuidv4 } from 'uuid';
import { query } from "./db";
import { AiService } from "../services/AiService"; // Importando nosso novo Cérebro

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
                this.io.emit(`qr_${this.instanceId}`, qr);
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                await query('UPDATE "Instance" SET status = $1 WHERE id = $2', ['DISCONNECTED', this.instanceId]);
                if (shouldReconnect) this.init();
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
                    const content = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();

                    if (!content) continue; // Ignora mensagens vazias ou apenas mídia por enquanto

                    // 1. LÓGICA DE CRM (Cria ou atualiza o cliente)
                    try {
                        if (!isFromMe) {
                            await query(`
                                INSERT INTO "Customer" (id, "instanceId", "phoneHash", "name", "lastContact", "status")
                                VALUES ($1, $2, $3, $4, NOW(), 'LEAD')
                                ON CONFLICT ("instanceId", "phoneHash") 
                                DO UPDATE SET "lastContact" = NOW();
                            `, [uuidv4(), this.instanceId, customerHash, "Cliente " + customerHash.substring(0,4)]);
                        }

                        // 2. SALVAR MENSAGEM NO LOG (Para a IA ter histórico)
                        const logId = uuidv4();
                        await query(
                            `INSERT INTO "AuditLog" (id, "instanceId", "customerHash", direction, content, timestamp) VALUES ($1, $2, $3, $4, $5, NOW())`,
                            [logId, this.instanceId, customerHash, isFromMe ? 'OUT' : 'IN', content]
                        );

                        // Emite para o front-end atualizar os gráficos
                        this.io.emit(`new_message_${this.instanceId}`, {
                            customerHash,
                            direction: isFromMe ? 'OUT' : 'IN',
                            content,
                            timestamp: new Date()
                        });

                        // =======================================================
                        // 3. O AGENTE DE INTELIGÊNCIA ARTIFICIAL (A Mágica)
                        // =======================================================
                        if (!isFromMe && content.length > 1) {
                            // Simula o "Digitando..." no WhatsApp do cliente
                            await this.sock.sendPresenceUpdate('composing', jid);
                            
                            // Chama a OpenAI passando o ID da instância e o Hash do cliente
                            const aiResponse = await AiService.generateResponse(this.instanceId, customerHash);
                            
                            // Pequeno delay humano antes de enviar a resposta
                            await delay(1500);
                            
                            // Envia a resposta final para o cliente
                            await this.sock.sendMessage(jid, { text: aiResponse });
                            
                            // Simula que parou de digitar
                            await this.sock.sendPresenceUpdate('paused', jid);
                            
                            // Salva a resposta da IA no banco também
                            await query(
                                `INSERT INTO "AuditLog" (id, "instanceId", "customerHash", direction, content, timestamp) VALUES ($1, $2, $3, 'OUT', $4, NOW())`,
                                [uuidv4(), this.instanceId, customerHash, aiResponse]
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