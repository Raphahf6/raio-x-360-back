import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { routes } from './routes';
import { restoreSessions } from './controllers/WhatsAppController';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);

// Exportamos o IO para que os Controllers (como o de Pedidos) possam usá-lo para emitir alertas
export const io = new Server(httpServer, {
    cors: { origin: "*" } 
});

// Registra todas as rotas modulares
app.use(routes);

// =======================================================
//   SERVER START
// =======================================================
const PORT = process.env.PORT || 3333;

httpServer.listen(PORT, async () => {
    console.log(`🚀 R&B Delivery SaaS rodando na porta ${PORT}`);
    console.log(`🔧 Arquitetura: Modular (Controllers & Routes)`);
    
    // Tenta restaurar sessões do WhatsApp ao ligar o servidor
    await restoreSessions(io);
});