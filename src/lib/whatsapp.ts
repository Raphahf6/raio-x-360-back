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
            browser: ['R&B Digital', 'Chrome', 'Auditoria 360'],
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
                    const content = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").toLowerCase();

                    // 1. SALVAR LOG (AUDITORIA)
                    try {
                        const logId = uuidv4();
                        await query(
                            `INSERT INTO "AuditLog" (id, "instanceId", "customerHash", direction, content, timestamp) VALUES ($1, $2, $3, $4, $5, NOW())`,
                            [logId, this.instanceId, customerHash, isFromMe ? 'OUT' : 'IN', content]
                        );

                        // Emite para o front
                        this.io.emit(`new_message_${this.instanceId}`, {
                            customerHash,
                            direction: isFromMe ? 'OUT' : 'IN',
                            content,
                            timestamp: new Date()
                        });

                        // 2. AUTOMAÇÃO CIRÚRGICA (Apenas se for mensagem do cliente)
                        if (!isFromMe && content.length > 1) {
                            await this.handleAutomation(jid, content);
                        }

                    } catch (error) {
                        console.error("Erro no processamento:", error);
                    }
                }
            }
        });
    }

    // Lógica da Automação
    private async handleAutomation(jid: string, content: string) {
        try {
            // Busca regras ativas no banco para esta instância
            const rules = await query(
                `SELECT * FROM "AutomationRule" WHERE "instanceId" = $1 AND "isActive" = true`,
                [this.instanceId]
            );

            for (const rule of rules.rows) {
                // Verifica se a mensagem contém a palavra-chave (ex: "pix")
                if (content.includes(rule.keyword.toLowerCase())) {
                    
                    console.log(`[Automação] Gatilho acionado: ${rule.keyword}`);
                    
                    // Delay humano (2s) para não parecer robô
                    await delay(2000);
                    
                    await this.sock.sendMessage(jid, { text: rule.response });
                    
                    // Salva o log da resposta automática também
                    await query(
                        `INSERT INTO "AuditLog" (id, "instanceId", "customerHash", direction, content, timestamp) VALUES ($1, $2, $3, 'OUT', $4, NOW())`,
                        [uuidv4(), this.instanceId, this.hashNumber(jid), `[AUTO] ${rule.response}`]
                    );

                    break; // Para na primeira regra encontrada (evita spam)
                }
            }
        } catch (error) {
            console.error("Erro na automação:", error);
        }
    }
}