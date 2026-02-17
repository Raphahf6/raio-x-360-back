import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "path";
import crypto from "crypto";
import { Server } from "socket.io";
import { v4 as uuidv4 } from 'uuid'; // Gera ID único
import { query } from "./db"; // Importa nossa conexão SQL direta

export class WhatsAppInstance {
    public sock: any;
    private instanceId: string;
    private io: Server;

    constructor(instanceId: string, io: Server) {
        this.instanceId = instanceId;
        this.io = io;
    }

    // Anonimiza o número do cliente (LGPD/Privacidade)
    private hashNumber(jid: string) {
        return crypto.createHash('sha256').update(jid).digest('hex');
    }

    public async init() {
        // Define onde salvar as credenciais (pasta sessions na raiz)
        const authPath = path.resolve(__dirname, '..', '..', 'sessions', this.instanceId);
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false, // Vamos enviar via Socket para o Front
            browser: ['R&B Digital', 'Chrome', 'Auditoria 360'], // Sua marca aqui
            defaultQueryTimeoutMs: undefined, // Evita timeout em conexões lentas
        });

        // Salva as credenciais sempre que atualizarem
        this.sock.ev.on('creds.update', saveCreds);

        // Monitora a conexão
        this.sock.ev.on('connection.update', async (update: any) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                // Envia QR Code para o frontend em tempo real
                this.io.emit(`qr_${this.instanceId}`, qr);
                console.log(`[R&B] QR Code gerado para instância: ${this.instanceId}`);
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                
                // Atualiza status no banco via SQL
                await query('UPDATE "Instance" SET status = $1 WHERE id = $2', ['DISCONNECTED', this.instanceId]);
                
                console.log(`[R&B] Conexão caiu. Reconectar? ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    this.init(); // Tenta reconectar automaticamente
                }
            } else if (connection === 'open') {
                // Conexão estabelecida com sucesso
                await query('UPDATE "Instance" SET status = $1 WHERE id = $2', ['CONNECTED', this.instanceId]);
                
                this.io.emit(`status_${this.instanceId}`, 'CONNECTED');
                console.log(`[R&B] Instância ${this.instanceId} conectada e auditando!`);
            }
        });

        // O CORAÇÃO DO RAIO-X: Escuta e Salva Mensagens
        this.sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
            if (type === 'notify') {
                for (const msg of messages) {
                    const jid = msg.key.remoteJid;
                    
                    // Ignora grupos e status
                    if (!jid || jid.includes('@g.us') || jid.includes('status@broadcast')) continue;

                    const customerHash = this.hashNumber(jid);
                    const isFromMe = msg.key.fromMe;
                    
                    // Extrai o texto de várias formas possíveis (iOS, Android, Web)
                    const content = msg.message?.conversation || 
                                  msg.message?.extendedTextMessage?.text || 
                                  msg.message?.imageMessage?.caption || 
                                  "[Mídia/Outros]";

                    try {
                        // SQL PURO: Salva o log de auditoria
                        const logId = uuidv4();
                        await query(
                            `INSERT INTO "AuditLog" 
                            (id, "instanceId", "customerHash", direction, content, timestamp) 
                            VALUES ($1, $2, $3, $4, $5, NOW())`,
                            [logId, this.instanceId, customerHash, isFromMe ? 'OUT' : 'IN', content]
                        );

                        // Emite evento para o Dashboard (Gráficos em tempo real)
                        this.io.emit(`new_message_${this.instanceId}`, {
                            customerHash,
                            direction: isFromMe ? 'OUT' : 'IN',
                            content,
                            timestamp: new Date()
                        });
                        
                        // console.log(`[Audit] Log salvo: ${logId}`);

                    } catch (error) {
                        console.error("Erro ao salvar log de auditoria:", error);
                    }
                }
            }
        });
    }
}