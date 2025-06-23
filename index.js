'use strict';

const MCPServer = require('./lib/mcp-server');

module.exports.title = 'WildDuck MCP Server';

module.exports.init = (app, done) => {
    const logger = app.logger;
    const config = app.config || {};
    
    logger.info('MCP', 'Initializing WildDuck MCP Server plugin (Official SDK)');
    
    // Helper to authenticate requests
    const authenticateRequest = async (req) => {
        // Check various token sources
        let accessToken = req.params.accessToken || 
                         req.query.accessToken || 
                         req.headers['x-access-token'] ||
                         (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') 
                          ? req.headers.authorization.substring(7) : null);
        
        if (accessToken && req.authenticate) {
            try {
                const authResult = await req.authenticate(accessToken);
                if (authResult.authenticated) {
                    req.user = authResult.user;
                    req.role = authResult.role;
                    return true;
                }
            } catch (err) {
                logger.warn('MCP', 'Authentication failed', { error: err.message });
            }
        }
        return false;
    };
    
    // Initialize MCP server with WildDuck context
    const mcpServer = new MCPServer({
        db: app.db,
        redis: app.redis,
        logger,
        config,
        // Handlers from WildDuck
        userHandler: app.userHandler,
        mailboxHandler: app.mailboxHandler,
        messageHandler: app.messageHandler,
        storageHandler: app.storageHandler
    });
    
    // Register MCP protocol endpoints
    // These will be available at /plugin/mcp/*
    // All endpoints support token in URL: /plugin/mcp/:accessToken/...

    // Secure attachment download (no authentication required - uses signed URLs)
    // Format: /plugin/mcp/att/<msgid>/<attid>/<expires>/<signature>/filename.ext
    app.addAPI('GET', '/att/:messageId/:attachmentId/:expires/:signature/:filename', async (req, res) => {
        await mcpServer.handleSecureAttachment(req, res);
    });
    
    // Server information
    app.addAPI('GET', '/info', (req, res, next) => {
        res.json({
            name: 'wildduck-mcp-server',
            version: '1.0.0',
            protocolVersion: '2024-11-05',
            capabilities: {
                resources: true,
                tools: true,
                prompts: true
            }
        });
        next();
    });
    
    async function handleMCPRequest(req, res) {
        await authenticateRequest(req);
        await mcpServer.handleRequest(req, res);
    }

    // Forward all MCP requests to the handler
    // Handle all methods (POST, GET, DELETE) with token in path
    ['POST', 'GET', 'DEL'].forEach(method => {
        app.addAPI(method, '/:accessToken', handleMCPRequest);
        app.addAPI(method, '/:accessToken/*', handleMCPRequest);
        
        // Also support without token in path (using query param or headers)
        app.addAPI(method, '/', handleMCPRequest);
        app.addAPI(method, '*', handleMCPRequest);
    });
    
    // // Initialize hook - called when all services are ready
    // app.addHook('init', async () => {
    //     logger.info('MCP', 'WildDuck MCP Server ready at /plugin/mcp');
    // });
    
    // Shutdown hook - clean up resources
    app.addHook('close', async () => {
        logger.info('MCP', 'Shutting down MCP Server');
        await mcpServer.shutdown();
    });
    
    setImmediate(done);
};