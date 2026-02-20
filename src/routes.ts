import { Router } from 'express';

// Importaremos os Controllers no próximo passo
import { CatalogController } from './controllers/CatalogController';
import { OrderController } from './controllers/OrderController';
import { CompanyController } from './controllers/CompanyController';
import { ProductController } from './controllers/ProductController';
import { WhatsAppController } from './controllers/WhatsAppController';
import { DashboardController } from './controllers/DashboardController';

export const routes = Router();

// ==========================================
// ROTAS PÚBLICAS (CATÁLOGO DIGITAL)
// ==========================================
routes.get('/catalog/:slug', CatalogController.getCatalog);
routes.post('/checkout', OrderController.createOrder);

// ==========================================
// ROTAS DO KDS (PDV / PEDIDOS)
// ==========================================
routes.get('/instance/:id/orders/active', OrderController.getActiveOrders);
routes.patch('/instance/:id/order/:orderId/status', OrderController.updateOrderStatus);

// ==========================================
// ROTAS DE EMPRESA E WHATSAPP
// ==========================================
routes.post('/company', CompanyController.createCompany);
routes.post('/instance/connect', WhatsAppController.connectInstance);

// ==========================================
// ROTAS DE CARDÁPIO (PRODUTOS E CATEGORIAS)
// ==========================================
routes.post('/instance/:id/category', ProductController.createCategory);
routes.get('/instance/:id/categories', ProductController.getCategories);
routes.post('/instance/:id/product', ProductController.createOrUpdateProduct);
routes.get('/instance/:id/products', ProductController.getProducts);
routes.delete('/instance/:id/product/:productId', ProductController.deleteProduct);

// ==========================================
// ROTAS DE DASHBOARD E CRM
// ==========================================
routes.get('/instance/:id/dashboard', DashboardController.getMetrics);
routes.get('/instance/:id/red-alert', DashboardController.getRedAlerts);
routes.get('/instance/:id/funnel', DashboardController.getFunnel);
routes.get('/instance/:id/customers', DashboardController.getCustomers);
routes.post('/automation', DashboardController.createAutomationRule);
routes.get('/instance/:id/automation', DashboardController.getAutomationRules);